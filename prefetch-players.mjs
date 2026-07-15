// Prefetch player portraits for the demo matches into data/players/.
// Source order: TheSportsDB cutout (transparent player render, the best
// looking on cards) > TheSportsDB thumb > Wikipedia page thumbnail.
// Public APIs only, polite pacing. Run on the VPS: node prefetch-players.mjs
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";
import { DEMO_MATCHES } from "./simulator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "data", "players");
mkdirSync(OUT, { recursive: true });

const UA = "HorusBot/1.0 (worldcup hackathon; contact: shadobsh@gmail.com)";
const slug = (name) => name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function playersOf(id) {
  const f = join(__dirname, "data", "history", `pbp-${id}.json.gz`);
  if (!existsSync(f)) return [];
  const pbp = JSON.parse(gunzipSync(readFileSync(f)));
  const names = new Set();
  for (const p of pbp.plays || []) {
    if (!/Goal|Card|Penalty|Assist|Substitution|Save|Foul/i.test(p.type || "")) continue;
    for (const m of String(p.text || "").matchAll(/([A-ZÀ-Þ][\p{L}'.-]+(?: [A-ZÀ-Þ][\p{L}'.-]+){1,3}) \(/gu)) names.add(m[1].trim());
  }
  return [...names];
}

async function fetchBuf(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

const deaccent = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

async function sdbSearch(q) {
  const r = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${encodeURIComponent(q)}`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.player || []).find((x) => x.strSport === "Soccer") || null;
}

async function fromSportsDb(name) {
  try {
    let p = await sdbSearch(name);
    if (!p && deaccent(name) !== name) p = await sdbSearch(deaccent(name)); // accents often break the search
    if (!p) return null;
    // cutout (transparent render) beats thumb beats nothing
    if (p.strCutout) { const b = await fetchBuf(p.strCutout); if (b) return { buf: b, kind: "cutout" }; }
    if (p.strThumb) { const b = await fetchBuf(p.strThumb); if (b) return { buf: b, kind: "thumb" }; }
    return null;
  } catch { return null; }
}

async function fromWikipedia(name) {
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, "_"))}?redirect=true`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.description && !/football|soccer/i.test(j.description)) return null;
    if (!j.thumbnail?.source) return null;
    const b = await fetchBuf(j.thumbnail.source);
    return b ? { buf: b, kind: "wiki" } : null;
  } catch { return null; }
}

const all = new Set();
for (const { id } of DEMO_MATCHES) for (const n of playersOf(id)) all.add(n);
console.log(`players referenced in demo events: ${all.size}`);

const counts = { cutout: 0, thumb: 0, wiki: 0, miss: 0, kept: 0 };
const onlyMissing = process.argv[2] === "missing";
for (const name of all) {
  const file = join(OUT, `${slug(name)}.png`);
  const marker = join(OUT, `${slug(name)}.cutout`);
  if (existsSync(marker) || (onlyMissing && existsSync(file))) { counts.kept++; continue; }
  let got = await fromSportsDb(name);
  if (!got && !existsSync(file)) got = await fromWikipedia(name);
  if (got) {
    writeFileSync(file, got.buf);
    if (got.kind === "cutout") writeFileSync(marker, ""); // don't re-fetch best quality
    counts[got.kind]++;
    console.log(`OK  ${name} (${got.kind})`);
  } else if (existsSync(file)) counts.kept++;
  else { counts.miss++; console.log(`MISS ${name}`); }
  await new Promise((r) => setTimeout(r, 2200)); // TheSportsDB free tier: 30 req/min
}
console.log("\ndone:", JSON.stringify(counts));
