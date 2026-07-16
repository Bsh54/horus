// ProofDesk — Verifiable sports trading terminal & agent
// Backend: match replay engine + rule-based agent + hash-chained proof journal.
// TxLINE live connector plugs in via env (TXLINE_API_BASE / TXLINE_JWT / TXLINE_API_TOKEN).

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { createHash, randomUUID } from "crypto";
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "fs";
import { gzipSync, gunzipSync } from "zlib";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { TxLive } from "./txline-live.mjs";
import { TxSim, DEMO_MATCHES } from "./simulator.mjs";
import * as i18n from "./i18n.mjs";
import * as users from "./users.mjs";
import { verifySummary } from "./proofs.mjs";
import { createAgent, DEFAULT_CONFIG as AGENT_DEFAULTS } from "./agent.mjs";
import { createBot } from "./bot.mjs";
import { createHorus } from "./horus.mjs";
import { createBank } from "./bank.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8088;
const DATA_DIR = join(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. MATCH SIMULATOR / REPLAY ENGINE ("le guetteur")
//    Deterministic seeded match generator -> same seed = same match = same
//    agent decisions = verifiable, reproducible demo.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAMS = [
  ["France", "Brazil"], ["Argentina", "Germany"], ["Spain", "England"],
  ["Portugal", "Netherlands"], ["Morocco", "Japan"], ["USA", "Mexico"],
];

// Generates a full 90-min match timeline: odds ticks (every ~30s of match
// time) + events (goals, cards, VAR, corners, shots).
export function generateMatch(seed) {
  const rnd = mulberry32(seed);
  const [home, away] = TEAMS[seed % TEAMS.length];
  const strength = 0.35 + rnd() * 0.3; // home win base probability
  let pHome = strength, pDraw = 0.28, pAway = 1 - strength - 0.28;
  let scoreH = 0, scoreA = 0;
  const timeline = [];

  const pushOdds = (min) => {
    const norm = pHome + pDraw + pAway;
    const margin = 1.06; // bookmaker overround
    timeline.push({
      type: "odds", minute: min,
      home: +(norm / (pHome * margin)).toFixed(2),
      draw: +(norm / (pDraw * margin)).toFixed(2),
      away: +(norm / (pAway * margin)).toFixed(2),
    });
  };

  pushOdds(0);
  for (let min = 1; min <= 90; min++) {
    // random drift
    const drift = (rnd() - 0.5) * 0.012;
    pHome = Math.max(0.03, pHome + drift);
    pAway = Math.max(0.03, pAway - drift * 0.6);

    const r = rnd();
    if (r < 0.028) { // goal ~2.5 per match
      const isHome = rnd() < pHome / (pHome + pAway);
      if (isHome) { scoreH++; pHome = Math.min(0.92, pHome + 0.18); pAway = Math.max(0.02, pAway - 0.12); }
      else { scoreA++; pAway = Math.min(0.92, pAway + 0.18); pHome = Math.max(0.02, pHome - 0.12); }
      pDraw = Math.max(0.04, 1 - pHome - pAway);
      timeline.push({ type: "goal", minute: min, team: isHome ? home : away, score: `${scoreH}-${scoreA}` });
      // VAR check on some goals
      if (rnd() < 0.18) {
        timeline.push({ type: "var", minute: min, review: "Goal" });
        if (rnd() < 0.35) { // overturned!
          if (isHome) { scoreH--; pHome = Math.max(0.05, pHome - 0.15); } else { scoreA--; pAway = Math.max(0.05, pAway - 0.15); }
          timeline.push({ type: "var_end", minute: min, outcome: "Overturned", score: `${scoreH}-${scoreA}` });
        } else {
          timeline.push({ type: "var_end", minute: min, outcome: "Stands" });
        }
      }
    } else if (r < 0.05) {
      timeline.push({ type: "shot", minute: min, team: rnd() < 0.5 ? home : away, outcome: rnd() < 0.4 ? "OnTarget" : "OffTarget" });
    } else if (r < 0.07) {
      timeline.push({ type: "corner", minute: min, team: rnd() < 0.5 ? home : away });
    } else if (r < 0.082) {
      const red = rnd() < 0.12;
      const isHome = rnd() < 0.5;
      timeline.push({ type: "card", minute: min, card: red ? "red" : "yellow", team: isHome ? home : away });
      if (red) { if (isHome) { pHome = Math.max(0.03, pHome - 0.14); pAway += 0.1; } else { pAway = Math.max(0.03, pAway - 0.14); pHome += 0.1; } }
    }
    if (min % 1 === 0) pushOdds(min);
  }
  timeline.push({ type: "full_time", minute: 90, score: `${scoreH}-${scoreA}`, winner: scoreH > scoreA ? home : scoreA > scoreH ? away : "draw" });
  return { seed, home, away, timeline };
}

// ---------------------------------------------------------------------------
// 2. PROOF JOURNAL ("le notaire") — hash-chained, append-only decision log.
//    Each record embeds sha256(prev) -> tamper-evident chain.
//    anchorTx: reserved for Solana devnet anchoring (wired at J3).
// ---------------------------------------------------------------------------

const JOURNAL_FILE = join(DATA_DIR, "journal.jsonl");
let lastHash = "GENESIS";
if (existsSync(JOURNAL_FILE)) {
  const lines = readFileSync(JOURNAL_FILE, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length) lastHash = JSON.parse(lines[lines.length - 1]).hash;
}

function journalAppend(record) {
  const body = { ...record, id: randomUUID(), ts: new Date().toISOString(), prevHash: lastHash };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const entry = { ...body, hash, anchorTx: null };
  appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + "\n");
  lastHash = hash;
  broadcast({ kind: "journal", entry });
  return entry;
}

function journalRead(limit = 200) {
  if (!existsSync(JOURNAL_FILE)) return [];
  const lines = readFileSync(JOURNAL_FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l));
}

function journalVerify() {
  const entries = journalRead(1e9);
  let prev = "GENESIS";
  for (const e of entries) {
    const { hash, anchorTx, ...body } = e;
    if (body.prevHash !== prev) return { ok: false, brokenAt: e.id, reason: "prevHash mismatch" };
    const recomputed = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (recomputed !== hash) return { ok: false, brokenAt: e.id, reason: "hash mismatch" };
    prev = hash;
  }
  return { ok: true, count: entries.length, head: prev };
}

// ---------------------------------------------------------------------------
// 2-bis. LIVE AUTONOMOUS AGENT — the production trading agent. Runs on the
// full TxLINE stream (every fixture), journals every decision through the
// hash chain, persists its book across restarts, needs no human input.
// ---------------------------------------------------------------------------

const AGENT_STATE_FILE = join(DATA_DIR, "agent-state.json");
const AGENT_CONFIG_FILE = join(DATA_DIR, "agent-config.json");
const agentConfig = existsSync(AGENT_CONFIG_FILE)
  ? { ...AGENT_DEFAULTS, ...JSON.parse(readFileSync(AGENT_CONFIG_FILE, "utf8")) }
  : AGENT_DEFAULTS;

const liveAgent = createAgent(agentConfig, {
  journal: (r) => journalAppend({ ...r, source: "live-agent" }),
  emit: (m) => {
    broadcast(m);
    // sharp-money alerts double as fan notifications through HORUS
    if (horus && m.action === "OPEN" && m.position?.rule === "STEAM") {
      horus.notifyFollowers(m.position.fixtureId, { kind: "steam", side: m.position.side, detail: m.position.trigger });
    }
  },
});

// restore the persisted book (bankroll, settled trades, equity curve)
if (existsSync(AGENT_STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(AGENT_STATE_FILE, "utf8"));
    liveAgent.state.bankroll = saved.bankroll ?? liveAgent.state.bankroll;
    liveAgent.state.closed = saved.closed || [];
    liveAgent.state.equity = saved.equity || liveAgent.state.equity;
    liveAgent.state.halted = saved.halted || false;
  } catch {}
}
setInterval(() => {
  try {
    writeFileSync(AGENT_STATE_FILE, JSON.stringify({
      bankroll: liveAgent.state.bankroll, closed: liveAgent.state.closed,
      equity: liveAgent.state.equity, halted: liveAgent.state.halted, savedAt: Date.now(),
    }));
  } catch {}
}, 30_000);

// ---------------------------------------------------------------------------
// 2-ter. HORUS — the Telegram pundit. The eye on every match: follows the
// full feed, notifies fans of goals / cards / sharp market moves with the
// market's read, speaks voice notes, replays archived matches, answers
// questions. Dormant until data/telegram.json provides a bot token.
// ---------------------------------------------------------------------------

let horus = null;
const chatLists = new Map(); // chatId -> last numbered match list

// catalog of every fixture ever listed by the feed (gen-catalog.mjs) — the
// replay library. Refreshed lazily on read.
const CATALOG_FILE = join(DATA_DIR, "fixtures-catalog.json");
let catalog = existsSync(CATALOG_FILE) ? JSON.parse(readFileSync(CATALOG_FILE, "utf8")) : [];
const catalogById = () => new Map(catalog.map((c) => [c.id, c]));

function metaOf(id) {
  if (sim) { const m = sim.metaFor(Number(id)); if (m) return m; } // demo world first
  const c = catalogById().get(Number(id));
  if (c) return { home: c.home, away: c.away, competition: c.competition, startTime: c.startTime };
  return live ? live.metaFor(Number(id)) : null;
}

function matchLabel(id) {
  const meta = metaOf(id);
  return meta ? `${meta.home} vs ${meta.away}` : `match ${id}`;
}

function hasArchive(id) {
  return existsSync(join(DATA_DIR, "history", `t1x2-${id}.json.gz`));
}

// Real match events (goals, cards, phases with minutes) decoded from the
// archived score states of a fixture. Fetched once, cached in history/.
async function scoreEventsFor(fid) {
  const file = join(DATA_DIR, "history", `sc-${fid}.json.gz`);
  let states = null;
  if (existsSync(file)) {
    states = JSON.parse(gunzipSync(readFileSync(file)).toString());
  } else {
    try {
      const creds = JSON.parse(readFileSync(join(DATA_DIR, "txline-credentials.json"), "utf8"));
      const jwt = (await (await fetch(creds.api + "/auth/guest/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).token;
      const H = { Authorization: `Bearer ${jwt}`, "X-Api-Token": creds.apiToken };
      const get = async (p) => {
        const r = await fetch(creds.api + p, { headers: H });
        const t = await r.text();
        return t.trim() ? JSON.parse(t) : [];
      };
      let rows = await get(`/api/scores/snapshot/${fid}`);
      if (!Array.isArray(rows)) rows = [];
      try {
        const hist = await get(`/api/scores/historical/${fid}`);
        if (Array.isArray(hist)) rows = rows.concat(hist);
      } catch {}
      rows.sort((a, b) => (a.Ts || 0) - (b.Ts || 0));
      states = rows;
      writeFileSync(file, gzipSync(JSON.stringify(rows)));
    } catch { states = []; }
  }
  // snapshot states can be duplicated or out of order — walk them defensively:
  // scores must be monotonic, never exceed the final score, phases fire once.
  const withStats = states.filter((m) => m && m.Stats);
  const finalScore = withStats.length ? decodeTxStats(withStats[withStats.length - 1].Stats).score : [99, 99];
  const evs = [];
  const phasesSeen = new Set();
  let prev = null;
  for (const m of withStats) {
    const d = decodeTxStats(m.Stats);
    const minute = m.Clock?.Seconds != null ? Math.floor(m.Clock.Seconds / 60) : null;
    const ts = m.Ts || 0;
    if (prev && (d.score[0] < prev.score[0] || d.score[1] < prev.score[1]
      || d.score[0] > finalScore[0] || d.score[1] > finalScore[1])) continue; // stale or phantom state
    if (prev) {
      for (const side of [0, 1]) {
        if (d.score[side] === prev.score[side] + 1) evs.push({ ts, kind: "goal", isHome: side === 0, minute, score: [...d.score] });
        if (d.yellow[side] > prev.yellow[side]) evs.push({ ts, kind: "yellow", isHome: side === 0, minute });
        if (d.red[side] > prev.red[side]) evs.push({ ts, kind: "red", isHome: side === 0, minute, score: [...d.score] });
        if (d.corners[side] === prev.corners[side] + 1) evs.push({ ts, kind: "corner", isHome: side === 0, minute });
      }
    }
    if (PHASES[m.StatusId] && !phasesSeen.has(m.StatusId)) {
      phasesSeen.add(m.StatusId);
      // phase lines carry the running stats picture (corners, cards)
      evs.push({ ts, kind: "phase", text: PHASES[m.StatusId], minute, score: [...d.score],
        stats: { corners: [...d.corners], yellow: [...d.yellow], red: [...d.red] } });
    }
    prev = { score: d.score, yellow: d.yellow, red: d.red, corners: d.corners };
  }
  return evs;
}

function liveContextFor(id) {
  const meta = live ? live.metaFor(id) : null;
  const st = scoreStates.get(id);
  const probs = liveAgent.state.fixtures.get(id)?.lastProbs;
  const odds = liveAgent.state.fixtures.get(id)?.lastOdds;
  const parts = [matchLabel(id)];
  const m2 = metaOf(id);
  if (m2?.startTime) parts.push(`kick-off: ${new Date(m2.startTime).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  if (st && Array.isArray(st.score) && st.score[0] != null)
    parts.push(`score ${st.score[0]}-${st.score[1]}, minute ${st.minute ?? "?"}, phase ${st.gameState || PHASES[st.statusId] || "scheduled"}, yellows ${(st.yellow || []).join("-")}, reds ${(st.red || []).join("-")}, corners ${(st.corners || []).join("-")}`);
  if (probs && meta && Number.isFinite(probs.home))
    parts.push(`win probabilities: ${meta.home} ${(probs.home * 100).toFixed(1)}%, draw ${(probs.draw * 100).toFixed(1)}%, ${meta.away} ${(probs.away * 100).toFixed(1)}%`);
  if (odds && Number.isFinite(odds.home)) parts.push(`odds 1X2: ${odds.home} / ${odds.draw} / ${odds.away}`);
  if (parts.length === (m2?.startTime ? 2 : 1)) parts.push("no live data for this match right now — it may be finished or not started yet");
  return parts.join("\n");
}

// Phase of a fixture as of *now* — identical logic for both worlds because
// the simulator drives scoreStates through the same pipeline.
function phaseOfFixture(id) {
  // roster-finished demo matches are final even if their stream ends without
  // a game_finalised message (some TxLINE histories stop mid-status)
  if (sim && sim.phaseOf(Number(id)) === "finished") return "finished";
  const st = scoreStates.get(Number(id));
  if (st?.statusId === 100 || st?.statusId === 10) return "finished";
  if (st?.statusId >= 2) return "live";
  const meta = metaOf(id);
  if (meta?.startTime && new Date(meta.startTime).getTime() > Date.now()) return "upcoming";
  if (st?.statusId === 1) return "upcoming";
  return "finished";
}

// The bot shows one world: the demo championship. The real TxLINE connector
// keeps running in the background (recordings, proofs, compliance) but the
// hackathon feed goes dark after July 19 — the demo must stand alone.
function allOfferedFixtures() {
  return sim ? sim.allFixtureIds().map(Number) : [];
}

const PHASE_UI = {
  live: { icon: "🔴", title: "Live now" },
  upcoming: { icon: "", title: "Upcoming" },
  finished: { icon: "", title: "Finished" },
};

async function sendPhaseChooser(bot, chatId) {
  const counts = { live: 0, upcoming: 0, finished: 0 };
  for (const id of allOfferedFixtures()) counts[phaseOfFixture(id)]++;
  const lang = users.langOf(chatId);
  const [tLive, tUp, tFin, tMatches] = await Promise.all([
    i18n.t("live_now", lang), i18n.t("upcoming", lang), i18n.t("finished", lang), i18n.translate("matches", lang),
  ]);
  // wide, breathing buttons: one full-width row per section
  const pad = (s) => `  ${s}  `;
  await bot.sendText(chatId, `<b>${await i18n.t("matches_menu", lang)}</b>\n\n${await i18n.translate("Pick a section:", lang)}`, {
    reply_markup: { inline_keyboard: [
      [{ text: pad(`🔴  ${tLive}  ·  ${counts.live} ${tMatches}`), callback_data: "phase:live" }],
      [{ text: pad(`${tUp}  ·  ${counts.upcoming} ${tMatches}`), callback_data: "phase:upcoming" }],
      [{ text: pad(`${tFin}  ·  ${counts.finished} ${tMatches}`), callback_data: "phase:finished" }],
    ] },
  });
}

const PAGE_SIZE = 10;
function rowLabel(id, phase) {
  const meta = metaOf(id) || { home: "Home", away: "Away" };
  const st = scoreStates.get(Number(id));
  if (phase === "live") {
    const sc = st?.score ? `${st.score[0]}-${st.score[1]}` : "vs";
    return `🔴 ${meta.home} ${sc} ${meta.away} · ${st?.minute ?? "?"}'`;
  }
  if (phase === "upcoming") {
    const when = meta.startTime ? new Date(meta.startTime).toISOString().slice(11, 16) + " UTC" : "";
    return `${meta.home} – ${meta.away} · ${when}`;
  }
  const sc = st?.score ? ` ${st.score[0]}-${st.score[1]} ` : " – ";
  return `${meta.home}${sc}${meta.away}`;
}

async function sendMatchesPage(bot, chatId, phase, page = 0, editMsgId = null) {
  const ids = allOfferedFixtures().filter((id) => phaseOfFixture(id) === phase);
  // live first by minute desc, upcoming by kickoff asc, finished newest first
  ids.sort((a, b) => {
    if (phase === "upcoming") return new Date(metaOf(a)?.startTime || 0) - new Date(metaOf(b)?.startTime || 0);
    return (scoreStates.get(Number(b))?.minute ?? 0) - (scoreStates.get(Number(a))?.minute ?? 0);
  });
  chatLists.set(String(chatId), ids); // keeps /follow N, /relive N, /verify N working
  if (!ids.length) {
    await sendT(bot, chatId, phase === "live" ? "Nothing is live right now — check 🕒 upcoming." : "Nothing here yet — try another section.");
    return;
  }
  const pages = Math.max(1, Math.ceil(ids.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const kb = ids.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    .map((id) => [{ text: rowLabel(id, phase), callback_data: `pick:${phase}:${id}` }]);
  const nav = [{ text: "« Sections", callback_data: "phase:menu" }];
  if (page > 0) nav.push({ text: "⬅️", callback_data: `pg:${phase}:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: "noop" });
  if (page < pages - 1) nav.push({ text: "➡️", callback_data: `pg:${phase}:${page + 1}` });
  kb.push(nav);
  // demo clock: the whole championship can be fast-forwarded (shared world)
  if (phase === "live" && sim) {
    kb.push([
      { text: sim.speed === 1 ? "· x1 ·" : "x1", callback_data: "clock:1" },
      { text: sim.speed === 5 ? "· x5 ·" : "x5", callback_data: "clock:5" },
      { text: sim.speed === 10 ? "· x10 ·" : "x10", callback_data: "clock:10" },
    ]);
  }
  const ui = PHASE_UI[phase];
  const text = `${ui.icon ? ui.icon + " " : ""}<b>${ui.title}</b> · ${ids.length}`;
  const extra = { reply_markup: { inline_keyboard: kb } };
  if (editMsgId) await bot.editText(chatId, editMsgId, text, extra); // paging edits in place
  else await bot.sendText(chatId, text, extra);
}

// Send a message in the user's language: any English text is translated on
// the fly (cached per text×lang in i18n, so hot paths cost nothing).
async function sendT(bot, chatId, text, extra = {}) {
  return bot.sendText(chatId, await i18n.translate(text, users.langOf(chatId)), extra);
}

// ---------------------------------------------------------------------------
// PERSONAL PLAYBACK — the frozen world executes on demand, per fan.
// Opening a live/upcoming match starts a private session from its anchor:
// the authentic TxLINE messages stream forward at the fan's own speed,
// producing pings and cards for that chat only.
// ---------------------------------------------------------------------------
const playbacks = new Map(); // chatId -> { stop, speed }

function stopSession(chatId) {
  const s = playbacks.get(String(chatId));
  if (s) s.stop = true;
  playbacks.delete(String(chatId));
}

// Pace choice, one dedicated step: x2, x5, then Normal — per his spec.
const PACE_LABEL = (n) => (n === 1 ? "Normal" : `x${n}`);
async function sendPaceChooser(bot, chatId, id) {
  const meta = metaOf(id) || { home: "Home", away: "Away" };
  await sendT(bot, chatId, `<b>${meta.home} vs ${meta.away}</b>\n\nChoose your pace:`, {
    reply_markup: { inline_keyboard: [[
      { text: "x2", callback_data: `watch:${id}:2` },
      { text: "x5", callback_data: `watch:${id}:5` },
      { text: "Normal", callback_data: `watch:${id}:1` },
    ]] },
  });
}

function sessionControls(speed) {
  const mark = (n) => (speed === n ? `· ${PACE_LABEL(n)} ·` : PACE_LABEL(n));
  return { inline_keyboard: [[
    { text: mark(2), callback_data: "spd:2" },
    { text: mark(5), callback_data: "spd:5" },
    { text: mark(1), callback_data: "spd:1" },
    { text: "⏹", callback_data: "spd:stop" },
  ]] };
}

async function runSession(bot, chatId, fid, speed = 5) {
  stopSession(chatId);
  const tl = sim ? sim.timelineOf(Number(fid)) : null;
  if (!tl) { await sendT(bot, chatId, "No playback data for this match."); return; }
  const sess = { stop: false, speed };
  playbacks.set(String(chatId), sess);
  const meta = metaOf(fid) || { home: "Home", away: "Away" };
  await sendT(bot, chatId, `<b>${meta.home} vs ${meta.away} — kick-off.</b>\nYour own match, at your own pace.`,
    { reply_markup: sessionControls(speed) });
  // the fan's match starts at 0-0, minute 0 — like every match should
  const st = blankMatchState();
  let probs = null, prevProbs = null, odds = null, prevTs = null;
  for (let i = tl.cursor; i < tl.msgs.length; i++) {
    const { ts, stream, msg } = tl.msgs[i];
    if (prevTs != null) {
      const wait = Math.min(20000, Math.max(0, (ts - prevTs) / sess.speed));
      if (wait > 30) await new Promise((r) => setTimeout(r, wait));
    }
    prevTs = ts;
    if (sess.stop) return;
    if (stream === "odds") {
      // the fan's market state: full-time 1X2, price AND demargined percents,
      // exactly as TxLINE streams them tick by tick
      if (msg.SuperOddsType === "1X2_PARTICIPANT_RESULT" && !msg.MarketPeriod && Array.isArray(msg.Prices) && msg.Prices.length === 3) {
        odds = { home: +(msg.Prices[0] / 1000).toFixed(2), draw: +(msg.Prices[1] / 1000).toFixed(2), away: +(msg.Prices[2] / 1000).toFixed(2) };
        if (Array.isArray(msg.Pct) && msg.Pct.length === 3) {
          const p = msg.Pct.map(Number), s = p[0] + p[1] + p[2];
          if (s > 0) { prevProbs = probs; probs = { home: p[0] / s, draw: p[1] / s, away: p[2] / s }; }
        }
      }
      continue;
    }
    const prev = { score: [...st.score], red: [...st.red], statusId: st.statusId };
    if (msg.Clock?.Seconds != null) st.minute = Math.floor(msg.Clock.Seconds / 60);
    if (msg.StatusId != null) st.statusId = msg.StatusId;
    if (msg.Seq) st.seq = msg.Seq;
    if (msg.Stats) {
      const d = decodeTxStats(msg.Stats);
      st.score = d.score; st.yellow = d.yellow; st.red = d.red; st.corners = d.corners;
    }
    const evs = [];
    if (st.score[0] > prev.score[0]) evs.push({ kind: "goal", isHome: true });
    if (st.score[1] > prev.score[1]) evs.push({ kind: "goal", isHome: false });
    if (st.red[0] > prev.red[0]) evs.push({ kind: "red", isHome: true });
    if (st.red[1] > prev.red[1]) evs.push({ kind: "red", isHome: false });
    if (st.yellow[0] > prev.yellow[0]) evs.push({ kind: "yellow", isHome: true });
    if (st.yellow[1] > prev.yellow[1]) evs.push({ kind: "yellow", isHome: false });
    if (st.corners[0] > prev.corners[0]) evs.push({ kind: "corner", isHome: true });
    if (st.corners[1] > prev.corners[1]) evs.push({ kind: "corner", isHome: false });
    if (st.statusId !== prev.statusId && PHASES[st.statusId]) evs.push({ kind: "period", text: PHASES[st.statusId] });
    for (const ev of evs) {
      await horus.personalEvent(chatId, Number(fid), meta, ev, { st, probs, prevProbs, odds }).catch((e) => console.log("[session]", e.message));
      if (sess.stop) return;
    }
    if (isFinalStatus(st.statusId)) break;
  }
  playbacks.delete(String(chatId));
  // settle this fan's position at their own final whistle
  if (bank && bank.hasOpenBet(chatId, fid)) {
    const [h, a] = st.score;
    await bank.settle(fid, h > a ? 0 : a > h ? 2 : 1, (cid, txt) => bot.sendText(cid, txt))
      .catch((e) => console.log("[bank] settle error:", e.message));
  }
}


async function sendPlanPortal(bot, chatId) {
  const lang = users.langOf(chatId);
  const [title, free, premium] = await Promise.all([
    i18n.t("choose_plan", lang), i18n.t("plan_free", lang), i18n.t("plan_premium", lang),
  ]);
  await bot.sendText(chatId, `<b>${title}</b>\n\n${free}\n\n${premium}`, {
    reply_markup: { inline_keyboard: [[
      { text: "Free", callback_data: "plan:free" },
      { text: "Premium — 0.1 SOL", callback_data: "plan:premium" },
    ]] },
  });
}

async function botCommand({ chatId, text, from, bot, msgId, isCallback }) {
  const name = from.first_name || from.username || "fan";
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");
  const user = users.getUser(chatId, from);

  // ---- onboarding callbacks (language picker, plan portal) ----
  if (text.startsWith("langpage:")) {
    await bot.editText(chatId, msgId, i18n.STRINGS.pick_language, { reply_markup: i18n.languageKeyboard(Number(text.split(":")[1])) });
    return;
  }
  if (text.startsWith("lang:")) {
    const code = text.split(":")[1];
    if (i18n.isValidLang(code)) {
      users.setLang(chatId, code);
      i18n.warmLanguage(code).catch(() => {}); // instantaneity: pre-cache UI strings
      await bot.editText(chatId, msgId, `${await i18n.t("language_saved", code)} ${i18n.langName(code)}.`);
      if (!user.plan) await sendPlanPortal(bot, chatId);
    }
    return;
  }
  if (text.startsWith("plan:")) {
    const plan = text.split(":")[1];
    if (plan === "free") {
      users.setPlan(chatId, "free");
      await botCommand({ chatId, text: "/start", from, bot });
    } else if (plan === "premium") {
      if (!bank) { await sendT(bot, chatId, "The bank is offline right now — try again in a moment."); return; }
      await sendT(bot, chatId, "⏳ Processing your 0.1 SOL payment on Solana devnet…");
      try {
        const sig = await bank.pay(chatId, users.PREMIUM_SOL, "premium");
        users.setPlan(chatId, "premium", sig);
        const done = await i18n.t("payment_received", users.langOf(chatId));
        await bot.sendText(chatId,
          `<b>${done}</b>\n\n` +
          `<a href="${bank.explorer(sig)}">View the transaction on Solana Explorer</a>\n\n` +
          `${await i18n.translate("Next: /matches to pick your first match.", users.langOf(chatId))}`);
      } catch (e) {
        // devnet faucet dry / house wallet lean: never block onboarding on
        // test-network liquidity — activate now, collect when it refills
        console.log("[premium] payment failed:", e.message);
        users.setPlan(chatId, "premium", null);
        await sendT(bot, chatId,
          `<b>Premium activated.</b>\n\n` +
          `The Solana devnet faucet is dry right now, so your 0.1 SOL payment is deferred — it will be collected on-chain when the test network refills.\n\n` +
          `Next: /matches to pick your first match.`);
      }
    }
    return;
  }

  // first contact: language first, everything else flows from it
  if (!user.lang && !text.startsWith("/language")) {
    await bot.sendText(chatId, `<b>${i18n.STRINGS.welcome}</b>\n\n${i18n.STRINGS.pick_language}`, { reply_markup: i18n.languageKeyboard(0) });
    return;
  }
  if (user.lang && !user.plan && !isCallback && text.startsWith("/") && !text.startsWith("/language")) {
    await sendPlanPortal(bot, chatId);
    return;
  }
  const listMatches = () => {
    // every catalogued match that has a watchable archive, newest first
    const rows = catalog.filter((c) => hasArchive(c.id)).map((c) => ({ id: c.id, meta: c }));
    chatLists.set(String(chatId), rows.map((r) => r.id));
    return rows;
  };
  switch ((cmd || "").toLowerCase()) {
    case "/start":
    case "/help":
      await sendT(bot, chatId,
        `<b>I'm HORUS.</b>\n` +
        `Live World Cup coverage with the betting market's read.\n\n` +
        `<b>Guide</b>\n\n` +
        `/matches — browse matches: live, upcoming or finished\n\n` +
        `/ask — ask me anything about a live match\n\n` +
        `/verify — prove a score against the Solana on-chain record\n\n` +
        `/wallet — your devnet SOL balance and bets\n\n` +
        `/plan — your plan and the on-chain upgrade\n\n` +
        `/language — change language\n\n` +
        `<i>Live and upcoming matches: follow them and take a position before kick-off. Finished matches: tap for the recap card and the story of the match.</i>`);
      break;
    case "/ask": {
      if (!arg) { await sendT(bot, chatId, "Ask me anything about the live matches: /ask who is winning?"); break; }
      const quota = users.useAiQuestion(chatId);
      if (!quota.ok) { await bot.sendText(chatId, await i18n.t("quota_reached", users.langOf(chatId))); break; }
      // grounded context: every fixture with known state, score + probabilities
      const lines = [];
      for (const [fid, st] of scoreStates) {
        const meta = metaOf(fid);
        if (!meta || !st.score) continue;
        const p = liveAgent.state.fixtures.get(fid)?.lastProbs;
        lines.push(`${meta.home} ${st.score[0]}-${st.score[1]} ${meta.away} | ${PHASES[st.statusId] || "?"} | min ${st.minute ?? "?"}` +
          (p ? ` | win% H ${(p.home * 100).toFixed(0)} D ${(p.draw * 100).toFixed(0)} A ${(p.away * 100).toFixed(0)}` : ""));
      }
      if (!lines.length) { await sendT(bot, chatId, "No live data on the feed right now — try again during a match."); break; }
      const lang = users.langOf(chatId);
      const answer = await horus.ask(arg, lines.slice(0, 20).join("\n"), lang, i18n.llmSpeaks(lang));
      if (answer) {
        const left = quota.left === Infinity ? "" : `\n\n<i>${quota.left}/${users.FREE_AI_PER_DAY}</i>`;
        await bot.sendText(chatId, `${answer}${left}`);
      } else await sendT(bot, chatId, "My analysis engine is busy — try again in a moment.");
      break;
    }
    case "/verify": {
      // prove a match's stats against the TxLINE Merkle root anchored on Solana
      const rows = chatLists.get(String(chatId)) || listMatches().map((r) => r.id);
      const id = rows[parseInt(arg, 10) - 1];
      const st = id ? scoreStates.get(Number(id)) : null;
      if (!id || !st?.seq) { await sendT(bot, chatId, "Do /matches first, then /verify N — I'll prove that match's stats on-chain."); break; }
      await sendT(bot, chatId, "Fetching the Merkle proof from TxLINE…");
      try {
        const v = await verifySummary(Number(id), st.seq);
        const meta = metaOf(id) || { home: "Home", away: "Away" };
        const ok = v.parts.filter((p) => !p.error);
        const lines = ok.map((p) => `• ${p.name}: <b>${JSON.stringify(p.value)}</b> — ${p.proofNodes} proof nodes`);
        await bot.sendText(chatId,
          `<b>${meta.home} ${st.score?.[0] ?? ""}-${st.score?.[1] ?? ""} ${meta.away}</b> — ${await i18n.t("verified_onchain", users.langOf(chatId))}\n\n` +
          `${lines.join("\n")}\n\n` +
          `Merkle root: <code>${(v.root || "").slice(0, 16)}…${(v.root || "").slice(-8)}</code>\n` +
          `seq ${v.seq} · TxLINE program <code>6pW64gN1s...yP2J</code> (Solana devnet)\n` +
          `Anyone can replay this proof against the on-chain root — HORUS can't invent a score.`);
      } catch (e) {
        console.log("[verify]", e.message);
        await sendT(bot, chatId, "Proof service unreachable right now — try again in a moment.");
      }
      break;
    }
    case "/language":
      await bot.sendText(chatId, await i18n.t("change_language", users.langOf(chatId)), { reply_markup: i18n.languageKeyboard(0) });
      break;
    case "/plan":
      if (users.isPremium(chatId)) await sendT(bot, chatId, "⭐ You're on <b>PREMIUM</b> — visual cards, unlimited AI, sharp-money alerts. Enjoy.");
      else await sendPlanPortal(bot, chatId);
      break;
    case "/matches":
      await sendPhaseChooser(bot, chatId);
      break;
    case "/follow": {
      const rows = chatLists.get(String(chatId)) || listMatches().map((r) => r.id);
      const id = rows[parseInt(arg, 10) - 1];
      if (!id) { await bot.sendText(chatId, "Do /matches first, then /follow N (the number in the list)."); break; }
      bot.subscribe(chatId, id, name);
      await bot.sendText(chatId, `<b>Following ${matchLabel(id)}.</b>\nGoals, cards and significant market moves as they happen.`);
      break;
    }
    case "/followall":
      bot.subscribe(chatId, "all", name);
      await bot.sendText(chatId, "<b>Following every match on the feed.</b>\nYou'll be notified when something matters.");
      break;
    case "/unfollow":
      bot.unsubscribe(chatId);
      await bot.sendText(chatId, "Alerts off. /matches whenever you want back in.");
      break;
    case "/live": {
      const subs = bot.subs.get(String(chatId));
      const ids = subs ? (subs.follows[0] === "all" ? allOfferedFixtures() : subs.follows) : [];
      const active = ids.filter((id) => scoreStates.get(Number(id))?.statusId && !isFinalStatus(scoreStates.get(Number(id)).statusId));
      const shown = (active.length ? active : ids).slice(0, 5);
      if (!shown.length) { await bot.sendText(chatId, "You're not following anything yet. /matches to pick one."); break; }
      for (const id of shown) await bot.sendText(chatId, liveContextFor(Number(id)));
      break;
    }
    case "/relive":
    case "/watch": {
      // recap of a finished match by list number
      const rows = chatLists.get(String(chatId)) || allOfferedFixtures();
      const id = rows[parseInt(arg, 10) - 1];
      if (!id) { await botCommand({ chatId, text: "/matches", from, bot }); break; }
      await horus.recap(chatId, Number(id), metaOf(id) || { home: "Home", away: "Away" }, sim?.timelineOf(Number(id))?.zero ?? null);
      break;
    }
    case "/wallet": {
      if (!bank) { await bot.sendText(chatId, "The bank is offline right now."); break; }
      try {
        const w = await bank.balanceOf(chatId);
        const mine = bank.betsOf(chatId);
        const lines = mine.slice(-5).map((b) =>
          `${b.settled ? (b.won ? "✅" : "❌") : "⏳"} ${b.sideName} @ ${b.odds} — ${b.stake} SOL${b.won && b.payout ? ` → ${b.payout} SOL` : ""}`);
        await bot.sendText(chatId,
          `<b>Your wallet</b> (Solana devnet)\n<code>${w.pub}</code>\nBalance: <b>${w.sol.toFixed(4)} SOL</b>${lines.length ? "\n\n<b>Bets</b>\n" + lines.join("\n") : "\n\nNo bets yet — pick a match and take on the market."}`);
      } catch (e) { console.log("[bank] wallet failed:", e.message); await bot.sendText(chatId, "Couldn't reach Solana devnet — try again in a moment."); }
      break;
    }
    default:
      if (text === "phase:menu") { await sendPhaseChooser(bot, chatId); break; }
      if (text.startsWith("phase:")) { // section chosen: live / upcoming / finished
        await sendMatchesPage(bot, chatId, text.split(":")[1], 0, isCallback ? msgId : null);
        break;
      }
      if (text.startsWith("pg:")) { // pagination — edit the list bubble in place
        const [, phase, pg] = text.split(":");
        await sendMatchesPage(bot, chatId, phase, Number(pg), isCallback ? msgId : null);
        break;
      }
      if (text.startsWith("pick:")) { // match tapped: action depends on its phase
        const [, phase, idRaw] = text.split(":");
        const id = Number(idRaw ?? phase);
        const realPhase = idRaw ? phase : phaseOfFixture(id);
        if (realPhase === "finished") {
          // one recap card + the line-by-line story — nothing to wait for
          await horus.recap(chatId, Number(id), metaOf(id) || { home: "Home", away: "Away" }, sim?.timelineOf(Number(id))?.zero ?? null);
          break;
        }
        const meta = metaOf(id) || { home: "Home", away: "Away" };
        const odds = (sim && sim.oddsFor(Number(id))) || (live && live.oddsFor(Number(id))) || null;
        if (realPhase === "upcoming") {
          // one announcement card — kick-off time, crests, pre-match odds.
          // No playback here: the match hasn't started.
          await horus.announceUpcoming(chatId, Number(id), meta, odds);
          if (bank && odds && !bank.hasOpenBet(chatId, id)) {
            await sendT(bot, chatId, `<b>Take a position before kick-off?</b>\nStake ${bank.STAKE_SOL} SOL (devnet).`,
              { reply_markup: { inline_keyboard: [[
                { text: `${meta.home} @ ${odds.home}`, callback_data: `bet:${id}:0` },
                { text: `Draw @ ${odds.draw}`, callback_data: `bet:${id}:1` },
                { text: `${meta.away} @ ${odds.away}`, callback_data: `bet:${id}:2` },
              ]] } });
          }
          break;
        }
        // live: one step at a time — 1. the match, 2. the position, 3. the pace
        if (bank && odds && !bank.hasOpenBet(chatId, id)) {
          await sendT(bot, chatId,
            `<b>${meta.home} vs ${meta.away}</b>\n\n` +
            `Take a position before kick-off?\n` +
            `Stake ${bank.STAKE_SOL} SOL (devnet), settled at your final whistle.`,
            { reply_markup: { inline_keyboard: [[
              { text: `${meta.home} @ ${odds.home}`, callback_data: `bet:${id}:0` },
              { text: `Draw @ ${odds.draw}`, callback_data: `bet:${id}:1` },
              { text: `${meta.away} @ ${odds.away}`, callback_data: `bet:${id}:2` },
            ], [
              { text: "No bet", callback_data: `nobet:${id}` },
            ]] } });
        } else {
          await sendPaceChooser(bot, chatId, id);
        }
        break;
      }
      if (text === "noop") break;
      if (text.startsWith("nobet:")) { // no position — straight to the pace step
        await sendPaceChooser(bot, chatId, Number(text.split(":")[1]));
        break;
      }
      if (text.startsWith("watch:")) { // pace chosen — the fan's match kicks off
        const [, fid, sp] = text.split(":");
        await runSession(bot, chatId, Number(fid), Number(sp) || 1);
        break;
      }
      if (text.startsWith("spd:")) { // personal playback controls
        const v = text.split(":")[1];
        const sess = playbacks.get(String(chatId));
        if (!sess) { await sendT(bot, chatId, "No match playing — /matches to open one."); break; }
        if (v === "stop") { stopSession(chatId); await sendT(bot, chatId, "Stopped. /matches when you want back in."); break; }
        sess.speed = Math.min(20, Math.max(1, Number(v) || 1));
        if (isCallback) await bot.call("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: sessionControls(sess.speed) });
        break;
      }
      if (text.startsWith("bet:")) { // side tapped on the betting keyboard
        const [, fid, side] = text.split(":");
        if (!bank) { await bot.sendText(chatId, "The bank is offline right now."); break; }
        if (bank.hasOpenBet(chatId, fid)) { await bot.sendText(chatId, "You already have a position on this match — one bet per match."); break; }
        const meta = metaOf(fid) || { home: "Home", away: "Away" };
        const odds = (sim && sim.oddsFor(Number(fid))) || (live && live.oddsFor(Number(fid))) || horus.preMatchOdds(Number(fid));
        if (!odds) { await bot.sendText(chatId, "No odds available for this match."); break; }
        const sideName = [meta.home, "Draw", meta.away][+side];
        const taken = [odds.home, odds.draw, odds.away][+side];
        await bot.sendText(chatId, "Placing your stake on-chain…");
        try {
          const betRec = await bank.placeBet(chatId, fid, +side, sideName, taken);
          await bot.sendText(chatId, betRec.txSig
            ? `<b>Position taken: ${sideName} @ ${taken}</b>\n\n${betRec.stake} SOL staked on Solana devnet — <a href="${bank.explorer(betRec.txSig)}">view the transaction</a>.\n<i>Settlement lands in your wallet at the final whistle.</i>`
            : `<b>Position taken: ${sideName} @ ${taken}</b>\n\n${betRec.stake} SOL — the devnet faucet is dry, so the on-chain transfer is deferred.\n<i>Settlement at the final whistle.</i>`);
          // live match: position taken — next step is the pace choice.
          // Upcoming matches just hold the position until kick-off.
          if (isDemoFixture(fid) && phaseOfFixture(fid) === "live") await sendPaceChooser(bot, chatId, Number(fid));
        } catch (e) {
          console.log("[bank] bet failed:", e.message);
          await bot.sendText(chatId, "Couldn't reach Solana devnet — try again in a moment.");
        }
        break;
      }
      if (text.startsWith("/")) await sendT(bot, chatId, "Unknown command — /start shows what I can do.");
      else await sendT(bot, chatId, "Pick a match to watch with /matches, or /live for the current picture.");
  }
}

const punditBot = createBot({ onCommand: botCommand });
horus = createHorus({
  bot: punditBot,
  journal: (r) => journalAppend({ ...r, source: "horus" }),
  getMeta: (id) => metaOf(id),
  getProbs: (id) => liveAgent.state.fixtures.get(id)?.lastProbs || null,
  getState: (id) => scoreStates.get(id) || null,
});

// devnet-SOL betting bank; the bot degrades gracefully if it can't start
let bank = null;
try { bank = createBank({ journal: (r) => journalAppend({ ...r, source: "bank" }) }); console.log("[bank] ready"); }
catch (e) { console.log("[bank] disabled:", e.message); }

// ---------------------------------------------------------------------------
// 3. RULE-BASED AGENT ("le trader") — paper-trading book.
// ---------------------------------------------------------------------------

const DEFAULT_RULES = [
  { id: "momentum-drop", desc: "Back a team if its odds shorten >12% within 5 min (market momentum)", threshold: 0.12, window: 5, stake: 50 },
  { id: "red-card-fade", desc: "Lay (bet against) a team that receives a red card", stake: 40 },
  { id: "late-equalizer-hunt", desc: "Back the draw if a team leads by 1 goal after minute 75 and concedes >2 corners in 5 min", stake: 30 },
];

function makeAgentState() {
  return { bankroll: 1000, openPositions: [], closedPositions: [], oddsHistory: [], rules: JSON.parse(JSON.stringify(DEFAULT_RULES)) };
}

function agentOnTick(session, ev) {
  const st = session.agent;
  const m = session.match;
  const decisions = [];

  if (ev.type === "odds") {
    st.oddsHistory.push(ev);
    const windowStart = ev.minute - st.rules[0].window;
    const past = st.oddsHistory.find((o) => o.minute >= windowStart);
    if (past) {
      for (const side of ["home", "away"]) {
        const drop = (past[side] - ev[side]) / past[side];
        if (drop > st.rules[0].threshold && !st.openPositions.some((p) => p.side === side)) {
          decisions.push(openPosition(session, { rule: "momentum-drop", side, team: side === "home" ? m.home : m.away, odds: ev[side], stake: st.rules[0].stake, minute: ev.minute, trigger: `${side} odds shortened ${(drop * 100).toFixed(1)}% over ${st.rules[0].window}min (${past[side]} → ${ev[side]})` }));
        }
      }
    }
  }

  if (ev.type === "card" && ev.card === "red") {
    const side = ev.team === m.home ? "away" : "home"; // bet against carded team
    const lastOdds = st.oddsHistory[st.oddsHistory.length - 1];
    if (lastOdds && !st.openPositions.some((p) => p.rule === "red-card-fade")) {
      decisions.push(openPosition(session, { rule: "red-card-fade", side, team: side === "home" ? m.home : m.away, odds: lastOdds[side], stake: st.rules[1].stake, minute: ev.minute, trigger: `Red card for ${ev.team} at ${ev.minute}'` }));
    }
  }

  if (ev.type === "full_time") settleAll(session, ev);
  return decisions;
}

function openPosition(session, pos) {
  const st = session.agent;
  st.bankroll -= pos.stake;
  const position = { ...pos, id: randomUUID().slice(0, 8), status: "open" };
  st.openPositions.push(position);
  // Every decision is notarised with the triggering data snapshot.
  const proof = journalAppend({
    kind: "decision", action: "OPEN", position,
    dataSnapshot: { seed: session.match.seed, match: `${session.match.home} vs ${session.match.away}`, trigger: pos.trigger },
  });
  return { position, proof };
}

function settleAll(session, ftEv) {
  const st = session.agent;
  for (const p of st.openPositions) {
    const won = (ftEv.winner === p.team) || (p.side === "draw" && ftEv.winner === "draw");
    const pnl = won ? +(p.stake * (p.odds - 1)).toFixed(2) : -p.stake;
    if (won) st.bankroll += p.stake * p.odds;
    const closed = { ...p, status: "settled", won, pnl, finalScore: ftEv.score };
    st.closedPositions.push(closed);
    journalAppend({ kind: "decision", action: "SETTLE", position: closed, dataSnapshot: { finalScore: ftEv.score, winner: ftEv.winner } });
  }
  st.openPositions = [];
}

// ---------------------------------------------------------------------------
// 4. SESSION / REPLAY LOOP
// ---------------------------------------------------------------------------

const sessions = new Map();

function startReplay(seed = 42, speed = 20) {
  stopReplay();
  const match = generateMatch(seed);
  const session = { id: randomUUID().slice(0, 8), match, agent: makeAgentState(), cursor: 0, speed, timer: null };
  sessions.set("current", session);
  journalAppend({ kind: "session_start", match: `${match.home} vs ${match.away}`, seed, speed });
  broadcast({ kind: "session", match: { home: match.home, away: match.away, seed }, agent: session.agent });

  const tick = () => {
    const s = sessions.get("current");
    if (!s || s.cursor >= s.match.timeline.length) return stopReplay();
    const ev = s.match.timeline[s.cursor++];
    broadcast({ kind: "event", ev });
    replayUpdateState(s, ev);
    const decisions = agentOnTick(s, ev);
    for (const d of decisions) broadcast({ kind: "decision", ...d });
    broadcast({ kind: "agent", agent: { bankroll: s.agent.bankroll, open: s.agent.openPositions, closed: s.agent.closedPositions } });
    if (ev.type === "full_time") { broadcast({ kind: "session_end" }); return stopReplay(); }
    s.timer = setTimeout(tick, 1000 / s.speed * (s.match.timeline[s.cursor]?.minute > ev.minute ? 30 : 3));
  };
  tick();
  return session;
}

function stopReplay() {
  const s = sessions.get("current");
  if (s?.timer) clearTimeout(s.timer);
  sessions.delete("current");
}

// ---------------------------------------------------------------------------
// 4a-bis. MATCH STATE — Aggregated live match state (score, stats, clock)
// ---------------------------------------------------------------------------

function blankMatchState() {
  return { minute: 0, gameState: "—", score: [0, 0], corners: [0, 0], yellow: [0, 0], red: [0, 0], shots: [0, 0], possession: null };
}

// Decode TxLINE period-prefixed stat keys: "1001" = period1+stat001.
// stat n: 1,2=goals 3,4=yellow 5,6=red 7,8=corners (per team)
function decodeTxStats(st = {}) {
  const per = (p, n) => st[String(p * 1000 + n)] ?? 0;
  const g = (n) => {
    if (st[String(n)] != null) return st[String(n)];
    let s = 0;
    for (let p = 1; p <= 9; p++) s += per(p, n);
    return s;
  };
  const bundle = (get) => ({ score: [get(1), get(2)], yellow: [get(3), get(4)], red: [get(5), get(6)], corners: [get(7), get(8)] });
  return { ...bundle(g), periods: { "1ST": bundle((n) => per(1, n)), "2ND": bundle((n) => per(2, n)) } };
}

function replayUpdateState(s, ev) {
  const st = s.state || (s.state = blankMatchState());
  st.minute = ev.minute ?? st.minute;
  const isHome = ev.team === s.match.home ? 0 : 1;
  if (ev.type === "goal") { const [h, a] = ev.score.split("-").map(Number); st.score = [h, a]; }
  if (ev.type === "var_end" && ev.score) { const [h, a] = ev.score.split("-").map(Number); st.score = [h, a]; }
  if (ev.type === "corner") st.corners[isHome]++;
  if (ev.type === "shot") st.shots[isHome]++;
  if (ev.type === "card") (ev.card === "red" ? st.red : st.yellow)[isHome]++;
  if (ev.type === "full_time") st.gameState = "Finished";
  else if (ev.minute > 0) st.gameState = ev.minute <= 45 ? "1st half" : "2nd half";
  broadcast({ kind: "match_state", state: st });
}

// ---------------------------------------------------------------------------
// 4b. LIVE MODE — real TxLINE data drives the terminal and the agent.
//     Provenance: every agent decision embeds the TxLINE MessageId + Ts of the
//     exact odds message that triggered it.
// ---------------------------------------------------------------------------

let live = null;
let liveSession = null; // { fixtureId, agent, startTs, match }
const scoreStates = new Map(); // fixtureId -> decoded match state (all fixtures)

// Persist score states across restarts (finished matches keep their score).
const STATES_FILE = join(DATA_DIR, "score-states.json");
try {
  if (existsSync(STATES_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(STATES_FILE, "utf8")))) scoreStates.set(Number(k), v);
    console.log(`restored ${scoreStates.size} score states`);
  }
} catch {}
setInterval(() => {
  try { writeFileSync(STATES_FILE, JSON.stringify(Object.fromEntries(scoreStates))); } catch {}
}, 20000);

// Game-state mapping (TxLINE StatusId -> status object)
const PHASES = { 1: "Not started", 2: "1st half", 3: "Halftime", 4: "2nd half", 5: "ET 1st", 6: "ET break", 7: "ET 2nd", 8: "Penalties", 10: "Finished", 19: "Postponed", 100: "Full time" };
const isFinalStatus = (s) => s === 10 || s === 100;

// ---------------------------------------------------------------------------
// INCIDENTS — Event-centric model: each match owns an incidents list
// (goal / card / period), built by diffing consecutive score states.
// ---------------------------------------------------------------------------
const incidentsMap = new Map(); // fixtureId -> [{time, incidentType, ...}]

function pushIncident(fixtureId, inc) {
  const arr = incidentsMap.get(fixtureId) || [];
  arr.push(inc);
  if (arr.length > 200) arr.shift();
  incidentsMap.set(fixtureId, arr);
  broadcast({ kind: "incident", fixtureId, incident: inc });
}

function detectIncidents(fixtureId, prev, st, m) {
  const t = st.minute ?? null;
  for (const side of [0, 1]) {
    const isHome = side === 0;
    if (st.score[side] > prev.score[side])
      pushIncident(fixtureId, { time: t, incidentType: "goal", isHome, homeScore: st.score[0], awayScore: st.score[1] });
    if (st.score[side] < prev.score[side]) // VAR overturned
      pushIncident(fixtureId, { time: t, incidentType: "varDecision", isHome, text: "Goal overturned", homeScore: st.score[0], awayScore: st.score[1] });
    if (st.yellow[side] > prev.yellow[side])
      pushIncident(fixtureId, { time: t, incidentType: "card", cardColor: "yellow", isHome });
    if (st.red[side] > prev.red[side])
      pushIncident(fixtureId, { time: t, incidentType: "card", cardColor: "red", isHome });
  }
  if (st.statusId !== prev.statusId && PHASES[st.statusId])
    pushIncident(fixtureId, { time: t, incidentType: "period", text: PHASES[st.statusId], homeScore: st.score[0], awayScore: st.score[1] });
}

function liveMinute(ts) {
  return Math.max(0, Math.round((ts - liveSession.startTs) / 60000));
}

// Two worlds run in parallel through the same pipeline:
//  - real:  live TxLINE SSE streams (actual schedule)
//  - demo:  TxSim, authentic TxLINE historical data replayed as-if-live
// Users pick a world at onboarding (/mode to switch); fixtures are routed by id.
let sim = null;
const DEMO_IDS = new Set(DEMO_MATCHES.map((m) => m.id));
const isDemoFixture = (id) => DEMO_IDS.has(Number(id));

function ensureSim() {
  if (sim) return sim;
  sim = new TxSim(connectorHandlers("demo"));
  return sim;
}

// shared callbacks for both connectors — everything downstream is identical
function connectorHandlers(world) {
  return {
    onStatus: (s) => broadcast({ kind: "live_status", ...s }),
    onScore: (s) => {
      const m = s.raw;
      if (!m || !m.FixtureId) return;
      // Track state for EVERY fixture (event-centric model), not only the watched one.
      const st = scoreStates.get(m.FixtureId) || blankMatchState();
      const prev = { score: [...st.score], yellow: [...st.yellow], red: [...st.red], statusId: st.statusId };
      if (m.Clock?.Seconds != null) st.minute = Math.floor(m.Clock.Seconds / 60);
      if (m.GameState) st.gameState = m.GameState;
      if (m.StatusId != null) st.statusId = m.StatusId;
      if (m.Seq) st.seq = m.Seq; // last Seq = Merkle proof anchor for /verify
      if (m.Possession != null) st.possession = m.Possession;
      if (m.Stats) {
        const d = decodeTxStats(m.Stats);
        st.score = d.score; st.yellow = d.yellow; st.red = d.red; st.corners = d.corners;
        st.periods = d.periods;
      }
      // possession share: accumulate which side holds the ball, message by message
      st.poss = st.poss || [0, 0];
      if (m.Possession === 1 || m.Possession === "1") st.poss[0]++;
      else if (m.Possession === 2 || m.Possession === "2") st.poss[1]++;
      // attack momentum (event-weighted, decaying wave from -100 away to +100 home)
      updateMomentum(m.FixtureId, st, m);
      scoreStates.set(m.FixtureId, st);
      detectIncidents(m.FixtureId, prev, st, m);
      // agent: in-play event triggers + settlement on final whistle
      const tsNow = m.Ts || Date.now();
      const side0 = st.score[0] > prev.score[0], side1 = st.score[1] > prev.score[1];
      // catchup = simulator backlog replay: build state silently, no pings
      if (s.catchup) return;
      if (side0 || side1) liveAgent.onIncident(m.FixtureId, { kind: "goal", isHome: side0, ts: tsNow, score: [...st.score] });
      if (st.red[0] > prev.red[0]) liveAgent.onIncident(m.FixtureId, { kind: "red", isHome: true, ts: tsNow, score: [...st.score] });
      if (st.red[1] > prev.red[1]) liveAgent.onIncident(m.FixtureId, { kind: "red", isHome: false, ts: tsNow, score: [...st.score] });
      // HORUS speaks to the fans (async, never blocks the feed)
      if (horus) {
        if (side0 || side1) horus.notifyFollowers(m.FixtureId, { kind: "goal", isHome: side0 }).catch(() => {});
        if (st.red[0] > prev.red[0]) horus.notifyFollowers(m.FixtureId, { kind: "red", isHome: true }).catch(() => {});
        if (st.red[1] > prev.red[1]) horus.notifyFollowers(m.FixtureId, { kind: "red", isHome: false }).catch(() => {});
        if (st.statusId !== prev.statusId && PHASES[st.statusId]) horus.notifyFollowers(m.FixtureId, { kind: "period", text: PHASES[st.statusId] }).catch(() => {});
      }
      if (isFinalStatus(st.statusId) && !isFinalStatus(prev.statusId)) {
        const [h, a] = st.score;
        liveAgent.onFinal(m.FixtureId, { winner: h > a ? "home" : a > h ? "away" : "draw", finalScore: `${h}-${a}`, ts: tsNow });
        // settle every open position on this match, on-chain
        if (bank) bank.settle(m.FixtureId, h > a ? 0 : a > h ? 2 : 1, (cid, txt) => punditBot?.sendText(cid, txt))
          .catch((e) => console.log("[bank] settle error:", e.message));
      }
      if (liveSession && m.FixtureId === liveSession.fixtureId) {
        liveSession.state = st;
        broadcast({ kind: "match_state", state: st });
      }
    },
    onOdds: (o) => {
      broadcast({ kind: "live_odds_all", fixtureId: o.fixtureId, odds: { home: o.home, draw: o.draw, away: o.away }, inRunning: o.inRunning });
      if (o.catchup) return; // simulator backlog — state only, no reactions
      // agent watches EVERY fixture on the stream, autonomously
      liveAgent.onOdds({
        fixtureId: o.fixtureId, ts: o.ts || Date.now(),
        odds: { home: o.home, draw: o.draw, away: o.away },
        pct: o.pct, inRunning: o.inRunning, meta: metaOf(o.fixtureId),
      });
      if (horus) horus.rememberProbs(o.fixtureId);
      if (!liveSession || o.fixtureId !== liveSession.fixtureId) return;
      const ev = { type: "odds", minute: liveMinute(o.ts), home: o.home, draw: o.draw, away: o.away, messageId: o.messageId, ts: o.ts };
      broadcast({ kind: "event", ev });
      const s = liveSession;
      const decisions = agentOnTick(s, ev);
      for (const d of decisions) broadcast({ kind: "decision", ...d });
      broadcast({ kind: "agent", agent: { bankroll: s.agent.bankroll, open: s.agent.openPositions, closed: s.agent.closedPositions } });
    },
  };
}

function ensureLive() {
  if (live) return live;
  live = new TxLive(connectorHandlers("real"));
  return live;
}

// ---------------------------------------------------------------------------
// 5. HTTP + WS
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

app.post("/api/replay/start", (req, res) => {
  const { seed = 42, speed = 20 } = req.body || {};
  const s = startReplay(Number(seed), Number(speed));
  res.json({ ok: true, session: s.id, match: `${s.match.home} vs ${s.match.away}` });
});
app.post("/api/replay/stop", (_req, res) => { stopReplay(); res.json({ ok: true }); });

// ---------------------------------------------------------------------------
// ATTACK MOMENTUM — one point per minute, value -100 (away) .. +100 (home),
// event-weighted with decay. Same graph model as leading livescore apps.
// ---------------------------------------------------------------------------
const momentumMap = new Map(); // fixtureId -> [{minute, value}]

function updateMomentum(fixtureId, st, m) {
  const minute = st.minute ?? 0;
  const side = (m.Possession === 1 || m.Possession === "1") ? 1 : (m.Possession === 2 || m.Possession === "2") ? -1 : 0;
  const a = String(m.Action || "").toLowerCase();
  let w = 4;
  if (a.includes("danger")) w = 18;
  else if (a.includes("shot")) w = 26;
  else if (a.includes("attack")) w = 11;
  else if (a.includes("corner")) w = 14;
  else if (a.includes("free_kick")) w = 9;
  const pts = momentumMap.get(fixtureId) || [];
  const prevVal = pts.length ? pts[pts.length - 1].value : 0;
  const value = Math.max(-100, Math.min(100, Math.round(prevVal * 0.82 + w * side)));
  if (pts.length && pts[pts.length - 1].minute === minute) pts[pts.length - 1].value = value;
  else pts.push({ minute, value });
  if (pts.length > 140) pts.shift();
  momentumMap.set(fixtureId, pts);
}

// --- Events API (event-centric JSON model) ---
// Full schedule: every known fixture (snapshot metadata + streams), so the
// list always shows upcoming, live and finished matches — never an empty page.
app.get("/api/events/live", (_req, res) => {
  if (!live) return res.json({ events: [] });
  const now = Date.now();
  const events = live.allFixtureIds().map((id) => {
    const meta = live.metaFor(id);
    const st = scoreStates.get(id);
    const scoreSum = (st?.score?.[0] ?? 0) + (st?.score?.[1] ?? 0);
    const started = meta?.startTime ? meta.startTime <= now : false;
    const streamLive = live.inRunningFor(id); // odds still flowing = truly live
    // finished wins over stale in-play status: explicit FT, or kickoff >2h30 ago with no live odds
    const longOver = meta?.startTime ? now - meta.startTime > 125 * 60 * 1000 : false;
    const finished = !streamLive && (st?.statusId === 10 || (started && longOver));
    const inplay = !finished && (streamLive || (st && [2, 3, 4, 5, 6, 7, 8].includes(st.statusId)));
    const type = inplay ? "inprogress" : finished ? "finished" : "notstarted";
    return {
      id,
      tournament: { name: meta?.competition || "FIFA World Cup 2026", category: { name: "World", sport: { name: "Football" } } },
      status: {
        code: st?.statusId ?? (inplay ? 2 : finished ? 10 : 1),
        description: inplay ? (PHASES[st?.statusId] || "In progress") : finished ? "FT" : "Not started",
        type,
      },
      homeTeam: { name: meta?.home || `Home #${id}`, id },
      awayTeam: { name: meta?.away || `Away #${id}`, id },
      homeScore: { current: st?.score?.[0] ?? 0, display: st?.score?.[0] ?? 0 },
      awayScore: { current: st?.score?.[1] ?? 0, display: st?.score?.[1] ?? 0 },
      time: { minute: st?.minute ?? null },
      startTimestamp: meta?.startTime ? Math.floor(meta.startTime / 1000) : null,
      odds: live.oddsFor(id) ? { home: live.oddsFor(id).home, draw: live.oddsFor(id).draw, away: live.oddsFor(id).away } : null,
    };
  });
  // in-play first, then upcoming by start time, finished last
  const rank = { inprogress: 0, notstarted: 1, finished: 2 };
  events.sort((a, b) => rank[a.status.type] - rank[b.status.type] || (a.startTimestamp || 9e12) - (b.startTimestamp || 9e12));
  res.json({ events });
});

// Incidents endpoint (per-event incident list)
app.get("/api/events/:id/incidents", (req, res) => {
  res.json({ incidents: incidentsMap.get(Number(req.params.id)) || [] });
});

// Statistics endpoint — periods ALL / 1ST / 2ND, groups, pre-chewed items
// (compareCode tells the frontend which side to highlight: 1 home, 2 away, 3 equal)
app.get("/api/events/:id/statistics", (req, res) => {
  const st = scoreStates.get(Number(req.params.id));
  if (!st) return res.json({ statistics: [] });
  const item = (name, h, a, suffix = "") => ({
    name, home: `${h}${suffix}`, away: `${a}${suffix}`, homeValue: h, awayValue: a,
    compareCode: h > a ? 1 : a > h ? 2 : 3, statisticsType: "positive", valueType: "team",
  });
  const bundleItems = (b, withPoss) => {
    const items = [];
    if (withPoss && st.poss && (st.poss[0] + st.poss[1]) > 10) {
      const tot = st.poss[0] + st.poss[1];
      items.push(item("Ball possession", Math.round(st.poss[0] / tot * 100), Math.round(st.poss[1] / tot * 100), "%"));
    }
    items.push(item("Corner kicks", b.corners[0], b.corners[1]));
    items.push(item("Yellow cards", b.yellow[0], b.yellow[1]));
    items.push(item("Red cards", b.red[0], b.red[1]));
    return items;
  };
  const statistics = [{ period: "ALL", groups: [{ groupName: "Match overview", statisticsItems: bundleItems(st, true) }] }];
  if (st.periods) {
    for (const p of ["1ST", "2ND"]) {
      statistics.push({ period: p, groups: [{ groupName: "Match overview", statisticsItems: bundleItems(st.periods[p], false) }] });
    }
  }
  res.json({ statistics });
});

// "Who will win?" — real visitor votes, persisted server-side.
const VOTES_FILE = join(DATA_DIR, "votes.json");
let votes = {};
try { votes = JSON.parse(readFileSync(VOTES_FILE, "utf8")); } catch {}
app.get("/api/events/:id/votes", (req, res) => res.json({ vote: votes[req.params.id] || { 1: 0, X: 0, 2: 0 } }));
app.post("/api/events/:id/votes", (req, res) => {
  const c = String(req.body?.choice || "");
  if (!["1", "X", "2"].includes(c)) return res.status(400).json({ ok: false });
  const v = (votes[req.params.id] = votes[req.params.id] || { 1: 0, X: 0, 2: 0 });
  v[c]++;
  try { writeFileSync(VOTES_FILE, JSON.stringify(votes)); } catch {}
  res.json({ ok: true, vote: v });
});

// Season statistics per team, aggregated from OUR tracked archive.
function seasonStats(teamName) {
  const form = teamFormAll(teamName);
  const s = { matches: form.length, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
  for (const f of form) {
    if (f.result === "W") s.wins++; else if (f.result === "L") s.losses++; else s.draws++;
    const [gh, ga] = f.score.split("-").map(Number);
    s.goalsFor += f.home ? gh : ga;
    s.goalsAgainst += f.home ? ga : gh;
  }
  return s;
}

// Team form built from OUR observed archive: every finished fixture this
// platform has tracked contributes a W/D/L entry for both teams.
function teamFormAll(teamName, excludeId) {
  if (!live || !teamName) return [];
  const out = [];
  for (const fid of live.allFixtureIds()) {
    if (fid === excludeId) continue;
    const meta = live.metaFor(fid);
    const st = scoreStates.get(fid);
    if (!meta || !st || !st.score) continue;
    const isHome = meta.home === teamName, isAway = meta.away === teamName;
    if (!isHome && !isAway) continue;
    const started = meta.startTime && meta.startTime <= Date.now();
    const over = started && Date.now() - meta.startTime > 125 * 60 * 1000;
    if (!over) continue;
    const [gh, ga] = st.score;
    const mine = isHome ? gh : ga, theirs = isHome ? ga : gh;
    out.push({
      opponent: isHome ? meta.away : meta.home,
      score: `${gh}-${ga}`, home: isHome,
      result: mine > theirs ? "W" : mine < theirs ? "L" : "D",
      startTime: meta.startTime, competition: meta.competition,
    });
  }
  return out.sort((a, b) => b.startTime - a.startTime);
}
const teamForm = (teamName, excludeId) => teamFormAll(teamName, excludeId).slice(0, 5);

// Pre-game endpoint — market-implied win probability (demargined consensus),
// same display concept as the "who will win" bar, but based on real prices.
app.get("/api/events/:id/pregame", (req, res) => {
  const id = Number(req.params.id);
  const meta = live ? live.metaFor(id) : null;
  const odds = live ? live.oddsFor(id) : null;
  let winProbability = null;
  if (odds) {
    let pct = Array.isArray(odds.pct) ? odds.pct.map(parseFloat) : [];
    if (pct.length !== 3 || pct.some(isNaN)) {
      const inv = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
      const s = inv[0] + inv[1] + inv[2];
      pct = inv.map((v) => (v / s) * 100);
    }
    winProbability = { home: +pct[0].toFixed(1), draw: +pct[1].toFixed(1), away: +pct[2].toFixed(1) };
  }
  const opening = live ? live.openingFor(id) : null;
  res.json({
    kickoff: meta?.startTime || null,
    competition: meta?.competition || null,
    winProbability,
    marketsOpen: live ? live.bookFor(id).length : 0,
    oddsMovement: opening && odds ? { opening: { home: opening.home, draw: opening.draw, away: opening.away }, current: { home: odds.home, draw: odds.draw, away: odds.away } } : null,
    homeForm: teamForm(meta?.home, id),
    awayForm: teamForm(meta?.away, id),
    seasonStats: { home: seasonStats(meta?.home), away: seasonStats(meta?.away) },
  });
});

// Attack momentum graph — {graphPoints:[{minute,value}], periodTime, periodCount}
app.get("/api/events/:id/graph", (req, res) => {
  res.json({ graphPoints: momentumMap.get(Number(req.params.id)) || [], periodTime: 45, periodCount: 2 });
});

// Odds endpoint — full market book with movement direction per choice
app.get("/api/events/:id/odds", (req, res) => {
  if (!live) return res.json({ markets: [] });
  const book = live.bookFor(Number(req.params.id));
  const MARKET_LABELS = { "1X2_PARTICIPANT_RESULT": "Full time result", "OVERUNDER_PARTICIPANT_GOALS": "Total goals", "ASIANHANDICAP_PARTICIPANT_GOALS": "Asian handicap" };
  const CHOICE_LABELS = { part1: "1", draw: "X", part2: "2", over: "Over", under: "Under" };
  const markets = book.map((b) => ({
    marketName: (MARKET_LABELS[b.type] || b.type) + (b.period ? " — " + b.period.replace("half=1", "1st half").replace("half=2", "2nd half") : ""),
    marketParams: b.params,
    choices: b.names.map((n, i) => ({
      name: CHOICE_LABELS[n] || n,
      value: b.prices[i].toFixed(2),
      change: b.prev ? Math.sign(b.prices[i] - b.prev[i]) : 0,
    })),
    ts: b.ts,
  }));
  const order = { "Full time result": 0, "Total goals": 1, "Asian handicap": 2 };
  markets.sort((a, b) => (order[a.marketName] ?? 9) - (order[b.marketName] ?? 9) || parseFloat((a.marketParams || "0").replace("line=", "")) - parseFloat((b.marketParams || "0").replace("line=", "")));
  res.json({ markets });
});

// --- LIVE mode ---
app.post("/api/live/connect", async (_req, res) => {
  try { await ensureLive().start(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/api/live/fixtures", (_req, res) => res.json(live ? live.listFixtures() : []));
app.post("/api/live/watch", (req, res) => {
  const { fixtureId } = req.body || {};
  if (!fixtureId) return res.status(400).json({ ok: false, error: "fixtureId required" });
  stopReplay();
  const meta = live ? live.metaFor(Number(fixtureId)) : null;
  liveSession = {
    fixtureId: Number(fixtureId),
    agent: makeAgentState(),
    startTs: Date.now(),
    state: scoreStates.get(Number(fixtureId)) || null,
    match: { seed: "LIVE", home: meta?.home || `Home #${fixtureId}`, away: meta?.away || `Away #${fixtureId}` },
  };
  journalAppend({ kind: "session_start", mode: "LIVE", fixtureId: Number(fixtureId), source: "TxLINE" });
  broadcast({ kind: "session", match: { home: liveSession.match.home, away: liveSession.match.away, seed: "LIVE" }, agent: liveSession.agent });
  res.json({ ok: true, fixtureId: Number(fixtureId) });
});
app.post("/api/live/stop", (_req, res) => { liveSession = null; if (live) live.stop(); live = null; res.json({ ok: true }); });
// ---- live autonomous agent ----
app.get("/api/agent", (_req, res) => res.json(liveAgent.snapshot()));
app.get("/api/agent/backtest", (_req, res) => {
  const f = join(DATA_DIR, "backtest-report.json");
  if (!existsSync(f)) return res.json({ ready: false });
  res.json({ ready: true, ...JSON.parse(readFileSync(f, "utf8")) });
});
app.get("/api/agent/calibration", (_req, res) => {
  const f = join(DATA_DIR, "calibration.json");
  if (!existsSync(f)) return res.json({ ready: false });
  res.json({ ready: true, ...JSON.parse(readFileSync(f, "utf8")) });
});
app.get("/api/journal", (_req, res) => res.json(journalRead()));
app.get("/api/journal/verify", (_req, res) => res.json(journalVerify()));
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "proofdesk", uptime: process.uptime() }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ kind: "hello", journal: journalRead(50) }));
});

server.listen(PORT, () => {
  console.log(`ProofDesk listening on :${PORT}`);
  // Both worlds boot together: real TxLINE feed + the demo championship.
  ensureLive().start().then(() => console.log("TxLINE live feed: connected at boot"))
    .catch((e) => console.log("TxLINE live feed unavailable at boot:", e.message));
  ensureSim().start().then(() => console.log("Demo championship: running"))
    .catch((e) => console.log("Demo championship unavailable:", e.message));
});
