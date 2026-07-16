// Audit every live/upcoming demo match through the real runSession dry-run.
// General coherence rules that must ALSO hold for real live matches:
//   R1 the session opens with exactly one KICK-OFF card
//   R2 the LAST message is the full-time card; nothing comes after it
//   R3 the final score on the full-time card equals the known real result
//   R4 goals are strictly non-decreasing and each side's tally only grows
//   R5 no duplicate consecutive identical cards
// Run on the VPS: node test-live-audit.mjs
const MATCHES = {
  18202701: "3-2", 18192996: "2-3", 18188721: "0-1", 18179551: "3-0",
  18213979: "1-2", 18237038: "0-2", 18209181: "2-0", 18198205: "0-1",
};
let fails = 0;
for (const [fid, want] of Object.entries(MATCHES)) {
  const r = await fetch("http://localhost:80/api/debug/watch", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fid, token: "horus-selftest" }),
  });
  const j = await r.json();
  const problems = [];
  if (!j.ok) { console.log(`${fid}: CRASH ${j.error}`); fails++; continue; }
  const msgs = j.sent;
  // R1 first message is an opening card
  if (!(msgs[0]?.t === "card" && /^open-/.test(msgs[0].card))) problems.push("no opening kick-off card first");
  // R2 last message is a full-time card
  const last = msgs[msgs.length - 1];
  if (!(last?.t === "card" && /fulltime/.test(last.card))) problems.push(`last message is not full-time (${last?.card || last?.text?.slice(0, 30)})`);
  // R2b nothing after full time: only one fulltime card and it's last
  const ftIdx = msgs.findIndex((m) => m.t === "card" && /fulltime/.test(m.card));
  if (ftIdx >= 0 && ftIdx !== msgs.length - 1) problems.push(`${msgs.length - 1 - ftIdx} message(s) after full-time`);
  // R3 final score from the fulltime card filename ps-<id>-fulltime-<hh><aa>-...
  const ftCard = last?.card || "";
  const sc = ftCard.match(/fulltime-(\d)(\d)-/);
  const got = sc ? `${sc[1]}-${sc[2]}` : "?";
  if (got !== want) problems.push(`final score ${got} != real ${want}`);
  // R4 goals non-decreasing from the goal pings
  let ph = -1, pa = -1, ok4 = true;
  for (const m of msgs) {
    const g = (m.text || "").match(/(\d+)-(\d+)/);
    if (m.text && /GOAL|BUT/i.test(m.text) && g) {
      const h = +g[1], a = +g[2];
      if (h < ph || a < pa) ok4 = false;
      ph = h; pa = a;
    }
  }
  if (!ok4) problems.push("a goal ping made the score go backwards");
  // R5 no identical consecutive cards
  for (let i = 1; i < msgs.length; i++) if (msgs[i].t === "card" && msgs[i].card === msgs[i - 1].card) problems.push(`duplicate card ${msgs[i].card}`);

  if (problems.length) { fails++; console.log(`${fid} (${want})  ✗\n   - ${problems.join("\n   - ")}`); }
  else console.log(`${fid} (${want})  ✓  ${msgs.length} messages`);
}
console.log(`\n${fails ? fails + " MATCH(ES) FAILED" : "ALL LIVE MATCHES COHERENT ✓"}`);
process.exit(fails ? 1 : 0);
