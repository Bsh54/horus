# 𓂀 HORUS — the eye on every match

**A Telegram pundit for the 2026 World Cup.** HORUS turns TxLINE's real-time
match data into instant visual cards — goals, cards and market swings, with the
betting market's read on every moment — in **your language**, and verifiable on
**Solana**.

Built for the TxODDS World Cup Hackathon (Consumer & Fan Experiences track),
powered end-to-end by the **TxLINE** real-time data layer.

**Try it → [@hoorusbot](https://t.me/hoorusbot)** · Landing & dashboard: https://proofdesk.shadrakbessanh.me

---

## What HORUS does

- **🌍 130+ languages.** Pick your language at first contact (Fon, Yorùbá,
  Swahili and more); every card, ping and AI answer arrives in it. `/language`
  to switch. Football terms use a curated lexicon, never raw machine translation.
- **⚽ Live visual cards.** Every goal, red card, yellow card, VAR call,
  kick-off and full-time is a designed card carrying the **real TxLINE
  demargined win probability and 1X2 odds at that exact minute** — plus the
  scorer / booked player's portrait.
- **🎬 Live a match from the 0th minute.** Open a live match, take a position,
  choose your pace (x2 / x5 / Normal), and watch the whole game unfold as
  personal, private playback — driven by the complete match feed.
- **🗣 Three pundit voices.** El Fuego, The Professor and OptaBrain narrate the
  moments — alive, never generic, and fact-locked (numbers, names and scores
  are never altered by the LLM).
- **💬 Ask anything.** In a private chat, just talk — HORUS answers only from
  the live feed and can't invent a score. Groups use `/ask`.
- **◎ On-chain, real SOL.** Take a position on a live/upcoming match; it settles
  automatically at the final whistle. Premium (0.1 SOL) is paid on-chain too.
  Every transfer is a real Solana **devnet** transaction — the TxL token is
  **never** used for wagering.
- **🔏 Verifiable.** `/verify` proves a match score against the TxLINE Merkle
  root anchored on Solana (statToProve / eventStatRoot / statProof). HORUS
  literally cannot fabricate a result. A hash-chained journal seals every alert.
- **🏁 Recaps.** Tap any finished match for one recap card + the full
  line-by-line story and complete stats.

## Bot commands

```
/start      onboarding: language → plan → matches
/matches    browse matches: live, upcoming, finished
/ask        ask HORUS about a live match (auto in private chats)
/verify N   prove a score on-chain (Solana Merkle proof)
/wallet     your devnet SOL balance and bets
/plan       your plan and on-chain upgrade
/language   change your language
/help       the guide
```

## Architecture

```
TxLINE (SSE streams + historical, on-chain authorised)
  ├─ /api/odds/stream        demargined consensus, all markets
  ├─ /api/scores/stream      team-level stats, clock, phases
  ├─ /api/scores/historical  authentic score replay of a match
  ├─ /api/odds/updates       full odds tick history
  └─ /api/scores/stat-validation   Merkle proof material
        │
        ▼
  server.js ── event pipeline: decode stats, detect goals/cards/periods,
        │      maintain per-match probability state, run personal sessions
        ├─ simulator.mjs  the demo championship — real TxLINE match streams
        │                 cached and served as live / upcoming / finished
        ├─ horus.mjs      cards, recaps, per-minute market lookup, LLM Q&A
        ├─ cards.mjs + cards/render.py   the visual card renderer (Pillow)
        ├─ personas.mjs   the three fact-locked pundit voices
        ├─ i18n.mjs       language catalog, translation cache, football lexicon
        ├─ users.mjs      profiles: language, plan, quotas
        ├─ bank.mjs       custodial devnet-SOL wallets: bets, payouts, premium
        ├─ proofs.mjs     TxLINE Merkle stat-validation → /verify
        ├─ agent.mjs      sharp-move detector on the demargined consensus
        └─ bot.mjs        Telegram Bot API client (long polling, zero deps)
```

Access to TxLINE is authorised **on-chain**: the server's Solana wallet holds a
devnet subscription to the TxLINE program, and every feed request is
authenticated with the token issued from that subscription.

**Demo continuity:** the hackathon feed is free only through July 19, while
judging runs to the 29th. HORUS caches the authentic TxLINE match streams
locally (`simulator.mjs fetch`), so the full product stays alive at any time.

## TxLINE endpoints used

- `POST /auth/guest/start` — session JWT
- `POST /api/token/activate` — API token from the on-chain subscription
- `GET /api/odds/stream`, `GET /api/scores/stream` — live SSE feeds
- `GET /api/fixtures/snapshot` — schedule, past and future
- `GET /api/odds/snapshot/{id}`, `GET /api/scores/snapshot/{id}`
- `GET /api/odds/updates/{id}` — full odds history (price + demargined Pct)
- `GET /api/scores/historical/{id}` — full score stream replay
- `GET /api/scores/stat-validation?fixtureId&seq&statKey` — Merkle proof
  (note: the parameter is `statKey`, not `statId`)

## Run it

```bash
npm install
node txline-onboard.mjs                 # one-time: wallet + on-chain subscription
echo '{ "token": "<telegram bot token>" }' > data/telegram.json

node simulator.mjs fetch                # one-time: cache authentic TxLINE match data
node prefetch-players.mjs               # one-time: cache player portraits
node server.js                          # feed + bot + landing/dashboard on :80
```

Optional: `data/deepseek.json` (`{ "key": "...", "model": "..." }`) enables the
pundit voices and Q&A; without it HORUS falls back to deterministic commentary.

### Operational tools

`gen-catalog.mjs` (build fixtures catalog) · `espn-archive.mjs` (fetch
play-by-play) · `prefetch-players.mjs` (player portraits) · `backtest.mjs`
(agent calibration) · `topup.mjs` / `wallet-info.mjs` (house wallet ops).
