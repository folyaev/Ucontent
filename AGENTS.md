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
