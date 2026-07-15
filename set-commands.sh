#!/bin/bash
TOKEN=$(python3 -c "import json;print(json.load(open('/opt/proofdesk/data/telegram.json'))['token'])")
curl -s "https://api.telegram.org/bot$TOKEN/setMyCommands" -H 'Content-Type: application/json' -d '{
  "commands": [
    {"command": "matches",   "description": "List World Cup matches on the feed"},
    {"command": "follow",    "description": "Follow match N (get live alerts)"},
    {"command": "followall", "description": "Follow every match"},
    {"command": "live",      "description": "Score, probabilities and odds right now"},
    {"command": "relive",    "description": "Watch a match from the start"},
    {"command": "stopreplay","description": "Leave the current match"},
    {"command": "unfollow",  "description": "Silence all alerts"},
    {"command": "start",     "description": "Who is HORUS + help"}
  ]
}'
echo
curl -s "https://api.telegram.org/bot$TOKEN/setMyDescription" -H 'Content-Type: application/json' -d '{"description":"The eye on every match. I watch all World Cup matches and their betting markets at once - goals, red cards and sharp market moves, by text and by voice. Powered by real-time TxLINE data on Solana."}'
echo
curl -s "https://api.telegram.org/bot$TOKEN/setMyShortDescription" -H 'Content-Type: application/json' -d '{"short_description":"The eye on every World Cup match - live alerts, voice notes, market intelligence."}'
echo
