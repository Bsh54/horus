// HORUS — the eye on every match.
// Pundit engine: turns feed events into fan-facing commentary with market
// context (win probabilities, odds moves), and broadcasts any archived match
// of the tournament progressively, as if it were live. Fully deterministic —
// no external AI service involved.
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";
import { translate, t as tKey, term } from "./i18n.mjs";
import { langOf, isPremium } from "./users.mjs";
import { renderCard, buildEventJob, playerPhoto } from "./cards.mjs";
import { quoteFor, polish } from "./personas.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "data");

const pctS = (p) => (Number.isFinite(p) ? (p * 100).toFixed(0) + "%" : "—");

// phrase the 1X2 picture as a pundit sentence, not a data dump
function marketPhrase(meta, p) {
  if (!p || !Number.isFinite(p.home)) return "";
  if (p.draw >= p.home && p.draw >= p.away)
    return `The market leans towards a draw at ${pctS(p.draw)}, with ${meta.home} at ${pctS(p.home)} and ${meta.away} at ${pctS(p.away)}.`;
  const fav = p.home >= p.away ? meta.home : meta.away;
  const out = p.home >= p.away ? meta.away : meta.home;
  const favP = Math.max(p.home, p.away), outP = Math.min(p.home, p.away);
  if (favP - outP < 0.08)
    return `The market can't split them — ${meta.home} ${pctS(p.home)}, ${meta.away} ${pctS(p.away)}, the draw ${pctS(p.draw)}.`;
  return `The market makes ${fav} favourites at ${pctS(favP)}; ${out} are given ${pctS(outP)}, the draw ${pctS(p.draw)}.`;
}

export function createHorus({ bot, journal, getMeta, getProbs, getState }) {
  // per-fixture last known probabilities to phrase "before -> after"
  const probMem = new Map();

  // ---------------------------------------------------------------------------
  // Narration templates (deterministic core)
  // ---------------------------------------------------------------------------
  function marketLine(fixtureId) {
    const p = getProbs(fixtureId);
    if (!p) return "";
    const meta = getMeta(fixtureId) || { home: "Home", away: "Away" };
    return marketPhrase(meta, p);
  }

  function describe(fixtureId, ev) {
    const meta = getMeta(fixtureId) || { home: "Home", away: "Away" };
    const st = getState(fixtureId) || {};
    const score = st.score ? `${st.score[0]}-${st.score[1]}` : "";
    const min = st.minute != null ? `${st.minute}'` : "";
    const before = probMem.get(fixtureId);
    const now = getProbs(fixtureId);
    let head = "", body = "";
    if (ev.kind === "goal") {
      const team = ev.isHome ? meta.home : meta.away;
      head = `⚽ GOAL — ${team}! ${meta.home} ${score} ${meta.away} (${min})`;
      if (before && now) {
        const side = ev.isHome ? "home" : "away";
        body = `${team} jump from ${pctS(before[side])} to ${pctS(now[side])} win probability.`;
      }
    } else if (ev.kind === "red") {
      const team = ev.isHome ? meta.home : meta.away;
      head = `🟥 RED CARD — ${team} down to ten men (${min}), score ${score}`;
      if (before && now) {
        const side = ev.isHome ? "home" : "away";
        body = `The market just cut ${team} from ${pctS(before[side])} to ${pctS(now[side])}.`;
      }
    } else if (ev.kind === "period") {
      head = `⏱ ${ev.text} — ${meta.home} ${score} ${meta.away}`;
    } else if (ev.kind === "steam") {
      const team = ev.side === "home" ? meta.home : ev.side === "away" ? meta.away : "the draw";
      head = `🚨 SHARP MOVE — big money arriving on ${team}`;
      body = ev.detail || "";
    }
    return { head, body, market: marketLine(fixtureId), meta };
  }

  async function notifyFollowers(fixtureId, ev) {
    if (!bot) return;
    const followers = bot.followersOf(fixtureId);
    if (!followers.length) return;
    const d = describe(fixtureId, ev);
    if (!d.head) return;
    const text = [d.head, d.body, d.market].filter(Boolean).join("\n");
    journal({ kind: "pundit", fixtureId, event: ev.kind, text });
    // Stage 1 — instant text ping, one translation per language (cached)
    await Promise.all(followers.map(async (f) => {
      const out = await translate(text, langOf(f.chatId));
      return bot.sendText(f.chatId, out);
    }));
    // Stage 2 — rich visual card for premium followers (never blocks stage 1)
    dispatchCards(fixtureId, ev, d).catch((e) => console.log("[cards]", e.message));
  }

  // Demo enrichment: TxLINE streams are team-level, but for replayed matches
  // the play-by-play archive names the scorer — find the play matching the
  // new score and pull the player (name + pre-fetched Wikimedia portrait).
  function playerFromPbp(fixtureId, kind, score, minute = null) {
    try {
      const pbp = loadPbp(fixtureId);
      if (!pbp?.plays) return null;
      let name = null;
      if (kind === "goal" && score) {
        const play = pbp.plays.find((p) => p.goal && p.text?.includes(` ${score[0]},`) && p.text?.includes(` ${score[1]}.`));
        name = play?.text?.match(/\d\.\s+([\p{Lu}][\p{L}'.-]+(?: [\p{Lu}][\p{L}'.-]+){0,3}) \(/u)?.[1] || null;
      } else if (kind === "red") {
        const play = pbp.plays.findLast((p) => /Red Card/i.test(p.type || ""));
        name = play?.text?.match(/^([\p{Lu}][\p{L}'.-]+(?: [\p{Lu}][\p{L}'.-]+){0,3}) \(/u)?.[1] || null;
      } else if (kind === "yellow" && minute != null) {
        // the booking closest to the current playback minute
        const cands = pbp.plays.filter((p) => p.type === "Yellow Card" && p.min != null);
        const play = cands.sort((a, b) => Math.abs(a.min - minute) - Math.abs(b.min - minute))[0];
        if (play && Math.abs(play.min - minute) <= 3)
          name = play.text?.match(/^([\p{Lu}][\p{L}'.-]+(?: [\p{Lu}][\p{L}'.-]+){0,3}) \(/u)?.[1] || null;
      }
      if (!name) return null;
      return { name, photo: playerPhoto(name), halo: kind === "goal", desat: kind === "red" ? 0.4 : 0 };
    } catch { return null; }
  }

  // Map feed events onto card kinds; render once per (event × language) and
  // fan the PNG out to premium followers (Telegram file_id reuse in bot).
  const CARD_KIND = { goal: "goal", red: "red", steam: "market" };
  async function dispatchCards(fixtureId, ev, d) {
    let kind = CARD_KIND[ev.kind];
    if (ev.kind === "period" && /finished|full/i.test(ev.text || "")) kind = "fulltime";
    else if (ev.kind === "period" && /1st half/i.test(ev.text || "")) kind = "kickoff";
    else if (ev.kind === "period" && ev.text) kind = "phase"; // halftime, 2nd half, ET…
    if (!kind) return;
    const premium = bot.followersOf(fixtureId); // everyone gets cards now
    if (!premium.length) return;
    const st = getState(fixtureId) || {};
    if (kind === "fulltime" && st.seq) ev = { ...ev, verified: `VERIFIED — TxLINE proof on Solana · seq ${st.seq} · statKey 1` };
    if (!ev.player && (kind === "goal" || kind === "red")) {
      const p = playerFromPbp(fixtureId, kind, st.score);
      if (p) ev = { ...ev, player: p };
    }
    const ctx = {
      meta: d.meta, state: st,
      probs: getProbs(fixtureId), prevProbs: probMem.get(fixtureId), odds: null,
    };
    const byLang = new Map();
    for (const f of premium) {
      const lang = langOf(f.chatId);
      if (!byLang.has(lang)) byLang.set(lang, []);
      byLang.get(lang).push(f.chatId);
    }
    // Persona voice: deterministic line, one optional LLM polish (3s budget),
    // then translated per language. Facts come from the live state only.
    const team = ev.isHome ? d.meta.home : d.meta.away;
    const baseQuote = quoteFor(kind, {
      fixtureId, team, player: ev.player?.name,
      minute: st.minute, score: (st.score || []).join("-"),
      prob: ctx.probs ? Math.round((ev.isHome ? ctx.probs.home : ctx.probs.away) * 100) + "%" : "—",
      fav: ctx.probs ? (ctx.probs.home >= ctx.probs.away ? d.meta.home : d.meta.away) : "",
      remaining: st.minute != null ? Math.max(0, 90 - st.minute) : "the remaining",
      ruling: ev.ruling || "decision overturned",
      move: ev.detail || "sharply", window: "minutes",
      count: (st.corners || [])[ev.isHome ? 0 : 1],
    });
    const quote = await polish(kind, baseQuote, `${d.meta.home} ${(st.score || []).join("-")} ${d.meta.away}, minute ${st.minute}`);
    for (const [lang, chatIds] of byLang) {
      const texts = {};
      for (const k of ["goal", "red_card", "yellow_card", "corner", "win_probability", "fulltime", "kickoff", "odds_moved"])
        texts[k] = (await tKey(k, lang)).toUpperCase();
      const quoteText = await translate(quote.text, lang);
      const evLang = kind === "phase" && ev.text ? { ...ev, text: await translate(ev.text, lang) } : ev;
      const job = buildEventJob({ ...evLang, kind, quote: { author: quote.author, text: quoteText } }, { ...ctx, texts });
      if (!job) continue;
      const cacheKey = `${fixtureId}-${kind}-${(st.score || []).join("")}-${st.minute ?? "x"}-${lang}`;
      try {
        const png = await renderCard(cacheKey, job);
        await Promise.all(chatIds.map((cid) => bot.sendPhoto(cid, png)));
      } catch (e) { console.log("[cards] render failed:", e.message); }
    }
  }

  // called after each odds tick so "before" is the pre-event picture
  function rememberProbs(fixtureId) {
    const p = getProbs(fixtureId);
    if (p) setTimeout(() => probMem.set(fixtureId, p), 5000); // lag memory ~5s behind
  }

  // ---------------------------------------------------------------------------
  // /relive — time machine: replay an archived match's market story
  // ---------------------------------------------------------------------------
  function loadTicksFor(fixtureId) {
    const f = join(DATA, "history", `t1x2-${fixtureId}.json.gz`);
    if (!existsSync(f)) return null;
    return JSON.parse(gunzipSync(readFileSync(f)).toString());
  }

  // archived play-by-play (fetched once from the public feed) — every foul,
  // shot, save, card, corner and substitution with its minute
  function loadPbp(fixtureId) {
    const f = join(DATA, "history", `pbp-${fixtureId}.json.gz`);
    if (!existsSync(f)) return null;
    try { return JSON.parse(gunzipSync(readFileSync(f)).toString()); } catch { return null; }
  }

  // which plays make the broadcast, by importance (0 = always shown)
  const PLAY_PRIORITY = {
    "Kickoff": 0, "Goal": 0, "Own Goal": 0, "Penalty Goal": 0, "Penalty Kick Missed": 0,
    "Red Card": 0, "Second Yellow Card": 0, "Halftime": 0, "Start 2nd Half": 0, "End Regular Time": 0,
    "Yellow Card": 1, "Save": 1, "Shot On Target": 1,
    "Shot Off Target": 2, "Shot Blocked": 2, "Corner Awarded": 2, "Substitution": 2,
    "Offside": 3, "Handball": 3, "Foul": 3,
  };
  const PLAY_EMOJI = {
    "Goal": "⚽", "Own Goal": "⚽", "Penalty Goal": "⚽", "Penalty Kick Missed": "😮",
    "Red Card": "🟥", "Second Yellow Card": "🟥", "Yellow Card": "🟨",
    "Save": "🧤", "Shot On Target": "🎯", "Shot Off Target": "💨", "Shot Blocked": "🚧",
    "Corner Awarded": "⛳", "Substitution": "🔁", "Offside": "🚩", "Foul": "⚠️", "Handball": "⚠️",
  };
  const isGoalPlay = (p) => p.goal || /goal$/i.test(p.type);

  // Build the broadcast from real play-by-play: structural moments and goals
  // always in, then shots/saves/cards/corners/fouls fill the message budget
  // for the chosen pace. Market reads are injected at kick-off, half-time
  // and right after each goal from the archived odds.
  function pbpTimeline(pbp, meta, durationSec, ticks) {
    const budget = Math.max(20, Math.floor(durationSec / 5)); // ~1 message / 5s max
    // idx keeps true chronological order (minutes alone tie in stoppage time);
    // structural plays at 0' arrive with a null minute from the archive
    const plays = (pbp.plays || [])
      .map((p, idx) => ({ ...p, idx, min: p.min ?? (PLAY_PRIORITY[p.type] === 0 ? 0 : null) }))
      .filter((p) => PLAY_PRIORITY[p.type] != null && p.min != null);
    const chosen = plays.filter((p) => PLAY_PRIORITY[p.type] === 0);
    for (const lvl of [1, 2, 3]) {
      const room = budget - chosen.length;
      if (room <= 0) break;
      const cand = plays.filter((p) => PLAY_PRIORITY[p.type] === lvl);
      chosen.push(...(cand.length <= room
        ? cand
        : cand.filter((_, i) => i % Math.ceil(cand.length / room) === 0).slice(0, room)));
    }
    chosen.sort((a, b) => a.idx - b.idx);
    // odds lookup by match minute (2nd half shifted by the interval)
    const inPlay = ticks.filter((t) => t.ir);
    const kickTs = inPlay.length ? inPlay[0].ts : null;
    const probAt = (min, period) => {
      if (kickTs == null) return null;
      const target = kickTs + (min + (period >= 2 ? 15 : 0)) * 60000;
      const t = inPlay.reduce((a, b) => (Math.abs(b.ts - target) < Math.abs(a.ts - target) ? b : a));
      return probOf(t);
    };
    // running score/cards tracked from the FULL play list, so cards carry
    // correct cumulative stats even for plays the text budget skipped
    const nameOf = (t) => String(t || "").match(/(?:\d\.\s+|^)([\p{Lu}][\p{L}'.’-]+(?: [\p{Lu}][\p{L}'.’-]+){0,3}) \(/u)?.[1] || null;
    const teamOf = (t) => String(t || "").match(/\(([^)]+)\)/)?.[1] || null;
    const isHomeTeam = (t) => teamOf(t) != null && String(meta.home).toLowerCase().includes(String(teamOf(t)).toLowerCase().split(" ")[0]);
    return chosen.map((p) => {
      let txt, card = null;
      const probs = probAt((p.min || 0) + 1, p.period);
      if (p.type === "Kickoff") {
        txt = `⏱ <b>We're underway — ${meta.home} against ${meta.away}.</b> ${marketPhrase(meta, probAt(0, 1))}`;
        card = { kind: "kickoff" };
      } else if (p.type === "Halftime") {
        txt = `⏱ <b>Half-time.</b> ${marketPhrase(meta, probAt(p.min || 45, 1))}`;
        card = { kind: "phase", text: "Half-time" };
      } else if (p.type === "Start 2nd Half") txt = "⏱ <b>Second half underway.</b>";
      else if (p.type === "End Regular Time") {
        txt = "🏁 <b>Full time.</b>";
        card = { kind: "fulltime" };
      } else if (isGoalPlay(p)) {
        const mkt = marketPhrase(meta, probs);
        txt = `⚽ <b>${p.text}</b>${mkt ? "\n" + mkt : ""}`;
        // "Goal! Argentina 1, Egypt 0. Player (Team)…" — score straight from the text
        const sc = String(p.text).match(/ (\d+)(?:\(\d+\))?, .*? (\d+)(?:\(\d+\))?\./);
        card = { kind: "goal", player: nameOf(p.text), isHome: isHomeTeam(p.text),
                 score: sc ? [Number(sc[1]), Number(sc[2])] : null, probs };
      } else {
        txt = `${PLAY_EMOJI[p.type] || ""} ${p.text}`.trim();
        if (/Red Card|Second Yellow/i.test(p.type))
          card = { kind: "red", player: nameOf(p.text), isHome: isHomeTeam(p.text), probs };
      }
      // paced on match minutes so quiet spells compress and action clusters
      return { ts: p.min * 60000 + p.idx, kind: p.type, big: isGoalPlay(p) || /Red|Second Yellow/i.test(p.type), min: p.min, txt, card };
    });
  }

  // ---------------------------------------------------------------------------
  // DeepSeek colour layer — rewrites the whole timeline as lively broadcast
  // lines in one call before pacing starts. Fully optional: any failure or
  // slow answer falls back to the deterministic lines.
  // ---------------------------------------------------------------------------
  const LLM_FILE = join(DATA, "deepseek.json");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  async function llmRewrite(meta, moments) {
    if (!existsSync(LLM_FILE)) return null;
    try {
      const cfg = JSON.parse(readFileSync(LLM_FILE, "utf8"));
      const lines = moments.map((m, i) => `${i}| ${m.txt.replace(/<[^>]+>/g, "")}`);
      const r = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
        body: JSON.stringify({
          model: cfg.model || "deepseek-chat",
          thinking: { type: "disabled" },
          temperature: 0.9,
          max_tokens: 4000,
          messages: [
            { role: "system", content: "You are HORUS, a professional live football commentator. Rewrite each numbered event line as one short, vivid line of live broadcast commentary (max 22 words). Keep every fact exact: minutes, player names, team names, scores, percentages. Professional tone, no hype words, no hashtags, keep the leading emoji if the line has one. Return ONLY a JSON array of strings, same count and order as the input." },
            { role: "user", content: `Match: ${meta.home} vs ${meta.away}, FIFA World Cup 2026.\n${lines.join("\n")}` },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json();
      const content = j.choices?.[0]?.message?.content || "";
      const arr = JSON.parse(content.slice(content.indexOf("["), content.lastIndexOf("]") + 1));
      if (!Array.isArray(arr) || arr.length !== moments.length) return null;
      return moments.map((m, i) => {
        const line = esc(arr[i]).trim();
        return { ...m, txt: m.big || /^⏱|^🏁/.test(m.txt) ? `<b>${line}</b>` : line };
      });
    } catch { return null; }
  }

  // One-shot grounded Q&A: answers ONLY from the live context we hand it.
  // If DeepSeek is fluent in the fan's language it answers directly;
  // otherwise it answers in English and we translate.
  async function ask(question, context, lang = "en", speaks = true) {
    if (!existsSync(LLM_FILE)) return null;
    const cfg = JSON.parse(readFileSync(LLM_FILE, "utf8"));
    const answerLang = speaks ? lang : "en";
    try {
      const r = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({
          model: cfg.model || "deepseek-chat",
          thinking: { type: "disabled" },
          temperature: 0.7, max_tokens: 400,
          messages: [
            { role: "system", content: `You are HORUS, a sharp football pundit. Answer the fan's question using ONLY the live data below — never invent scores, odds or facts not present. If the data doesn't cover it, say so briefly. Max 80 words. Answer in language code "${answerLang}".\n\nLIVE DATA:\n${context}` },
            { role: "user", content: question },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });
      const j = await r.json();
      let out = j.choices?.[0]?.message?.content?.trim();
      if (!out) return null;
      if (!speaks && lang !== "en") out = await translate(out, lang);
      return esc(out);
    } catch { return null; }
  }

  function probOf(t) {
    if (t.pct && t.pct.length === 3) { const s = t.pct[0] + t.pct[1] + t.pct[2]; return { home: t.pct[0] / s, draw: t.pct[1] / s, away: t.pct[2] / s }; }
    const inv = [1000 / t.p[0], 1000 / t.p[1], 1000 / t.p[2]]; const s = inv[0] + inv[1] + inv[2];
    return { home: inv[0] / s, draw: inv[1] / s, away: inv[2] / s };
  }

  // condense a full odds history into the key market moments
  function keyMoments(ticks, meta) {
    const out = [];
    let prev = null, kickoff = null;
    for (const t of ticks) {
      const p = probOf(t);
      if (t.ir && kickoff == null) { kickoff = t.ts; out.push({ ts: t.ts, txt: `⏱ <b>We're underway — ${meta.home} against ${meta.away}.</b> ${marketPhrase(meta, p)}` }); }
      if (prev) {
        for (const side of ["home", "away", "draw"]) {
          const d = p[side] - prev[side];
          if (Math.abs(d) >= 0.14 && t.ir) {
            const team = side === "home" ? meta.home : side === "away" ? meta.away : "The draw";
            const min = kickoff ? Math.round((t.ts - kickoff) / 60000) + "'" : "";
            out.push({ ts: t.ts, txt: d > 0
              ? `💥 Market shock (${min}): ${team} surge ${pctS(prev[side])} → ${pctS(p[side])} — almost certainly a goal or a red card.`
              : `📉 (${min}) ${team} collapse ${pctS(prev[side])} → ${pctS(p[side])}.` });
            prev = p;
          }
        }
      }
      if (!prev || Math.abs(probOf(t).home - prev.home) > 0.02) prev = p;
    }
    const last = ticks[ticks.length - 1];
    if (last) {
      const p = probOf(last);
      const winner = p.home > 0.8 ? meta.home : p.away > 0.8 ? meta.away : p.draw > 0.8 ? "a draw" : null;
      if (winner) out.push({ ts: last.ts, txt: `🏁 <b>Full time.</b> ${winner === "a draw" ? "It ends level" : winner + " take it"}.` });
    }
    // keep at most 12 moments
    return out.length > 12 ? [out[0], ...out.slice(1, -1).filter((_, i) => i % Math.ceil((out.length - 2) / 10) === 0), out[out.length - 1]] : out;
  }

  // Build the progressive timeline of a match from its archived ticks:
  // kick-off, market shocks (goals/cards seen through the odds), closing
  // verdict. No filler — a message only ever means something happened.
  function buildTimeline(ticks, meta) {
    return keyMoments(ticks, meta).sort((a, b) => a.ts - b.ts);
  }

  // Real score events (from the archived score states) rendered as broadcast lines
  function eventMoments(events, meta) {
    const out = [];
    for (const e of events || []) {
      const team = e.isHome ? meta.home : meta.away;
      const min = e.minute != null && Number.isFinite(e.minute) ? ` (${e.minute}')` : "";
      const sc = e.score && e.score[0] != null ? `${meta.home} ${e.score[0]}-${e.score[1]} ${meta.away}` : "";
      const stats = e.stats
        ? `\nCorners ${e.stats.corners[0]}-${e.stats.corners[1]} · Yellows ${e.stats.yellow[0]}-${e.stats.yellow[1]}${(e.stats.red[0] || e.stats.red[1]) ? ` · Reds ${e.stats.red[0]}-${e.stats.red[1]}` : ""}`
        : "";
      if (e.kind === "goal") out.push({ ts: e.ts, big: true, txt: `⚽ <b>GOAL — ${team}.</b> ${sc}${min}` });
      else if (e.kind === "red") out.push({ ts: e.ts, big: true, txt: `🟥 <b>Red card — ${team} down to ten.</b>${min} ${sc}` });
      else if (e.kind === "yellow") out.push({ ts: e.ts, txt: `🟨 Yellow card — ${team}${min}` });
      else if (e.kind === "corner") out.push({ ts: e.ts, minor: true, txt: `⛳ Corner — ${team}${min}` });
      else if (e.kind === "phase") out.push({ ts: e.ts, txt: `⏱ <b>${e.text}</b>${sc ? " — " + sc : ""}${stats}` });
    }
    return out;
  }

  // deterministic closing summary from the match facts
  function closingSummary(meta, events) {
    const goals = (events || []).filter((e) => e.kind === "goal");
    const reds = (events || []).filter((e) => e.kind === "red");
    const last = goals[goals.length - 1];
    const final = last && last.score ? `${last.score[0]}-${last.score[1]}` : null;
    const parts = [`That's full time in ${meta.home} vs ${meta.away}${final ? ` — ${final}` : ""}.`];
    if (goals.length) parts.push(`${goals.length} goal${goals.length > 1 ? "s" : ""}: ` +
      goals.map((g) => `${g.isHome ? meta.home : meta.away}${g.minute != null ? ` ${g.minute}'` : ""}`).join(", ") + ".");
    if (reds.length) parts.push(`${reds.length} red card${reds.length > 1 ? "s" : ""} shaped the game.`);
    return parts.join(" ");
  }

  // Visual card for a replay moment: same renderer as live, in the fan's
  // language, caption = the commentary line. Returns false to fall back to text.
  async function sendReplayCard(chatId, fixtureId, meta, m, replaySt) {
    try {
      const c = m.card;
      if (c.kind === "goal" && c.score) replaySt.score = c.score;
      if (c.kind === "red") replaySt.red[c.isHome ? 0 : 1]++;
      const lang = langOf(chatId);
      const texts = {};
      for (const k of ["goal", "red_card", "corner", "win_probability", "fulltime", "kickoff"])
        texts[k] = (await tKey(k, lang)).toUpperCase();
      const caption = await translate(m.txt.replace(/<[^>]+>/g, ""), lang);
      const player = c.player ? { name: c.player, photo: playerPhoto(c.player), halo: c.kind === "goal", desat: c.kind === "red" ? 0.4 : 0 } : null;
      const q = quoteFor(c.kind, { fixtureId, team: c.isHome ? meta.home : meta.away, player: c.player, minute: m.min, score: replaySt.score.join("-"),
        prob: c.probs ? Math.round((c.isHome ? c.probs.home : c.probs.away) * 100) + "%" : null,
        fav: c.probs ? (c.probs.home >= c.probs.away ? meta.home : meta.away) : "", remaining: m.min != null ? Math.max(0, 90 - m.min) : null });
      const job = buildEventJob(
        { kind: c.kind, isHome: c.isHome, player, text: c.text, quote: { author: q.author, text: await translate(q.text, lang) } },
        { meta, state: { ...replaySt, minute: m.min }, probs: c.probs, prevProbs: null, odds: null, texts });
      if (!job) return false;
      const png = await renderCard(`rl-${fixtureId}-${c.kind}-${replaySt.score.join("")}-${m.min ?? "x"}-${lang}`, job);
      const r = await bot.sendPhoto(chatId, png, caption);
      return !!r?.ok;
    } catch (e) { console.log("[cards] replay render failed:", e.message); return false; }
  }

  // Mini cards (the designed m-series): yellow, corner.
  async function sendMiniCard(chatId, fixtureId, meta, ev, { st, lang, team, bot: B = bot }) {
    try {
      const texts = {};
      for (const k of ["yellow_card", "corner", "cards", "corners"]) texts[k] = (await tKey(k, lang)).toUpperCase();
      const evx = { ...ev, player: undefined };
      if (ev.kind === "yellow") {
        const name = typeof ev.player === "string" ? ev.player : playerFromPbp(fixtureId, "yellow", null, st.minute)?.name;
        evx.title = name || `${term("yellow_card", lang)} — ${team}`;
        evx.subtitle = name ? `${term("yellow_card", lang)} — ${team}` : "";
        texts.yellow_card = term("yellow_card", lang).toUpperCase();
        texts.cards = term("yellow_cards", lang);
      } else if (ev.kind === "corner") {
        const n = (st.corners || [0, 0])[ev.isHome ? 0 : 1];
        evx.title = `${term("corners", lang)} — ${team}`;
        evx.subtitle = await translate(`Corner number ${n} for ${team}.`, lang);
        texts.corner = term("corners", lang).toUpperCase();
        texts.corners = term("corners", lang);
      }
      if (evx.title && playerPhoto(evx.title)) evx.player = { name: evx.title, photo: playerPhoto(evx.title) };
      else if (ev.kind === "yellow" && evx.title && !evx.title.includes("—")) evx.player = { name: evx.title, photo: playerPhoto(evx.title) };
      const job = buildEventJob(evx, { meta, state: st, probs: null, prevProbs: null, odds: null, texts });
      if (!job) return;
      const png = await renderCard(`m-${fixtureId}-${ev.kind}-${st.minute ?? "x"}-${(st.corners || []).join("")}-${(st.yellow || []).join("")}-${lang}`, job);
      await B.sendPhoto(chatId, png);
    } catch (e) { console.log("[cards] mini render failed:", e.message); }
  }

  // Full-match event timeline from the play-by-play — EVERY match, from the
  // 0th minute, so a viewer always lives the whole game. Goals/cards/corners/
  // periods with running score and cumulative counts. (Market comes from the
  // authentic TxLINE odds series, matched by minute, in runSession.)
  function matchEvents(fixtureId, meta) {
    const pbp = loadPbp(fixtureId);
    if (!pbp?.plays) return [];
    const nH = String(meta.home).toLowerCase().trim(), nA = String(meta.away).toLowerCase().trim();
    const key = (s) => String(s || "").toLowerCase().trim().split(/\s+/)[0]; // first word, never ""
    const hK = key(nH), aK = key(nA);
    const sideOf = (n) => {
      const t = String(n || "").toLowerCase().trim();
      if (!t) return -1;
      const tK = key(t);
      const homeHit = (hK && t.includes(hK)) || (tK && nH.includes(tK));
      const awayHit = (aK && t.includes(aK)) || (tK && nA.includes(tK));
      if (homeHit && !awayHit) return 0;
      if (awayHit && !homeHit) return 1;
      return -1; // ambiguous or none — don't guess
    };
    const scorer = (t) => String(t).match(/\.\s+([\p{Lu}][\p{L}'’.-]+(?: [\p{Lu}][\p{L}'’.-]+){0,3}) \(/u)?.[1]
      || String(t).match(/by ([\p{Lu}][\p{L}'’.-]+(?: [\p{Lu}][\p{L}'’.-]+){0,3}),/u)?.[1] || null;
    const booked = (t) => String(t).match(/^([\p{Lu}][\p{L}'’.-]+(?: [\p{Lu}][\p{L}'’.-]+){0,3}) \(/u)?.[1] || null;
    const GOALS = new Set(["Goal", "Goal - Header", "Penalty - Scored", "Own Goal"]);
    const evs = [];
    let score = [0, 0], yellow = [0, 0], red = [0, 0], corners = [0, 0];
    for (const p of pbp.plays) {
      const min = p.min ?? 0, ty = p.type || "", text = p.text || "";
      if (GOALS.has(ty)) {
        // last two "<name> <number>" pairs in the sentence = the score line
        const pairs = [...text.matchAll(/([A-Za-zÀ-ÿ'’.\- ]+?)\s+(\d+)(?:\s*\(\d+\))?(?=[,.])/g)].slice(-2);
        if (pairs.length === 2) {
          const ns = [...score];
          for (const m of pairs) { const s = sideOf(m[1]); if (s >= 0) ns[s] = Number(m[2]); }
          const inc = ns[0] > score[0] ? 0 : ns[1] > score[1] ? 1 : -1;
          score = ns;
          if (inc >= 0) evs.push({ min, kind: "goal", isHome: inc === 0, score: [...score], player: scorer(text), own: ty === "Own Goal", pen: ty === "Penalty - Scored" });
        }
      } else if (/Red Card|Second Yellow/i.test(ty)) {
        const s = sideOf(text.match(/\(([^)]+)\)/)?.[1]); if (s >= 0) { red[s]++; evs.push({ min, kind: "red", isHome: s === 0, player: booked(text) }); }
      } else if (ty === "Yellow Card") {
        const s = sideOf(text.match(/\(([^)]+)\)/)?.[1]); if (s >= 0) { yellow[s]++; evs.push({ min, kind: "yellow", isHome: s === 0, yellow: [...yellow], player: booked(text) }); }
      } else if (ty === "Corner Awarded") {
        const s = sideOf(text.match(/Corner,\s*([^.]+?)\./)?.[1]); if (s >= 0) { corners[s]++; evs.push({ min, kind: "corner", isHome: s === 0, corners: [...corners] }); }
      } else if (ty === "Halftime") evs.push({ min, kind: "period", text: "Halftime" });
      else if (ty === "Start 2nd Half") evs.push({ min, kind: "period", text: "2nd half" });
      else if (ty === "Start Extra Time") evs.push({ min, kind: "period", text: "Extra time" });
      else if (ty === "End Regular Time" || ty === "End Extra Time") evs.push({ min, kind: "period", text: "Full time" });
    }
    return evs;
  }

  // The opening card of a personal session: a KICK-OFF duel when the fan
  // starts from the whistle, or a "coverage joins" score card mid-game.
  async function openingCard(chatId, fixtureId, meta, { minute = 0, score = [0, 0], seeded = false, odds = null, keyboard = null, bot: B = bot }) {
    const lang = langOf(chatId);
    try {
      let job;
      if (seeded) {
        const texts = { fulltime: term("kick_off", lang).toUpperCase() };
        job = buildEventJob({ kind: "fulltime", badge: `${term("kick_off", lang).toUpperCase()} · ${minute}'`, live: true },
          { meta, state: { score, minute }, probs: null, prevProbs: null, odds: null, texts });
      } else {
        job = buildEventJob({ kind: "kickoff" },
          { meta, state: { score: [0, 0], minute: 0 }, probs: null, prevProbs: null, odds,
            texts: { kickoff: term("kick_off", lang).toUpperCase() } });
      }
      if (!job) return;
      const png = await renderCard(`open-${fixtureId}-${seeded ? minute : "k"}-${lang}`, job);
      await B.sendPhoto(chatId, png, "", keyboard ? { reply_markup: keyboard } : {});
    } catch (e) { console.log("[cards] opening render failed:", e.message); }
  }

  // One event of a PERSONAL playback session: instant text ping, then the
  // visual card — both to a single chat, in the fan's language.
  async function personalEvent(chatId, fixtureId, meta, ev, { st, probs, prevProbs, odds, bot: B = bot }) {
    const lang = langOf(chatId);
    const score = `${st.score[0]}-${st.score[1]}`;
    const min = st.minute != null ? `${st.minute}'` : "";
    const team = ev.isHome ? meta.home : meta.away;
    // small events: one mini card, no text ping (the designed m-cards)
    if (ev.kind === "yellow" || ev.kind === "corner") {
      return sendMiniCard(chatId, fixtureId, meta, ev, { st, lang, team, bot: B });
    }
    let head = "";
    if (ev.kind === "goal") head = `⚽ ${term("goal", lang)} — ${team}! ${meta.home} ${score} ${meta.away} (${min})`;
    else if (ev.kind === "red") head = `🟥 ${term("red_card", lang).toUpperCase()} — ${team} (${min}), ${score}`;
    else if (ev.kind === "var") head = `📺 VAR — ${await translate(`${team} goal overturned`, lang)}. ${meta.home} ${score} ${meta.away} (${min})`;
    else if (ev.kind === "period") head = `⏱ ${await translate(ev.text, lang)} — ${meta.home} ${score} ${meta.away}`;
    if (!head) return;
    await B.sendText(chatId, head);
    let kind = ev.kind === "goal" ? "goal" : ev.kind === "red" ? "red" : ev.kind === "var" ? "var" : null;
    if (ev.kind === "period" && /full time|finished/i.test(ev.text || "")) kind = "fulltime";
    else if (ev.kind === "period" && /1st half/i.test(ev.text || "")) kind = "kickoff";
    else if (ev.kind === "period") kind = "phase";
    if (!kind) return;
    const evx = { ...ev, kind };
    if (kind === "goal" || kind === "red") {
      // exact scorer/sent-off name from the event, else resolve from pbp
      const name = typeof ev.player === "string" ? ev.player : null;
      const p = name
        ? { name, photo: playerPhoto(name), halo: kind === "goal", desat: kind === "red" ? 0.4 : 0 }
        : playerFromPbp(fixtureId, kind, st.score);
      evx.player = p || undefined;
    }
    if (kind === "phase") evx.text = await translate(ev.text, lang);
    if (kind === "var") { evx.title = await translate("DECISION OVERTURNED", lang); evx.ruling = "NO GOAL"; }
    const texts = {};
    for (const k of ["goal", "red_card", "corner", "win_probability", "fulltime", "kickoff", "corners", "cards"])
      texts[k] = (await tKey(k, lang)).toUpperCase();
    const q = quoteFor(kind, {
      fixtureId, team: ev.isHome ? meta.home : meta.away, player: evx.player?.name,
      minute: st.minute, score,
      prob: probs ? Math.round((ev.isHome ? probs.home : probs.away) * 100) + "%" : null,
      fav: probs ? (probs.home >= probs.away ? meta.home : meta.away) : "",
      remaining: st.minute != null ? Math.max(0, 90 - st.minute) : null,
    });
    const job = buildEventJob(
      { ...evx, quote: { author: q.author, text: await translate(q.text, lang) } },
      { meta, state: st, probs, prevProbs, odds, texts });
    if (!job) return;
    try {
      const png = await renderCard(`ps-${fixtureId}-${kind}-${st.score.join("")}-${st.minute ?? "x"}-${lang}`, job);
      await B.sendPhoto(chatId, png);
    } catch (e) { console.log("[cards] personal render failed:", e.message); }
  }

  // Upcoming match: ONE announcement card — kick-off time, crests, pre-match
  // odds, the market's read. No playback, no controls. (Design: 10_upcoming.)
  async function announceUpcoming(chatId, fixtureId, meta, odds) {
    const lang = langOf(chatId);
    const when = meta.startTime ? new Date(meta.startTime).toISOString().slice(11, 16) + " UTC" : null;
    let note = null;
    if (odds?.pct?.length === 3) {
      const p = odds.pct.map(Number);
      const s = p[0] + p[1] + p[2];
      if (s > 0) {
        const fav = p[0] >= p[2] ? meta.home : meta.away;
        note = await translate(`The market makes ${fav} favourites at ${Math.round(Math.max(p[0], p[2]) / s * 100)}%.`, lang);
      }
    }
    const job = buildEventJob(
      { kind: "upcoming", countdown: when ? `${term("kick_off", lang).toUpperCase()} ${when}` : null, note },
      { meta, state: {}, probs: null, prevProbs: null, odds, texts: { upcoming: (await tKey("upcoming", lang)).toUpperCase() } });
    const caption = await translate(
      `<b>${meta.home} vs ${meta.away}</b>\n${when ? `Kick-off at ${when}. ` : ""}I'll be right here when it starts.`, lang);
    try {
      const png = await renderCard(`up-${fixtureId}-${lang}`, job);
      await bot.sendPhoto(chatId, png, caption);
    } catch (e) {
      console.log("[cards] upcoming render failed:", e.message);
      await bot.sendText(chatId, caption);
    }
  }

  // Finished match: one recap card + one line-by-line story of the match.
  // No pacing, no betting — the fan taps and gets the whole picture at once.
  async function recap(chatId, fixtureId, meta, kickoffTs = null) {
    const lang = langOf(chatId);
    const st = getState(fixtureId) || {};
    const pbp = loadPbp(fixtureId);
    const who = (t, mid) => String(t).match(mid ? /(?:\d\.\s+|^)([\p{Lu}][\p{L}'.’-]+(?: [\p{Lu}][\p{L}'.’-]+){0,3}) \(/u : /^([\p{Lu}][\p{L}'.’-]+(?: [\p{Lu}][\p{L}'.’-]+){0,3}) \(/u)?.[1];
    // Which side does a name belong to? Match against BOTH team names and
    // refuse to guess: unmatched events are not counted.
    const norm = (s) => String(s || "").toLowerCase();
    const sideOfTeam = (team) => {
      if (!team) return -1;
      const t = norm(team);
      if (norm(meta.home).includes(t) || t.includes(norm(meta.home).split(" ")[0])) return 0;
      if (norm(meta.away).includes(t) || t.includes(norm(meta.away).split(" ")[0])) return 1;
      return -1;
    };
    const parenTeam = (t) => String(t).match(/\(([^)]+)\)/)?.[1];
    // --- key moments + stat counters from the play-by-play archive ---
    const GOAL_TYPES = new Set(["Goal", "Goal - Header", "Own Goal", "Penalty - Scored"]);
    const lines = [];
    const tally = { fouls: [0, 0], shotsOn: [0, 0], shotsOff: [0, 0], offsides: [0, 0], saves: [0, 0] };
    const bump = (key, side) => { if (side >= 0) tally[key][side]++; };
    if (pbp?.plays) {
      for (const p of pbp.plays) {
        const min = p.min != null ? `${p.min}'` : "–";
        const ty = p.type || "";
        if (GOAL_TYPES.has(ty)) {
          const sc = String(p.text).match(/ (\d+)(?:\(\d+\))?, .*? (\d+)(?:\(\d+\))?\./);
          const og = ty === "Own Goal" ? ` (${term("own_goal", lang)})` : ty === "Penalty - Scored" ? ` (${term("penalty", lang)})` : "";
          lines.push(`${min}  ⚽ ${who(p.text, true) || term("goal", lang)}${og}${sc ? ` — ${sc[1]}-${sc[2]}` : ""}`);
        } else if (/Red Card|Second Yellow/i.test(ty)) lines.push(`${min}  🟥 ${who(p.text) || term("red_cards", lang)}`);
        else if (ty === "Yellow Card") lines.push(`${min}  🟨 ${who(p.text) || term("yellow_cards", lang)}`);
        else if (/Penalty - (Missed|Saved)/.test(ty)) lines.push(`${min}  ✗ ${term(/Saved/.test(ty) ? "penalty_saved" : "penalty_missed", lang)}`);
        else if (ty === "Halftime") lines.push(`${min}  ⏱ ${term("half_time", lang)}`);
        else if (ty === "Start Extra Time") lines.push(`${min}  ⏱ ${term("extra_time", lang)}`);
        else if (ty === "End Regular Time") lines.push(`${min}  🏁 ${term("full_time", lang)}`);
        // two foul phrasings: "Foul by X (Team)" = Team committed it;
        // "X (Team) wins a free kick" = the OTHER team committed it
        else if (ty === "Foul") {
          const s = sideOfTeam(parenTeam(p.text));
          if (/Foul by/.test(p.text)) bump("fouls", s);
          else if (/wins a free kick/.test(p.text)) bump("fouls", s >= 0 ? 1 - s : -1);
        }
        else if (ty === "Shot On Target") bump("shotsOn", sideOfTeam(parenTeam(p.text)));
        else if (ty === "Shot Off Target" || ty === "Shot Blocked") bump("shotsOff", sideOfTeam(parenTeam(p.text)));
        else if (ty === "Offside") bump("offsides", sideOfTeam(parenTeam(p.text)));
        else if (ty === "Save") bump("saves", sideOfTeam(parenTeam(p.text)));
      }
    }
    const score = st.score ? `${st.score[0]}-${st.score[1]}` : "";
    const fmt = (a) => `${a[0]} - ${a[1]}`;
    // corners & yellows come from the TxLINE stats themselves — authoritative;
    // every label is real football vocabulary from the curated lexicon
    const statBlock = [
      `${term("shots_on_target", lang)}: ${fmt(tally.shotsOn)}`,
      `${term("shots_off_target", lang)}: ${fmt(tally.shotsOff)}`,
      `${term("saves", lang)}: ${fmt(tally.saves)}`,
      ...(st.corners ? [`${term("corners", lang)}: ${fmt(st.corners)}`] : []),
      `${term("fouls", lang)}: ${fmt(tally.fouls)}`,
      `${term("offsides", lang)}: ${fmt(tally.offsides)}`,
      ...(st.yellow ? [`${term("yellow_cards", lang)}: ${fmt(st.yellow)}`] : []),
      ...(st.red && (st.red[0] || st.red[1]) ? [`${term("red_cards", lang)}: ${fmt(st.red)}`] : []),
    ].join("\n");
    const kickLine = kickoffTs
      ? `${term("kick_off", lang)}: ${new Date(kickoffTs).toISOString().slice(0, 16).replace("T", " ")} UTC\n\n`
      : "";
    const caption =
      `<b>${meta.home} ${score} ${meta.away}</b>\n` +
      kickLine +
      (lines.length ? lines.join("\n\n") + "\n\n" : "") +
      `<b>${term("match_stats", lang)}</b>\n${statBlock}`;
    // --- the recap card: score + stat boxes, nothing else ---
    try {
      const texts = {};
      for (const k of ["fulltime", "corners", "cards"]) texts[k] = (await tKey(k, lang)).toUpperCase();
      const job = buildEventJob({ kind: "fulltime" }, { meta, state: st, probs: null, prevProbs: null, odds: null, texts });
      const png = await renderCard(`recap-${fixtureId}-${score}-${lang}`, job);
      // Telegram photo captions cap at 1024 chars — long stories go as text
      if (caption.length <= 1000) { await bot.sendPhoto(chatId, png, caption); return; }
      await bot.sendPhoto(chatId, png);
      await bot.sendText(chatId, caption);
      return;
    } catch (e) { console.log("[cards] recap render failed:", e.message); }
    await bot.sendText(chatId, caption);
  }

  const reliveRuns = new Map(); // chatId -> abort flag
  // speed: time multiplier over the real match clock (1 = real time, 2, 5)
  async function relive(chatId, fixtureId, meta, speed = 5, events = []) {
    speed = Math.max(1, Number(speed) || 5);
    const ticks = loadTicksFor(fixtureId);
    if (!ticks || !ticks.length) { await bot.sendText(chatId, "No coverage available for that match — /matches for the rest."); return; }
    const pbp = loadPbp(fixtureId);
    const usedPbp = !!(pbp && pbp.plays && pbp.plays.length);
    // message budget follows speed: faster replay, tighter selection
    const durationSec = Math.round(95 * 60 / speed);
    let moments;
    if (usedPbp) {
      // full play-by-play available: broadcast the real match flow
      moments = pbpTimeline(pbp, meta, Math.min(durationSec, 900), ticks);
    } else {
      moments = buildTimeline(ticks, meta);
      const evMoments = eventMoments(events, meta);
      if (evMoments.length) {
        // real events take the lead: drop market-inferred shocks (they duplicate goals)
        moments = moments.filter((m) => !/💥|📉/.test(m.txt)).concat(evMoments);
        moments.sort((a, b) => a.ts - b.ts);
      }
    }
    if (!moments.length) { await bot.sendText(chatId, "No market story available for that match — /matches for another."); return; }
    const factor = speed; // real ms per replay ms — the match clock, multiplied
    reliveRuns.set(String(chatId), { stop: false });
    await bot.sendText(chatId, await translate(
      `<b>${meta.home} vs ${meta.away}</b> — kick-off${speed > 1 ? ` (x${speed})` : ""}.\n<i>/stopreplay to leave</i>`, langOf(chatId)));
    // one LLM pass turns the deterministic lines into live commentary;
    // any failure keeps the deterministic broadcast untouched
    const lively = await llmRewrite(meta, moments);
    if (lively) moments = lively;
    let prevTs = moments[0].ts;
    const replaySt = { score: [0, 0], yellow: [0, 0], red: [0, 0], corners: [0, 0] };
    for (const m of moments) {
      // cap quiet spells so half-time never freezes the chat for 15 minutes
      const wait = Math.min(90000, Math.max(800, (m.ts - prevTs) / factor));
      await new Promise((r) => setTimeout(r, wait));
      if (reliveRuns.get(String(chatId))?.stop) { reliveRuns.delete(String(chatId)); return; }
      prevTs = m.ts;
      // big moments arrive as a visual card; everything else stays text
      if (m.card && (await sendReplayCard(chatId, fixtureId, meta, m, replaySt))) continue;
      await bot.sendText(chatId, await translate(m.txt, langOf(chatId)));
    }
    // with real play-by-play the full-time whistle already closed the show
    await bot.sendText(chatId, usedPbp ? "Next match: /matches" : `🎙 ${closingSummary(meta, events)}\n\nNext match: /matches`);
    reliveRuns.delete(String(chatId));
  }

  // pre-match decimal odds from the first archived TxLINE tick (prices are ×1000)
  function preMatchOdds(fixtureId) {
    const ticks = loadTicksFor(fixtureId);
    if (!ticks || !ticks.length) return null;
    const t = ticks.find((x) => !x.ir) || ticks[0];
    if (!t.p || t.p.length !== 3 || !t.p.every((v) => Number.isFinite(v) && v > 1000)) return null;
    return { home: +(t.p[0] / 1000).toFixed(2), draw: +(t.p[1] / 1000).toFixed(2), away: +(t.p[2] / 1000).toFixed(2) };
  }

  // 1X2 result of the archived match: 0 home, 1 draw, 2 away, null if unknown
  const normName = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, "").trim();
  function finalResultOf(fixtureId, meta) {
    const pbp = loadPbp(fixtureId);
    if (pbp && pbp.plays && pbp.plays.length) {
      const goals = pbp.plays.filter(isGoalPlay);
      if (!goals.length) return 1; // goalless: the 1X2 market settles as a draw
      const m = goals[goals.length - 1].text.match(/([A-Za-z' .&-]+?)\s+(\d+),\s*([A-Za-z' .&-]+?)\s+(\d+)/);
      if (m) {
        let h = +m[2], a = +m[4];
        const first = normName(m[1].replace(/^goal!?\s*/i, ""));
        const homeN = normName(meta?.home);
        if (homeN && first && !(first.includes(homeN) || homeN.includes(first))) [h, a] = [a, h];
        return h > a ? 0 : h < a ? 2 : 1;
      }
    }
    const ticks = loadTicksFor(fixtureId);
    if (ticks && ticks.length) {
      const p = probOf(ticks[ticks.length - 1]);
      if (p.home > 0.8) return 0;
      if (p.away > 0.8) return 2;
      if (p.draw > 0.8) return 1;
    }
    return null;
  }

  return { notifyFollowers, rememberProbs, relive, recap, personalEvent, openingCard, matchEvents, announceUpcoming, preMatchOdds, finalResultOf, ask,
    stopReplay: (chatId) => { const r = reliveRuns.get(String(chatId)); if (r) r.stop = true; } };
}
