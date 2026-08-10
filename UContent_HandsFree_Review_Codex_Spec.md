# UContent Hands-Free Script Review Mode + Adobe Premiere MCP
## Implementation Specification for Codex

**Target repository:** `folyaev/Ucontent`  
**Target branch baseline:** `main`  
**Spec date:** 2026-08-10  
**Primary goal:** build the first genuinely usable hands-free Script Review Mode inside the existing UContent codebase, with optional Adobe Premiere Pro playback/control through MCP.

---

# 0. EXECUTION DIRECTIVE

This is an implementation task, not a brainstorming task.

Work directly in the existing `folyaev/Ucontent` repository. Do not create a second application or a "UContent 2.0". Audit the current repository first, then implement the vertical slice described below.

Do not ask the user to choose routine implementation details. Resolve them from the repository, runtime capabilities, and this spec. Ask only if a destructive or truly non-resolvable decision is required.

The required result is a working feature, tests, setup notes, and a short verification checklist.

Do not stop at UI mockups, interfaces, TODOs, pseudocode, or a roadmap.

---

# 1. PRODUCT NORTH STAR

The user must be able to process a script by topic without touching the keyboard.

The intended top-level loop is:

```text
TOPIC INTRO
    ↓
SCRIPT PASS
    ↓
TOPIC CHECKPOINT
    ├── "следующая тема" ────────────────→ NEXT TOPIC
    └── "покажи кандидатов"
                 ↓
          CANDIDATE PASS
                 ↓
          TOPIC SUMMARY
                 ↓
             NEXT TOPIC
```

Search/production runs independently in the background while the user continues the Script Pass.

At the end of a topic, UContent should tell the user what it has already found and offer two meaningful choices:

```text
"По этой теме 5 запросов.
По трём уже есть кандидаты, два ещё ищутся.
Показать кандидатов или перейти к следующей теме?"
```

The Candidate Pass is hands-free:

```text
"Кандидат 1 из 5"
→ preview plays

"следующий"
→ candidate 2

"этот берём"
→ USE current candidate

"первый, второй и пятый"
→ USE candidates 1, 2, 5

"второй и четвёртый не нужны"
→ REJECT 2, 4

"ищи ещё"
→ MORE for current request

"ищи глубже"
→ DEEPER for current request

"повтори"
→ replay current candidate

"предыдущий"
→ previous candidate

"открой источник"
→ open original URL

"в премьер"
→ open the current local preview/final media in Premiere if available

"следующий запрос"
→ next request in current topic

"следующая тема"
→ exit Candidate Pass and continue
```

The user should make creative decisions. The machine should handle navigation, search, preview preparation, persistence, downloading, cutting, verification, file placement, and Premiere handoff.

---

# 2. EXISTING UCONTENT BASELINE — PRESERVE IT

Audit the live repository before editing, but assume the current baseline includes:

- Node.js ESM application.
- `server.mjs` as the main HTTP server/API.
- `telegram-bot.mjs`.
- browser UI under `public/`.
- existing `/script-text`.
- Notion scrape + stable segment IDs.
- segment `media_items`.
- `media-index.mjs` JSON media index.
- existing `yt-dlp`, `gallery-dl`, ffmpeg and Python `.venv`.
- existing Puppeteer/browser profile.
- UTrends/RSS/search tooling.
- screenshot engine.
- video cutter.
- Remotion.
- local `data/` and `media/`.
- Docker support, but also native Windows/macOS launch.

Current `package.json` is intentionally small. Do not convert the project into a framework-heavy stack.

Current media files remain on disk. Do not put binary media into SQLite.

Do not break `/script-text`, Telegram flows, existing media attachments, Remotion, downloads, screenshot workflows, or segment ID reconciliation.

---

# 3. HARD ENGINEERING CONSTRAINTS

1. **Local-first.**
   Core review functionality must not require an external paid API.

2. **Free-first.**
   Reuse local tools already in UContent.

3. **Restart-safe.**
   Requests, decisions, review position and production jobs must survive a process restart.

4. **Human-on-demand.**
   Do not interrupt Script Pass because production has a question unless the machine is physically blocked.

5. **Capture/Review must not wait for Production.**
   Search, preview creation and downloads are background work.

6. **Preview-first / download-last.**
   Do not fully download every search result.

7. **No VLM watching every candidate.**
   Use metadata, subtitles, text, thumbnail and short preview first.

8. **No universal autonomous agent.**
   Deterministic state machines and allow-listed commands are preferred.

9. **No unrestricted shell/browser from voice or LLM.**
   Voice commands become typed internal intents.

10. **No unsafe Premiere scripting by default.**
    Never enable arbitrary ExtendScript execution as a normal runtime dependency.

11. **Premiere is an adapter, not the database or workflow engine.**
    UContent remains the source of truth for requests, candidates, decisions and assets.

12. **Premiere must be optional.**
    If Premiere/MCP is unavailable, browser review still works.

13. **Do not force a full data migration before the vertical slice works.**
    Existing scrape JSON and stable Segment IDs remain authoritative for script content in this phase.

---

# 4. PREMIERE MCP DECISION

## 4.1 Primary MCP

Use as the primary integration target:

```text
leancoderkavy/premiere-pro-mcp
npm package: premiere-pro-mcp
baseline inspected: v1.9.2
```

Reasons:

- mature CEP control surface;
- read-only connection verification;
- project inspection;
- Source Monitor controls;
- modern capability-gated UXP integration;
- Premiere-native transcript access on compatible hosts;
- Source Monitor exact position control through UXP on compatible Premiere 26.3+ hosts;
- subclip creation through UXP;
- stable marker GUID reads through UXP;
- safer explicit capability model.

Do **not** fork it initially.

## 4.2 Secondary reference / fallback donor

Keep compatibility architecture broad enough to later support:

```text
hetpatel-11/Adobe_Premiere_Pro_MCP
```

It exposes a similarly large CEP tool surface and includes useful operations such as `add_marker_to_project_item`.

Do not run both MCP servers as normal production backends simultaneously.

## 4.3 Do not adopt the Ayush Ojha four-language stack as UContent infrastructure

`ayushozha/AdobePremiereProMCP` contains valuable architectural ideas, especially:

- media probe;
- thumbnail generation;
- waveform/silence;
- script parsing;
- asset matching;
- EDL;
- pacing analysis.

But do not import its Go + Rust + Python + TypeScript service mesh into UContent. UContent already has its own production stack.

Borrow ideas only when they solve a demonstrated UContent problem.

---

# 5. PREMIERE CAPABILITY MODEL

Never assume tool availability from a version string alone.

At connection time:

```text
1. start/connect MCP
2. call verify_premiere_connection
3. tools/list
4. if available call get_uxp_capabilities
5. cache normalized capabilities
6. expose them through /api/premiere/status
```

Normalize capabilities into:

```js
{
  connected: true,
  projectOpen: true,
  activeSequence: true,
  cep: true,
  uxp: true,
  exactSourceSeek: true,
  nativeTranscript: true,
  createSubclip: true,
  stableMarkerIds: true,
  sourcePlayback: true,
  importMedia: true,
  projectItemSearch: true
}
```

The UContent business layer must ask the adapter for semantic capabilities such as:

```js
premiere.capabilities().exactSourceSeek
```

It must not check specific MCP tool names outside the Premiere adapter.

---

# 6. PREMIERE TOOLS TO USE

The exact live tool catalog wins over this document. During implementation, inspect `tools/list`.

## Baseline CEP tools expected from the primary MCP

Use where present:

```text
verify_premiere_connection
get_full_project_overview
search_project_items
get_project_item_info
find_items_by_media_path
create_bin
move_item_to_bin
import_media

open_in_source
close_source_monitor
close_all_source_clips
set_source_in_out
get_source_monitor_info

play_source_monitor
get_source_monitor_position

add_marker
list_markers

save_project
```

Do not assume every tool above has identical arguments across MCP versions. Hide argument differences inside `PremiereAdapter`.

## UXP-enhanced tools

Use only after capability verification:

```text
get_uxp_capabilities
get_uxp_state

set_source_monitor_position_uxp

has_transcript_uxp
get_clip_transcript_uxp
search_clip_transcript_uxp

create_subclip_uxp
list_markers_uxp
```

Important:

- `get_clip_transcript_uxp` reads Premiere's existing native transcript. It does not itself run Speech-to-Text.
- `set_source_monitor_position_uxp` is the preferred exact candidate seek.
- `create_subclip_uxp` may be useful after a range has been accepted.
- `list_markers_uxp` can read stable marker GUIDs, including project-item markers when supported.
- Do not invent an automatic transcript-to-timeline edit path. The upstream project deliberately does not promise that yet.

---

# 7. PREMIERE RUNTIME MODES

## Mode A — Native UContent host — implement now

Supported MVP:

```text
Premiere Pro
UContent Node server
Premiere MCP server
MCP connector/panel
```

all run on the same Windows/macOS host.

UContent acts as an MCP client over stdio.

## Mode B — UContent in Docker — graceful fallback now

Do not spend the first implementation cycle solving host/Docker Premiere transport.

When UContent runs inside Docker and cannot reach a host Premiere MCP safely:

```text
premiere.connected = false
reviewPlaybackBackend = browser
```

The complete Review Mode must still work.

## Mode C — optional host bridge later

Only after the native vertical slice is stable, a small authenticated host-side bridge may expose a narrow UContent-specific Premiere API to Docker through `host.docker.internal`.

It is not required for the first acceptance gate.

---

# 8. MCP CLIENT IMPLEMENTATION

Create:

```text
src/premiere/premiere-mcp-client.mjs
src/premiere/premiere-adapter.mjs
src/premiere/premiere-review-controller.mjs
```

Prefer the official Model Context Protocol Node SDK rather than hand-writing JSON-RPC if adding the SDK is reasonable in the current dependency model.

Configuration:

```env
UCONTENT_PREMIERE_ENABLED=1
PREMIERE_MCP_COMMAND=premiere-pro-mcp
PREMIERE_MCP_ARGS=
PREMIERE_MCP_TIMEOUT_MS=5000
UCONTENT_PREMIERE_AUTO_IMPORT=0
UCONTENT_PREMIERE_UNSAFE=0
```

If the command is not available:

- return a clean unavailable state;
- do not crash UContent;
- use browser playback.

Requirements for `PremiereMcpClient`:

- start subprocess lazily;
- initialize MCP correctly;
- list tools;
- call tool by name;
- hard timeout;
- structured errors;
- reconnect after clean failure;
- do not automatically retry mutation calls unless they are idempotent or carry a verified operation ID;
- kill child on UContent shutdown;
- redact dangerous environment data from logs.

Do not expose generic `callTool(name,args)` to voice parsing or frontend code.

---

# 9. PREMIERE ADAPTER CONTRACT

The rest of UContent calls semantic methods:

```js
class PremiereAdapter {
  async status()
  async connect()
  async inspectProject()

  async ensureReviewBin({ episodeId })
  async ensureImported({ localPath, displayName, episodeId })

  async openSource({ projectItemId, projectItemName })
  async seekSource({ seconds })
  async setSourceRange({ startSeconds, endSeconds })
  async playSource({ speed = 1 })
  async closeSource()

  async getNativeTranscript({ projectItemId, projectItemName })
  async searchNativeTranscript({ projectItemId, projectItemName, query })

  async createAcceptedSubclip({
    projectItemId,
    projectItemName,
    name,
    startSeconds,
    endSeconds
  })

  async handoffAsset({
    localPath,
    episodeId,
    topicTitle,
    segmentId,
    requestId,
    candidateId,
    startSeconds,
    endSeconds
  })
}
```

Every adapter method returns a normalized envelope:

```js
{
  ok: true,
  backend: "premiere-mcp",
  capability: "exactSourceSeek",
  data: {}
}
```

or:

```js
{
  ok: false,
  unavailable: true,
  code: "UXP_EXACT_SEEK_UNAVAILABLE",
  message: "..."
}
```

No MCP-specific result shape should escape this module.

---

# 10. REVIEW PLAYBACK BACKENDS

Define a generic interface:

```js
ReviewPlaybackBackend
  prepare(candidate)
  play(candidate)
  replay()
  stop()
  openOriginal()
  dispose()
```

Implement:

```text
BrowserReviewPlayback
PremiereReviewPlayback
```

## BrowserReviewPlayback

This is mandatory and always available when a candidate has a browser-playable preview.

It controls `<video>` in `public/review.js`.

Advantages:

- deterministic play/pause/end events;
- no Premiere requirement;
- works during Docker mode;
- clean fallback.

## PremiereReviewPlayback

Use only if candidate media exists locally and Premiere capabilities are sufficient.

Flow:

```text
local preview exists
    ↓
ensureImported()
    ↓
openSource()
    ↓
setSourceRange()
    ↓
exact seek via UXP when available
    ↓
playSource()
    ↓
preview duration timer / state observation
    ↓
transition UI into LISTENING
```

If exact source seek is unavailable and the preview file itself is already trimmed to the desired range, exact seeking is unnecessary; open the trimmed preview at its beginning.

This is a key design decision:

> For candidate review, prefer importing a tiny pre-trimmed preview fragment rather than importing a full 20-minute source just to seek to 12:31.

Therefore Premiere 26.3 UXP is an enhancement, not an absolute requirement for candidate review.

Do not fill the production Premiere project with uncontrolled garbage. Put temporary candidate preview imports in a deterministic bin such as:

```text
UContent REVIEW
  / <episode-id>
```

Rejected preview files/imports are disposable and can be cleaned at episode finalization.

Accepted final assets go into a separate deterministic location/bin.

---

# 11. FINAL PREMIERE HANDOFF

`USE` remains a UContent decision first.

Flow:

```text
USE candidate
  ↓
persist decision
  ↓
cancel lower-value work
  ↓
prioritize final download
  ↓
verify source
  ↓
determine selected range
  ↓
cut/remux/transcode only if needed
  ↓
verify output
  ↓
attach to existing Segment media_items
  ↓
upsert existing media-index
  ↓
Asset READY
  ↓
optional Premiere handoff
```

Premiere handoff must never be required for Asset READY.

If `UCONTENT_PREMIERE_AUTO_IMPORT=1`, import verified assets after Asset READY.

Default to not inserting assets into a timeline automatically.

A later explicit command may do timeline insertion, but that is out of the first Review MVP unless trivial and verified.

---

# 12. CURRENT UCONTENT DATA COMPATIBILITY

Do not immediately move script content out of existing scrape JSON.

Existing scrape + stable segment ID remains authoritative for:

```text
topic
segment order
segment text
media_items
is_done
```

Add a new persistent production/review database keyed by:

```text
scrape_id
topic_key/title
segment_id
```

This lets the vertical slice work without a risky script migration.

---

# 13. SQLITE PERSISTENCE

Introduce SQLite for review/production state.

Before choosing a Node SQLite binding, inspect the actual runtime and Docker/native constraints.

Preferred decision order:

1. a stable built-in `node:sqlite` API if the actual supported Node runtime can use it without an unacceptable experimental flag/warning policy;
2. otherwise a well-supported SQLite package such as `better-sqlite3`, including required Docker/native build support.

Do not create Postgres/Redis/RabbitMQ.

Suggested module:

```text
src/storage/db.mjs
src/storage/migrations/
src/storage/repositories/
```

Minimum schema:

```sql
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  scrape_id TEXT NOT NULL,
  state TEXT NOT NULL,
  playback_backend TEXT NOT NULL DEFAULT 'browser',
  topic_index INTEGER NOT NULL DEFAULT 0,
  segment_index INTEGER NOT NULL DEFAULT 0,
  current_request_id TEXT,
  current_candidate_id TEXT,
  current_candidate_index INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS voice_utterances (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  normalized_text TEXT,
  parsed_intent_json TEXT,
  confidence REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES review_sessions(id)
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  scrape_id TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  type TEXT NOT NULL,
  query TEXT NOT NULL,
  raw_text TEXT,
  created_by TEXT NOT NULL,
  utterance_id TEXT,
  utterance_task_index INTEGER,
  status TEXT NOT NULL,
  search_depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(utterance_id, utterance_task_index)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  payload_json TEXT,
  result_json TEXT,
  heartbeat_at TEXT,
  last_error TEXT,
  run_after TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY(request_id) REFERENCES requests(id)
);

CREATE INDEX IF NOT EXISTS jobs_status_priority_idx
ON jobs(status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  request_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  url TEXT NOT NULL,
  title TEXT,
  uploader TEXT,
  duration_seconds REAL,
  score REAL,
  rank INTEGER,
  status TEXT NOT NULL,
  preview_path TEXT,
  preview_start_seconds REAL,
  preview_end_seconds REAL,
  local_source_path TEXT,
  selected_start_seconds REAL,
  selected_end_seconds REAL,
  transcript_source TEXT,
  metadata_json TEXT,
  shown_count INTEGER NOT NULL DEFAULT 0,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(request_id, source, source_id, url),
  FOREIGN KEY(request_id) REFERENCES requests(id)
);

CREATE TABLE IF NOT EXISTS candidate_decisions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  utterance_id TEXT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reverted_at TEXT,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id),
  FOREIGN KEY(request_id) REFERENCES requests(id),
  FOREIGN KEY(session_id) REFERENCES review_sessions(id)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  scrape_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  local_path TEXT,
  source_url TEXT,
  start_seconds REAL,
  end_seconds REAL,
  status TEXT NOT NULL,
  verification_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES candidates(id),
  FOREIGN KEY(request_id) REFERENCES requests(id)
);

CREATE TABLE IF NOT EXISTS review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES review_sessions(id)
);
```

Use migrations. Do not mutate schema ad hoc at request time.

---

# 14. JOB QUEUE

Current in-memory `MEDIA_JOBS = new Map()` is not sufficient for new production work.

Do not necessarily rewrite every legacy media job immediately.

Implement a new restart-safe job queue for the new Request/Candidate/Asset pipeline.

Job states:

```text
queued
running
retry_wait
completed
failed
cancelled
needs_user
```

Required fields:

```text
attempt
max_attempts
priority
heartbeat_at
last_error
run_after
```

Startup recovery:

```text
running job
AND heartbeat stale
→ queued or retry_wait
```

Jobs must be idempotent.

Use deterministic operation/output keys.

Important priorities:

```text
INTERACTIVE VOICE
    >
SELECTED ASSET
    >
CURRENT CANDIDATE PREVIEW
    >
OTHER PREVIEWS
    >
BACKGROUND SEARCH
    >
DEEP ANALYSIS
```

Implement with simple queues/semaphores, not a distributed scheduler.

---

# 15. REQUEST / CANDIDATE / ASSET SEMANTICS

## Request

Human intent:

```json
{
  "type": "find_video",
  "query": "Путин спускается по трапу",
  "segmentId": "seg-42"
}
```

One utterance may produce multiple Requests.

## Candidate

Potential material found for one Request.

## Decision

Review action:

```text
USE
REJECT
```

`MORE`, `DEEPER`, `OPEN`, navigation commands are not candidate decisions.

## Asset

Only a selected candidate that has been successfully turned into a verified local edit-ready file.

---

# 16. SCRIPT PASS STATE MACHINE

Implement a deterministic state machine.

Top-level states:

```text
LOADING
TOPIC_INTRO
READING_SEGMENT
LISTENING_SCRIPT
TRANSCRIBING_SCRIPT
PARSING_SCRIPT
SAVING_REQUESTS
TOPIC_CHECKPOINT
CANDIDATE_INTRO
PLAYING_CANDIDATE
LISTENING_CANDIDATE
TRANSCRIBING_CANDIDATE
PARSING_CANDIDATE
REQUEST_CHECKPOINT
TOPIC_SUMMARY
PAUSED
DONE
ERROR_RECOVERABLE
```

Do not store only frontend state. Persist enough server state to resume.

## Script Pass transition

```text
TOPIC_INTRO
→ READING_SEGMENT
→ LISTENING_SCRIPT
→ TRANSCRIBING_SCRIPT
→ PARSING_SCRIPT
→ SAVING_REQUESTS
→ next READING_SEGMENT
```

If user says no request for a segment:

```text
"дальше"
"следующий"
"ничего"
```

advance without creating a Request.

At the final eligible segment:

```text
→ TOPIC_CHECKPOINT
```

---

# 17. TOPIC CHECKPOINT

Compute:

```text
request count
requests with preview-ready candidates
candidate count
searching count
failed count
needs_user count
```

Example TTS:

```text
"Тема закончена.
Пять запросов.
По трём уже есть кандидаты.
Два ещё ищутся.
Показать кандидатов или следующая тема?"
```

Allowed intents:

```text
REVIEW_CANDIDATES
NEXT_TOPIC
REVIEW_LATER
WAIT_FOR_RESULTS
REPEAT_STATUS
PAUSE
```

`NEXT_TOPIC` must never cancel background search by default.

---

# 18. CANDIDATE PASS

Review order:

```text
current topic
  → requests in segment order
    → candidates by rank/score
```

At the start of each request, speak a short context:

```text
"Запрос два: Путин спускается по трапу.
Нашёл пять кандидатов."
```

For each candidate:

```text
announce index + compact metadata
play preview
transition to LISTENING_CANDIDATE
```

Example:

```text
"Кандидат 2 из 5. Reuters, 11 секунд."
```

Do not speak a long title over the video.

After all candidates for a Request:

```text
REQUEST_CHECKPOINT
```

Say:

```text
"Выбери номера, скажи ещё, глубже или следующий запрос."
```

This enables the desired command:

```text
"первый, второй и пятый"
```

Batch actions must use the stable candidate list snapshot for the current request, not a list that can reorder while the user is speaking.

Freeze a `review_rank` snapshot when entering the request's Candidate Pass.

Newly arriving candidates go after the existing snapshot or wait for the next `MORE`.

---

# 19. VOICE COMMAND MODEL

Voice must not directly execute code.

Pipeline:

```text
audio
→ VAD/end-of-speech
→ STT
→ deterministic parser
→ if unresolved: local LLM parser
→ schema validation
→ typed intent
→ state-machine command
```

Internal command schema:

```js
{
  intent: "USE_INDICES",
  indices: [1, 2, 5],
  text: null,
  confidence: 0.99,
  parser: "deterministic"
}
```

The set of legal intents depends on the current state.

Reject impossible intents rather than guessing destructively.

---

# 20. DETERMINISTIC RUSSIAN COMMAND PARSER

Create:

```text
src/review/voice-command-parser.mjs
src/review/ru-number-parser.mjs
```

Support numeric forms:

```text
1
один
первый
первого
первая
первую
номер один

2 / два / второй / второго
...
```

Support at least 1–20.

Normalize conjunctions and ranges:

```text
"первый второй и пятый"
"первый, второй, пятый"
"1 2 5"
"с первого по третий"
```

Core Candidate intents and Russian synonyms:

```text
USE_CURRENT
  "этот"
  "берём"
  "его берём"
  "оставь"
  "используем"
  "подходит"

USE_INDICES
  "первый и третий"
  "берём второй четвертый"
  "оставь 1 2 и 5"

REJECT_CURRENT
  "нет"
  "не подходит"
  "мимо"
  "отклонить"
  "не берём"

REJECT_INDICES
  "второй и четвертый не нужны"
  "отклони первый третий"

NEXT_CANDIDATE
  "дальше"
  "следующий"
  "следующий кандидат"

PREVIOUS_CANDIDATE
  "назад"
  "предыдущий"

REPLAY_CURRENT
  "повтори"
  "ещё раз"

MORE
  "ищи ещё"
  "ещё варианты"
  "покажи ещё"

DEEPER
  "ищи глубже"
  "копай глубже"
  "глубокий поиск"

OPEN_SOURCE
  "открой источник"
  "открой оригинал"

OPEN_PREMIERE
  "в премьер"
  "открой в премьере"

NEXT_REQUEST
  "следующий запрос"

NEXT_TOPIC
  "следующая тема"
  "к следующей теме"

UNDO_LAST_DECISION
  "отмени последнее"
  "верни последнее решение"

STATUS
  "статус"
  "что осталось"

PAUSE
  "пауза"
  "остановись"
```

Script Pass intents:

```text
CREATE_REQUESTS
NEXT_SEGMENT
REPEAT_SEGMENT
UNDO_LAST_REQUEST
NEXT_TOPIC
PAUSE
```

State context disambiguates `"следующий"`.

---

# 21. LOCAL LLM FALLBACK

Do not call an LLM when deterministic parsing already succeeds.

If a local command model already exists in UContent, reuse it.

If not, create an adapter without forcing a particular runtime into the architecture:

```text
src/ai/local-command-normalizer.mjs
```

The model receives only:

```text
current state
current topic title
current segment text
raw STT text
legal intents for current state
candidate count if relevant
```

Do not send the full episode.

Force structured JSON matching a schema.

Example Candidate Pass output schema:

```json
{
  "intent": "USE_INDICES",
  "indices": [1, 2, 5],
  "confidence": 0.94
}
```

If confidence is low or output is invalid:

```text
do not mutate state
ask a short clarification/repeat
```

---

# 22. AUDIO / HANDS-FREE MVP

Preserve the half-duplex philosophy.

First stable cycle:

```text
TTS SPEAKS
→ TTS ENDS
→ LISTENING
→ VAD detects speech
→ VAD detects end
→ STT
→ command executes
→ next TTS/playback
```

Do not require simultaneous always-on recognition while candidate audio is playing.

This avoids:

- the candidate audio being transcribed as a command;
- echo problems;
- wake-word complexity;
- false activation.

Frontend microphone constraints should request, when supported:

```js
{
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}
```

Use a clear visual state indicator:

```text
READING
PLAYING
LISTENING
TRANSCRIBING
SEARCHING
SAVING
PAUSED
```

The user must always know whether the microphone is listening.

---

# 23. STT

Audit the repository for an existing stable local STT path first.

If one exists, wrap it.

If it does not, create a provider abstraction:

```text
src/voice/stt-adapter.mjs
```

A persistent local worker is preferred over spawning/loading a model per utterance.

A reasonable fallback implementation is a persistent Python worker using a locally installed Whisper-family runtime, but do not hardwire the whole UContent architecture to WhisperX.

Requirements:

- Russian;
- timestamps optional for commands;
- low latency;
- model stays loaded;
- CPU fallback;
- GPU optional/configurable;
- no external API required.

Store raw transcript and parsed command for debugging.

Do not fine-tune anything in this phase.

---

# 24. TTS

Audit and reuse existing TTS where possible.

For the browser MVP, OS/browser speech synthesis is acceptable behind an adapter if it is already reliable in the user's environment.

Create a small frontend/backend-neutral interface so TTS can later be changed.

TTS phrases must be short during Candidate Pass.

---

# 25. NEW REVIEW UI

Do not embed this workflow inside the existing `/script-text` UI.

Create:

```text
public/review.html
public/review.js
public/review.css
```

Route:

```text
/review
```

The UI is not a dashboard full of controls. It is a hands-free status surface.

Suggested layout:

```text
┌──────────────────────────────────────────────┐
│ TOPIC 3 / 8                                  │
│ Путин прибыл в США                           │
├──────────────────────────────────────────────┤
│ SCRIPT / REQUEST                             │
│ "...current segment..."                      │
│                                              │
│ ● LISTENING                                  │
├──────────────────────────────────────────────┤
│ CURRENT REQUEST                              │
│ Путин спускается по трапу                    │
├──────────────────────────────────────────────┤
│ CANDIDATE 2 / 5                              │
│ [video preview]                              │
│ Reuters · 00:11                              │
├──────────────────────────────────────────────┤
│ READY 3   SEARCHING 2   FAILED 0             │
│ Premiere: CONNECTED / Browser fallback       │
└──────────────────────────────────────────────┘
```

Use big state typography.

Keep buttons for recovery/debug/mouse fallback, but voice is the primary path.

Minimum fallback buttons:

```text
Next
Repeat
Use
Reject
More
Deeper
Pause
```

---

# 26. REVIEW API

Add modular handlers instead of making `server.mjs` larger with all business logic.

Suggested endpoints:

```text
GET  /api/review/status
POST /api/review/start
POST /api/review/:sessionId/stop
POST /api/review/:sessionId/pause
POST /api/review/:sessionId/resume

POST /api/review/:sessionId/utterance
POST /api/review/:sessionId/audio

GET  /api/review/:sessionId/state
GET  /api/review/:sessionId/events

POST /api/review/:sessionId/command

GET  /api/review/requests/:requestId/candidates
POST /api/review/candidates/:candidateId/action

GET  /api/premiere/status
POST /api/premiere/reconnect
POST /api/premiere/candidates/:candidateId/open
```

The frontend should receive progress through SSE or the project's existing simplest suitable event channel.

Avoid high-frequency polling where SSE is straightforward.

---

# 27. SERVER MODULE STRUCTURE

The exact names may be adjusted after repo audit, but keep responsibilities separated.

Recommended:

```text
src/
  review/
    review-service.mjs
    review-state-machine.mjs
    review-session-repository.mjs
    voice-command-parser.mjs
    ru-number-parser.mjs
    topic-navigation.mjs

  voice/
    stt-adapter.mjs
    tts-contract.mjs

  production/
    job-queue.mjs
    job-worker.mjs
    request-service.mjs
    candidate-service.mjs
    asset-service.mjs

  search/
    candidate-provider.mjs
    youtube-provider.mjs

  preview/
    preview-service.mjs
    browser-preview.mjs

  premiere/
    premiere-mcp-client.mjs
    premiere-adapter.mjs
    premiere-review-controller.mjs

  storage/
    db.mjs
    migrations/
    repositories/

public/
  review.html
  review.js
  review.css
```

`server.mjs` should become an integration/composition root for the new feature, not contain the complete new feature inline.

Do not refactor unrelated old code purely for style.

---

# 28. YOUTUBE FIRST VERTICAL SLICE

The first automatic Candidate Provider is YouTube.

Do not start X/VK implementation before this works.

Reuse the existing local `yt-dlp`.

Search phase:

```text
ytsearch / metadata-only
→ no full media download
→ Candidate rows
```

Collect where cheap:

```text
source id
URL
title
channel/uploader
duration
thumbnail
upload date if available
basic format/capability info
```

Search result itself can become a Candidate before a preview exists:

```text
discovered
→ preview_queued
→ preview_ready
```

---

# 29. CHEAP CANDIDATE LOCALIZATION

For top-ranked YouTube candidates, prefer text/subtitles before vision.

Pipeline:

```text
Candidate metadata
→ captions available?
    ├── yes → fetch only subtitle data
    │          ↓
    │       find best query/semantic hit
    │          ↓
    │       derive source time range
    └── no  → thumbnail/metadata only first
```

Do not run a large visual model across full videos.

For subtitle hit:

```text
previewStart = max(0, hitStart - preRoll)
previewEnd   = hitEnd + postRoll
```

Reasonable defaults:

```text
preRoll: 2–3 seconds
postRoll: 5–10 seconds
max preview: ~15 seconds
```

Keep these configurable.

---

# 30. PREVIEW GENERATION

Generate previews only for candidates likely to be shown.

Preferred output:

```text
media/cache/previews/<episode>/<request>/<candidate>.mp4
```

Use a low-cost review profile, for example:

```text
H.264
360p or 480p
audio included
short duration
faststart
```

The final edit-ready asset is separate and higher quality.

Preview generation should be cancellable.

When a user says `USE`, selected-candidate work jumps in priority.

When a user says `REJECT`, future expensive work for that candidate should stop.

---

# 31. MORE VS DEEPER

These are distinct.

## MORE

Cheap expansion:

```text
more results
next search page
more simple query variants
more metadata/subtitle probing
```

No heavy vision.

## DEEPER

Higher budget for the current Request:

```text
broader query expansion
additional source adapters if implemented
browser fallback if needed
more caption probing
keyframes
optional targeted vision
optional research
```

In the first implementation, if vision/research is not implemented, DEEPER must still perform a real deeper deterministic operation. Do not fake success.

Persist `search_depth`.

---

# 32. PROGRESSIVE CANCELLATION

On `USE`:

```text
cancel unnecessary deep search
cancel lower-value preview jobs if enough has been selected
stop future preview generation for rejected/irrelevant candidates
prioritize selected candidate download
```

Do not cancel useful work for other Requests in the same topic unless clearly unnecessary.

---

# 33. BATCH SELECTION SEMANTICS

For a current request with frozen snapshot:

```text
1 cand-a
2 cand-b
3 cand-c
4 cand-d
5 cand-e
```

User:

```text
"первый второй и пятый"
```

must atomically map to:

```text
USE cand-a
USE cand-b
USE cand-e
```

If an index does not exist:

- apply valid indices only if intent remains unambiguous;
- report the missing number briefly;
- never shift numbers because new candidates arrived.

Use a transaction for batch decisions.

---

# 34. UNDO

Support:

```text
"отмени последнее"
```

At minimum:

- undo last Request creation in Script Pass if no irreversible final asset step has completed;
- undo last candidate decision in Candidate Pass.

A reverted USE should:

- cancel queued asset jobs if not finished;
- if final Asset already exists, do not silently delete it;
- mark decision reverted and explain status.

Do not implement destructive file deletion as an invisible voice-side effect.

---

# 35. ASSET WORKER

For a selected candidate:

```text
download selected source / necessary range
→ verify source
→ determine selected range
→ remux/cut when possible
→ transcode only when necessary
→ verify output
→ deterministic filename
→ attach to existing segment
→ media-index upsert
→ Asset READY
```

Reuse existing UContent downloader/cutter/ffmpeg logic.

Do not create duplicate download stacks.

The final file should be in the existing media organization expected by UContent.

---

# 36. RANGE SELECTION

Candidates should carry:

```text
preview_start_seconds
preview_end_seconds
```

If the user accepts the shown excerpt with no further trim instruction:

```text
selected_start_seconds = preview_start_seconds
selected_end_seconds = preview_end_seconds
```

Later add explicit trim voice commands if useful, but first make acceptance deterministic.

Final output may include configurable edit handles.

---

# 37. PREMIERE-NATIVE TRANSCRIPTS — OPTIONAL HIGH-VALUE PATH

For media already in Premiere:

```text
has_transcript_uxp
→ get_clip_transcript_uxp
→ search_clip_transcript_uxp
```

Use this for cases such as:

```text
"найди, где он говорит про стоимость производства"
```

when the source clip is already a Premiere project item.

Do not run separate Whisper on the same clip merely to duplicate an existing Premiere transcript unless needed for reliability/format reasons.

Cache the transcript revision/hash and source item identity.

This path is optional for the first web-candidate vertical slice but should be represented in the adapter architecture.

---

# 38. REVIEW BIN / PROJECT HYGIENE

Temporary Premiere review imports:

```text
UContent REVIEW/<episode-id>/
```

Final accepted assets:

```text
UContent/<episode-id>/<topic>/
```

Exact bin naming can be adapted to existing user project conventions, but use deterministic names.

Before import:

```text
find by media path
```

Do not import the same preview repeatedly.

Rejected temporary previews are disposable.

Do not delete project items automatically during an active review session unless the cleanup action is explicitly safe and tested.

---

# 39. CONFIGURATION

Add a documented configuration block.

Suggested:

```env
# Review
UCONTENT_REVIEW_ENABLED=1
UCONTENT_REVIEW_DEFAULT_BACKEND=auto
UCONTENT_REVIEW_PREVIEW_SECONDS=12
UCONTENT_REVIEW_PRE_ROLL=2
UCONTENT_REVIEW_POST_ROLL=7

# Voice
UCONTENT_STT_PROVIDER=auto
UCONTENT_STT_DEVICE=auto
UCONTENT_STT_MODEL=
UCONTENT_VAD_SILENCE_MS=900

# Premiere
UCONTENT_PREMIERE_ENABLED=1
PREMIERE_MCP_COMMAND=premiere-pro-mcp
PREMIERE_MCP_ARGS=
PREMIERE_MCP_TIMEOUT_MS=5000
UCONTENT_PREMIERE_AUTO_IMPORT=0
UCONTENT_PREMIERE_UNSAFE=0
```

`auto` review backend:

```text
candidate has local preview
AND Premiere available
AND user preference is Premiere
→ Premiere

otherwise
→ browser
```

Expose a simple UI toggle:

```text
Playback: AUTO / PREMIERE / BROWSER
```

Persist preference locally.

---

# 40. SECURITY

Mandatory:

- voice never becomes shell syntax;
- LLM output validated against intent schema;
- Candidate URLs normalized/validated;
- file paths constrained to allowed UContent media/cache roots;
- no arbitrary MCP tool calls from frontend;
- no arbitrary MCP tool calls from LLM;
- do not enable MCP unsafe-script profile;
- do not expose Premiere bridge over a public network in MVP;
- use existing UContent access protections for remote Review UI;
- redact tokens/cookies from logs;
- no automatic destructive cleanup on uncertain identity.

---

# 41. OBSERVABILITY

Every request must have a timeline.

Event examples:

```text
request_created
search_started
candidates_found
candidate_discovered
preview_started
preview_ready
candidate_shown
candidate_accepted
candidate_rejected
more_requested
deeper_requested
download_started
download_completed
cut_completed
verification_completed
asset_ready
premiere_import_started
premiere_import_completed
```

Record timestamps.

Metrics:

```text
Voice → Request
Request → First Candidate
Request → First Preview
Candidate shown → decision
Selection → Asset READY
Asset READY → Premiere imported
```

The primary metric is user active time.

---

# 42. FRONTEND EVENT CONTRACT

SSE event payloads should be compact and typed.

Example:

```json
{
  "type": "review.state",
  "sessionId": "rev-...",
  "state": "LISTENING_CANDIDATE",
  "topic": {
    "index": 2,
    "count": 8,
    "title": "..."
  },
  "request": {
    "id": "req-...",
    "query": "..."
  },
  "candidate": {
    "id": "cand-...",
    "index": 2,
    "count": 5,
    "title": "...",
    "source": "youtube",
    "previewUrl": "/api/..."
  },
  "counts": {
    "ready": 3,
    "searching": 2,
    "failed": 0
  }
}
```

Do not send giant transcript/candidate objects on every state event.

---

# 43. CRASH / RESTART BEHAVIOR

Simulate this.

Example:

```text
Candidate 3 is being reviewed
user accepted candidate 1
server crashes
```

After restart:

- session reopens;
- candidate 1 remains accepted;
- candidate indices for the frozen request snapshot remain stable;
- session resumes at candidate 3 or a clearly defined checkpoint;
- no duplicate Request is created;
- no duplicate final download is started.

Use idempotency keys:

```text
utteranceId + taskIndex
candidateId + final parameters hash
```

---

# 44. TESTS — REQUIRED

The existing project currently has minimal automated checks. Add a focused test harness using Node's built-in test runner unless the repository audit shows an existing preferred test framework.

Create tests for:

## Parser

- Russian ordinal parsing 1–20.
- `"первый второй и пятый"`.
- `"второй и четвертый не нужны"`.
- `"следующий"` disambiguation by state.
- `"ищи глубже"` vs `"ищи ещё"`.
- invalid candidate number.
- duplicate utterance.

## State machine

- Script Pass happy path.
- topic boundary.
- review now.
- next topic while jobs still running.
- candidate sequential navigation.
- batch USE.
- batch REJECT.
- MORE.
- DEEPER.
- undo.
- pause/resume.
- restart restoration.

## Persistence

- Request idempotency.
- job recovery.
- batch decision transaction.
- candidate ordering snapshot.
- no duplicate Asset.

## Premiere adapter

Use a fake MCP transport.

Test:

- MCP unavailable.
- CEP only.
- UXP exact seek available.
- transcript capability missing.
- tool call timeout.
- mutation not automatically retried.
- import dedupe by media path.
- normalized errors.

## API

- start session.
- post utterance.
- get state.
- candidate action.
- SSE event order where feasible.

---

# 45. LIVE PREMIERE VERIFICATION

Do this only on a disposable Premiere project.

Required smoke sequence:

```text
verify_premiere_connection
→ inspect project
→ create/find UContent REVIEW bin
→ import one tiny test preview
→ find imported item by path
→ open_in_source
→ if available set_source_monitor_position_uxp(2.0)
→ read position back
→ set source in/out
→ play source
→ close source
→ if available create_subclip_uxp
```

Do not modify an important production sequence in this smoke test.

Record which capabilities actually pass on the user's Premiere build.

The runtime must use that capability result, not assumptions.

---

# 46. PERFORMANCE GATES

Do not claim success if the interaction feels slower than manual review.

Measure:

```text
voice end → transcript
transcript → intent
intent → UI state change
candidate command → next preview starts
```

Target interaction behavior:

- deterministic command parsing: effectively immediate;
- state transition: sub-second excluding STT/media loading;
- next already-prepared preview: should feel immediate;
- search/background work must never freeze microphone UI.

Preload the next candidate preview where cheap.

Do not preload full sources.

---

# 47. IMPLEMENTATION ORDER

## Phase 0 — Audit and baseline tests

1. Inspect current repo.
2. Run existing `npm run check`.
3. Map current scrape loading/saving, stable Segment IDs, media attachment and download/cutter functions.
4. Add no behavior changes yet.
5. Document internal integration points in `docs/review-implementation-notes.md`.

Gate:
existing behavior remains green.

## Phase 1 — Persistence + state machine without voice/search

Implement:

- SQLite;
- review session;
- Request;
- Candidate;
- Decision;
- minimal jobs;
- state machine;
- fake candidates;
- `/review` UI;
- button-driven end-to-end flow.

Gate:
with fake candidates, user can finish a topic and batch-select 1,2,5.

## Phase 2 — Voice

Implement:

- browser mic;
- half-duplex state;
- VAD/end-of-speech;
- STT adapter;
- deterministic command parser;
- local LLM fallback only if needed.

Gate:
real Russian voice commands navigate fake Candidate Pass without keyboard.

## Phase 3 — Background Request/Search vertical slice

Implement:

- Request creation from Script Pass;
- production queue;
- YouTube metadata search;
- Candidates persist progressively.

Gate:
Script Pass continues while Candidates arrive.

## Phase 4 — Preview-first

Implement:

- caption probe;
- cheap localization;
- preview generation;
- browser playback;
- cancellation/priorities.

Gate:
candidate previews appear without downloading every full source.

## Phase 5 — Premiere MCP adapter

Implement:

- MCP client;
- capability handshake;
- status UI;
- local preview import;
- Source Monitor review;
- browser fallback.

Gate:
candidate preview can be reviewed in Premiere hands-free on the user's live build, with fallback working when disconnected.

## Phase 6 — USE → Asset READY

Implement:

- final selected download;
- verify;
- cut/remux/transcode;
- attach `media_items`;
- media index;
- Asset state;
- optional Premiere import.

Gate:
voice selection produces a verified edit-ready file attached to the correct segment.

## Phase 7 — Recovery / polish

Implement:

- crash recovery;
- retry;
- undo;
- cleanup of disposable previews;
- metrics;
- final docs.

Gate:
kill/restart test passes.

---

# 48. WHAT NOT TO IMPLEMENT YET

Do not block this release on:

- X source support;
- VK source support;
- knowledge graph;
- full browser agent;
- fine-tuned STT;
- global video cache;
- automatic AI montage;
- automatic transcript-based Premiere timeline reconstruction;
- timeline insertion of every selected asset;
- always-on full-duplex barge-in;
- Docker-to-host Premiere bridge;
- mobile native app;
- huge VLM ranking system;
- multi-user server architecture.

Leave clear extension seams, not half-built subsystems.

---

# 49. REQUIRED END-TO-END DEMO

Use a real scrape with at least two topics.

Demo:

```text
1. Open /review.
2. Topic 1 TTS starts.
3. Segment 1 is read.
4. User says:
   "Тут найди общий план самолёта и где он выходит."
5. Two Requests are created.
6. UI immediately goes to next segment.
7. Search runs in background.
8. Topic ends.
9. UContent reports candidate readiness.
10. User says:
    "покажи кандидатов."
11. Candidate previews are played.
12. User says:
    "первый второй и пятый."
13. Three USE decisions persist atomically.
14. User says:
    "ищи глубже" for another unresolved Request.
15. User says:
    "следующая тема."
16. Topic 2 begins while previous production continues.
17. Restart UContent.
18. Session and decisions survive.
19. At least one selected candidate reaches Asset READY.
20. Asset is attached to the correct existing Segment.
21. If Premiere is connected, open/import the prepared media through MCP.
```

---

# 50. DEFINITION OF DONE

The feature is not done until all are true:

- `/review` exists as a separate hands-free UI.
- user can progress by topic.
- Script Pass creates structured Requests.
- one utterance can create multiple Requests.
- Production never blocks Script Pass.
- topic checkpoint reports actual current status.
- Candidate Pass works sequentially.
- candidate numbering is stable.
- `"первый второй и пятый"` works.
- `USE`, `REJECT`, `MORE`, `DEEPER`, `OPEN`, `NEXT`, `REPEAT`, `UNDO` work.
- state survives restart.
- candidates persist.
- selected candidate can become Asset READY.
- final Asset is attached to the correct existing Segment.
- existing media index is updated.
- no full download occurs for every rejected candidate.
- browser playback works without Premiere.
- Premiere status is capability-detected.
- a local preview can be opened in Premiere through MCP on a supported live host.
- exact Source Monitor seek is used only when live capability exists.
- Premiere failure never crashes Review Mode.
- unsafe MCP scripting is disabled.
- `npm run check` still passes.
- new automated tests pass.
- setup and recovery are documented.

---

# 51. CODE QUALITY RULES FOR THIS CHANGE

- Keep new modules small and testable.
- Use explicit state enums/constants.
- Validate every external boundary.
- Use atomic DB transactions for multi-candidate decisions.
- Avoid global mutable Maps for persistent workflow truth.
- Do not duplicate current media download/cutter logic.
- Keep legacy compatibility adapters where needed.
- No silent catch blocks in the new core.
- Errors shown to user should be concise; full details go to logs/events.
- Add JSDoc/types where they materially clarify contracts.
- Prefer deterministic IDs/output keys where retries are possible.

---

# 52. DOCUMENTATION TO ADD

Add:

```text
docs/review-mode.md
docs/premiere-mcp.md
docs/review-implementation-notes.md
```

`review-mode.md`:

- user flow;
- voice commands;
- UI states;
- recovery.

`premiere-mcp.md`:

- install primary Premiere MCP;
- connector setup;
- required same-host native mode for MVP;
- status test;
- capability explanation;
- fallback behavior;
- safe/unsafe policy.

`review-implementation-notes.md`:

- actual current repo integration points discovered during audit;
- chosen SQLite implementation and why;
- exact STT backend found/implemented;
- exact live Premiere tools/capabilities;
- known limitations.

---

# 53. SETUP UX

Add a diagnostic command if it fits the current CLI style:

```text
npm run doctor:review
```

It should report:

```text
Node/runtime          OK
SQLite                OK
ffmpeg                OK
yt-dlp                OK
STT                   OK/WARN
review database       OK
media root            OK
Premiere MCP command  OK/WARN
Premiere MCP server   CONNECTED/WARN
CEP bridge            CONNECTED/WARN
UXP capabilities      exact-seek/transcript/etc.
```

Premiere should be WARN, not FAIL, because browser fallback is valid.

---

# 54. FINAL CODEX BEHAVIOR

When implementing:

1. audit;
2. write a short internal plan;
3. implement code;
4. run tests/checks;
5. fix failures;
6. live-test the non-destructive vertical slice;
7. summarize changed files;
8. list exact commands to launch and verify.

Do not return only recommendations.

If a specific upstream Premiere MCP tool behaves differently from this spec, inspect the installed tool schema/live result, adapt `PremiereAdapter`, record the difference in docs, and continue.

The business behavior in this spec is authoritative. MCP tool names are implementation details.

---

# 55. PRODUCT PRINCIPLE

Keep this sentence in mind when making tradeoffs:

> Do not automate human vision at any cost. Automate everything around the human decision so the decision itself takes only a few seconds.

The successful UX is:

```text
user speaks for a few seconds
        ↓
moves on immediately
        ↓
UContent searches/prepares in background
        ↓
at topic end it offers ready candidates
        ↓
user says "первый, второй и пятый"
        ↓
UContent produces verified edit-ready assets
```
