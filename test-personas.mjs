// Smoke test: deterministic persona quotes + one LLM polish round-trip.
import { quoteFor, polish, personaFor } from "./personas.mjs";

const ctx = { fixtureId: 18202701, team: "Argentina", player: "Lionel Messi", minute: 83, score: "2-2", prob: "62%" };
for (const kind of ["goal", "red", "yellow", "var", "market", "fulltime"]) {
  const q = quoteFor(kind, { ...ctx, ruling: "NO GOAL", move: "41% -> 62%", count: 6 });
  console.log(`${kind.padEnd(9)} [${q.author}] ${q.text}`);
}
const polished = await polish("goal", quoteFor("goal", ctx), "Argentina 2-2 Egypt, minute 83");
console.log("\npolished  [" + polished.author + "] " + polished.text);
