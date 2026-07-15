# 𓂀 HORUS — the eye on every match

**A Telegram pundit bot for the 2026 World Cup.** HORUS watches every match and
its betting market at the same time, and tells you the moment something
matters — in **your language**, by text *and* by voice.

Built for the TxODDS World Cup Hackathon (Consumer & Fan Experiences track),
powered end-to-end by the **TxLINE** real-time data layer on **Solana**.

**Try it: [@hoorusbot](https://t.me/hoorusbot)** · Live dashboard: https://proofdesk.shadrakbessanh.me

## What HORUS does

- **🌍 Speaks your language** — pick from 130+ languages at `/start`
  (including Fon, Yorùbá, Swahili…); every notification, card and AI answer
  arrives in it. Change anytime with `/language`.
- **⚽ Live notifications** — goals, red cards, period changes, with the
  market's read attached: *"England jump from 41% to 62% win probability."*
- **🚨 Sharp-money alerts** — a calibrated detector watches the demargined
  odds consensus and warns fans when big money moves on a match, before the
  score explains why.
- **🗣 Voice notes (TTS)** — the big moments arrive as spoken pundit voice
  lines, like a friend sending you voice messages during the match.
- **💬 Conversational Q&A** — ask anything ("who is winning?", "what does the
  market think?"); HORUS answers from the live TxLINE data, never from
  imagination.
- **🕰 Time machine** — `/relive N` replays any archived tournament match as
  if it were live: the market story unfolds message by message. Works long
  after the matches have ended.
- **⭐ Free & Premium plans** — Free gets instant text alerts and 5 AI
  questions a day; Premium (0.1 SOL, paid **on-chain on Solana devnet**)
  unlocks visual match cards, voice commentary, unlimited AI and sharp-money
  alerts.
- **🔏 Verifiable pundit** — every alert HORUS sends is appended to a
  hash-chained journal (SHA-256, each entry sealing the previous one), so its
  track record cannot be rewritten after the fact.

## Bot commands

```
/start           onboarding: language → plan → matches
/matches         list matches on the feed
/follow N        follow one match
/followall       follow everything
/live            current picture: score, minute, probabilities, odds
/ask <question>  talk to HORUS about the live matches
/relive N        replay an archived match, as if live
/plan            your plan — upgrade to Premium (devnet SOL)
/language        change your language
/wallet          your devnet SOL balance and bets
/voice on|off    voice notes
/unfollow        silence HORUS
```

## How it works

```
TxLINE (SSE streams, Solana devnet)
  ├─ /api/odds/stream        consensus demargined odds, all markets
  ├─ /api/scores/stream      team-level stats, clock, phases
  ├─ /api/scores/historical  authentic score replay of finished matches
  └─ /api/odds/updates       full historical tick data
        │
        ▼
  server.js  ── decodes stats, detects goals/cards/periods,
        │       maintains per-match probability state
        ├─ simulator.mjs  DEMO_MODE=1: replays 14 real World Cup matches
        │                 as live/upcoming/finished — same pipeline, the
        │                 bot cannot tell demo from reality
        ├─ i18n.mjs       language catalog + translation client + cache
        ├─ users.mjs      profiles: language, Free/Premium plan, AI quota
        ├─ agent.mjs      sharp-move detector (deterministic thresholds,
        │                 calibrated by replaying the recorded tournament)
        ├─ bank.mjs       custodial devnet-SOL wallets: bets, payouts and
        │                 Premium payments, every transfer on-chain
        ├─ horus.mjs      narration + TTS (edge-tts → opus) + LLM Q&A layer
        └─ bot.mjs        Telegram Bot API client (long polling, zero deps)
```

Access to TxLINE is authorised **on-chain**: the server's Solana wallet holds
a devnet subscription to the TxLINE program, and every feed request is
authenticated with the token issued from that on-chain subscription.

## TxLINE endpoints used

- `POST /auth/guest/start` — session JWT
- `POST /api/token/activate` — API token from the on-chain subscription
- `GET /api/odds/stream`, `GET /api/scores/stream` — live SSE feeds
- `GET /api/fixtures/snapshot` (+ `startEpochDay`) — schedule, past and future
- `GET /api/odds/snapshot/{fixtureId}`, `GET /api/scores/snapshot/{fixtureId}`
- `GET /api/odds/updates/{fixtureId}` — full odds history
- `GET /api/scores/historical/{fixtureId}` — score stream replay (demo mode)
- `GET /api/scores/stat-validation?fixtureId&seq&statKey` — Merkle proof
  material for on-chain stat verification

## Run it

```bash
npm install
node txline-onboard.mjs        # one-time: wallet + on-chain subscription
echo '{ "token": "<telegram bot token>" }' > data/telegram.json
node server.js                 # feed + bot + dashboard on :8088

# demo mode: replay 14 real World Cup matches as if live
node simulator.mjs fetch       # one-time: cache authentic TxLINE history
DEMO_MODE=1 node server.js
```

Optional: `data/deepseek.json` (`{ "key": "..." }`) enables the conversational
layer; without it HORUS falls back to deterministic commentary. Voice notes
need `ffmpeg` and `edge-tts` on the PATH.
