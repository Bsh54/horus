// Top up the house wallet from the devnet faucet, with retries.
import { readFileSync } from "fs";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
const w = JSON.parse(readFileSync("data/wallet.json", "utf8"));
const kp = Keypair.fromSecretKey(Uint8Array.from(Array.isArray(w) ? w : Object.values(w)));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
console.log("house:", kp.publicKey.toBase58());
for (let i = 1; i <= 6; i++) {
  const bal = await conn.getBalance(kp.publicKey) / LAMPORTS_PER_SOL;
  console.log(`balance: ${bal} SOL`);
  if (bal >= 4) break;
  try {
    const sig = await conn.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`airdrop ${i} ok`);
  } catch (e) {
    console.log(`airdrop ${i} failed: ${e.message.slice(0, 80)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log("final:", await conn.getBalance(kp.publicKey) / LAMPORTS_PER_SOL, "SOL");
