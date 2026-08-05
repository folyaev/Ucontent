const form = document.querySelector("#scrape-form");
const input = document.querySelector("#notion-url");
const statusEl = document.querySelector("#status");
const documentEl = document.querySelector("#document");
const selectEl = document.querySelector("#scrape-select");
document.documentElement.classList.toggle("telegram-mini", new URLSearchParams(window.location.search).get("mini") === "1");
const xmlExportButton = document.querySelector("#xml-export");
const tgSendButton = document.querySelector("#tg-send");
const notionRefreshButton = document.querySelector("#notion-refresh");
const rssResearchButton = document.querySelector("#rss-research");
const mediaPickerEl = document.querySelector("#media-picker");
const mediaPickerTopicEl = document.querySelector("#media-picker-topic");
const mediaPickerListEl = document.querySelector("#media-picker-list");
const mediaPickerCloseButton = document.querySelector("#media-picker-close");
const mediaUploadDropzone = document.querySelector("#media-upload-dropzone");
const mediaUploadInput = document.querySelector("#media-upload-input");
const mediaDownloadForm = document.querySelector("#media-download-form");
const mediaDownloadUrlInput = document.querySelector("#media-download-url");
const mediaDownloadButton = document.querySelector("#media-download-button");
const mediaDownloadStatusEl = document.querySelector("#media-download-status");
const mediaDownloadFallbackScreenshotInput = document.querySelector("#media-download-fallback-screenshot");
const remotionRenderForm = document.querySelector("#remotion-render-form");
const remotionQuoteInput = document.querySelector("#remotion-quote");
const remotionFormatInput = document.querySelector("#remotion-format");
const remotionSourceInput = document.querySelector("#remotion-source");
const remotionAuthorInput = document.querySelector("#remotion-author");
const remotionRoleInput = document.querySelector("#remotion-role");
const remotionLogoInput = document.querySelector("#remotion-logo");
const remotionBackgroundInput = document.querySelector("#remotion-background");
const remotionLogoSearchInput = document.querySelector("#remotion-logo-search");
const remotionLogoResultsEl = document.querySelector("#remotion-logo-results");
const remotionRenderButton = document.querySelector("#remotion-render-button");
const themeToggleButton = document.querySelector("#theme-toggle");
const searchDialogEl = document.querySelector("#search-dialog");
const searchDialogQueryEl = document.querySelector("#search-dialog-query");
const searchDialogYesButton = document.querySelector("#search-dialog-yes");
const searchDialogEditButton = document.querySelector("#search-dialog-edit");
const searchDialogCancelButton = document.querySelector("#search-dialog-cancel");

let currentScrape = null;
let currentLines = [];
let currentSegments = [];
let activeMediaSegmentId = "";
let activeMediaTopic = "";
let saveTimer = null;
let hasUnsavedChanges = false;
let saveInFlight = null;
let activeDownloadPoll = null;
let pendingFocusStart = null;
let lastFocusedSegmentId = "";
let rssMode = false;
let rssCandidates = {};
let rssLoading = false;
let segmentSearch = null;
let pendingSearchDialog = null;
let remotionLogoSearchTimer = null;
let openSegmentMenuId = "";

function setStatus(message) {
  statusEl.textContent = message;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isUrlLine(line) {
  return /^https?:\/\/\S+$/i.test(String(line ?? "").trim());
}

function segmentKind(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  if (isUrlLine(trimmed) && !trimmed.includes("\n")) return "link";
  if (trimmed.startsWith("/")) return "direction";
  return "text";
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function shouldHideLine(line) {
  return String(line ?? "").trim() === "\u041e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435 \u0432\u0438\u0434\u0435\u043e";
}

function parseDocumentSections(lines) {
  const prelude = [];
  const sections = [];
  let current = null;

  lines.forEach((line, index) => {
    const trimmed = String(line ?? "").trim();
    if (trimmed.startsWith("### ")) {
      current = {
        title: trimmed.replace(/^###\s+/, "").trim() || "Untitled",
        lineIndex: index,
        lineIndexes: []
      };
      sections.push(current);
      return;
    }
    if (current) {
      current.lineIndexes.push(index);
    } else {
      prelude.push(index);
    }
  });

  return { prelude, sections };
}

function parseSegmentBlocks(indexes) {
  const blocks = [];
  let current = null;

  function flush() {
    if (!current) return;
    current.text = current.lines.join("\n").trim();
    current.kind = segmentKind(current.text);
    if (current.text && current.kind) blocks.push(current);
    current = null;
  }

  for (const index of indexes) {
    const line = currentLines[index] ?? "";
    const trimmed = String(line).trim();
    if (!trimmed || shouldHideLine(trimmed)) {
      flush();
      continue;
    }
    if (trimmed.startsWith("# ")) {
      flush();
      blocks.push({ start: index, end: index, kind: "heading", text: trimmed });
      continue;
    }
    if (!current) current = { start: index, end: index, lines: [] };
    current.end = index;
    current.lines.push(line);
  }
  flush();
  return blocks;
}

function segmentForBlock(block) {
  return currentSegments.find((segment) => segment.start === block.start && segment.end === block.end) || null;
}

function segmentById(segmentId) {
  return currentSegments.find((segment) => segment.id === segmentId) || null;
}

function headingBlock(block) {
  return `<h1 class="block heading-1" data-start="${block.start}" data-end="${block.end}">${escapeHtml(block.text.replace(/^#\s+/, ""))}</h1>`;
}

function segmentLabel(kind) {
  if (kind === "link") return "link";
  if (kind === "direction") return "note";
  return "text";
}

function effectiveSegmentType(block, segment) {
  return segment?.type || block.kind || "text";
}

function isVideoPath(value) {
  return /\.(mp4|mov|webm|m4v|mkv)(?:$|[?#])/i.test(String(value || ""));
}

function supportsMediaTimecode(item) {
  const value = String(item?.path || item?.url || "");
  return /\.(mp4|mov|webm|m4v|mkv|avi|mp3|m4a|aac|wav|ogg|opus|flac)(?:$|[?#])/i.test(value);
}

function mediaRawUrl(path) {
  return `/api/media/raw?path=${encodeURIComponent(path)}`;
}

function mediaPreviewHtml(item) {
  if (item.thumbnail) return `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" />`;
  if (item.path && isVideoPath(item.path)) {
    const src = mediaRawUrl(item.path);
    return `<video src="${escapeHtml(src)}#t=0.1" preload="metadata" muted playsinline></video>`;
  }
  return "";
}

function mediaItemsForSegment(segment) {
  const items = Array.isArray(segment?.media_items) ? segment.media_items : [];
  const normalized = items
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      url: String(item.url || "").trim(),
      path: String(item.path || "").trim(),
      thumbnail: String(item.thumbnail || "").trim(),
      timecode: String(item.timecode || item.start_timecode || item.media_start_timecode || "").trim()
    }))
    .filter((item) => item.url || item.path || item.thumbnail);
  const legacy = segment?.media
    ? {
      url: String(segment.media.url || "").trim(),
      path: String(segment.media.path || "").trim(),
      thumbnail: String(segment.media.thumbnail || "").trim(),
      timecode: String(segment.media.timecode || segment.media.start_timecode || segment.media.media_start_timecode || "").trim()
    }
    : null;
  if (legacy?.url || legacy?.path || legacy?.thumbnail) {
    const exists = normalized.some((item) => item.url === legacy.url && item.path === legacy.path && item.thumbnail === legacy.thumbnail);
    if (!exists) normalized.unshift(legacy);
  }
  return normalized;
}

function renderSegmentMediaItems(segment) {
  const items = mediaItemsForSegment(segment);
  if (!items.length) return "";
  return `
    <div class="segment-media-list">
      ${items.map((item, index) => `
        <div class="segment-media">
          ${mediaPreviewHtml(item)}
          <span>${escapeHtml(item.url || item.path || item.thumbnail || "")}</span>
          ${supportsMediaTimecode(item) ? `
            <label class="media-timecode" title="Таймкод (начало: 01:23, или диапазон: 01:20-01:35)">
              <span>⏱</span>
              <input value="${escapeHtml(item.timecode || "")}" placeholder="0:00" size="16" data-action="media-timecode" data-segment-id="${escapeHtml(segment?.id || "")}" data-media-index="${index}" />
            </label>
          ` : ""}
          <button type="button" data-action="remove-media" data-segment-id="${escapeHtml(segment?.id || "")}" data-media-index="${index}" title="Remove media">-</button>
        </div>
      `).join("")}
    </div>
  `;
}

function renderSegmentSearch(block) {
  if (!segmentSearch || Number(segmentSearch.start) !== Number(block.start)) return "";
  if (segmentSearch.loading) {
    return '<div class="segment-search-results"><p class="empty">Ищу ссылки...</p></div>';
  }
  const items = Array.isArray(segmentSearch.items) ? segmentSearch.items : [];
  if (!items.length) {
    return '<div class="segment-search-results"><p class="empty">Ничего не найдено.</p></div>';
  }
  return `
    <div class="segment-search-results">
      <div class="segment-search-head">
        <strong>Поиск: ${escapeHtml(segmentSearch.query || "")}</strong>
        <button type="button" data-action="segment-search-close" title="Close">×</button>
      </div>
      ${items.map((item, index) => `
        <div class="rss-candidate" data-index="${index}">
          <div class="rss-candidate-copy">
            <strong>${escapeHtml(item.title || "")}</strong>
            <a href="${escapeHtml(item.url || "")}" target="_blank" rel="noreferrer">${escapeHtml(item.url || "")}</a>
            <span>${escapeHtml(item.source || item.origin || "RSS")} · ${escapeHtml(item.origin || "search")}</span>
          </div>
          <div class="rss-candidate-actions">
            <button type="button" data-action="segment-search-accept" data-index="${index}" title="Add after segment">+</button>
            <button type="button" data-action="segment-search-reject" data-index="${index}" title="Hide for this query">-</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function segmentBlock(block) {
  if (block.kind === "heading") return headingBlock(block);
  const segment = segmentForBlock(block);
  const trimmed = String(block.text ?? "").trim();
  const safeText = escapeHtml(trimmed);
  const kind = block.kind || "text";
  const type = effectiveSegmentType(block, segment);
  const isDone = Boolean(segment?.is_done);
  const isLink = kind === "link";
  const host = isLink ? escapeHtml(hostOf(trimmed)) : "";
  const mediaHtml = renderSegmentMediaItems(segment);
  const searchHtml = renderSegmentSearch(block);
  const menuId = segment?.id || `${block.start}:${block.end}`;
  const preview = isLink
    ? `
      <a class="link-preview is-empty" href="${safeText}" target="_blank" rel="noreferrer" data-preview-url="${safeText}">
        <img alt="" loading="lazy" />
        <span class="link-preview-copy">
          <strong>${host}</strong>
          <span></span>
          <em>${host}</em>
        </span>
      </a>
    `
    : "";
  return `
    <div class="block content-segment is-${kind}${isDone ? " is-done" : ""}${openSegmentMenuId && openSegmentMenuId === menuId ? " is-menu-open" : ""}" data-segment-id="${escapeHtml(segment?.id || "")}" data-menu-id="${escapeHtml(menuId)}" data-start="${block.start}" data-end="${block.end}">
      <div class="content-segment-toolbar">
        <button type="button" class="segment-menu-toggle" data-action="toggle-segment-menu" data-menu-id="${escapeHtml(menuId)}" data-segment-id="${escapeHtml(segment?.id || "")}" data-start="${block.start}" data-end="${block.end}" title="Actions">⋯</button>
        <div class="segment-action-menu">
          <span>${escapeHtml(type)}${segment?.id ? ` · ${escapeHtml(segment.id)}` : ""}</span>
          <button type="button" data-action="move-up" data-start="${block.start}" data-end="${block.end}" title="Move up">↑</button>
          <button type="button" data-action="move-down" data-start="${block.start}" data-end="${block.end}" title="Move down">↓</button>
          <button type="button" data-action="segment-search" data-start="${block.start}" data-end="${block.end}" title="Search links">🔎</button>
          <button type="button" data-action="attach-media" data-segment-id="${escapeHtml(segment?.id || "")}" title="Media">📎</button>
          <button type="button" data-action="add-after" data-start="${block.start}" data-end="${block.end}" title="Add after">+</button>
          <button type="button" data-action="delete-segment" data-start="${block.start}" data-end="${block.end}" title="Delete">-</button>
          <button type="button" class="${isDone ? "is-active" : ""}" data-action="toggle-done" data-segment-id="${escapeHtml(segment?.id || "")}" title="${isDone ? "Mark not done" : "Mark done"}">✓</button>
        </div>
      </div>
      <textarea data-action="edit-segment" data-start="${block.start}" data-end="${block.end}" rows="1">${safeText}</textarea>
      ${mediaHtml}
      ${preview}
      ${searchHtml}
    </div>
  `;
}

function renderBlocks(indexes) {
  return parseSegmentBlocks(indexes).map(segmentBlock).filter(Boolean).join("\n");
}

function candidateKey(topic, index) {
  return `${topic}\u001f${index}`;
}

function renderRssCandidates(section) {
  if (rssLoading) {
    return '<div class="rss-candidates"><p class="empty">Searching RSS...</p></div>';
  }
  const candidates = Array.isArray(rssCandidates[section.title]) ? rssCandidates[section.title] : [];
  if (!candidates.length) {
    return '<div class="rss-candidates"><p class="empty">No RSS candidates.</p></div>';
  }
  return `
    <div class="rss-candidates">
      ${candidates.map((item, index) => {
        const title = escapeHtml(item.title || "");
        const url = escapeHtml(item.url || "");
        const source = escapeHtml(item.source || item.origin || "RSS");
        const origin = escapeHtml(item.origin || "rss");
        return `
          <div class="rss-candidate" data-topic="${escapeHtml(section.title)}" data-index="${index}">
            <div class="rss-candidate-copy">
              <strong>${title}</strong>
              <a href="${url}" target="_blank" rel="noreferrer">${url}</a>
              <span>${source} · ${origin}</span>
            </div>
            <div class="rss-candidate-actions">
              <button type="button" data-action="rss-accept" data-topic="${escapeHtml(section.title)}" data-index="${index}" title="Add to topic">+</button>
              <button type="button" data-action="rss-reject" data-topic="${escapeHtml(section.title)}" data-index="${index}" title="Hide forever">-</button>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function segmentIsReady(block) {
  const segment = segmentForBlock(block);
  return Boolean(segment?.is_done);
}

function completionPercent(blocks) {
  if (!blocks.length) return 0;
  const ready = blocks.filter(segmentIsReady).length;
  return Math.round((ready / blocks.length) * 100);
}

function renderSection(section) {
  const blocks = parseSegmentBlocks(section.lineIndexes).filter((block) => block.kind !== "heading");
  const body = rssMode
    ? renderRssCandidates(section)
    : blocks.map(segmentBlock).filter(Boolean).join("\n");
  const percent = completionPercent(blocks);
  return `
    <details class="topic" open data-line="${section.lineIndex}">
      <summary>
        <span>${escapeHtml(section.title)}</span>
        <button class="topic-add-button" type="button" data-action="add-topic-segment" data-line="${section.lineIndex}" title="Add segment">+</button>
        <em class="${percent === 100 && blocks.length ? "is-complete" : ""}" title="${blocks.length ? `${percent}% ready` : "0% ready"}">${percent}%</em>
      </summary>
      <div class="topic-body">
        ${body || `<button class="empty empty-topic-add" type="button" data-action="add-topic-segment" data-line="${section.lineIndex}">Empty topic. Add segment</button>`}
      </div>
    </details>
  `;
}

function renderDocument() {
  const { prelude, sections } = parseDocumentSections(currentLines);
  const preludeHtml = renderBlocks(prelude);
  const sectionsHtml = sections.map(renderSection).join("\n");
  documentEl.innerHTML = [preludeHtml, sectionsHtml].filter(Boolean).join("\n") || '<p class="empty">Empty scrape.</p>';
  xmlExportButton.disabled = !currentScrape?.id;
  tgSendButton.disabled = !currentScrape?.id;
  notionRefreshButton.disabled = !currentScrape?.id || !currentScrape?.url;
  rssResearchButton.disabled = !currentScrape?.id || rssLoading;
  rssResearchButton.classList.toggle("is-active", rssMode);
  autosizeTextareas();
  focusPendingSegment();
  loadPreviews();
}

function autosizeTextareas() {
  document.querySelectorAll("textarea[data-action='edit-segment']").forEach((textarea) => {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  });
}

function focusPendingSegment() {
  if (pendingFocusStart === null) return;
  const textarea = document.querySelector(`textarea[data-action="edit-segment"][data-start="${pendingFocusStart}"]`);
  pendingFocusStart = null;
  if (!textarea) return;
  textarea.focus();
  textarea.select();
}

function contentFromLines() {
  return currentLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function normalizeUrlForCompare(url) {
  return String(url || "").replace(/#.*$/, "").replace(/\/$/, "");
}

function candidateForButton(button) {
  const topic = button.dataset.topic || "";
  const index = Number(button.dataset.index);
  const list = Array.isArray(rssCandidates[topic]) ? rssCandidates[topic] : [];
  return { topic, index, item: list[index] || null };
}

function removeCandidate(topic, index) {
  const list = Array.isArray(rssCandidates[topic]) ? rssCandidates[topic] : [];
  rssCandidates[topic] = list.filter((_, itemIndex) => itemIndex !== index);
  renderDocument();
}

function blockText(start, end) {
  const first = Number(start);
  const last = Number(end);
  if (!Number.isInteger(first) || !Number.isInteger(last)) return "";
  return currentLines.slice(first, last + 1).join("\n").trim();
}

function askSearchQuery(text) {
  return new Promise((resolve) => {
    pendingSearchDialog = { resolve, text };
    searchDialogQueryEl.textContent = `Ищем "${text.slice(0, 160)}"?`;
    searchDialogEl.hidden = false;
    searchDialogYesButton.focus();
  });
}

function closeSearchDialog(value = "") {
  const pending = pendingSearchDialog;
  pendingSearchDialog = null;
  searchDialogEl.hidden = true;
  if (pending) pending.resolve(value);
}

async function openSegmentSearch(start, end) {
  const text = blockText(start, end);
  if (!text) return;
  const query = await askSearchQuery(text);
  if (!query || !query.trim()) return;
  await runSegmentSearch(Number(start), Number(end), query);
}

async function runSegmentSearch(start, end, query) {
  segmentSearch = { start, end, query, loading: true, items: [] };
  renderDocument();
  setStatus(`searching: ${query}`);
  try {
    const response = await fetch("/api/rss-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, hours: 504, limit: 6, searxng: true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Search failed");
    segmentSearch = { start, end, query: data.query || query, loading: false, items: data.items || [] };
    setStatus(`found ${(data.items || []).length} links`);
  } catch (error) {
    segmentSearch = { start, end, query, loading: false, items: [] };
    setStatus(error.message || "Search failed");
  }
  renderDocument();
}

function currentSegmentSearchItem(index) {
  const items = Array.isArray(segmentSearch?.items) ? segmentSearch.items : [];
  return items[Number(index)] || null;
}

function removeSegmentSearchItem(index) {
  if (!segmentSearch) return;
  segmentSearch.items = (segmentSearch.items || []).filter((_, itemIndex) => itemIndex !== Number(index));
  renderDocument();
}

async function acceptSegmentSearchResult(index) {
  if (!segmentSearch) return;
  const item = currentSegmentSearchItem(index);
  if (!item?.url) return;
  const existing = new Set(currentLines.map(normalizeUrlForCompare));
  if (existing.has(normalizeUrlForCompare(item.url))) {
    removeSegmentSearchItem(index);
    return;
  }
  const source = String(item.source || item.origin || "RSS").trim();
  const title = String(item.title || "").trim();
  const insertAt = Number(segmentSearch.end) + 1;
  currentLines.splice(insertAt, 0, "", `${source}: ${title}`, "", String(item.url).trim(), "");
  removeSegmentSearchItem(index);
  await saveNow();
  setStatus("search link added");
}

async function rejectSegmentSearchResult(index) {
  const item = currentSegmentSearchItem(index);
  if (!item?.url || !segmentSearch?.query) return;
  try {
    const response = await fetch("/api/rss-candidates/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: segmentSearch.query, url: item.url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Reject failed");
    removeSegmentSearchItem(index);
    setStatus("search link hidden");
  } catch (error) {
    setStatus(error.message || "Reject failed");
  }
}

async function loadRssCandidates() {
  if (!currentScrape?.id) return;
  rssLoading = true;
  rssMode = true;
  rssCandidates = {};
  renderDocument();
  setStatus("searching RSS candidates...");
  try {
    const response = await fetch(`/api/scrapes/${encodeURIComponent(currentScrape.id)}/rss-candidates?hours=504&limit=5&searxng=1`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "RSS search failed");
    rssCandidates = data.topics || {};
    const total = Object.values(rssCandidates).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
    setStatus(`RSS candidates: ${total}`);
  } catch (error) {
    setStatus(error.message || "RSS search failed");
  } finally {
    rssLoading = false;
    renderDocument();
  }
}

async function acceptRssCandidate(button) {
  const { topic, index, item } = candidateForButton(button);
  if (!item?.url || !topic) return;
  const sections = parseDocumentSections(currentLines).sections;
  const section = sections.find((candidate) => candidate.title === topic);
  if (!section) return;
  const existing = new Set(currentLines.map(normalizeUrlForCompare));
  if (existing.has(normalizeUrlForCompare(item.url))) {
    removeCandidate(topic, index);
    return;
  }
  const source = String(item.source || item.origin || "RSS").trim();
  const title = String(item.title || "").trim();
  const insertLines = ["", `${source}: ${title}`, "", String(item.url).trim(), ""];
  currentLines.splice(section.lineIndex + 1, 0, ...insertLines);
  removeCandidate(topic, index);
  await saveNow();
  rssMode = true;
  setStatus(`added RSS link to ${topic}`);
  renderDocument();
}

async function rejectRssCandidate(button) {
  const { topic, index, item } = candidateForButton(button);
  if (!item?.url || !topic) return;
  try {
    const response = await fetch("/api/rss-candidates/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, url: item.url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Reject failed");
    removeCandidate(topic, index);
    setStatus(`hidden RSS link for ${topic}`);
  } catch (error) {
    setStatus(error.message || "Reject failed");
  }
}

function scheduleSave() {
  if (!currentScrape?.id) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  hasUnsavedChanges = true;
  setStatus("unsaved changes");
}

async function saveNow() {
  if (!currentScrape?.id) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saveInFlight) return saveInFlight;
  saveInFlight = (async () => {
    const content = contentFromLines();
    const response = await fetch(`/api/scrapes/${encodeURIComponent(currentScrape.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content })
    });
    const data = await response.json();
    if (!response.ok) {
      setStatus(data.error || "save failed");
      return null;
    }
    if (contentFromLines() !== content) {
      currentScrape = {
        ...data.scrape,
        content: contentFromLines()
      };
      hasUnsavedChanges = true;
      setStatus("unsaved changes");
      return data.scrape;
    }
    currentScrape = data.scrape;
    hasUnsavedChanges = false;
    setStatus(`${currentScrape.title || currentScrape.id} - saved`);
    currentSegments = Array.isArray(currentScrape.segments) ? currentScrape.segments : [];
    renderDocument();
    return data.scrape;
  })();
  try {
    return await saveInFlight;
  } finally {
    saveInFlight = null;
  }
}

function defaultSegmentText() {
  return "Новый текст";
}

function allSegmentBlocks() {
  const indexes = currentLines.map((_, index) => index);
  return parseSegmentBlocks(indexes).filter((block) => block.kind !== "heading");
}

function spliceWithSeparators(firstStart, firstEnd, secondStart, secondEnd) {
  const before = currentLines.slice(0, firstStart);
  const first = currentLines.slice(firstStart, firstEnd + 1);
  const between = currentLines.slice(firstEnd + 1, secondStart);
  const second = currentLines.slice(secondStart, secondEnd + 1);
  const after = currentLines.slice(secondEnd + 1);
  currentLines = [...before, ...second, ...between, ...first, ...after];
}

function moveSegment(start, end, direction) {
  const blocks = allSegmentBlocks();
  const currentIndex = blocks.findIndex((block) => block.start === Number(start) && block.end === Number(end));
  if (currentIndex < 0) return;
  if (direction < 0 && currentIndex > 0) {
    const prev = blocks[currentIndex - 1];
    spliceWithSeparators(prev.start, prev.end, blocks[currentIndex].start, blocks[currentIndex].end);
  } else if (direction > 0 && currentIndex < blocks.length - 1) {
    const current = blocks[currentIndex];
    const next = blocks[currentIndex + 1];
    spliceWithSeparators(current.start, current.end, next.start, next.end);
  } else {
    return;
  }
  renderDocument();
  scheduleSave();
}

function insertSegmentAfter(end) {
  const insertAt = Math.max(0, Number(end) + 1);
  currentLines.splice(insertAt, 0, "", defaultSegmentText(), "");
  pendingFocusStart = insertAt + 1;
  renderDocument();
  scheduleSave();
}

function insertTopicSegment(headingIndex) {
  let insertAt = currentLines.length;
  for (let index = Number(headingIndex) + 1; index < currentLines.length; index += 1) {
    if (String(currentLines[index] ?? "").trim().startsWith("### ")) {
      insertAt = index;
      break;
    }
  }
  currentLines.splice(insertAt, 0, "", defaultSegmentText(), "");
  pendingFocusStart = insertAt + 1;
  renderDocument();
  scheduleSave();
}

function deleteSegment(start, end) {
  const first = Number(start);
  const last = Number(end);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) return;
  currentLines.splice(first, last - first + 1);
  renderDocument();
  scheduleSave();
}

function replaceSegment(textarea) {
  const first = Number(textarea.dataset.start);
  const last = Number(textarea.dataset.end);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) return;
  const replacement = textarea.value.split(/\r?\n/);
  currentLines.splice(first, last - first + 1, ...replacement);
  const newEnd = first + replacement.length - 1;
  textarea.dataset.end = String(newEnd);
  const segment = textarea.closest(".content-segment");
  if (segment) segment.dataset.end = String(newEnd);
  autosizeTextareas();
  scheduleSave();
}

async function patchSegment(segmentId, patch) {
  if (!currentScrape?.id || !segmentId) return null;
  const response = await fetch(`/api/scrapes/${encodeURIComponent(currentScrape.id)}/segments/${encodeURIComponent(segmentId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(data.error || "segment update failed");
    return null;
  }
  currentScrape = data.scrape;
  currentSegments = Array.isArray(currentScrape.segments) ? currentScrape.segments : [];
  renderDocument();
  setStatus(`${currentScrape.title || currentScrape.id} - segment saved`);
  return data.segment;
}

async function toggleSegmentDone(segmentId) {
  const segment = segmentById(segmentId);
  if (!segment) return;
  if (hasUnsavedChanges) await saveNow();
  await patchSegment(segmentId, { is_done: !Boolean(segment.is_done) });
}

async function addMediaToSegment(segmentId, item) {
  if (!segmentId || !item) return null;
  return patchSegment(segmentId, { add_media: item });
}

async function removeMediaFromSegment(segmentId, mediaIndex) {
  if (!segmentId) return null;
  return patchSegment(segmentId, {
    remove_media_index: Number(mediaIndex),
    delete_media_file: true
  });
}

async function updateMediaTimecode(segmentId, mediaIndex, timecode) {
  const segment = segmentById(segmentId);
  const index = Number(mediaIndex);
  if (!segment || !Number.isInteger(index)) return null;
  const items = mediaItemsForSegment(segment);
  const item = items[index];
  if (!item || !supportsMediaTimecode(item)) return null;
  return patchSegment(segmentId, {
    update_media_index: index,
    media_item: {
      ...item,
      timecode: String(timecode || "").trim()
    }
  });
}

function topicForSegment(segmentId, fallback = "") {
  const segment = segmentById(segmentId);
  return segment?.topic || fallback || "";
}

function mediaForFile(file) {
  return {
    url: "",
    path: file.path || "",
    thumbnail: file.thumbnail || "",
    title: file.title || file.name || "",
    description: file.description || "",
    format_note: file.format_note || ""
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}

async function checkGraphicsFile(fileName) {
  try {
    const response = await fetch(`/api/media/check-graphics?name=${encodeURIComponent(fileName)}`);
    if (response.ok) {
      const data = await response.json();
      if (data.exists) {
        return data.file;
      }
    }
  } catch (error) {
    console.error("Graphics pre-flight check failed:", error);
  }
  return null;
}

async function uploadMediaFileToSegment(file, segmentId, topic = "") {
  if (!file || !segmentId) return null;
  const fileName = file.name || defaultClipboardFileName(file);
  const existing = await checkGraphicsFile(fileName);
  if (existing) {
    await addMediaToSegment(segmentId, mediaForFile(existing));
    return existing;
  }
  const base64 = await fileToBase64(file);
  const response = await fetch("/api/media/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic: topicForSegment(segmentId, topic),
      fileName: fileName,
      dataBase64: base64
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Upload failed");
  await addMediaToSegment(segmentId, mediaForFile(data.file));
  return data.file;
}

function defaultClipboardFileName(file) {
  const type = String(file?.type || "").toLowerCase();
  if (type.includes("png")) return "clipboard.png";
  if (type.includes("jpeg") || type.includes("jpg")) return "clipboard.jpg";
  if (type.includes("webp")) return "clipboard.webp";
  if (type.includes("gif")) return "clipboard.gif";
  if (type.includes("mp4")) return "clipboard.mp4";
  return "clipboard-file";
}

function mediaFileFromTransfer(dataTransfer) {
  const files = [...(dataTransfer?.files || [])].filter((file) => file && file.size > 0);
  if (files.length) return files[0];
  const items = [...(dataTransfer?.items || [])];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file && file.size > 0) return file;
    }
  }
  return null;
}

function renderMediaFileButton(file, isTopicFile) {
  const thumb = file.thumbnail ? `<img src="${escapeHtml(file.thumbnail)}" alt="" loading="lazy" />` : '<span class="media-file-icon">file</span>';
  return `
    <div class="media-file-row${isTopicFile ? " is-topic" : ""}">
      <button class="media-file-option" type="button" data-media-path="${escapeHtml(file.path)}">
        ${thumb}
        <span>
          <strong>${escapeHtml(file.name || file.path)}</strong>
          <em>${escapeHtml(file.path || "")}</em>
        </span>
      </button>
      <div class="media-file-actions">
        <button type="button" data-remotion-bg="${escapeHtml(file.path)}">Фон</button>
        <button type="button" data-remotion-logo="${escapeHtml(file.path)}">Лого</button>
      </div>
    </div>
  `;
}

function renderLogoSearchResults(files) {
  if (!remotionLogoResultsEl) return;
  const items = Array.isArray(files) ? files : [];
  if (!items.length) {
    remotionLogoResultsEl.innerHTML = '<p class="empty">Логотипы не найдены.</p>';
    return;
  }
  remotionLogoResultsEl.innerHTML = items.slice(0, 18).map((file) => `
    <button type="button" data-logo-path="${escapeHtml(file.path)}" data-logo-label="${escapeHtml(file.label || file.name || "")}">
      <img src="${escapeHtml(file.thumbnail || mediaRawUrl(file.path))}" alt="" loading="lazy" />
      <span>${escapeHtml(file.label || file.name || file.path)}</span>
    </button>
  `).join("");
}

async function searchRemotionLogos(query = "") {
  if (!remotionLogoResultsEl) return;
  const response = await fetch(`/api/logos?q=${encodeURIComponent(query || "")}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Logo search failed");
  renderLogoSearchResults(data.files || []);
}

async function loadMediaLibrary(topic) {
  mediaPickerListEl.innerHTML = '<p class="empty">Loading media...</p>';
  const response = await fetch(`/api/media?topic=${encodeURIComponent(topic || "")}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Media list failed");
  activeMediaTopic = data.topic || topic || "";
  mediaPickerTopicEl.textContent = activeMediaTopic ? `Media/${activeMediaTopic}` : "Media";
  const topicFiles = Array.isArray(data.topic_files) ? data.topic_files : [];
  const allFiles = Array.isArray(data.files) ? data.files : [];
  const topicPaths = new Set(topicFiles.map((file) => file.path));
  const otherFiles = allFiles.filter((file) => !topicPaths.has(file.path)).slice(0, 120);
  const html = [
    topicFiles.length ? `<h3>Topic folder</h3>${topicFiles.map((file) => renderMediaFileButton(file, true)).join("")}` : '<h3>Topic folder</h3><p class="empty">Folder is empty.</p>',
    otherFiles.length ? `<h3>All Media</h3>${otherFiles.map((file) => renderMediaFileButton(file, false)).join("")}` : ""
  ].join("");
  mediaPickerListEl.innerHTML = html || '<p class="empty">No media files found.</p>';
}

async function openMediaPicker(segmentId) {
  const segment = segmentById(segmentId);
  if (!segment) return;
  activeMediaSegmentId = segmentId;
  activeMediaTopic = segment.topic || "";
  remotionQuoteInput.value = "";
  remotionSourceInput.value = segment.topic || "";
  remotionAuthorInput.value = "";
  remotionRoleInput.value = "";
  remotionLogoInput.value = "";
  remotionBackgroundInput.value = "";
  remotionLogoSearchInput.value = "";
  remotionLogoResultsEl.innerHTML = "";
  mediaPickerEl.hidden = false;
  await searchRemotionLogos("").catch(() => null);
  await loadMediaLibrary(activeMediaTopic).catch((error) => {
    mediaPickerListEl.innerHTML = `<p class="empty">${escapeHtml(error.message || "Media list failed")}</p>`;
  });
}

function closeMediaPicker() {
  mediaPickerEl.hidden = true;
  activeMediaSegmentId = "";
  activeMediaTopic = "";
  mediaUploadInput.value = "";
  mediaDownloadUrlInput.value = "";
  remotionQuoteInput.value = "";
  remotionSourceInput.value = "";
  remotionAuthorInput.value = "";
  remotionRoleInput.value = "";
  remotionLogoInput.value = "";
  remotionBackgroundInput.value = "";
  remotionLogoSearchInput.value = "";
  remotionLogoResultsEl.innerHTML = "";
  mediaDownloadStatusEl.textContent = "";
  if (activeDownloadPoll) {
    clearTimeout(activeDownloadPoll);
    activeDownloadPoll = null;
  }
}

async function uploadMediaFile(file) {
  if (!file || !activeMediaSegmentId) return;
  await uploadMediaFileToSegment(file, activeMediaSegmentId, activeMediaTopic);
  closeMediaPicker();
}

function setMediaDownloadStatus(message) {
  mediaDownloadStatusEl.textContent = message || "";
}

async function pollMediaDownload(jobId) {
  const response = await fetch(`/api/media-download/${encodeURIComponent(jobId)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Download status failed");
  const job = data.job || {};
  if (job.state === "completed") {
    const outputFiles = Array.isArray(job.output_files) ? job.output_files : [];
    const firstFile = outputFiles[0];
    setMediaDownloadStatus(firstFile ? `Downloaded: ${firstFile.name || firstFile.path}` : "Downloaded");
    if (firstFile && activeMediaSegmentId) {
      await addMediaToSegment(activeMediaSegmentId, mediaForFile(firstFile));
    }
    await loadMediaLibrary(activeMediaTopic).catch(() => null);
    closeMediaPicker();
    return;
  }
  if (job.state === "failed") {
    throw new Error(job.error || "Download failed");
  }
  const progress = Number.isFinite(Number(job.progress)) ? `${Math.round(Number(job.progress))}%` : "";
  const stageLabels = {
    standard: "Обычная загрузка",
    fallback_screenshot: "Делаю резервный скриншот",
    discovering: "Ищу прямое видео на странице",
    fallback_download: "Скачиваю найденное видео"
  };
  setMediaDownloadStatus(`${stageLabels[job.stage] || "Downloading"} ${progress}`.trim());
  activeDownloadPoll = setTimeout(() => {
    void pollMediaDownload(jobId).catch((error) => {
      setMediaDownloadStatus(error.message || "Download failed");
      mediaDownloadButton.disabled = false;
      activeDownloadPoll = null;
    });
  }, 1200);
}

async function downloadMediaUrl(url) {
  if (!url || !activeMediaSegmentId) return;
  mediaDownloadButton.disabled = true;
  setMediaDownloadStatus("Queued...");
  const response = await fetch("/api/media-download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      topic: activeMediaTopic,
      segmentId: activeMediaSegmentId,
      captureFallbackScreenshot: mediaDownloadFallbackScreenshotInput?.checked !== false
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Download failed");
  await pollMediaDownload(data.job.id);
}

async function renderRemotionForActiveSegment() {
  const segment = segmentById(activeMediaSegmentId);
  if (!segment) return;
  const quote = remotionQuoteInput.value.trim();
  if (!quote) throw new Error("Заполните заголовок или цитату");
  remotionRenderButton.disabled = true;
  setMediaDownloadStatus("Rendering Remotion card...");
  const format = remotionFormatInput.value || "quote-1x1";
  const isNews = format.startsWith("news-");
  const backgroundValue = remotionBackgroundInput.value.trim();
  const response = await fetch("/api/remotion/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      format,
      props: {
        type: isNews ? "news" : "quote",
        source: remotionSourceInput.value || segment.topic || "UContent",
        quote,
        title: quote,
        author: remotionAuthorInput.value || "",
        role: remotionRoleInput.value || "",
        logoIcon: remotionLogoInput.value || "",
        label: isNews ? "News" : "Quote",
        accent: "#f0b24c",
        background: backgroundValue ? { image: backgroundValue, dim: 0.62, blur: 0 } : { dim: 0.7 }
      }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Remotion render failed");
  if (data.file) {
    await addMediaToSegment(activeMediaSegmentId, mediaForFile(data.file));
    setMediaDownloadStatus(`Rendered: ${data.file.name || data.file.path}`);
    await loadMediaLibrary(activeMediaTopic).catch(() => null);
    closeMediaPicker();
  }
}

async function loadPreviews() {
  const previews = [...document.querySelectorAll("[data-preview-url]")];
  for (const preview of previews) {
    const url = preview.dataset.previewUrl;
    try {
      const response = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
      if (!response.ok) continue;
      const data = await response.json();
      const title = data.title || hostOf(url);
      const description = data.description || "";
      const siteName = data.siteName || hostOf(url);
      preview.querySelector("strong").textContent = title;
      preview.querySelector("span span").textContent = description;
      preview.querySelector("em").textContent = siteName;
      const img = preview.querySelector("img");
      if (data.image) {
        img.src = data.image;
      } else {
        img.remove();
      }
      preview.classList.remove("is-empty");
    } catch {
      // URL line remains visible even when preview fails.
    }
  }
}

async function loadScrape(id = "") {
  const endpoint = id ? `/api/scrapes/${encodeURIComponent(id)}` : "/api/latest";
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error("No saved scrape yet");
  const data = await response.json();
  currentScrape = data.scrape;
  if (!currentScrape) throw new Error("No saved scrape yet");
  currentLines = String(currentScrape.content ?? "").split(/\r?\n/);
  currentSegments = Array.isArray(currentScrape.segments) ? currentScrape.segments : [];
  hasUnsavedChanges = false;
  renderDocument();
  setStatus(`${currentScrape.title || currentScrape.id} - ${currentLines.length} lines`);
  input.value = currentScrape.url || "";

}

async function refreshScrapeList() {
  const response = await fetch("/api/scrapes");
  if (!response.ok) return;
  const data = await response.json();
  const items = Array.isArray(data.scrapes) ? data.scrapes : [];
  selectEl.innerHTML = '<option value="">Latest</option>';
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.title || item.id} - ${item.created_at || ""}`;
    selectEl.append(option);
  }
}

documentEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    if (!event.target.closest?.(".content-segment-toolbar") && openSegmentMenuId) {
      openSegmentMenuId = "";
      document.querySelectorAll(".content-segment.is-menu-open").forEach((item) => item.classList.remove("is-menu-open"));
    }
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const action = button.dataset.action;
  if (action === "toggle-segment-menu") {
    const menuId = button.dataset.menuId || `${button.dataset.start}:${button.dataset.end}`;
    openSegmentMenuId = openSegmentMenuId === menuId ? "" : menuId;
    renderDocument();
    return;
  }
  const keepMenuOpen = ["attach-media", "segment-search"].includes(action);
  if (!keepMenuOpen) openSegmentMenuId = "";
  if (action === "add-after") insertSegmentAfter(button.dataset.end);
  if (action === "delete-segment") deleteSegment(button.dataset.start, button.dataset.end);
  if (action === "add-topic-segment") insertTopicSegment(button.dataset.line);
  if (action === "move-up") moveSegment(button.dataset.start, button.dataset.end, -1);
  if (action === "move-down") moveSegment(button.dataset.start, button.dataset.end, 1);
  if (action === "toggle-done") void toggleSegmentDone(button.dataset.segmentId);
  if (action === "attach-media") void openMediaPicker(button.dataset.segmentId);
  if (action === "remove-media") void removeMediaFromSegment(button.dataset.segmentId, button.dataset.mediaIndex);
  if (action === "rss-accept") void acceptRssCandidate(button);
  if (action === "rss-reject") void rejectRssCandidate(button);
  if (action === "segment-search") void openSegmentSearch(button.dataset.start, button.dataset.end);
  if (action === "segment-search-accept") void acceptSegmentSearchResult(button.dataset.index);
  if (action === "segment-search-reject") void rejectSegmentSearchResult(button.dataset.index);
  if (action === "segment-search-close") {
    segmentSearch = null;
    renderDocument();
  }
});

documentEl.addEventListener("change", (event) => {
  const inputEl = event.target.closest?.("input[data-action='media-timecode']");
  if (!inputEl) return;
  void updateMediaTimecode(inputEl.dataset.segmentId, inputEl.dataset.mediaIndex, inputEl.value);
});

documentEl.addEventListener("keydown", (event) => {
  const inputEl = event.target.closest?.("input[data-action='media-timecode']");
  if (!inputEl || event.key !== "Enter") return;
  event.preventDefault();
  inputEl.blur();
});

documentEl.addEventListener("focusin", (event) => {
  const segmentEl = event.target.closest?.(".content-segment[data-segment-id]");
  const segmentId = segmentEl?.dataset?.segmentId || "";
  if (segmentId) lastFocusedSegmentId = segmentId;
});

documentEl.addEventListener("dragover", (event) => {
  const segmentEl = event.target.closest?.(".content-segment[data-segment-id]");
  if (!segmentEl || !event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  segmentEl.classList.add("is-drop-target");
  event.dataTransfer.dropEffect = "copy";
});

documentEl.addEventListener("dragleave", (event) => {
  const segmentEl = event.target.closest?.(".content-segment[data-segment-id]");
  if (!segmentEl || segmentEl.contains(event.relatedTarget)) return;
  segmentEl.classList.remove("is-drop-target");
});

documentEl.addEventListener("drop", async (event) => {
  const segmentEl = event.target.closest?.(".content-segment[data-segment-id]");
  if (!segmentEl) return;
  const file = mediaFileFromTransfer(event.dataTransfer);
  if (!file) return;
  event.preventDefault();
  segmentEl.classList.remove("is-drop-target");
  const segmentId = segmentEl.dataset.segmentId || "";
  try {
    setStatus("uploading dropped media...");
    await uploadMediaFileToSegment(file, segmentId);
  } catch (error) {
    setStatus(error.message || "Upload failed");
  }
});

document.addEventListener("paste", async (event) => {
  if (event.target.closest?.("#media-picker")) return;
  const file = mediaFileFromTransfer(event.clipboardData);
  if (!file) return;
  const segmentEl = event.target.closest?.(".content-segment[data-segment-id]");
  const segmentId = segmentEl?.dataset?.segmentId || lastFocusedSegmentId;
  if (!segmentId) return;
  event.preventDefault();
  try {
    setStatus("uploading pasted media...");
    await uploadMediaFileToSegment(file, segmentId);
  } catch (error) {
    setStatus(error.message || "Upload failed");
  }
});

mediaPickerListEl.addEventListener("click", async (event) => {
  const bgButton = event.target.closest("button[data-remotion-bg]");
  if (bgButton) {
    remotionBackgroundInput.value = bgButton.dataset.remotionBg || "";
    setMediaDownloadStatus(`Фон: ${remotionBackgroundInput.value}`);
    return;
  }
  const logoButton = event.target.closest("button[data-remotion-logo]");
  if (logoButton) {
    remotionLogoInput.value = logoButton.dataset.remotionLogo || "";
    setMediaDownloadStatus(`Лого: ${remotionLogoInput.value}`);
    return;
  }
  const button = event.target.closest("button[data-media-path]");
  if (!button || !activeMediaSegmentId) return;
  await addMediaToSegment(activeMediaSegmentId, {
    url: "",
    path: button.dataset.mediaPath || "",
    thumbnail: button.querySelector("img")?.getAttribute("src") || ""
  });
  closeMediaPicker();
});

remotionLogoSearchInput.addEventListener("input", () => {
  clearTimeout(remotionLogoSearchTimer);
  remotionLogoSearchTimer = setTimeout(() => {
    void searchRemotionLogos(remotionLogoSearchInput.value.trim()).catch((error) => {
      remotionLogoResultsEl.innerHTML = `<p class="empty">${escapeHtml(error.message || "Logo search failed")}</p>`;
    });
  }, 180);
});

remotionLogoResultsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-logo-path]");
  if (!button) return;
  const logoPath = button.dataset.logoPath || "";
  const logoLabel = button.dataset.logoLabel || "";
  remotionLogoInput.value = logoPath;
  if (logoLabel && (!remotionSourceInput.value || remotionSourceInput.value === activeMediaTopic)) {
    remotionSourceInput.value = logoLabel;
  }
  setMediaDownloadStatus(`Лого: ${logoPath}`);
});

mediaPickerCloseButton.addEventListener("click", closeMediaPicker);

mediaPickerEl.addEventListener("click", (event) => {
  if (event.target === mediaPickerEl) closeMediaPicker();
});

async function handleFileSelected(file) {
  if (!file) return;
  mediaUploadDropzone.classList.add("is-uploading");
  const textEl = mediaUploadDropzone.querySelector(".dropzone-text");
  const originalText = textEl?.textContent || "Перетащите файлы сюда или нажмите для выбора";
  if (textEl) textEl.textContent = `Загрузка: ${file.name}...`;
  try {
    await uploadMediaFile(file);
  } catch (error) {
    setStatus(error.message || "Upload failed");
  } finally {
    if (textEl) textEl.textContent = originalText;
    mediaUploadDropzone.classList.remove("is-uploading");
    mediaUploadInput.value = "";
  }
}

mediaUploadDropzone.addEventListener("click", () => {
  mediaUploadInput.click();
});

mediaUploadInput.addEventListener("change", () => {
  const file = mediaUploadInput.files?.[0];
  if (file) handleFileSelected(file);
});

["dragenter", "dragover"].forEach((eventName) => {
  mediaUploadDropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    mediaUploadDropzone.classList.add("is-dragover");
  }, false);
});

["dragleave", "drop"].forEach((eventName) => {
  mediaUploadDropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    mediaUploadDropzone.classList.remove("is-dragover");
  }, false);
});

mediaUploadDropzone.addEventListener("drop", (e) => {
  const dt = e.dataTransfer;
  const file = dt.files?.[0];
  if (file) handleFileSelected(file);
}, false);

mediaDownloadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = mediaDownloadUrlInput.value.trim();
  if (!url) return;
  try {
    await downloadMediaUrl(url);
  } catch (error) {
    setMediaDownloadStatus(error.message || "Download failed");
    setStatus(error.message || "Download failed");
  } finally {
    mediaDownloadButton.disabled = false;
  }
});

remotionRenderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await renderRemotionForActiveSegment();
  } catch (error) {
    setMediaDownloadStatus(error.message || "Remotion render failed");
  } finally {
    remotionRenderButton.disabled = false;
  }
});

searchDialogYesButton.addEventListener("click", () => {
  closeSearchDialog(pendingSearchDialog?.text || "");
});

searchDialogEditButton.addEventListener("click", () => {
  const base = pendingSearchDialog?.text || "";
  const custom = window.prompt("Введите поисковый запрос", base);
  closeSearchDialog(custom || "");
});

searchDialogCancelButton.addEventListener("click", () => closeSearchDialog(""));

searchDialogEl.addEventListener("click", (event) => {
  if (event.target === searchDialogEl) closeSearchDialog("");
});

documentEl.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  if (target.dataset.action !== "edit-segment") return;
  replaceSegment(target);
});

documentEl.addEventListener("focusout", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  if (target.dataset.action !== "edit-segment") return;
  if (hasUnsavedChanges) void saveNow();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  const button = form.querySelector("button");
  button.disabled = true;
  setStatus("scraping Notion...");
  try {
    if (hasUnsavedChanges) await saveNow();
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Scrape failed");
    currentScrape = data.scrape;
    currentLines = String(data.scrape.content ?? "").split(/\r?\n/);
    currentSegments = Array.isArray(data.scrape.segments) ? data.scrape.segments : [];
    renderDocument();
    setStatus(`${data.scrape.title || data.scrape.id} - scraped`);
    await refreshScrapeList();
    selectEl.value = data.scrape.id;
  } catch (error) {
    setStatus(error.message || "Scrape failed");
  } finally {
    button.disabled = false;
  }
});

selectEl.addEventListener("change", async () => {
  try {
    if (hasUnsavedChanges) await saveNow();
    await loadScrape(selectEl.value);
  } catch (error) {
    setStatus(error.message || "Could not load scrape");
  }
});

xmlExportButton.addEventListener("click", async () => {
  if (!currentScrape?.id) return;
  const originalText = xmlExportButton.textContent;
  try {
    xmlExportButton.disabled = true;
    if (hasUnsavedChanges) await saveNow();
    xmlExportButton.textContent = "Exporting...";
    setStatus("Exporting XML...");

    const response = await fetch(`/api/scrapes/${encodeURIComponent(currentScrape.id)}/export.xml`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Export failed");
    }

    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition");
    let fileName = `${currentScrape.id}.xml`;
    if (disposition) {
      const filenameStarMatch = disposition.match(/filename\*=UTF-8''([^;\n]+)/i);
      if (filenameStarMatch && filenameStarMatch[1]) {
        fileName = decodeURIComponent(filenameStarMatch[1]);
      } else {
        const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/i);
        if (filenameMatch && filenameMatch[1]) {
          fileName = filenameMatch[1];
        }
      }
    }

    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
    setStatus("XML exported successfully");
  } catch (error) {
    setStatus(error.message || "Export failed");
  } finally {
    xmlExportButton.disabled = false;
    xmlExportButton.textContent = originalText;
  }
});

tgSendButton.addEventListener("click", async () => {
  if (!currentScrape?.id) return;
  const originalText = tgSendButton.textContent;
  try {
    tgSendButton.disabled = true;
    if (hasUnsavedChanges) await saveNow();
    tgSendButton.textContent = "Sending...";
    setStatus("Broadcasting to Telegram...");
    const response = await fetch(`/api/scrapes/${encodeURIComponent(currentScrape.id)}/send-to-tg`, {
      method: "POST"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to send");
    setStatus(data.message || "Broadcasted!");
  } catch (error) {
    setStatus(error.message || "Failed to send");
  } finally {
    tgSendButton.disabled = false;
    tgSendButton.textContent = originalText;
  }
});

notionRefreshButton.addEventListener("click", async () => {
  if (!currentScrape?.id) return;
  notionRefreshButton.disabled = true;
  setStatus("refreshing Notion...");
  try {
    if (hasUnsavedChanges) await saveNow();
    const response = await fetch(`/api/scrapes/${encodeURIComponent(currentScrape.id)}/refresh`, {
      method: "POST"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Refresh failed");
    currentScrape = data.scrape;
    currentLines = String(currentScrape.content ?? "").split(/\r?\n/);
    currentSegments = Array.isArray(currentScrape.segments) ? currentScrape.segments : [];
    renderDocument();
    setStatus("refreshed");
    await refreshScrapeList();
    selectEl.value = currentScrape.id;
  } catch (error) {
    setStatus(error.message || "Refresh failed");
  } finally {
    notionRefreshButton.disabled = !currentScrape?.id || !currentScrape?.url;
  }
});

rssResearchButton.addEventListener("click", async () => {
  if (!currentScrape?.id) return;
  if (rssMode) {
    rssMode = false;
    renderDocument();
    setStatus("RSS mode off");
    return;
  }
  await loadRssCandidates();
});

window.Telegram?.WebApp?.ready?.();
window.Telegram?.WebApp?.expand?.();
const initialScrapeId = new URLSearchParams(window.location.search).get("scrape") || "";
await refreshScrapeList();
try {
  await loadScrape(initialScrapeId);
  if (initialScrapeId) selectEl.value = initialScrapeId;
} catch {
  setStatus("document-first mode");
}

// --- Theme toggle ---
(function initTheme() {
  const saved = localStorage.getItem("ucontent-theme");
  const isLight = saved === "light";
  document.documentElement.classList.toggle("light", isLight);
  themeToggleButton.textContent = isLight ? "☀️" : "🌙";
})();

themeToggleButton.addEventListener("click", () => {
  const isLight = document.documentElement.classList.toggle("light");
  localStorage.setItem("ucontent-theme", isLight ? "light" : "dark");
  themeToggleButton.textContent = isLight ? "☀️" : "🌙";
});
