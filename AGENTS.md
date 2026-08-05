# Repository instructions

## Text encoding

- Keep every source, configuration, documentation, and message-template file in UTF-8.
- Preserve Russian text as real Unicode. Never commit replacement characters, runs of four or more question marks, or text that was decoded and re-encoded through the wrong code page.
- On Windows, always specify UTF-8 when reading text with PowerShell (`Get-Content -Encoding UTF8`). Do not pass non-ASCII text to Node, Docker, curl, or Telegram through a PowerShell here-string/stdin pipeline unless the complete pipeline is explicitly UTF-8-safe. Prefer text stored in a UTF-8 source file or Unicode escape sequences for one-off shell commands.
- After changing user-visible text, run `npm run check`. The encoding check is mandatory before rebuilding or restarting the service.
- For Telegram smoke tests containing Russian text, inspect the returned Bot API `message.text` or `message.caption` and assert that it exactly matches the string sent. A successful HTTP response alone is insufficient.

## Verification

- Run `npm run check` after JavaScript or user-visible text changes.
- When changing video processing, also test the relevant command inside the `ucontent` container against a real media file.

## YouTube cookies and anti-bot failures

- If YouTube media stops downloading and the bot only sends page previews/screenshots, first check cookies before changing downloader logic.
- Common log symptoms: `youtube.com needs browser cookies`, `Sign in to confirm you're not a bot`, `Only images are available`, `Requested format is not available`, or fallback to `Не удалось скачать медиа. Сохраняю превью страницы...`.
- In Docker, media downloads should prefer a real cookies file over browser-profile extraction. Check these in order: `MEDIA_COOKIES_PATH`, `SCREENSHOT_COOKIES_PATH` (usually `/app/data/cookies.txt`), then `MEDIA_COOKIES_FROM_BROWSER`.
- A stale `MEDIA_COOKIES_FROM_BROWSER=firefox:/app/firefox-profile` can break YouTube even when `/app/data/cookies.txt` still works. Test both explicitly before deciding cookies are bad.
- Test inside the container with the same tools the bot uses, for example:
  `docker exec ucontent sh -lc "/app/.venv/bin/yt-dlp --no-update --no-playlist --cookies /app/data/cookies.txt --js-runtimes deno:/usr/local/bin/deno --simulate --print '%(title)s | %(availability)s | %(duration)s' '<youtube-url>'"`
- Also verify the JS runtime exists. If `MEDIA_YTDLP_JS_RUNTIME=deno:/usr/local/bin/deno`, then `/usr/local/bin/deno` must exist inside `ucontent`; otherwise YouTube extraction may degrade or fail.
- If `yt-dlp` intermittently reports `Network is unreachable` or DNS failures from Docker while host networking works, force IPv4 for YouTube tests/downloads with `--force-ipv4` before assuming cookies are stale.
- If the cookies file is stale, refresh/export cookies from the logged-in browser/session and retry before making code changes.

## Download integrity

- Never treat a downloaded file as complete merely because the download command exited successfully or the destination file exists.
- After every download, verify integrity with a format-appropriate check before using, moving, publishing, or reporting the file as ready. At minimum, confirm a non-zero plausible size; use a supplied checksum when available.
- For downloaded video or audio, probe the finished file with `ffprobe` and perform a full decode check with `ffmpeg -v error -i <file> -f null -`. A successful metadata probe alone is not sufficient.
- Download to a temporary partial filename and rename it to the final filename only after all integrity checks pass. If verification fails, report the failure and do not present the partial or corrupt file as completed.
