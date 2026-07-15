// TxSim — demo simulator that replays finished World Cup matches as if live.
//
// Data source is 100% authentic TxLINE: for each demo fixture we fetch once
//   GET /api/scores/historical/{id}   (full scores stream replay, SSE format)
//   GET /api/odds/updates/{id}        (full odds tick history)
// cache them under data/sim/, then re-timestamp and feed the messages through
// the exact same handleOdds/handleScore pipeline as the real SSE connector
// (TxSim extends TxLive) — so the dispatcher, cards and bets cannot tell the
// difference between demo mode and a real live match.
//
// Timeline model: T0 = simulator start.
//   live matches      → already `offsetMin` deep; earlier messages replay
//                       instantly with catchup=true (build state, no pings),
//                       the rest are emitted on schedule.
//   upcoming matches  → kick off `startsInMin` after T0 (pre-match odds ticks
//                       replay as catchup so cards show real opening odds).
//   finished matches  → entire history replays as catchup at T0.
//
// SIM_SPEED env (default 1) accelerates playback for video takes.
//
// CLI:  node simulator.mjs fetch   — download & cache the demo data (run on
//                                    the VPS where TxLINE credentials live).
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { TxLive } from "./txline-live.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIM_DIR = join(__dirname, "data", "sim");

// The 14 demo matches (selected from real WC2026 archives, see session notes).
// Selected from the 20 fixtures that /api/scores/historical actually serves
// (verified 2026-07-15) — everything here has authentic TxLINE score history.
export const DEMO_MATCHES = [
  // ---- LIVE at T0 ----
  // NB: offsetMin is relative to the start of TxLINE coverage (zero), which
  // for the hero begins at half-time (clock 45', score 0-1) — offset 15 puts
  // us at ~60' just before the 67'/79'/83'/90' goal sequence of the comeback.
  { id: 18202701, home: "Argentina", away: "Egypt",       phase: "live", offsetMin: 15 }, // hero: 0-2 → 3-2
  { id: 18192996, home: "Mexico",    away: "England",     phase: "live", offsetMin: 30 }, // 5 goals, red card, 3 VAR
  // Brazil-Norway coverage starts at half-time (like the hero) — offset is
  // relative to coverage start, 5 ≈ the 50th minute of the match
  { id: 18187298, home: "Brazil",    away: "Norway",      phase: "live", offsetMin: 5 }, // Haaland double 79/90, pen missed
  { id: 18179550, home: "Belgium",   away: "Senegal",     phase: "live", offsetMin: 15 }, // 0-2 → 3-2 in extra time
  { id: 18213979, home: "Norway",    away: "England",     phase: "live", offsetMin: 40 }, // Bellingham double, extra time
  // ---- UPCOMING at T0 ----
  { id: 18237038, home: "France",    away: "Spain",       phase: "upcoming", startsInMin: 10 },
  { id: 18209181, home: "France",    away: "Morocco",     phase: "upcoming", startsInMin: 30 },
  { id: 18198205, home: "Portugal",  away: "Spain",       phase: "upcoming", startsInMin: 60 }, // 90'+ winner
  // ---- FINISHED at T0 ----
  { id: 18202783, home: "Switzerland", away: "Colombia",  phase: "finished" }, // 0-0, pens 4-3, 3 pens missed/saved
  { id: 18176123, home: "Australia", away: "Egypt",       phase: "finished" }, // 1-1, pens, own goal
  { id: 18222446, home: "Argentina", away: "Switzerland", phase: "finished" }, // 3-1 aet, red card
  { id: 18218149, home: "Spain",     away: "Belgium",     phase: "finished" }, // 2-1, 88' winner
  { id: 18179763, home: "Portugal",  away: "Croatia",     phase: "finished" }, // 2-1, Ronaldo + 90' Ramos
  { id: 18175918, home: "Argentina", away: "Cape Verde",  phase: "finished" }, // 111' own goal in ET
];

const scoresFile = (id) => join(SIM_DIR, `${id}-scores.jsonl`);
const oddsFile = (id) => join(SIM_DIR, `${id}-odds.json`);

// ---------------------------------------------------------------------------
export class TxSim extends TxLive {
  constructor(opts) {
    super(opts);
    this.speed = Math.max(0.1, Number(process.env.SIM_SPEED || 1));
    this.matches = new Map(); // id -> { cfg, msgs, cursor, zero, simKickoff }
  }

  // Never talks to the network: everything comes from data/sim/.
  async start() {
    if (this.running) return;
    this.running = true;
    this.simStart = Date.now();
    this.meta = new Map();
    for (const cfg of DEMO_MATCHES) {
      if (!existsSync(scoresFile(cfg.id))) {
        this.onStatus({ state: "sim_missing_data", fixtureId: cfg.id });
        continue;
      }
      const msgs = loadTimeline(cfg.id);
      if (!msgs.length) continue;
      // zero = real kickoff. Historical scores keep GameState="scheduled" for
      // the whole match (API quirk); the live phase is in StatusId (>1 once
      // play starts) and Clock.Running. Anchor on the first in-play message.
      const kick = msgs.find((x) => x.stream === "scores" && ((x.msg.StatusId ?? 1) > 1 || x.msg.Clock?.Running));
      const zero = kick?.ts ?? msgs.find((x) => x.stream === "scores")?.ts ?? msgs[0].ts;
      const offsetMs = (cfg.offsetMin || 0) * 60000;
      const startsInMs = (cfg.startsInMin || 0) * 60000;
      // startTime shown on upcoming cards = simulated kickoff wall-clock
      const simKickoff = cfg.phase === "upcoming" ? this.simStart + startsInMs
        : cfg.phase === "live" ? this.simStart - offsetMs / this.speed
        : this.simStart - 3 * 3600000;
      this.meta.set(cfg.id, {
        home: cfg.home, away: cfg.away,
        competition: "FIFA World Cup 2026",
        startTime: new Date(simKickoff).toISOString(),
        demoPhase: cfg.phase,
      });
      this.matches.set(cfg.id, { cfg, msgs, cursor: 0, zero, offsetMs, startsInMs });
    }
    this.onStatus({ state: "sim_started", fixtures: this.matches.size, speed: this.speed });

    // Backlog replay: establish current state silently (no fan notifications).
    for (const m of this.matches.values()) this.drain(m, this.horizon(m), true);

    // Scheduled emission: one 250ms tick drives all matches.
    this.timer = setInterval(() => {
      for (const m of this.matches.values()) this.drain(m, this.horizon(m), false);
    }, 250);
  }

  // How far into each match's own timeline (ms relative to its zero) we are now.
  horizon(m) {
    const elapsed = (Date.now() - this.simStart) * this.speed;
    if (m.cfg.phase === "finished") return Infinity;
    if (m.cfg.phase === "upcoming") return elapsed - m.startsInMs; // negative until kickoff
    return m.offsetMs + elapsed; // live
  }

  // Emit every message whose relative time <= horizon. During catchup the
  // message objects carry catchup=true so the dispatcher builds state quietly.
  drain(m, horizonMs, catchup) {
    while (m.cursor < m.msgs.length) {
      const { ts, stream, msg } = m.msgs[m.cursor];
      const rel = ts - m.zero;
      // pre-match messages (rel < 0) always replay immediately; the kick-off
      // itself (rel = 0) must wait for its scheduled horizon
      if (rel >= 0 && rel > horizonMs) break;
      m.cursor++;
      if (stream === "odds") this.handleOdds({ ...msg, __catchup: catchup });
      else this.handleScore({ ...msg, __catchup: catchup });
    }
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.onStatus({ state: "stopped" });
  }

  // Demo phase for menus (live/upcoming/finished as of *simulated* now).
  phaseOf(fixtureId) { return this.matches.get(fixtureId)?.cfg.phase || null; }

  // Demo clock control: change speed without jumping the timeline — the
  // elapsed simulated time is preserved by rebasing simStart.
  setSpeed(newSpeed) {
    newSpeed = Math.min(20, Math.max(1, Number(newSpeed) || 1));
    const scaled = (Date.now() - this.simStart) * this.speed;
    this.speed = newSpeed;
    this.simStart = Date.now() - scaled / newSpeed;
    // upcoming kick-off wall-clock times shift with the new speed
    for (const [id, m] of this.matches) {
      if (m.cfg.phase !== "upcoming") continue;
      const meta = this.meta.get(id);
      if (meta) meta.startTime = new Date(Date.now() + Math.max(0, m.startsInMs - scaled) / newSpeed).toISOString();
    }
    this.onStatus({ state: "sim_speed", speed: newSpeed });
    return newSpeed;
  }
}

// Propagate the catchup flag through TxLive's normalised events.
const origHandleScore = TxLive.prototype.handleScore;
TxSim.prototype.handleScore = function (m) {
  const catchup = !!m.__catchup;
  const onScore = this.onScore;
  this.onScore = (ev) => onScore({ ...ev, catchup });
  try { origHandleScore.call(this, m); } finally { this.onScore = onScore; }
};
const origHandleOdds = TxLive.prototype.handleOdds;
TxSim.prototype.handleOdds = function (m) {
  const catchup = !!m.__catchup;
  const onOdds = this.onOdds;
  this.onOdds = (ev) => onOdds({ ...ev, catchup });
  try { origHandleOdds.call(this, m); } finally { this.onOdds = onOdds; }
};

// ---------------------------------------------------------------------------
// Timeline loading: merge scores (jsonl) + odds (json array), sort by Ts.
function loadTimeline(id) {
  const out = [];
  for (const line of readFileSync(scoresFile(id), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); out.push({ ts: m.Ts, stream: "scores", msg: m }); } catch {}
  }
  if (existsSync(oddsFile(id))) {
    try {
      for (const m of JSON.parse(readFileSync(oddsFile(id), "utf8"))) {
        if (m && m.Ts) out.push({ ts: m.Ts, stream: "odds", msg: m });
      }
    } catch {}
  }
  return out.filter((x) => x.ts).sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------------------
// CLI fetch: download authentic TxLINE data for the 14 matches (run on VPS).
async function fetchDemoData() {
  mkdirSync(SIM_DIR, { recursive: true });
  const creds = JSON.parse(readFileSync(join(__dirname, "data", "txline-credentials.json"), "utf8"));
  const jwtRes = await fetch(`${creds.api}/auth/guest/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const jwt = (await jwtRes.json()).token;
  const headers = { Authorization: `Bearer ${jwt}`, "X-Api-Token": creds.apiToken };

  for (const { id, home, away } of DEMO_MATCHES) {
    // scores/historical returns SSE-format text: "data: {...}" lines
    const sr = await fetch(`${creds.api}/api/scores/historical/${id}`, { headers });
    if (!sr.ok) { console.log(`[fetch] ${id} scores → ${sr.status}`); continue; }
    const lines = (await sr.text()).split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    writeFileSync(scoresFile(id), lines.join("\n") + "\n");

    const or = await fetch(`${creds.api}/api/odds/updates/${id}`, { headers });
    if (or.ok) {
      const body = await or.json();
      const arr = Array.isArray(body) ? body : body.updates || body.data || [];
      writeFileSync(oddsFile(id), JSON.stringify(arr));
      console.log(`[fetch] ${id} ${home}-${away}: ${lines.length} score msgs, ${arr.length} odds ticks`);
    } else {
      console.log(`[fetch] ${id} ${home}-${away}: ${lines.length} score msgs, odds → ${or.status}`);
    }
  }
  console.log("[fetch] done →", SIM_DIR);
}

if (process.argv[2] === "fetch") fetchDemoData().catch((e) => { console.error(e); process.exit(1); });
