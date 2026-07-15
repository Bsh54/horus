#!/bin/bash
TOKEN=$(python3 -c "import json;print(json.load(open('/opt/proofdesk/data/telegram.json'))['token'])")
curl -s "https://api.telegram.org/bot$TOKEN/setMyCommands" -H 'Content-Type: application/json' -d '{
  "commands": [
    {"command": "matches",   "description": "Browse matches: live, upcoming, finished"},
    {"command": "ask",       "description": "Ask HORUS about a live match"},
    {"command": "verify",    "description": "Prove a score on-chain (Solana)"},
    {"command": "wallet",    "description": "Your devnet SOL balance and bets"},
    {"command": "plan",      "description": "Your plan and on-chain upgrade"},
    {"command": "language",  "description": "Change your language"},
    {"command": "help",      "description": "Guide - what HORUS can do"}
  ]
}'
echo
curl -s "https://api.telegram.org/bot$TOKEN/setMyDescription" -H 'Content-Type: application/json' -d '{"description":"The eye on every match. I broadcast World Cup matches inside Telegram - goals, cards, corners and what the betting market makes of it, minute by minute. Powered by TxLINE data on Solana."}'
echo
curl -s "https://api.telegram.org/bot$TOKEN/setMyShortDescription" -H 'Content-Type: application/json' -d '{"short_description":"The eye on every World Cup match - broadcasts with market intelligence."}'
echo
