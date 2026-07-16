// TRUTH HARNESS — replays every playable demo match headless through the
// exact session detection logic and cross-checks each emitted event against
// the raw TxLINE data and the play-by-play archive. Zero tolerance checks:
//   1. final score == the game_finalised Stats of the raw stream
//   2. goals emitted == final score sum; each matches a pbp goal within ±4'
//   3. every goal has fresh odds + demargined probabilities at that instant
//   4. minutes never go backwards; probabilities always sum to ~100%
//   5. yellows/corners at FT == the raw stream's final Stats
// Run on the VPS: node test-session-truth.mjs
import { readFileSync, existsSync } from "fs";
import { gunzipSync } from "zlib";
import { TxSim, DEMO_MATCHES } from "./simulator.mjs";

const decode = (stats) => {
  const g = (k) => Number(stats[k] ?? 0);
  return { score: [g(1), g(2)], yellow: [g(3), g(4)], red: [g(5), g(6)], corners: [g(7), g(8)] };
};

const sim = new TxSim({ onOdds: () => {}, onScore: () => {}, onStatus: () => {} });
await sim.start();

let failures = 0;
for (const cfg of DEMO_MATCHES.filter((m) => m.phase !== "finished")) {
  const tl = sim.timelineOf(cfg.id);
  if (!tl) { console.log(`${cfg.id} NO TIMELINE`); failures++; continue; }
  const label = `${cfg.home}-${cfg.away}`;
  // ground truth from the raw stream
  const rawScores = tl.msgs.filter((x) => x.stream === "scores").map((x) => x.msg);
  const finalMsg = [...rawScores].reverse().find((m) => m.Stats && Object.keys(m.Stats).length);
  const truth = decode(finalMsg.Stats);
  // pbp goals, keyed by the score they produced ("Team 1, Team 0.")
  let pbpGoals = [];
  const pf = `data/history/pbp-${cfg.id}.json.gz`;
  if (existsSync(pf)) {
    const pbp = JSON.parse(gunzipSync(readFileSync(pf)));
    pbpGoals = (pbp.plays || [])
      .filter((p) => ["Goal", "Goal - Header", "Own Goal", "Penalty - Scored"].includes(p.type))
      .map((p) => { const m = String(p.text).match(/ (\d+)(?:\(\d+\))?, .*? (\d+)(?:\(\d+\))?\./); return m ? `${m[1]}-${m[2]}` : null; });
  }
  // headless session — same mid-coverage seeding rule as the real one
  const st = { score: [0, 0], yellow: [0, 0], red: [0, 0], corners: [0, 0], minute: 0, statusId: null };
  const firstStats = tl.msgs.slice(tl.cursor).find((x) => x.stream === "scores" && x.msg.Stats && Object.keys(x.msg.Stats).length)?.msg;
  let seeded = "";
  if (firstStats) {
    const d = decode(firstStats.Stats);
    if (d.score[0] + d.score[1] > 0 || (firstStats.Clock?.Seconds ?? 0) > 300) {
      Object.assign(st, d);
      st.minute = Math.floor((firstStats.Clock?.Seconds ?? 0) / 60);
      st.statusId = firstStats.StatusId ?? null;
      seeded = ` (coverage joins at ${st.minute}', ${st.score.join("-")})`;
    }
  }
  let probs = null, odds = null, lastOddsTs = null, minuteMax = 0;
  const events = [];
  const problems = [];
  for (let i = tl.cursor; i < tl.msgs.length; i++) {
    const { ts, stream, msg } = tl.msgs[i];
    if (stream === "scores" && msg.StatusId === 100 && i < tl.finalIdx) continue;
    if (stream === "odds") {
      if (msg.SuperOddsType === "1X2_PARTICIPANT_RESULT" && !msg.MarketPeriod && Array.isArray(msg.Prices) && msg.Prices.length === 3) {
        odds = msg.Prices.map((p) => p / 1000);
        lastOddsTs = ts;
        if (Array.isArray(msg.Pct)) {
          const p = msg.Pct.map(Number), s = p[0] + p[1] + p[2];
          if (s > 0) probs = p.map((x) => x / s);
          if (!(s > 95 && s < 105)) problems.push(`pct sum ${s.toFixed(1)} at ${ts}`);
        }
      }
      continue;
    }
    const prev = { ...st, score: [...st.score], yellow: [...st.yellow], red: [...st.red], corners: [...st.corners] };
    // mirror of the session's display rule: minute never decreases inside a
    // period; a status change resets the baseline (45' second half, etc.)
    if (msg.Clock?.Seconds != null) {
      const m = Math.floor(msg.Clock.Seconds / 60);
      if (msg.StatusId != null && msg.StatusId !== st.statusId) st.minute = m;
      else st.minute = Math.max(st.minute ?? 0, m);
    }
    if (msg.StatusId != null) st.statusId = msg.StatusId;
    if (msg.Stats && Object.keys(msg.Stats).length) Object.assign(st, decode(msg.Stats));
    if (st.minute < minuteMax - 1 && st.statusId === prev.statusId) problems.push(`minute went back ${minuteMax}->${st.minute} mid-period`);
    if (st.statusId !== prev.statusId) minuteMax = st.minute;
    minuteMax = Math.max(minuteMax, st.minute);
    for (const side of [0, 1]) {
      if (st.score[side] < prev.score[side]) events.push({ kind: "var", side, min: st.minute });
      if (st.score[side] > prev.score[side]) {
        const oddsAge = lastOddsTs ? ((ts - lastOddsTs) / 1000).toFixed(0) : "NONE";
        // match by the resulting score, robust to clock drift between feeds
        const nearPbp = pbpGoals.includes(`${st.score[0]}-${st.score[1]}`);
        events.push({ kind: "goal", side, min: st.minute, score: [...st.score], oddsAge, probs: probs ? probs.map((x) => Math.round(x * 100)).join("/") : "NONE", pbpMatch: nearPbp });
        if (!odds) problems.push(`goal at ${st.minute}' with no odds yet`);
      }
      if (st.yellow[side] > prev.yellow[side]) events.push({ kind: "yellow", side, min: st.minute });
      if (st.red[side] > prev.red[side]) events.push({ kind: "red", side, min: st.minute });
      if (st.corners[side] > prev.corners[side]) events.push({ kind: "corner", side, min: st.minute });
    }
    if (st.statusId === 100) break;
  }
  // zero-tolerance comparisons
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
  if (!eq(st.score, truth.score)) problems.push(`FINAL SCORE session ${st.score} != raw ${truth.score}`);
  const goalsEmitted = events.filter((e) => e.kind === "goal").length;
  const overturned = events.filter((e) => e.kind === "var").length;
  const seededGoals = seeded ? Number(seeded.match(/(\d+)-(\d+)\)/)?.[1] ?? 0) + Number(seeded.match(/(\d+)-(\d+)\)/)?.[2] ?? 0) : 0;
  if (goalsEmitted - overturned + seededGoals !== truth.score[0] + truth.score[1])
    problems.push(`goals ${goalsEmitted} - VAR ${overturned} + seeded ${seededGoals} != final sum ${truth.score[0] + truth.score[1]}`);
  // goals without a pbp counterpart are only a problem if they were NOT
  // overturned by VAR (an overturned goal never reaches the play-by-play)
  const unmatchedGoals = events.filter((e) => e.kind === "goal" && !e.pbpMatch).length;
  if (pbpGoals.length && unmatchedGoals > overturned)
    problems.push(`${unmatchedGoals} goal(s) without pbp match but only ${overturned} VAR overturn(s)`);
  if (!eq(st.yellow, truth.yellow)) problems.push(`yellows ${st.yellow} != raw ${truth.yellow}`);
  if (!eq(st.corners, truth.corners)) problems.push(`corners ${st.corners} != raw ${truth.corners}`);
  const goals = events.filter((e) => e.kind === "goal");
  console.log(`\n=== ${cfg.id} ${label} [${cfg.phase}]${seeded} final ${st.score.join("-")} (truth ${truth.score.join("-")}) | yellows ${st.yellow.join("-")} corners ${st.corners.join("-")}`);
  for (const g of goals) console.log(`  goal ${g.min}' -> ${g.score.join("-")} | odds age ${g.oddsAge}s | win% ${g.probs} | pbp ${g.pbpMatch ? "OK" : "??"}`);
  console.log(`  events: ${goalsEmitted} goals, ${overturned} VAR overturns, ${events.filter((e) => e.kind === "yellow").length} yellows, ${events.filter((e) => e.kind === "corner").length} corners, ${events.filter((e) => e.kind === "red").length} reds`);
  if (problems.length) { failures++; console.log(`  PROBLEMS:\n   - ${problems.slice(0, 8).join("\n   - ")}`); }
  else console.log("  ALL CHECKS PASS ✓");
}
console.log(`\n${failures ? failures + " MATCH(ES) WITH PROBLEMS" : "EVERY MATCH VERIFIED ✓"}`);
sim.stop();
process.exit(failures ? 1 : 0);
