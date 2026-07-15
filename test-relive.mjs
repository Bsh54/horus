// Dry-run of a replay: prints the broadcast lines instead of sending them.
import { readdirSync, readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { createHorus } from "./horus.mjs";

const fid = Number(readdirSync("data/history").find((f) => f.startsWith("pbp-")).match(/\d+/)[0]);
const pbp = JSON.parse(gunzipSync(readFileSync(`data/history/pbp-${fid}.json.gz`)));
console.log(`fixture ${fid}: ${pbp.home} vs ${pbp.away} — ${pbp.plays.length} plays\n`);

const fakeBot = { sendText: async (_, t) => console.log("— " + t.replace(/\n/g, "\n  ")) };
const horus = createHorus({ bot: fakeBot, journal: () => {}, getMeta: () => null, getProbs: () => null, getState: () => null });
await horus.relive("test", fid, { home: pbp.home, away: pbp.away }, 15, []);
