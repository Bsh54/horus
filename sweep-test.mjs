// Return the test punter's devnet SOL to the house wallet.
import { readFileSync } from "fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
const w = JSON.parse(readFileSync("data/wallet.json", "utf8"));
const house = Keypair.fromSecretKey(Uint8Array.from(Array.isArray(w) ? w : Object.values(w)));
const punters = JSON.parse(readFileSync("data/punters.json", "utf8"));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const p = punters["test-punter-1"];
if (!p) { console.log("no test punter"); process.exit(0); }
const kp = Keypair.fromSecretKey(Uint8Array.from(p.secret));
const bal = await conn.getBalance(kp.publicKey);
const send = bal - 6000; // keep dust for the fee
if (send <= 0) { console.log("nothing to sweep"); process.exit(0); }
const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: house.publicKey, lamports: send }));
await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
console.log(`swept ${send / LAMPORTS_PER_SOL} SOL back to house`);
console.log("house balance:", await conn.getBalance(house.publicKey) / LAMPORTS_PER_SOL, "SOL");
