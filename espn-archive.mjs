// Archive ESPN play-by-play for every catalogued match that has a TxLINE
// odds archive. Maps ESPN events to our fixtures by team names + date, then
// stores the meaningful plays as data/history/pbp-{fixtureId}.json.gz.
// Run on the server: node espn-archive.mjs
import { readFileSync, writeFileSync, existsSync } from "fs";
import { gzipSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "data");
const HIST = join(DATA, "history");

const LEAGUE = "fifa.world";
const SB = (d) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}/scoreboard?dates=${d}`;
const PLAYS = (id, page) => `https://sports.core.api.espn.com/v2/sports/soccer/leagues/${LEAGUE}/events/${id}/competitions/${id}/plays?limit=500&page=${page}`;

// play types that carry no story — dropped to keep ~1300 plays down to the action
const NOISE = /^(pass|throw in|clear|interception|out|take on|cross|ball recovery|dispossessed|aerial|tackle|block|start|end|good skill|error|punch|claim|smother|keeper pick-up|pick-up)$/i;

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, "").trim();
const ALIAS = {
  "usa": "united states", "korea republic": "south korea", "ir iran": "iran",
  "cote divoire": "ivory coast", "curacao": "curacao",
};
const canon = (s) => ALIAS[norm(s)] || norm(s);
const sameTeam = (a, b) => {
  const x = canon(a), y = canon(b);
  return x === y || x.includes(y) || y.includes(x);
};

async function jget(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const catalog = JSON.parse(readFileSync(join(DATA, "fixtures-catalog.json"), "utf8"));
const targets = catalog.filter((c) => existsSync(join(HIST, `t1x2-${c.id}.json.gz`)));
console.log(`${targets.length} archived fixtures to map`);

// one scoreboard call per distinct match day
const days = [...new Set(targets.map((c) => new Date(c.startTime).toISOString().slice(0, 10).replace(/-/g, "")))].sort();
const espnEvents = [];
for (const d of days) {
  try {
    const sb = await jget(SB(d));
    for (const ev of sb.events || []) {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find((c) => c.homeAway === "home")?.team?.displayName;
      const away = comp?.competitors?.find((c) => c.homeAway === "away")?.team?.displayName;
      espnEvents.push({ id: ev.id, date: ev.date, home, away });
    }
    console.log(`scoreboard ${d}: ${(sb.events || []).length} events`);
  } catch (e) { console.log(`scoreboard ${d} failed: ${e.message}`); }
}

let mapped = 0, fetched = 0, skipped = 0;
const unmatched = [];
for (const fx of targets) {
  const out = join(HIST, `pbp-${fx.id}.json.gz`);
  const fxDay = new Date(fx.startTime).toISOString().slice(0, 10);
  const ev = espnEvents.find((e) =>
    e.date && e.date.slice(0, 10) === fxDay &&
    ((sameTeam(e.home, fx.home) && sameTeam(e.away, fx.away)) ||
     (sameTeam(e.home, fx.away) && sameTeam(e.away, fx.home))));
  if (!ev) { unmatched.push(`${fx.id} ${fx.home} vs ${fx.away} ${fxDay}`); continue; }
  mapped++;
  if (existsSync(out)) { skipped++; continue; }
  try {
    const plays = [];
    for (let page = 1; page <= 6; page++) {
      const pg = await jget(PLAYS(ev.id, page));
      for (const p of pg.items || []) {
        const type = p.type?.text || "";
        if (NOISE.test(type)) continue;
        const text = p.text || p.shortText || type;
        if (!text) continue;
        plays.push({
          min: parseInt(p.clock?.displayValue, 10) || null,
          period: p.period?.number || null,
          type, text: text.slice(0, 300),
          goal: !!p.scoringPlay,
        });
      }
      if (!pg.pageCount || page >= pg.pageCount) break;
    }
    writeFileSync(out, gzipSync(JSON.stringify({ espnId: ev.id, home: fx.home, away: fx.away, plays })));
    fetched++;
    console.log(`pbp ${fx.id} ${fx.home} vs ${fx.away}: ${plays.length} plays`);
  } catch (e) { console.log(`pbp ${fx.id} failed: ${e.message}`); }
}
console.log(`\nmapped ${mapped}/${targets.length} · fetched ${fetched} · already had ${skipped}`);
if (unmatched.length) console.log(`unmatched:\n${unmatched.join("\n")}`);
