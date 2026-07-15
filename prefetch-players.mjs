// Prefetch player portraits for the demo matches into data/players/.
// Source: Wikipedia page thumbnails (freely licensed Wikimedia images) —
// deliberately no scraping of sources that refuse automated access.
// Run once on the VPS: node prefetch-players.mjs
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";
import { DEMO_MATCHES } from "./simulator.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "data", "players");
mkdirSync(OUT, { recursive: true });

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const slug = (name) => name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---- collect player names from the pbp archives of the demo matches ----
function playersOf(id) {
  const f = join(__dirname, "data", "history", `pbp-${id}.json.gz`);
  if (!existsSync(f)) return [];
  const pbp = JSON.parse(gunzipSync(readFileSync(f)));
  const names = new Set();
  for (const p of pbp.plays || []) {
    if (!/Goal|Card|Penalty|Assist|Substitution|Save/i.test(p.type || "")) continue;
    // narrative texts carry "FirstName LastName (Team)" — capture all
    for (const m of String(p.text || "").matchAll(/([A-ZÀ-Þ][\p{L}'.-]+(?: [A-ZÀ-Þ][\p{L}'.-]+){1,3}) \(/gu)) {
      names.add(m[1].trim());
    }
  }
  return [...names];
}

async function fromWikipedia(name, attempt = 0) {
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, "_"))}?redirect=true`,
      { headers: { "User-Agent": "HorusBot/1.0 (worldcup hackathon; contact: shadobsh@gmail.com)" }, signal: AbortSignal.timeout(8000) });
    if (r.status === 429 && attempt < 3) {
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      return fromWikipedia(name, attempt + 1);
    }
    if (!r.ok) { console.log(`  [${r.status}] ${name}`); return null; }
    const j = await r.json();
    // only accept footballer pages to avoid namesakes
    if (j.description && !/football|soccer/i.test(j.description)) return null;
    const src = j.thumbnail?.source;
    if (!src) return null;
    const img = await fetch(src, { headers: { "User-Agent": "HorusBot/1.0 (worldcup hackathon; contact: shadobsh@gmail.com)" }, signal: AbortSignal.timeout(8000) });
    if (img.status === 429 && attempt < 3) {
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      return fromWikipedia(name, attempt + 1);
    }
    if (!img.ok) { console.log(`  [img ${img.status}] ${name}`); return null; }
    return Buffer.from(await img.arrayBuffer());
  } catch (e) { console.log(`  [err ${e.message}] ${name}`); return null; }
}

const all = new Set();
for (const { id } of DEMO_MATCHES) for (const n of playersOf(id)) all.add(n);
console.log(`players referenced in demo events: ${all.size}`);

let ok = 0, miss = [];
for (const name of all) {
  const file = join(OUT, `${slug(name)}.png`);
  if (existsSync(file)) { ok++; continue; }
  const buf = await fromWikipedia(name);
  if (buf) { writeFileSync(file, buf); ok++; console.log(`OK  ${name}`); }
  else { miss.push(name); console.log(`MISS ${name}`); }
  await new Promise((r) => setTimeout(r, 300)); // stay polite
}
console.log(`\ndone: ${ok}/${all.size} — missing: ${miss.length}`);
if (miss.length) console.log(miss.join(" | "));
