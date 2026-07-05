# UContent Portable

Self-contained Telegram + web workflow for UT content.

This folder is meant to be copied as one unit. It contains the UContent app, local helper source, RSS/search tooling, video cutter source, Remotion source, Docker config for local Telegram Bot API, and Docker config for SearXNG.

Runtime dependency folders are intentionally not bundled: `node_modules`, `.venv`, `data`, and `media` are created locally.

## Layout

- `server.mjs` - web server and API.
- `telegram-bot.mjs` - Telegram bot.
- `public/` - browser UI.
- `vendor/HeadlessNotion/` - local Notion scraper source.
- `vendor/xml-export/` - local XML export source.
- `tools/screenshot-engine/` - local screenshot engine source.
- `tools/video-scene-cutter/` - local Telegram video cutter source.
- `tools/utrends/` - RSS/Search tooling and source lists.
- `Remotion/` - Remotion project source.
- `media/` - default media root, ignored by git.
- `data/` - local scrape/session data, ignored by git.
- `.venv/` - local Python tools environment, ignored by git.
- `docker-compose.yml` - UContent + local Telegram Bot API + SearXNG.

## First Setup

## Run Everything In Docker

This is the easiest option when you want local Telegram Bot API support for files over the normal bot limits.

```powershell
cd C:\Ucontent
docker compose up -d --build
```

Open:

```text
http://localhost:5197/script-text
```

## Run UContent Locally

Windows:

```powershell
cd C:\Ucontent
.\setup-windows.ps1
docker compose up -d telegram-bot-api searxng
npm run start
```

macOS:

```bash
cd UContent
chmod +x setup-mac.sh
./setup-mac.sh
docker compose up -d telegram-bot-api searxng
npm run start
```

Then edit `.env`:

- `UCONTENT_BOT_TOKEN`
- `BASE_API_URL` / `BASE_FILE_URL` if using local Telegram Bot API
- optional `PAMPAM_ROOT` if you do not want the portable default `./media`
- optional `FFMPEG_PATH` if `ffmpeg` is not in `PATH`

## Run

```bash
npm run start
```

Open:

```text
http://localhost:5197/script-text
```

## Tools Resolution

UContent prefers local tools:

- `yt-dlp`: `UContent/.venv` or `UContent/tools`
- `gallery-dl`: `UContent/.venv` or `UContent/tools`
- screenshot engine: `UContent/tools/screenshot-engine`
- video scene cutter: `UContent/tools/video-scene-cutter`
- RSS/search: `UContent/tools/utrends`
- Remotion: `UContent/Remotion`

External paths can still be set through `.env`, but they are no longer required for the default layout.

## Remotion Graphics

The media picker can render Remotion quote/news cards directly into `media/graphics` and attach the result to the active segment.

In Docker, Remotion dependencies are installed during the `ucontent` image build from `Remotion/package-lock.json`.

Programmatic render endpoint:

```http
POST /api/remotion/render
```

Example body:

```json
{
  "format": "quote-1x1",
  "props": {
    "source": "UCONTENT",
    "quote": "Text to render",
    "author": "Author"
  }
}
```

Supported formats: `quote-1x1`, `quote-2x1`, `news-1x1`, `news-2x1`, plus `quote-1x1-alpha` and `quote-2x1-alpha`.
