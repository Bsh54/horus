// Drives the REAL bot handler through the whole live journey via the debug
// endpoint, printing what the bot sends at each step and failing loudly on any
// uncaught error. Run on the VPS after the server is up: node test-live-flow.mjs
const BASE = "http://localhost:80/api/debug/cmd";
const CHAT = "debugchat";

async function cmd(text, isCallback = false) {
  const r = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: CHAT, text, isCallback, token: "horus-selftest" }) });
  const j = await r.json();
  const tag = isCallback ? "tap" : "cmd";
  if (!j.ok) { console.log(`\n✗ ${tag} "${text}" CRASHED: ${j.error}\n   ${(j.stack || []).join("\n   ")}`); process.exitCode = 1; return j; }
  console.log(`\n${tag} "${text}"`);
  for (const s of j.sent) {
    if (s.t === "photo") console.log(`   [CARD ${s.png}]${s.cap ? " " + s.cap.replace(/\n/g, " / ").slice(0, 70) : ""}`);
    else console.log(`   ${s.t === "edit" ? "(edit) " : ""}${(s.text || "").replace(/\n/g, " / ").slice(0, 90)}`);
    if (s.kb) console.log(`     buttons: ${s.kb.map((row) => row.map((b) => `[${b.text}→${b.callback_data}]`).join(" ")).join("  ")}`);
  }
  return j;
}

// find a live fixture id from the running sim state
const states = await (await fetch("http://localhost:80/api/live/fixtures")).json().catch(() => []);
console.log("=== ONBOARDING ===");
await cmd("/start");
await cmd("lang:fr", true);
await cmd("plan:free", true);

console.log("\n=== MATCHES MENU ===");
await cmd("/matches");
await cmd("phase:live", true);

// grab the first live match id from the section listing
const listing = await (await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: CHAT, text: "phase:live", isCallback: true, token: "horus-selftest" }) })).json();
const firstPick = listing.sent?.flatMap((s) => s.kb || []).flat().find((b) => b.callback_data?.startsWith("pick:live:"));
if (!firstPick) { console.log("no live match found in the listing"); process.exit(1); }
const id = firstPick.callback_data.split(":")[2];
console.log(`\n=== LIVE JOURNEY on ${id} ===`);
await cmd(`pick:live:${id}`, true);      // 1. the match -> position or pace
await cmd(`nobet:${id}`, true);          // 2. skip bet -> pace chooser
await cmd(`watch:${id}:10`, true);       // 3. pace chosen -> playback starts (detached)

console.log("\n(playback runs detached server-side; letting it breathe 8s)");
await new Promise((r) => setTimeout(r, 8000));
await cmd("spd:stop", true);             // stop the personal session

console.log(`\n${process.exitCode ? "FLOW HIT AN ERROR ✗" : "LIVE FLOW OK ✓"}`);
