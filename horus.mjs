// HORUS — the eye on every match.
// Pundit engine: turns feed events into fan-facing commentary with market
// context (win probabilities, odds moves), and broadcasts any archived match
// of the tournament progressively, as if it were live. Fully deterministic —
// no external AI service involved.
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";

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
    for (const f of followers) {
      await bot.sendText(f.chatId, text);
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
    return chosen.map((p) => {
      let txt;
      if (p.type === "Kickoff") txt = `⏱ <b>We're underway — ${meta.home} against ${meta.away}.</b> ${marketPhrase(meta, probAt(0, 1))}`;
      else if (p.type === "Halftime") txt = `⏱ <b>Half-time.</b> ${marketPhrase(meta, probAt(p.min || 45, 1))}`;
      else if (p.type === "Start 2nd Half") txt = "⏱ <b>Second half underway.</b>";
      else if (p.type === "End Regular Time") txt = "🏁 <b>Full time.</b>";
      else if (isGoalPlay(p)) {
        const mkt = marketPhrase(meta, probAt((p.min || 0) + 1, p.period));
        txt = `⚽ <b>${p.text}</b>${mkt ? "\n" + mkt : ""}`;
      } else txt = `${PLAY_EMOJI[p.type] || ""} ${p.text}`.trim();
      // paced on match minutes so quiet spells compress and action clusters
      return { ts: p.min * 60000 + p.idx, kind: p.type, big: isGoalPlay(p) || /Red|Second Yellow/i.test(p.type), min: p.min, txt };
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

  const reliveRuns = new Map(); // chatId -> abort flag
  // durationSec: how long the fan wants the whole match to take
  async function relive(chatId, fixtureId, meta, durationSec = 300, events = []) {
    const ticks = loadTicksFor(fixtureId);
    if (!ticks || !ticks.length) { await bot.sendText(chatId, "No coverage available for that match — /matches for the rest."); return; }
    const pbp = loadPbp(fixtureId);
    const usedPbp = !!(pbp && pbp.plays && pbp.plays.length);
    let moments;
    if (usedPbp) {
      // full play-by-play available: broadcast the real match flow
      moments = pbpTimeline(pbp, meta, durationSec, ticks);
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
    const span = Math.max(1, moments[moments.length - 1].ts - moments[0].ts);
    const factor = span / (durationSec * 1000); // real ms per replay ms
    reliveRuns.set(String(chatId), { stop: false });
    await bot.sendText(chatId,
      `🔴 <b>${meta.home} vs ${meta.away}</b> — coverage starting.\nI'll bring you the match and what the market makes of it. <i>(/stopreplay to leave)</i>`);
    // one LLM pass turns the deterministic lines into live commentary;
    // any failure keeps the deterministic broadcast untouched
    const lively = await llmRewrite(meta, moments);
    if (lively) moments = lively;
    let prevTs = moments[0].ts;
    for (const m of moments) {
      const wait = Math.min(60000, Math.max(800, (m.ts - prevTs) / factor));
      await new Promise((r) => setTimeout(r, wait));
      if (reliveRuns.get(String(chatId))?.stop) { reliveRuns.delete(String(chatId)); return; }
      prevTs = m.ts;
      await bot.sendText(chatId, m.txt);
    }
    // with real play-by-play the full-time whistle already closed the show
    await bot.sendText(chatId, usedPbp ? "Next match: /matches" : `🎙 ${closingSummary(meta, events)}\n\nNext match: /matches`);
    reliveRuns.delete(String(chatId));
  }

  return { notifyFollowers, rememberProbs, relive,
    stopReplay: (chatId) => { const r = reliveRuns.get(String(chatId)); if (r) r.stop = true; } };
}
