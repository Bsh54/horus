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
    return `Market now: ${meta.home} ${pctS(p.home)} · Draw ${pctS(p.draw)} · ${meta.away} ${pctS(p.away)}`;
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
      if (t.ir && kickoff == null) { kickoff = t.ts; out.push({ ts: t.ts, txt: `⏱ Kick-off! ${meta.home} vs ${meta.away}. Market: ${meta.home} ${pctS(p.home)} · Draw ${pctS(p.draw)} · ${meta.away} ${pctS(p.away)}` }); }
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
      if (winner) out.push({ ts: last.ts, txt: `🏁 <b>Full time.</b> ${winner === "a draw" ? "It ends level" : winner + " take it"}. Final market read: ${meta.home} ${pctS(p.home)} · Draw ${pctS(p.draw)} · ${meta.away} ${pctS(p.away)}` });
    }
    // keep at most 12 moments
    return out.length > 12 ? [out[0], ...out.slice(1, -1).filter((_, i) => i % Math.ceil((out.length - 2) / 10) === 0), out[out.length - 1]] : out;
  }

  // Build the full progressive timeline of a match from its archived ticks:
  // kick-off, market shocks (goals/cards seen through the odds), periodic
  // checkpoints, closing verdict. Each moment keeps its real timestamp so the
  // replay can be paced at any speed.
  function buildTimeline(ticks, meta) {
    const moments = keyMoments(ticks, meta);
    // periodic market checkpoints between the key moments (every ~15 virtual minutes)
    const inPlay = ticks.filter((t) => t.ir);
    if (inPlay.length > 10) {
      const start = inPlay[0].ts, end = inPlay[inPlay.length - 1].ts;
      const step = (end - start) / 7;
      for (let k = 1; k < 7; k++) {
        const target = start + k * step;
        const t = inPlay.reduce((a, b) => (Math.abs(b.ts - target) < Math.abs(a.ts - target) ? b : a));
        const p = probOf(t);
        const min = Math.round((t.ts - start) / 60000);
        moments.push({ ts: t.ts, checkpoint: true,
          txt: `⏱ ${min}' — market check: ${meta.home} ${pctS(p.home)} · Draw ${pctS(p.draw)} · ${meta.away} ${pctS(p.away)}` });
      }
    }
    moments.sort((a, b) => a.ts - b.ts);
    // drop checkpoints that land within 60s of a key moment
    return moments.filter((m, i) => !m.checkpoint || !moments.some((o) => !o.checkpoint && Math.abs(o.ts - m.ts) < 60000));
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
    let moments = buildTimeline(ticks, meta);
    let evMoments = eventMoments(events, meta);
    if (durationSec <= 120) evMoments = evMoments.filter((m) => !m.minor); // quick mode: skip corners
    if (evMoments.length) {
      // real events take the lead: drop market-inferred shocks (they duplicate goals)
      moments = moments.filter((m) => !/💥|📉/.test(m.txt)).concat(evMoments);
      moments.sort((a, b) => a.ts - b.ts);
    }
    if (!moments.length) { await bot.sendText(chatId, "No market story available for that match — /matches for another."); return; }
    const span = Math.max(1, moments[moments.length - 1].ts - moments[0].ts);
    const factor = span / (durationSec * 1000); // real ms per replay ms
    reliveRuns.set(String(chatId), { stop: false });
    await bot.sendText(chatId,
      `🔴 <b>${meta.home} vs ${meta.away}</b> — coverage starting.\nI'll bring you the match and what the market makes of it. <i>(/stopreplay to leave)</i>`);
    let prevTs = moments[0].ts;
    for (const m of moments) {
      const wait = Math.min(60000, Math.max(800, (m.ts - prevTs) / factor));
      await new Promise((r) => setTimeout(r, wait));
      if (reliveRuns.get(String(chatId))?.stop) { reliveRuns.delete(String(chatId)); return; }
      prevTs = m.ts;
      await bot.sendText(chatId, m.txt);
    }
    // closing summary built strictly from the match facts
    await bot.sendText(chatId, `🎙 ${closingSummary(meta, events)}\n\nNext match: /matches`);
    reliveRuns.delete(String(chatId));
  }

  return { notifyFollowers, rememberProbs, relive,
    stopReplay: (chatId) => { const r = reliveRuns.get(String(chatId)); if (r) r.stop = true; } };
}
