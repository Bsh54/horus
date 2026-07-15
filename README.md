# 𓂀 HORUS — the eye on every match

**A Telegram pundit bot for the 2026 World Cup.** HORUS watches every match and
its betting market at the same time, and tells you the moment something
matters — by text *and* by voice.

Built for the TxODDS World Cup Hackathon (Consumer & Fan Experiences track),
powered end-to-end by the **TxLINE** real-time data layer on **Solana**.

**Try it: [@hoorusbot](https://t.me/hoorusbot)** · Live dashboard: https://proofdesk.shadrakbessanh.me

## What HORUS does

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
- **🔏 Verifiable pundit** — every alert HORUS sends is appended to a
  hash-chained journal (SHA-256, each entry sealing the previous one), so its
  track record cannot be rewritten after the fact.

## Bot commands

```
/matches         list matches on the feed
/follow N        follow one match
/followall       follow everything
/live            current picture: score, minute, probabilities, odds
/ask <question>  talk to HORUS about the live matches
/relive N        replay an archived match, as if live
/voice on|off    voice notes
/unfollow        silence HORUS
```

## How it works

```
TxLINE (SSE streams, Solana devnet)
  ├─ /api/odds/stream     consensus demargined odds, all markets
  ├─ /api/scores/stream   team-level stats, clock, phases
  └─ /api/odds/updates    full historical tick data (time machine)
        │
        ▼
  server.js  ── decodes stats, detects goals/cards/periods,
        │       maintains per-match probability state
        ├─ agent.mjs   sharp-move detector (deterministic thresholds,
        │              calibrated by replaying the recorded tournament)
        ├─ horus.mjs   narration + TTS (edge-tts → opus) + LLM Q&A layer
        └─ bot.mjs     Telegram Bot API client (long polling, zero deps)
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
- `GET /api/odds/updates/{fixtureId}` — full odds history (powers `/relive`)

## Run it

```bash
npm install
node txline-onboard.mjs        # one-time: wallet + on-chain subscription
echo '{ "token": "<telegram bot token>" }' > data/telegram.json
node server.js                 # feed + bot + dashboard on :8088
```

Optional: `data/deepseek.json` (`{ "key": "..." }`) enables the conversational
layer; without it HORUS falls back to deterministic commentary. Voice notes
need `ffmpeg` and `edge-tts` on the PATH.
