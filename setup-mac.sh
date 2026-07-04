#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
npm install
python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip yt-dlp gallery-dl
./.venv/bin/python -m pip install -r tools/video-scene-cutter/requirements.txt
if [ -f tools/utrends/requirements.txt ]; then
  ./.venv/bin/python -m pip install -r tools/utrends/requirements.txt
fi
printf 'Done. Start infra with: docker compose up -d telegram-bot-api searxng\n'
printf 'Start UContent locally with: npm run start\n'
