// Prints wallet.json structure and public address only — never the secret.
import { readFileSync, readdirSync } from "fs";
const w = JSON.parse(readFileSync("data/wallet.json", "utf8"));
console.log("wallet.json fields:", Object.keys(w).join(", "));
try {
  const { Keypair, Connection, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
  const kp = Keypair.fromSecretKey(Uint8Array.from(Array.isArray(w) ? w : Object.values(w)));
  console.log("pubkey:", kp.publicKey.toBase58());
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  console.log("devnet balance:", (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL, "SOL");
} catch (e) { console.log("web3 check failed:", e.message); }
console.log("solana pkgs:", readdirSync("node_modules/@solana").join(", "));
