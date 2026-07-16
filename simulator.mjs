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
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from "fs";
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
  // (Brazil-Norway was dropped: its stream carries a broken early fragment —
  // phantom goal + spurious game_finalised. Replaced by Paraguay-France.)
  { id: 18188721, home: "Paraguay",  away: "France",      phase: "live", offsetMin: 55 }, // Mbappé winner 70'
  // (Belgium-Senegal dropped July 15: the API stopped serving its history.)
  { id: 18179551, home: "Spain",     away: "Austria",     phase: "live", offsetMin: 25 }, // Oyarzabal double, 3-0
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

// Reserve fixtures with verified API history — cached as insurance because
// the hackathon feed is already dropping fixtures ahead of the July 19 cut.
export const RESERVE_IDS = [18179549, 18179552, 18185036, 18175918, 18176123, 18202783];

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
      // kickIdx = first message of the match itself (personal playback start)
      const kickIdx = Math.max(0, msgs.findIndex((x) => x.ts >= zero));
      this.matches.set(cfg.id, { cfg, msgs, cursor: 0, zero, offsetMs, startsInMs, kickIdx });
    }
    this.onStatus({ state: "sim_started", fixtures: this.matches.size });

    // FROZEN WORLD: drain every match to its anchor once (silently), then
    // stop. Live matches stay at their anchor minute forever; a fan who opens
    // one gets a personal playback session from that exact point (server-side).
    for (const m of this.matches.values()) this.drain(m, this.anchor(m), true);
  }

  // Anchor point of each match in its own timeline (ms relative to zero).
  anchor(m) {
    if (m.cfg.phase === "finished") return Infinity;
    if (m.cfg.phase === "upcoming") return -1; // pre-match only
    return m.offsetMs; // live: frozen mid-match
  }

  // Authentic market by match-minute: every in-running 1X2 tick (price +
  // demargined percents) indexed to minutes since kick-off. Powers the odds
  // shown on each event card when the match is driven from the play-by-play.
  oddsByMinute(fixtureId) {
    const m = this.matches.get(Number(fixtureId));
    if (!m) return [];
    const out = [];
    for (const { ts, stream, msg } of m.msgs) {
      if (stream !== "odds") continue;
      if (msg.SuperOddsType !== "1X2_PARTICIPANT_RESULT" || msg.MarketPeriod || !Array.isArray(msg.Prices) || msg.Prices.length !== 3) continue;
      const min = Math.round((ts - m.zero) / 60000);
      const odds = { home: +(msg.Prices[0] / 1000).toFixed(2), draw: +(msg.Prices[1] / 1000).toFixed(2), away: +(msg.Prices[2] / 1000).toFixed(2) };
      let probs = null;
      if (Array.isArray(msg.Pct) && msg.Pct.length === 3) {
        const p = msg.Pct.map(Number), s = p[0] + p[1] + p[2];
        if (s > 0) probs = { home: p[0] / s, draw: p[1] / s, away: p[2] / s };
      }
      out.push({ min, odds, probs });
    }
    return out;
  }

  // Personal playback source: the whole match from its own kick-off.
  // finalIdx guards against spurious mid-stream game_finalised messages:
  // only the LAST one truly ends the match.
  timelineOf(fixtureId) {
    const m = this.matches.get(Number(fixtureId));
    if (!m) return null;
    if (m.finalIdx === undefined) {
      m.finalIdx = m.msgs.findLastIndex((x) => x.stream === "scores" && x.msg.StatusId === 100);
    }
    return { msgs: m.msgs, cursor: m.kickIdx, zero: m.zero, finalIdx: m.finalIdx };
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
    this.onStatus({ state: "stopped" });
  }

  // Static section of each match — the frozen world never reclassifies.
  phaseOf(fixtureId) { return this.matches.get(Number(fixtureId))?.cfg.phase || null; }
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

  // The hackathon feed dies July 19 and already returns empty for some
  // fixtures — NEVER overwrite a good local cache with a worse response.
  const sizeOf = (f) => { try { return statSync(f).size; } catch { return 0; } };
  const targets = [...DEMO_MATCHES, ...RESERVE_IDS.map((id) => ({ id, home: `reserve`, away: id }))];
  for (const { id, home, away } of targets) {
    // scores/historical returns SSE-format text: "data: {...}" lines
    const sr = await fetch(`${creds.api}/api/scores/historical/${id}`, { headers });
    if (!sr.ok) { console.log(`[fetch] ${id} scores → ${sr.status} (cache kept)`); continue; }
    const lines = (await sr.text()).split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const payload = lines.join("\n") + "\n";
    if (payload.length >= sizeOf(scoresFile(id))) writeFileSync(scoresFile(id), payload);
    else console.log(`[fetch] ${id} scores response smaller than cache — kept cache`);

    const or = await fetch(`${creds.api}/api/odds/updates/${id}`, { headers });
    if (or.ok) {
      const body = await or.json();
      const arr = Array.isArray(body) ? body : body.updates || body.data || [];
      const oddsPayload = JSON.stringify(arr);
      if (oddsPayload.length >= sizeOf(oddsFile(id))) writeFileSync(oddsFile(id), oddsPayload);
      console.log(`[fetch] ${id} ${home}-${away}: ${lines.length} score msgs, ${arr.length} odds ticks`);
    } else {
      console.log(`[fetch] ${id} ${home}-${away}: ${lines.length} score msgs, odds → ${or.status} (cache kept)`);
    }
  }
  console.log("[fetch] done →", SIM_DIR);
}

if (process.argv[2] === "fetch") fetchDemoData().catch((e) => { console.error(e); process.exit(1); });
