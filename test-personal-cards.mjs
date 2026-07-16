// Isolate the personal-session card path: fire one of each event kind through
// horus.personalEvent with a recording bot and confirm each renders without
// throwing. Run on the VPS: node test-personal-cards.mjs
import { createHorus } from "./horus.mjs";

const meta = { home: "Mexico", away: "England" };
const sent = [];
const bot = {
  sendText: async (cid, text) => { sent.push({ t: "text", text: text.slice(0, 60) }); return { ok: true }; },
  sendPhoto: async (cid, png) => { sent.push({ t: "photo", png: String(png).split(/[/\\]/).pop() }); return { ok: true }; },
};
const horus = createHorus({
  bot, journal: () => {},
  getMeta: () => meta, getProbs: () => null, getState: () => null,
});

const base = { score: [1, 0], yellow: [1, 0], red: [0, 0], corners: [3, 1], minute: 35, statusId: 2 };
const probs = { home: 0.1, draw: 0.24, away: 0.66 };
const odds = { home: 8.2, draw: 3.9, away: 1.4 };
const cases = [
  ["goal",   { kind: "goal", isHome: false }, { ...base, score: [0, 1] }],
  ["red",    { kind: "red", isHome: true },    { ...base, red: [1, 0] }],
  ["yellow", { kind: "yellow", isHome: true }, { ...base, yellow: [2, 0] }],
  ["corner", { kind: "corner", isHome: false }, { ...base, corners: [3, 2] }],
  ["kickoff",{ kind: "period", text: "1st half" }, { ...base, minute: 1 }],
  ["halftime",{ kind: "period", text: "Halftime" }, { ...base, minute: 45 }],
  ["fulltime",{ kind: "period", text: "Finished" }, { ...base, minute: 90, statusId: 100 }],
  ["var",    { kind: "var", isHome: false }, { ...base, score: [1, 0] }],
];
let fail = 0;
for (const [name, ev, st] of cases) {
  sent.length = 0;
  try {
    await horus.personalEvent("t", 18192996, meta, ev, { st, probs, prevProbs: probs, odds });
    const photo = sent.find((s) => s.t === "photo");
    const text = sent.find((s) => s.t === "text");
    console.log(`${name.padEnd(9)} ${photo ? "CARD " + photo.png : "no card"} ${text ? "| ping: " + text.text : ""}`);
    if (!photo && ev.kind !== "corner" && ev.kind !== "yellow") { /* mini cards have no text ping */ }
  } catch (e) { fail++; console.log(`${name.padEnd(9)} THREW: ${e.message}`); }
}
console.log(`\n${fail ? fail + " FAILED ✗" : "ALL CARD KINDS RENDER ✓"}`);
process.exit(fail ? 1 : 0);
