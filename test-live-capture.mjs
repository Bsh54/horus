// One-off: capture the real live TxLINE feed for a few minutes and summarize
// exactly how live data is shaped, to compare against our simulator's replay.
import { readFileSync, writeFileSync } from "fs";

const creds = JSON.parse(readFileSync("data/txline-credentials.json", "utf8"));
const jwtRes = await fetch(`${creds.api}/auth/guest/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const jwt = (await jwtRes.json()).token;
const H = { Authorization: `Bearer ${jwt}`, "X-Api-Token": creds.apiToken };

// 1. what's on the schedule right now
const fx = await (await fetch(`${creds.api}/api/fixtures/snapshot`, { headers: H })).json();
const list = Array.isArray(fx) ? fx : fx.fixtures || fx.data || [];
console.log("=== fixtures/snapshot ===");
for (const f of list) console.log(f.FixtureId, f.Participant1, "vs", f.Participant2, "| start", new Date(f.StartTime).toISOString(), "| state", f.GameState, "| statusId", f.StatusId);

// 2. capture both SSE streams for 90s
async function capture(path, seconds) {
  const out = [];
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), seconds * 1000);
  try {
    const res = await fetch(creds.api + path, { headers: { ...H, Accept: "text/event-stream" }, signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith("data:")) { try { out.push(JSON.parse(line.slice(5))); } catch {} }
      }
    }
  } catch {}
  return out;
}

console.log("\ncapturing 90s of live streams…");
const [scores, odds] = await Promise.all([capture("/api/scores/stream", 90), capture("/api/odds/stream", 90)]);
writeFileSync("/tmp/live-scores.json", JSON.stringify(scores));
writeFileSync("/tmp/live-odds.json", JSON.stringify(odds));

console.log(`\n=== scores stream: ${scores.length} msgs ===`);
const byFix = {};
for (const m of scores) (byFix[m.FixtureId] = byFix[m.FixtureId] || []).push(m);
for (const [id, ms] of Object.entries(byFix)) {
  const states = [...new Set(ms.map((x) => x.GameState))];
  const statuses = [...new Set(ms.map((x) => x.StatusId))];
  const actions = [...new Set(ms.map((x) => x.Action))].slice(0, 12);
  const last = ms[ms.length - 1];
  console.log(`fixture ${id}: ${ms.length} msgs | GameState=${states} | StatusId=${statuses} | clock=${last.Clock?.Seconds} | score=${last.Stats?.["1"]}-${last.Stats?.["2"]} | actions: ${actions.join(",")}`);
  console.log("  sample:", JSON.stringify(ms[Math.floor(ms.length / 2)]).slice(0, 500));
}

console.log(`\n=== odds stream: ${odds.length} msgs ===`);
const byFixO = {};
for (const m of odds) (byFixO[m.FixtureId] = byFixO[m.FixtureId] || []).push(m);
for (const [id, ms] of Object.entries(byFixO)) {
  const types = [...new Set(ms.map((x) => x.SuperOddsType))];
  const inr = [...new Set(ms.map((x) => x.InRunning))];
  console.log(`fixture ${id}: ${ms.length} msgs | types=${types.join(",")} | InRunning=${inr}`);
  const m1 = ms.find((x) => x.SuperOddsType === "1X2_PARTICIPANT_RESULT");
  if (m1) console.log("  1X2 sample:", JSON.stringify(m1).slice(0, 400));
}
