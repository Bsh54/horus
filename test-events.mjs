// Quick check: decode real match events for France - Spain (18237038)
import { readFileSync } from "fs";
const creds = JSON.parse(readFileSync("data/txline-credentials.json", "utf8"));
const jwt = (await (await fetch(creds.api + "/auth/guest/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).token;
const H = { Authorization: "Bearer " + jwt, "X-Api-Token": creds.apiToken };
const r = await fetch(creds.api + "/api/scores/snapshot/18237038", { headers: H });
const rows = JSON.parse(await r.text());
console.log("states:", rows.length);
const dec = (S) => {
  const g = (k) => { const v = S[String(k)]; return Array.isArray(v) ? v[0] : (v ?? 0); };
  return { score: [g(1), g(2)], yellow: [g(3), g(4)], red: [g(5), g(6)] };
};
let prev = null;
for (const m of rows.sort((a, b) => (a.Ts || 0) - (b.Ts || 0))) {
  if (!m.Stats) continue;
  const d = dec(m.Stats);
  const min = m.Clock?.Seconds != null ? Math.floor(m.Clock.Seconds / 60) : null;
  if (prev) {
    for (const s of [0, 1]) {
      if (d.score[s] > prev.score[s]) console.log("GOAL side", s, "min", min, "score", d.score.join("-"));
      if (d.yellow[s] > prev.yellow[s]) console.log("YELLOW side", s, "min", min);
      if (d.red[s] > prev.red[s]) console.log("RED side", s, "min", min);
    }
    if (m.StatusId !== prev.st) console.log("PHASE", m.StatusId, "min", min);
  }
  prev = { score: d.score, yellow: d.yellow, red: d.red, st: m.StatusId };
}
