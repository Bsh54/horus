// HORUS personas — three pundit voices so cards and pings feel alive, never
// generic. Deterministic template core (always works, zero latency) with an
// optional DeepSeek polish pass that must preserve every fact.
//
//   El Fuego     — fire and heart; goals, comebacks, shootouts
//   The Professor— cold tactical reading; cards, VAR, game management
//   OptaBrain    — the numbers voice; markets, probabilities, patterns
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LLM_FILE = join(__dirname, "data", "deepseek.json");

export const PERSONAS = {
  fuego: {
    name: "El Fuego",
    style: "a South American radio commentator LIVE ON AIR as it happens: breathless, present tense, the crowd roaring behind you. Never analytical, never past tense.",
  },
  professor: {
    name: "The Professor",
    style: "a co-commentator reacting live from the gantry: calm, present tense, one sharp tactical read of what just happened on the pitch below you. Never excited.",
  },
  opta: {
    name: "OptaBrain",
    style: "the touchline data analyst cutting in live: one number first, present tense, what it means right now. Never emotional.",
  },
};

// Which voice owns which moment.
const OWNER = {
  goal: "fuego", penalty: "fuego", shootout: "fuego", comeback: "fuego",
  red: "professor", yellow: "professor", var: "professor", fulltime: "professor",
  market: "opta", kickoff: "opta", upcoming: "opta", corner: "opta",
};
export const personaFor = (kind) => PERSONAS[OWNER[kind] || "professor"];

// Deterministic quote templates — seeded pick so the same event renders the
// same line in every language (translation cache stays hot).
const T = {
  goal: [
    (c) => `${c.team} strike at ${c.minute}'! ${c.score} — and the market believed at just ${c.prob}.`,
    (c) => `It's ${c.score}! ${c.player ? c.player + " delivers" : c.team + " deliver"} the moment this match was waiting for.`,
    (c) => `${c.minute}' and the stadium erupts — ${c.team} make it ${c.score}!`,
  ],
  red: [
    (c) => `Down to ten. ${c.team} must now defend ${c.remaining ?? "the remaining"} minutes the market says they can't afford.`,
    (c) => `A red changes every plan. ${c.team}'s shape has to be rebuilt on the fly.`,
  ],
  yellow: [
    (c) => `A booking for ${c.player || c.team} — one mistimed tackle from real trouble now.`,
    (c) => `${c.team} walk the disciplinary tightrope: that yellow changes how they can press.`,
  ],
  var: [
    (c) => `The screen decides: ${c.ruling}. Cold procedure, huge consequence at ${c.score}.`,
  ],
  market: [
    (c) => `${c.move} in ${c.window} — money this fast usually knows something the crowd doesn't.`,
    (c) => `The consensus just moved ${c.move}. Watch the next five minutes.`,
  ],
  kickoff: [
    (c) => `${c.prob} says ${c.fav} — but probabilities don't take kick-offs.`,
  ],
  fulltime: [
    (c) => `Full-time, ${c.score}. Every stat sealed by TxLINE, provable on Solana.`,
  ],
  corner: [
    (c) => `${c.count ?? "More"} corners now for ${c.team} — sustained pressure shows up in the numbers first.`,
  ],
};

const hash = (s) => [...String(s)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);

// Deterministic line (English) for an event; ctx fields are best-effort.
export function quoteFor(kind, ctx = {}) {
  const persona = personaFor(kind);
  const pool = T[kind] || T.goal;
  const line = pool[hash(`${ctx.fixtureId}-${kind}-${ctx.score}-${ctx.minute}`) % pool.length](ctx);
  return { author: persona.name, text: line };
}

// Optional polish: rewrite the deterministic line in the persona's voice.
// Hard 3s budget; any failure returns the deterministic line untouched.
export async function polish(kind, quote, matchLine) {
  if (!existsSync(LLM_FILE)) return quote;
  try {
    const cfg = JSON.parse(readFileSync(LLM_FILE, "utf8"));
    const persona = personaFor(kind);
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model || "deepseek-chat",
        thinking: { type: "disabled" },
        temperature: 1.0, max_tokens: 80,
        messages: [
          { role: "system", content: `You are ${persona.name}, ${persona.style} You are commentating THIS moment as it happens, speaking to fans listening live. Rewrite the line as one spoken sentence, max 18 words, present tense. Keep every fact exactly: numbers, minutes, names, scores. Return only the sentence.` },
          { role: "user", content: `Match: ${matchLine}\nLine: ${quote.text}` },
        ],
      }),
      signal: AbortSignal.timeout(3000),
    });
    const j = await r.json();
    const out = j.choices?.[0]?.message?.content?.trim().replace(/^"|"$/g, "");
    return out && out.length > 8 ? { ...quote, text: out } : quote;
  } catch { return quote; }
}
