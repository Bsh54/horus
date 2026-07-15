// Card service — turns feed events into rendered PNG cards.
// Node builds the JSON job (texts already translated), Python (Pillow) renders
// the validated design. One render per (event × language), reused for every
// follower via the PNG cache; team logos come from SofaScore with a disk cache.
import { spawn } from "child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dirname, "data", "cards-cache");
const LOGOS = join(CACHE, "logos");
mkdirSync(LOGOS, { recursive: true });

const PY = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const RENDER = join(__dirname, "cards", "render.py");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// National-team colours for the side bands (fallback: neutral surface).
const TEAM_COLORS = {
  argentina: [117, 170, 219], egypt: [206, 17, 38], mexico: [0, 104, 71],
  england: [207, 20, 43], brazil: [0, 155, 58], norway: [186, 12, 47],
  belgium: [237, 41, 57], senegal: [0, 133, 62], france: [0, 85, 164],
  spain: [170, 21, 27], morocco: [193, 39, 45], portugal: [0, 98, 65],
  croatia: [23, 82, 165], switzerland: [255, 0, 0], colombia: [252, 209, 22],
  australia: [0, 132, 61], "cape verde": [0, 63, 135], netherlands: [255, 121, 0],
  germany: [35, 31, 32], japan: [188, 0, 45], usa: [60, 59, 110],
};
const teamColor = (name) => TEAM_COLORS[String(name || "").toLowerCase()] || [56, 89, 138];

// ---------------------------------------------------------------------------
// Team badge = national flag from flagcdn.com (public CDN, no auth), cached on
// disk forever; render.py circle-masks it into a round crest.
const TEAM_ISO = {
  argentina: "ar", egypt: "eg", mexico: "mx", england: "gb-eng", brazil: "br",
  norway: "no", belgium: "be", senegal: "sn", france: "fr", spain: "es",
  morocco: "ma", portugal: "pt", croatia: "hr", switzerland: "ch",
  colombia: "co", australia: "au", "cape verde": "cv", "cabo verde": "cv",
  germany: "de", japan: "jp", usa: "us", "united states": "us",
  netherlands: "nl", ghana: "gh", austria: "at", algeria: "dz", canada: "ca",
  paraguay: "py", tunisia: "tn", sweden: "se", vietnam: "vn", myanmar: "mm",
  "new zealand": "nz", india: "in", ecuador: "ec", haiti: "ht",
  "south africa": "za", ukraine: "ua", nigeria: "ng", "ivory coast": "ci",
  "saudi arabia": "sa", qatar: "qa", uruguay: "uy", chile: "cl", peru: "pe",
  italy: "it", poland: "pl", denmark: "dk", scotland: "gb-sct", wales: "gb-wls",
  "south korea": "kr", iran: "ir", uzbekistan: "uz", jordan: "jo", panama: "pa",
  "costa rica": "cr", honduras: "hn", jamaica: "jm", turkey: "tr", greece: "gr",
  serbia: "rs", slovenia: "si", slovakia: "sk", romania: "ro", hungary: "hu",
  czechia: "cz", "czech republic": "cz", albania: "al", georgia: "ge",
};
// Player portraits: pre-fetched Wikimedia images (prefetch-players.mjs) in
// data/players/. No live scraping — a missing photo falls back to initials.
const PLAYERS = join(__dirname, "data", "players");
const slug = (name) => String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export function playerPhoto(name) {
  if (!name) return null;
  const f = join(PLAYERS, `${slug(name)}.png`);
  return existsSync(f) ? f : null;
}

const logoMiss = new Set();
async function teamLogo(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  const iso = TEAM_ISO[key];
  if (!iso) return null;
  const file = join(LOGOS, `${iso}.png`);
  if (existsSync(file)) return file;
  if (logoMiss.has(iso)) return null;
  try {
    const img = await fetch(`https://flagcdn.com/w160/${iso}.png`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(4000) });
    if (!img.ok) { logoMiss.add(iso); return null; }
    writeFileSync(file, Buffer.from(await img.arrayBuffer()));
    return file;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
function runRender(job) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [RENDER], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(0, 300) || `render exit ${code}`)));
    p.on("error", reject);
    p.stdin.write(JSON.stringify(job));
    p.stdin.end();
    setTimeout(() => { try { p.kill(); } catch {} ; reject(new Error("render timeout")); }, 8000).unref?.();
  });
}

// Render (or reuse) a card. cacheKey should identify (fixture, event, lang).
export async function renderCard(cacheKey, job) {
  const out = join(CACHE, `${cacheKey.replace(/[^a-zA-Z0-9_-]+/g, "_")}.png`);
  if (existsSync(out)) return out;
  const [homeLogo, awayLogo] = await Promise.all([teamLogo(job.home.name), teamLogo(job.away.name)]);
  job.home.logo = homeLogo; job.home.color = job.home.color || teamColor(job.home.name);
  job.away.logo = awayLogo; job.away.color = job.away.color || teamColor(job.away.name);
  job.out = out;
  await runRender(job);
  return out;
}

// ---------------------------------------------------------------------------
// Event -> job builders. ctx: { meta:{home,away}, state:{score,minute,...},
// probs:{home,draw,away}, odds:{home,draw,away}, texts:{...translated labels} }
const pct = (p) => Number.isFinite(p) ? Math.round(p * 100) + "%" : "—";

export function buildEventJob(ev, ctx) {
  const { meta, state, probs, prevProbs, odds, texts = {} } = ctx;
  const score = state?.score || [0, 0];
  const minute = state?.minute ?? null;
  const common = {
    home: { name: meta.home }, away: { name: meta.away },
    score, minute, live: true,
  };
  const probLine = probs && prevProbs
    ? `${pct(ev.isHome ? prevProbs.home : prevProbs.away)} → ${pct(ev.isHome ? probs.home : probs.away)}`
    : probs ? pct(ev.isHome ? probs.home : probs.away) : "—";
  const oddsSide = odds ? (ev.isHome ? odds.home : odds.away) : null;

  switch (ev.kind) {
    case "goal": return {
      ...common, kind: "big", badge: texts.goal || "GOAL", badgeColor: "gold",
      hlHome: !!ev.isHome, hlAway: !ev.isHome,
      player: ev.player || { name: ev.isHome ? meta.home : meta.away, halo: true },
      stats: [
        [texts.win_probability || "Win probability", probLine, "gold"],
        ...(oddsSide ? [[`${texts.live_odds || "Live odds"}`, String(oddsSide), "green"]] : []),
      ],
      quote: ev.quote,
    };
    case "red": return {
      ...common, kind: "big", badge: texts.red_card || "RED CARD", badgeColor: "red", badgeFg: "fg",
      player: ev.player || { name: ev.isHome ? meta.home : meta.away, desat: 0.4 },
      redCardIcon: true,
      stats: [
        [texts.men_on_pitch || "Men on pitch", ev.isHome ? "10 v 11" : "11 v 10", "red"],
        [texts.win_probability || "Win probability", probLine, "gold"],
      ],
      quote: ev.quote,
    };
    case "yellow": return {
      ...common, kind: "mini", badge: texts.yellow_card || "YELLOW CARD", badgeColor: "yellow",
      title: ev.title || (texts.yellow_card || "Yellow card"),
      subtitle: ev.subtitle || "",
      statLabel: texts.cards || "Cards",
      statVal: `${(state?.yellow || [0, 0])[0]} - ${(state?.yellow || [0, 0])[1]}`,
      statColor: "yellow",
    };
    case "corner": return {
      ...common, kind: "mini", badge: texts.corner || "CORNER", badgeColor: "gold_deep",
      title: ev.title || (texts.corner || "Corner"),
      subtitle: ev.subtitle || "",
      statLabel: texts.corners || "Corners",
      statVal: `${(state?.corners || [0, 0])[0]} - ${(state?.corners || [0, 0])[1]}`,
      statColor: "gold",
    };
    case "var": return {
      ...common, kind: "big", badge: "VAR", badgeColor: "cyan", sub: "REVIEW",
      centerText: ev.title || texts.var_cancelled || "DECISION OVERTURNED", player: null,
      stats: [[texts.ruling || "Ruling", ev.ruling || "NO GOAL", "cyan"]],
      quote: ev.quote,
    };
    case "kickoff": return {
      ...common, kind: "duel", badge: texts.kickoff || "KICK-OFF", badgeColor: "kick_green",
      stats: odds ? [["1", String(odds.home), "fg"], ["X", String(odds.draw), "fg"], ["2", String(odds.away), "fg"]] : [],
      note: ev.note,
    };
    case "upcoming": return {
      ...common, kind: "duel", badge: texts.upcoming || "UPCOMING", badgeColor: "steel", badgeFg: "fg", live: false,
      centerText: ev.countdown,
      stats: odds ? [["1", String(odds.home), "fg"], ["X", String(odds.draw), "fg"], ["2", String(odds.away), "fg"]] : [],
      note: ev.note,
    };
    case "fulltime": return {
      ...common, kind: "fulltime", badge: texts.fulltime || "FULL-TIME", badgeColor: "fg", live: false,
      stats: [
        [texts.corners || "Corners", `${(state?.corners || [0, 0])[0]} - ${(state?.corners || [0, 0])[1]}`, "fg"],
        [texts.cards || "Cards", `${(state?.yellow || [0, 0])[0] + (state?.red || [0, 0])[0]} - ${(state?.yellow || [0, 0])[1] + (state?.red || [0, 0])[1]}`, "fg"],
      ],
      verified: ev.verified, quote: ev.quote,
    };
    case "market": return {
      ...common, kind: "big", badge: texts.odds_moved || "MARKET ALERT", badgeColor: "violet", badgeFg: "fg",
      sub: "SHARP MONEY", player: null,
      stats: [
        [texts.win_probability || "Win probability", probLine, "violet"],
        ...(odds ? [[texts.consensus || "Consensus 1X2", `${odds.home} / ${odds.draw} / ${odds.away}`, "violet"]] : []),
      ],
      quote: ev.quote,
    };
    default: return null;
  }
}
