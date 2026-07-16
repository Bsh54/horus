// Full transcript of a live match as a viewer receives it, via the real
// runSession (dry-run). Usage: node test-watch-transcript.mjs <fixtureId>
const fid = process.argv[2] || "18192996"; // Mexico-England
const r = await fetch("http://localhost:80/api/debug/watch", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fid, token: "horus-selftest" }),
});
const j = await r.json();
if (!j.ok) { console.log("CRASH:", j.error, "\n", (j.stack || []).join("\n")); process.exit(1); }
let cards = 0, texts = 0;
for (const s of j.sent) {
  if (s.t === "card") { cards++; console.log(`  [CARD ${s.card}]${s.cap ? "  " + s.cap.replace(/\n/g, " / ").slice(0, 80) : ""}`); }
  else { texts++; console.log(`  ${s.text.replace(/\n/g, " / ").slice(0, 100)}${s.kb ? "   ⌨" : ""}`); }
}
console.log(`\n${j.sent.length} messages: ${texts} text, ${cards} cards`);
