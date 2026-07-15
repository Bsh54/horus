// Verifiable backtest: replay real recorded odds histories through the exact
// same agent engine that trades live, grade against real final results, and
// write a full report (per-rule stats, equity curve, CLV) to data/.
// Usage:
//   node backtest.mjs                 # run with DEFAULT_CONFIG over all cached+listed fixtures
//   node backtest.mjs --fetch         # also download missing odds histories (cache in data/history/)
//   node backtest.mjs --grid          # calibration: grid-search key thresholds, write calibration table
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gzipSync, gunzipSync } from "zlib";
import { createAgent, DEFAULT_CONFIG } from "./agent.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "data");
const HIST = join(DATA, "history");
mkdirSync(HIST, { recursive: true });

const creds = JSON.parse(readFileSync(join(DATA, "txline-credentials.json"), "utf8"));

async function freshJwt() {
  const r = await fetch(creds.api + "/auth/guest/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return (await r.json()).token;
}
async function api(path, jwt) {
  const r = await fetch(creds.api + path, { headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": creds.apiToken } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  const t = await r.text();
  return t.trim() ? JSON.parse(t) : [];
}

// ---- fixture universe (walk the past with startEpochDay) --------------------
async function listFixtures(jwt) {
  const today = Math.floor(Date.now() / 86400000);
  const seen = new Map();
  for (let d = today - 70; d <= today; d += 25) {
    try {
      for (const f of await api(`/api/fixtures/snapshot?startEpochDay=${d}`, jwt)) {
        if (f.FixtureId) seen.set(f.FixtureId, f);
      }
    } catch {}
  }
  return [...seen.values()].sort((a, b) => (a.StartTime || 0) - (b.StartTime || 0));
}

// ---- odds history cache ------------------------------------------------------
// Full histories are 60-90k messages per match; the engine only consumes the
// full-time 1X2 line, so we cache a slim tick list per fixture and never hold
// more than one match in memory at a time.
function slimTicks(rows) {
  const out = [];
  for (const m of rows) {
    if (m.SuperOddsType !== "1X2_PARTICIPANT_RESULT" || m.MarketPeriod || !Array.isArray(m.Prices) || m.Prices.length !== 3) continue;
    out.push({ ts: m.Ts, p: m.Prices, pct: m.Pct, ir: m.InRunning ? 1 : 0 });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

async function loadTicks(fid, jwt, fetchMissing) {
  const slim = join(HIST, `t1x2-${fid}.json.gz`);
  if (existsSync(slim)) return JSON.parse(gunzipSync(readFileSync(slim)).toString());
  const full = join(HIST, `odds-${fid}.json.gz`);
  let rows = null;
  if (existsSync(full)) rows = JSON.parse(gunzipSync(readFileSync(full)).toString());
  else if (fetchMissing) rows = await api(`/api/odds/updates/${fid}`, jwt);
  if (!Array.isArray(rows) || !rows.length) return null;
  const ticks = slimTicks(rows);
  writeFileSync(slim, gzipSync(JSON.stringify(ticks)));
  return ticks;
}

// ---- ground truth ------------------------------------------------------------
const ALIAS = { "Czechia": "Czech Republic", "Bosnia & Herzegovina": "Bosnia & Herzegovina", "USA": "USA", "Türkiye": "Turkey" };
const norm = (n) => (ALIAS[n] || n || "").toLowerCase().replace(/[^a-z]/g, "");

function loadResults() {
  const file = join(DATA, "worldcup-results.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8")).matches || [];
}

function groundTruth(fixture, results, closing) {
  const h = norm(fixture.Participant1IsHome === false ? fixture.Participant2 : fixture.Participant1);
  const a = norm(fixture.Participant1IsHome === false ? fixture.Participant1 : fixture.Participant2);
  const day = Math.floor((fixture.StartTime || 0) / 86400000);
  for (const r of results) {
    if (Math.abs(Math.floor(r.startTimestamp * 1000 / 86400000) - day) > 1) continue;
    if (norm(r.homeTeam) === h && norm(r.awayTeam) === a) {
      // 1X2 settles on 90-minute result: period1+period2
      const h90 = (r.homeScore.period1 ?? 0) + (r.homeScore.period2 ?? 0);
      const a90 = (r.awayScore.period1 ?? 0) + (r.awayScore.period2 ?? 0);
      const winner = h90 > a90 ? "home" : a90 > h90 ? "away" : "draw";
      return { winner, finalScore: `${h90}-${a90}`, source: "results-file" };
    }
  }
  // fallback: deduce from closing in-play 1X2 (a price collapsing to <=1.05 marks the winner)
  if (closing) {
    const entries = [["home", closing.home], ["draw", closing.draw], ["away", closing.away]];
    const [side, price] = entries.sort((x, y) => x[1] - y[1])[0];
    if (price <= 1.08) return { winner: side, finalScore: null, source: "closing-odds" };
  }
  return null;
}

// ---- run one backtest pass ----------------------------------------------------
// Streams fixture by fixture: load ticks -> feed engine -> settle -> free memory.
async function runPass(config, fixtures, results, jwt, fetchMissing, onProgress) {
  const agent = createAgent(config, { journal: () => null });
  let graded = 0, skipped = 0, withHistory = 0;

  for (const f of fixtures) {
    let ticks = null;
    try { ticks = await loadTicks(f.FixtureId, jwt, fetchMissing); } catch {}
    if (!ticks || !ticks.length) { skipped++; continue; }
    withHistory++;
    const meta = {
      home: f.Participant1IsHome === false ? f.Participant2 : f.Participant1,
      away: f.Participant1IsHome === false ? f.Participant1 : f.Participant2,
      startTime: f.StartTime,
    };
    let lastInPlay = null;
    for (const t of ticks) {
      const tick = {
        fixtureId: f.FixtureId, ts: t.ts,
        odds: { home: t.p[0] / 1000, draw: t.p[1] / 1000, away: t.p[2] / 1000 },
        pct: t.pct, inRunning: !!t.ir, meta,
      };
      if (tick.inRunning) lastInPlay = tick.odds;
      agent.onOdds(tick);
    }
    const truth = groundTruth(f, results, lastInPlay);
    if (truth) {
      agent.onFinal(f.FixtureId, { winner: truth.winner, finalScore: truth.finalScore, ts: (f.StartTime || 0) + 2 * 3600 * 1000 });
      graded++;
    } else {
      // no verifiable result -> void the positions (stake returned), stay honest
      for (const p of agent.state.open.filter((p) => p.fixtureId === f.FixtureId)) {
        agent.state.bankroll = +(agent.state.bankroll + p.stake).toFixed(2);
      }
      agent.state.open = agent.state.open.filter((p) => p.fixtureId !== f.FixtureId);
      skipped++;
    }
    agent.state.fixtures.delete(f.FixtureId); // free per-fixture buffers
    if (onProgress && (graded + skipped) % 25 === 0) onProgress(graded + skipped);
  }
  return { agent, graded, skipped, withHistory };
}

// ---- main ----------------------------------------------------------------------
const args = process.argv.slice(2);
const doFetch = args.includes("--fetch");
const doGrid = args.includes("--grid");

const jwt = await freshJwt();
const fixtures = (await listFixtures(jwt)).filter((f) => (f.StartTime || 0) < Date.now());
console.log(`fixtures in the past: ${fixtures.length}`);
const results = loadResults();

if (!doGrid) {
  const { agent, graded, skipped, withHistory } = await runPass(DEFAULT_CONFIG, fixtures, results, jwt, doFetch,
    (n) => console.log(`processed: ${n}/${fixtures.length}`));
  const report = { ranAt: new Date().toISOString(), config: DEFAULT_CONFIG, fixtures: fixtures.length,
    withHistory, graded, skipped, ...agent.snapshot() };
  writeFileSync(join(DATA, "backtest-report.json"), JSON.stringify(report, null, 1));
  const k = report.kpis;
  console.log(`\n== BACKTEST == trades=${k.trades} winRate=${k.winRatePct}% pnl=${k.pnl} roi=${k.roiPct}% avgCLV=${k.avgClvPct}% bankroll=${k.bankroll}`);
  console.log("by rule:", JSON.stringify(k.byRule));
} else {
  const grid = [];
  for (const steamPts of [0.03, 0.04, 0.05, 0.07])
    for (const steamWindowMin of [5, 10, 15])
      for (const maxOdds of [3.0, 4.5])
        grid.push({ steamPts, steamWindowMs: steamWindowMin * 60000, maxOdds });
  const table = [];
  for (const g of grid) {
    const cfgRun = { ...DEFAULT_CONFIG, ...g };
    const { agent, graded } = await runPass(cfgRun, fixtures, results, jwt, false, null);
    const k = agent.kpis();
    table.push({ ...g, graded, trades: k.trades, winRatePct: k.winRatePct, pnl: k.pnl, roiPct: k.roiPct, avgClvPct: k.avgClvPct, bankroll: k.bankroll });
    console.log(`steam=${g.steamPts} win=${g.steamWindowMs / 60000}min maxOdds=${g.maxOdds} -> trades=${k.trades} pnl=${k.pnl} roi=${k.roiPct}% clv=${k.avgClvPct}%`);
  }
  table.sort((a, b) => b.pnl - a.pnl);
  writeFileSync(join(DATA, "calibration.json"), JSON.stringify({ ranAt: new Date().toISOString(), table }, null, 1));
  console.log("\nbest:", JSON.stringify(table[0]));
}
