$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip yt-dlp gallery-dl
.\.venv\Scripts\python.exe -m pip install -r tools\video-scene-cutter\requirements.txt
if (Test-Path tools\utrends\requirements.txt) {
  .\.venv\Scripts\python.exe -m pip install -r tools\utrends\requirements.txt
}
Write-Host "Done. Start infra with: docker compose up -d telegram-bot-api searxng"
Write-Host "Start UContent locally with: npm run start"
