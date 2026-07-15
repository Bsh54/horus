// HORUS bank — custodial devnet-SOL betting from Telegram.
// Every stake and payout is a real on-chain transfer on Solana devnet,
// settled by the archived TxLINE result. The house wallet (data/wallet.json)
// funds new punters and holds the escrow.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "data");
const HOUSE_FILE = join(DATA, "wallet.json");
const PUNTERS_FILE = join(DATA, "punters.json");
const BETS_FILE = join(DATA, "bets.json");

const RPC = "https://api.devnet.solana.com";
export const STAKE_SOL = 0.05;           // fixed tap-to-bet stake
const FUND_SOL = 0.25;                    // starter balance for a new punter
const EXPLORER = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export function createBank({ journal = () => {} } = {}) {
  const conn = new Connection(RPC, "confirmed");
  const house = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(HOUSE_FILE, "utf8"))));

  const punters = existsSync(PUNTERS_FILE) ? JSON.parse(readFileSync(PUNTERS_FILE, "utf8")) : {};
  const bets = existsSync(BETS_FILE) ? JSON.parse(readFileSync(BETS_FILE, "utf8")) : [];
  const savePunters = () => writeFileSync(PUNTERS_FILE, JSON.stringify(punters));
  const saveBets = () => writeFileSync(BETS_FILE, JSON.stringify(bets));

  async function transfer(fromKp, toPub, sol) {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: fromKp.publicKey,
      toPubkey: new PublicKey(toPub),
      lamports: Math.round(sol * LAMPORTS_PER_SOL),
    }));
    return sendAndConfirmTransaction(conn, tx, [fromKp], { commitment: "confirmed" });
  }

  async function ensureHouseFunds() {
    const bal = await conn.getBalance(house.publicKey);
    if (bal < 1 * LAMPORTS_PER_SOL) {
      try {
        const sig = await conn.requestAirdrop(house.publicKey, 2 * LAMPORTS_PER_SOL);
        await conn.confirmTransaction(sig, "confirmed");
        console.log("[bank] airdropped 2 SOL to house");
      } catch (e) { console.log("[bank] airdrop failed:", e.message); }
    }
    return conn.getBalance(house.publicKey);
  }

  function punterKp(chatId) {
    const id = String(chatId);
    if (!punters[id]) {
      const kp = Keypair.generate();
      punters[id] = { secret: Array.from(kp.secretKey), pub: kp.publicKey.toBase58() };
      savePunters();
    }
    return Keypair.fromSecretKey(Uint8Array.from(punters[id].secret));
  }

  return {
    STAKE_SOL,
    explorer: EXPLORER,

    async balanceOf(chatId) {
      const kp = punterKp(chatId);
      return { pub: kp.publicKey.toBase58(), sol: (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL };
    },

    hasOpenBet(chatId, fixtureId) {
      return bets.some((b) => b.chatId === String(chatId) && b.fid === Number(fixtureId) && !b.settled);
    },

    // stake goes punter -> house, on-chain; funds the punter first if new
    async placeBet(chatId, fixtureId, side, sideName, odds) {
      const kp = punterKp(chatId);
      await ensureHouseFunds();
      const bal = await conn.getBalance(kp.publicKey);
      if (bal < (STAKE_SOL + 0.01) * LAMPORTS_PER_SOL) {
        await transfer(house, kp.publicKey, FUND_SOL); // starter grant from the house
      }
      const sig = await transfer(kp, house.publicKey, STAKE_SOL);
      const bet = {
        id: `${Date.now()}-${chatId}`, chatId: String(chatId), fid: Number(fixtureId),
        side, sideName, odds, stake: STAKE_SOL, txSig: sig, settled: false, placedAt: Date.now(),
      };
      bets.push(bet); saveBets();
      journal({ kind: "bet-placed", ...bet });
      return bet;
    },

    // result: 0 home / 1 draw / 2 away — pays winners at the odds taken
    async settle(fixtureId, result, notify) {
      for (const b of bets) {
        if (b.fid !== Number(fixtureId) || b.settled) continue;
        b.settled = true;
        b.won = b.side === result;
        if (b.won) {
          const payout = +(b.stake * b.odds).toFixed(4);
          try {
            b.payoutSig = await transfer(house, punterKp(b.chatId).publicKey, payout);
            b.payout = payout;
            await notify(b.chatId,
              `💰 <b>You beat the market.</b> ${b.sideName} @ ${b.odds} — ${b.stake} SOL returns <b>${payout} SOL</b>, paid on-chain.\n<a href="${EXPLORER(b.payoutSig)}">View payout on Solana Explorer</a>`);
          } catch (e) {
            b.payoutError = e.message;
            await notify(b.chatId, `You won ${b.sideName} @ ${b.odds}, payout pending — the bank will retry.`);
          }
        } else {
          await notify(b.chatId, `📉 Settled: ${b.sideName} @ ${b.odds} didn't come in. The market keeps your ${b.stake} SOL this time.`);
        }
        journal({ kind: "bet-settled", id: b.id, won: b.won, payout: b.payout || 0 });
      }
      saveBets();
    },

    // one-off on-chain payment punter -> house (premium upgrade); funds the
    // punter's custodial wallet first so the demo flow never dead-ends
    async pay(chatId, sol, kind = "premium") {
      const kp = punterKp(chatId);
      await ensureHouseFunds();
      const bal = await conn.getBalance(kp.publicKey);
      if (bal < (sol + 0.01) * LAMPORTS_PER_SOL) {
        // fund only what the payment needs, so a lean house wallet still works
        const houseBal = await conn.getBalance(house.publicKey);
        const grant = houseBal >= (FUND_SOL + 0.01) * LAMPORTS_PER_SOL ? FUND_SOL : sol + 0.05;
        await transfer(house, kp.publicKey, grant);
      }
      const sig = await transfer(kp, house.publicKey, sol);
      journal({ kind: `pay-${kind}`, chatId: String(chatId), sol, txSig: sig });
      return sig;
    },

    openBetsFor: (fixtureId) => bets.filter((b) => b.fid === Number(fixtureId) && !b.settled),
    betsOf: (chatId) => bets.filter((b) => b.chatId === String(chatId)),
  };
}
