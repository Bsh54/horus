// HORUS — the eye on every match.
// Pundit engine: turns live feed events into fan-facing commentary with market
// context (win probabilities, odds moves), speaks through TTS voice notes,
// answers questions through an optional LLM layer, and can replay any archived
// match of the tournament as if it were live.
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { gunzipSync } from "zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "data");
const TTS_DIR = join(DATA, "tts");
mkdirSync(TTS_DIR, { recursive: true });

const DEEPSEEK_FILE = join(DATA, "deepseek.json");
const deepseekKey = existsSync(DEEPSEEK_FILE) ? JSON.parse(readFileSync(DEEPSEEK_FILE, "utf8")).key : null;

const pctS = (p) => (p * 100).toFixed(0) + "%";

export function createHorus({ bot, journal, getMeta, getProbs, getState }) {
  // per-fixture last known probabilities to phrase "before -> after"
  const probMem = new Map();

  // ---------------------------------------------------------------------------
  // TTS: edge-tts (free neural voices) -> mp3 -> ffmpeg -> ogg/opus voice note
  // ---------------------------------------------------------------------------
  function tts(text, outBase) {
    return new Promise((resolve) => {
      const mp3 = join(TTS_DIR, outBase + ".mp3");
      const ogg = join(TTS_DIR, outBase + ".ogg");
      execFile("edge-tts", ["--voice", "en-GB-RyanNeural", "--rate", "+12%", "--text", text, "--write-media", mp3], { timeout: 30000 }, (e1) => {
        if (e1) return resolve(null);
        execFile("ffmpeg", ["-y", "-i", mp3, "-c:a", "libopus", "-b:a", "32k", ogg], { timeout: 30000 }, (e2) => {
          resolve(e2 ? null : ogg);
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // LLM layer (optional): colourful phrasing + Q&A. Deterministic templates are
  // the fallback — the product never depends on the external API.
  // ---------------------------------------------------------------------------
  async function llm(system, user, maxTokens = 220) {
    if (!deepseekKey) return null;
    try {
      const r = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepseekKey}` },
        body: JSON.stringify({
          model: "deepseek-chat", max_tokens: maxTokens, temperature: 0.7,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(12000),
      });
      const body = await r.json();
      return body.choices?.[0]?.message?.content?.trim() || null;
    } catch { return null; }
  }

  const PUNDIT_PERSONA = "You are HORUS, a jovial, warm, funny football pundit — like an excited best friend watching the match with the fan. Talk casually, with energy and humour, 1-3 short sentences, spoken style, no markdown, no emojis in voice lines. You know betting markets inside out: probabilities come from real demargined odds. Never invent facts beyond the data given.";

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

    // voice line for the big moments (goal / red / steam)
    let ogg = null;
    if (["goal", "red", "steam"].includes(ev.kind)) {
      const spoken = (await llm(PUNDIT_PERSONA,
        `Say this event as a live pundit voice line: ${d.head}. ${d.body} ${d.market}`)) ||
        `${d.head.replace(/[⚽🟥🚨]/g, "")}. ${d.body}`;
      ogg = await tts(spoken, `${fixtureId}-${Date.now()}`);
    }
    for (const f of followers) {
      await bot.sendText(f.chatId, text);
      if (ogg && f.voice !== false) await bot.sendVoice(f.chatId, ogg);
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
      if (winner) out.push({ ts: last.ts, txt: `🏁 <b>FULL TIME!</b> ${winner === "a draw" ? "It ends level" : winner + " take it"}! Final market read: ${meta.home} ${pctS(p.home)} · Draw ${pctS(p.draw)} · ${meta.away} ${pctS(p.away)} — what a watch! 🙌` });
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

  const reliveRuns = new Map(); // chatId -> abort flag
  // durationSec: how long the fan wants the whole match to take
  async function relive(chatId, fixtureId, meta, durationSec = 300) {
    const ticks = loadTicksFor(fixtureId);
    if (!ticks || !ticks.length) { await bot.sendText(chatId, "Ah, that one's not in my library yet! 😔 Try another — /matches"); return; }
    const moments = buildTimeline(ticks, meta);
    if (!moments.length) { await bot.sendText(chatId, "That match was so quiet even the market fell asleep 😴 Pick another one — /matches"); return; }
    const span = Math.max(1, moments[moments.length - 1].ts - moments[0].ts);
    const factor = span / (durationSec * 1000); // real ms per replay ms
    reliveRuns.set(String(chatId), { stop: false });
    await bot.sendText(chatId,
      `🔴 <b>WE'RE LIVE — ${meta.home} 🆚 ${meta.away}!</b> 🏟\n\nI'm your eyes on the pitch AND on the market. Grab a drink, I'm commentating — you just enjoy! 🍹\n<i>(/stopreplay to leave the match)</i>`);
    let prevTs = moments[0].ts;
    for (const m of moments) {
      const wait = Math.min(60000, Math.max(800, (m.ts - prevTs) / factor));
      await new Promise((r) => setTimeout(r, wait));
      if (reliveRuns.get(String(chatId))?.stop) { reliveRuns.delete(String(chatId)); return; }
      prevTs = m.ts;
      await bot.sendText(chatId, m.txt);
      // the biggest swings also arrive as voice
      if (!m.checkpoint && /💥/.test(m.txt)) {
        const spoken = (await llm(PUNDIT_PERSONA, `Say this replay moment as a live pundit voice line: ${m.txt.replace(/<[^>]+>/g, "")}`))
          || m.txt.replace(/[💥📉🏁⏱]/g, "");
        const ogg = await tts(spoken, `relive-${chatId}-${Date.now()}`);
        const sub = bot.subs.get(String(chatId));
        if (ogg && (!sub || sub.voice !== false)) await bot.sendVoice(chatId, ogg);
      }
    }
    const spoken = (await llm(PUNDIT_PERSONA, `Give a 2-sentence closing summary of this match market story:\n${moments.filter((m) => !m.checkpoint).map((m) => m.txt).join("\n")}`))
      || `And that is full time in ${meta.home} against ${meta.away}. What a story the market told.`;
    const ogg = await tts(spoken, `relive-${chatId}-${Date.now()}`);
    if (ogg) await bot.sendVoice(chatId, ogg);
    reliveRuns.delete(String(chatId));
  }

  // ---------------------------------------------------------------------------
  // Conversational Q&A
  // ---------------------------------------------------------------------------
  async function ask(chatId, question, liveContext) {
    const answer = await llm(PUNDIT_PERSONA + " Answer the fan's question strictly from this live data:\n" + liveContext, question, 300);
    await bot.sendText(chatId, answer || "My chatty brain is taking a nap right now 😴 — but the numbers never sleep! Try /live for the raw picture.");
  }

  return { notifyFollowers, rememberProbs, relive, ask, tts, llm,
    stopReplay: (chatId) => { const r = reliveRuns.get(String(chatId)); if (r) r.stop = true; } };
}
