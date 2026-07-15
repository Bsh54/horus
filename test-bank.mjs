// End-to-end dry run of the betting bank on devnet: fund, stake, settle.
import { createBank } from "./bank.mjs";
import { createHorus } from "./horus.mjs";
import { readFileSync, readdirSync } from "fs";
import { gunzipSync } from "zlib";

const bank = createBank({ journal: (r) => console.log("journal:", r.kind) });
const horus = createHorus({ bot: null, journal: () => {}, getMeta: () => null, getProbs: () => null, getState: () => null });

const fid = Number(readdirSync("data/history").find((f) => f.startsWith("pbp-")).match(/\d+/)[0]);
const pbp = JSON.parse(gunzipSync(readFileSync(`data/history/pbp-${fid}.json.gz`)));
const meta = { home: pbp.home, away: pbp.away };
console.log(`fixture ${fid}: ${meta.home} vs ${meta.away}`);

const odds = horus.preMatchOdds(fid);
console.log("pre-match odds:", odds);
const result = horus.finalResultOf(fid, meta);
console.log("final result (0=home 1=draw 2=away):", result);

const CHAT = "test-punter-1";
console.log("balance before:", await bank.balanceOf(CHAT));
const winSide = result, winName = [meta.home, "Draw", meta.away][result];
const bet = await bank.placeBet(CHAT, fid, winSide, winName, [odds.home, odds.draw, odds.away][winSide]);
console.log("bet placed:", bet.sideName, "@", bet.odds, "tx:", bet.txSig.slice(0, 20) + "…");
console.log("balance after stake:", await bank.balanceOf(CHAT));
await bank.settle(fid, result, async (cid, txt) => console.log(`notify ${cid}:`, txt.replace(/<[^>]+>/g, "")));
console.log("balance after settle:", await bank.balanceOf(CHAT));
