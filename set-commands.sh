#!/bin/bash
TOKEN=$(python3 -c "import json;print(json.load(open('/opt/proofdesk/data/telegram.json'))['token'])")
curl -s "https://api.telegram.org/bot$TOKEN/setMyCommands" -H 'Content-Type: application/json' -d '{
  "commands": [
    {"command": "matches",   "description": "Pick a World Cup match to watch"},
    {"command": "stopreplay","description": "Leave the current match"},
    {"command": "start",     "description": "Who is HORUS + help"}
  ]
}'
echo
curl -s "https://api.telegram.org/bot$TOKEN/setMyDescription" -H 'Content-Type: application/json' -d '{"description":"The eye on every match. I broadcast World Cup matches inside Telegram - goals, cards, corners and what the betting market makes of it, minute by minute. Powered by TxLINE data on Solana."}'
echo
curl -s "https://api.telegram.org/bot$TOKEN/setMyShortDescription" -H 'Content-Type: application/json' -d '{"short_description":"The eye on every World Cup match - broadcasts with market intelligence."}'
echo
