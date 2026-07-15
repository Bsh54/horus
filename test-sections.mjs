// Smoke test: ask the running server for its per-phase section counts by
// reading the persisted score states the sim has built.
import { readFileSync } from "fs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(20000); // let the periodic state save fire
const states = JSON.parse(readFileSync("data/score-states.json", "utf8"));
const rows = Object.entries(states).map(([id, st]) => ({ id, statusId: st.statusId, minute: st.minute, score: st.score }));
console.log(JSON.stringify(rows, null, 0));
