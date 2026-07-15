// Build data/fixtures-catalog.json: every fixture the feed has ever listed
// (walking the past with startEpochDay), so the bot can offer any archived
// match for replay. Run once, rerun anytime to refresh.
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "data");
const creds = JSON.parse(readFileSync(join(DATA, "txline-credentials.json"), "utf8"));

const jwt = (await (await fetch(creds.api + "/auth/guest/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).token;
const today = Math.floor(Date.now() / 86400000);
const seen = new Map();
for (let d = today - 70; d <= today; d += 25) {
  const r = await fetch(`${creds.api}/api/fixtures/snapshot?startEpochDay=${d}`, { headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": creds.apiToken } });
  if (!r.ok) continue;
  for (const f of await r.json()) {
    if (!f.FixtureId) continue;
    const p1Home = f.Participant1IsHome !== false;
    seen.set(f.FixtureId, {
      id: f.FixtureId,
      home: p1Home ? f.Participant1 : f.Participant2,
      away: p1Home ? f.Participant2 : f.Participant1,
      competition: f.Competition || "",
      startTime: f.StartTime || 0,
    });
  }
}
const list = [...seen.values()].sort((a, b) => b.startTime - a.startTime);
writeFileSync(join(DATA, "fixtures-catalog.json"), JSON.stringify(list, null, 1));
console.log(`catalog: ${list.length} fixtures`);
