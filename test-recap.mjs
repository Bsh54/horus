// Smoke test: recap parsing on Spain-Belgium (18218149) — English, no send.
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";

const meta = { home: "Spain", away: "Belgium" };
const pbp = JSON.parse(gunzipSync(readFileSync("data/history/pbp-18218149.json.gz")));
const norm = (s) => String(s || "").toLowerCase();
const sideOfTeam = (team) => {
  if (!team) return -1;
  const t = norm(team);
  if (norm(meta.home).includes(t) || t.includes(norm(meta.home).split(" ")[0])) return 0;
  if (norm(meta.away).includes(t) || t.includes(norm(meta.away).split(" ")[0])) return 1;
  return -1;
};
const parenTeam = (t) => String(t).match(/\(([^)]+)\)/)?.[1];
const GOAL_TYPES = new Set(["Goal", "Goal - Header", "Own Goal", "Penalty - Scored"]);
const lines = [];
const tally = { fouls: [0, 0], shotsOn: [0, 0], shotsOff: [0, 0], offsides: [0, 0], saves: [0, 0] };
const bump = (k, s) => { if (s >= 0) tally[k][s]++; };
let unmatched = 0;
for (const p of pbp.plays) {
  const ty = p.type || "";
  const min = p.min != null ? `${p.min}'` : "-";
  if (GOAL_TYPES.has(ty)) lines.push(`${min} GOAL ${p.text.slice(0, 60)}`);
  else if (ty === "Yellow Card") lines.push(`${min} YEL ${p.text.slice(0, 50)}`);
  else if (ty === "Halftime") lines.push(`${min} HT`);
  else if (ty === "End Regular Time") lines.push(`${min} FT`);
  else if (ty === "Foul") { const s = sideOfTeam(parenTeam(p.text)); if (s < 0) unmatched++; bump("fouls", s); }
  else if (ty === "Shot On Target") bump("shotsOn", sideOfTeam(parenTeam(p.text)));
  else if (ty === "Shot Off Target" || ty === "Shot Blocked") bump("shotsOff", sideOfTeam(parenTeam(p.text)));
  else if (ty === "Offside") bump("offsides", sideOfTeam(parenTeam(p.text)));
  else if (ty === "Save") bump("saves", sideOfTeam(parenTeam(p.text)));
}
console.log(lines.join("\n"));
console.log("fouls", tally.fouls, "shotsOn", tally.shotsOn, "shotsOff", tally.shotsOff, "offsides", tally.offsides, "saves", tally.saves, "| unmatched fouls:", unmatched);
const fouls = pbp.plays.filter((p) => p.type === "Foul");
console.log("total fouls:", fouls.length,
  "| 'Foul by':", fouls.filter((p) => /Foul by/.test(p.text)).length,
  "| 'wins a free kick':", fouls.filter((p) => /wins a free kick/.test(p.text)).length);
for (const t of fouls.slice(0, 6)) console.log("-", t.text.slice(0, 85));
