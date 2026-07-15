// Truth check: do the odds shown for upcoming France-Spain match the raw
// TxLINE data? Compares the sim's served odds with the last pre-kick-off
// 1X2 tick in the authentic odds history.
import { readFileSync } from "fs";
import { TxSim } from "./simulator.mjs";

const FID = 18237038; // France vs Spain (upcoming)

// 1) what the raw TxLINE file says
const raw = JSON.parse(readFileSync(`data/sim/${FID}-odds.json`, "utf8"));
const scores = readFileSync(`data/sim/${FID}-scores.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const kick = scores.find((m) => (m.StatusId ?? 1) > 1 || m.Clock?.Running);
const zero = kick?.Ts;
const pre1x2 = raw.filter((m) => m.SuperOddsType === "1X2_PARTICIPANT_RESULT" && !m.MarketPeriod && m.Ts < zero && Array.isArray(m.Prices));
const last = pre1x2[pre1x2.length - 1];
console.log("raw TxLINE last pre-match 1X2 tick:");
console.log("  MessageId:", last.MessageId, "| Bookmaker:", last.Bookmaker);
console.log("  Prices/1000:", last.Prices.map((p) => p / 1000).join(" / "), "| Pct:", last.Pct.join(" / "));
console.log("  Ts:", new Date(last.Ts).toISOString(), "| kick-off was:", new Date(zero).toISOString());

// 2) what the sim serves to the bot
const sim = new TxSim({ onOdds: () => {}, onScore: () => {}, onStatus: () => {} });
await sim.start();
const served = sim.oddsFor(FID);
console.log("\nserved by the bot:", served.home, "/", served.draw, "/", served.away, "| pct:", served.pct?.join(" / "));
console.log("\nMATCH:", served.home === last.Prices[0] / 1000 && served.draw === last.Prices[1] / 1000 && served.away === last.Prices[2] / 1000 ? "IDENTICAL ✓" : "DIFFERENT ✗");
sim.stop();
process.exit(0);
