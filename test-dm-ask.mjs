// Simulate a private-chat plain message being auto-answered by HORUS/DeepSeek.
const BASE = "http://localhost:80/api/debug/cmd";
const CHAT = "dmtest99";
async function cmd(text, isCallback = false) {
  const r = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: CHAT, text, isCallback, token: "horus-selftest" }) });
  const j = await r.json();
  if (!j.ok) { console.log(`CRASH on "${text}": ${j.error}`); return; }
  console.log(`\n> "${text}"`);
  for (const s of j.sent) console.log("  " + (s.text || `[${s.png}]`).replace(/\n/g, " / ").slice(0, 160));
}
await cmd("lang:en", true);
await cmd("plan:free", true);
await cmd("who is winning right now?");   // plain message → should be answered
