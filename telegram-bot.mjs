import { promises as fs, createReadStream, createWriteStream, existsSync } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);


// Default Token for @utcontentbot if not specified in env
const DEFAULT_TOKEN = "8668449496:AAGiTFs0j2tR4apeHDk-g0AMek8Ud4ZNjGw";

let rawBaseApi = process.env.TELEGRAM_BASE_API_URL || process.env.BASE_API_URL || "http://127.0.0.1:8081/bot";
if (rawBaseApi.includes("://tgbotapi:")) {
  rawBaseApi = rawBaseApi.replace("://tgbotapi:", "://127.0.0.1:");
}
const BASE_API_URL = rawBaseApi.replace(/\/$/, "");

let rawBaseFile = process.env.TELEGRAM_BASE_FILE_URL || process.env.BASE_FILE_URL || "http://127.0.0.1:8081/file";
if (rawBaseFile.includes("://tgbotapi:")) {
  rawBaseFile = rawBaseFile.replace("://tgbotapi:", "://127.0.0.1:");
}
const BASE_FILE_URL = rawBaseFile.replace(/\/$/, "");
const UCONTENT_SELF_URL = (process.env.UCONTENT_SELF_URL || `http://127.0.0.1:${process.env.UCONTENT_PORT || 5197}`).replace(/\/$/, "");

let botRunning = false;
let botContext = null;
let currentSession = null;
let offset = 0;
let notionRefreshTimer = null;
let notionRefreshRunning = false;
const unsortedDownloadQueues = new Map();
const configuredNotionRefreshInterval = Number(process.env.NOTION_REFRESH_INTERVAL_MS || 5 * 60 * 1000);
const NOTION_REFRESH_INTERVAL_MS = Number.isFinite(configuredNotionRefreshInterval)
  ? Math.max(60 * 1000, configuredNotionRefreshInterval)
  : 5 * 60 * 1000;
const downloadProbeCache = new Map();

/**
 * Loads the active telegram session from tg-session.json
 */
async function loadSession(dataDir) {
  const target = path.join(dataDir, "tg-session.json");
  try {
    const raw = await fs.readFile(target, "utf8");
    currentSession = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    currentSession = {
      chatId: null,
      scrapeId: null,
      activeSegmentId: null,
      messageId: null,
      randomMode: false,
      downloadMode: false,
      sdvgMaxMode: false, // only show segments starting with /
      screenshotLabMode: false, // only show segments with links for screenshot capture
      shotCtx: null,
      timecodeCtx: null,
      renameCtx: null,
      renameTargets: [],
      screenshotTargets: [],
      folderMoveContexts: {},
      folderCreateCtx: null,
      remotionCtx: null,
      remotionDefaults: {},
      logoPickCtx: null,
      remotionRenders: [],
      cutJobs: {},
      trimJobs: {},
      trimInputCtx: null,
      searchCtx: null,
      sdvgActive: false,
      notionBaselineScrapeId: "",
      notionKnownSegmentIds: [],
      notionKnownTopics: [],
      lastUpdateId: 0
    };
  }
  currentSession.lastUpdateId = Number(currentSession.lastUpdateId || 0);
  currentSession.renameTargets = Array.isArray(currentSession.renameTargets) ? currentSession.renameTargets : [];
  currentSession.screenshotTargets = Array.isArray(currentSession.screenshotTargets) ? currentSession.screenshotTargets : [];
  currentSession.folderMoveContexts = currentSession.folderMoveContexts && typeof currentSession.folderMoveContexts === "object" && !Array.isArray(currentSession.folderMoveContexts)
    ? currentSession.folderMoveContexts
    : {};
  currentSession.folderCreateCtx = currentSession.folderCreateCtx || null;
  currentSession.remotionCtx = currentSession.remotionCtx || null;
  currentSession.remotionDefaults = currentSession.remotionDefaults && typeof currentSession.remotionDefaults === "object" && !Array.isArray(currentSession.remotionDefaults)
    ? currentSession.remotionDefaults
    : {};
  currentSession.logoPickCtx = currentSession.logoPickCtx || null;
  currentSession.remotionRenders = Array.isArray(currentSession.remotionRenders) ? currentSession.remotionRenders : [];
  currentSession.renameCtx = currentSession.renameCtx || null;
  currentSession.cutJobs = currentSession.cutJobs && typeof currentSession.cutJobs === "object" ? currentSession.cutJobs : {};
  currentSession.trimJobs = currentSession.trimJobs && typeof currentSession.trimJobs === "object" ? currentSession.trimJobs : {};
  currentSession.trimInputCtx = currentSession.trimInputCtx || null;
  currentSession.sdvgActive = currentSession.sdvgActive === undefined
    ? Boolean(currentSession.scrapeId && !currentSession.downloadMode)
    : Boolean(currentSession.sdvgActive);
  currentSession.screenshotLabMode = Boolean(currentSession.screenshotLabMode);
  currentSession.notionBaselineScrapeId = String(currentSession.notionBaselineScrapeId || "");
  currentSession.notionKnownSegmentIds = Array.isArray(currentSession.notionKnownSegmentIds) ? currentSession.notionKnownSegmentIds : [];
  currentSession.notionKnownTopics = Array.isArray(currentSession.notionKnownTopics) ? currentSession.notionKnownTopics : [];
  return currentSession;
}

/**
 * Saves the active telegram session to tg-session.json
 */
async function saveSession(dataDir, session) {
  const target = path.join(dataDir, "tg-session.json");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(target, JSON.stringify(session, null, 2), "utf8");
}

/**
 * Helper to call Telegram Bot API methods
 */
async function callApi(token, method, body = {}) {
  const url = `${BASE_API_URL}${token}/${method}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const resData = await response.json();
    if (!resData.ok) {
      throw new Error(resData.description || `Telegram API error: ${method}`);
    }
    return resData.result;
  } catch (error) {
    console.error(`[bot-api-error] Method: ${method}, Error:`, error.message);
    throw error;
  }
}

const SCREENSHOT_SCRIPT_PATH = process.env.UCONTENT_SCREENSHOT_SCRIPT ||
  path.resolve(process.cwd(), "tools", "screenshot-engine", "link-screenshot.js");
const TELEGRAM_CAPTION_MAX = 1024;

function mediaUploadContentType(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

/**
 * Sends a local file to Telegram using multipart/form-data
 */
async function callApiMultipart(token, method, fields, fileField, filePath, fileName) {
  const boundary = `----TGBotBoundary${Date.now().toString(16)}`;
  const chunks = [];
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null) continue;
    const strVal = typeof val === "object" ? JSON.stringify(val) : String(val);
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${strVal}\r\n`
    ));
  }
  const fileBuffer = await fs.readFile(filePath);
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mediaUploadContentType(fileName)}\r\n\r\n`
  ));
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const url = `${BASE_API_URL}${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  const resData = await response.json();
  if (!resData.ok) throw new Error(resData.description || `Telegram API error: ${method}`);
  return resData.result;
}

async function callApiMultipartFiles(token, method, fields, files) {
  const boundary = `----TGBotBoundary${Date.now().toString(16)}`;
  const chunks = [];
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null) continue;
    const strVal = typeof val === "object" ? JSON.stringify(val) : String(val);
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${strVal}\r\n`
    ));
  }
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${mediaUploadContentType(file.name)}\r\n\r\n`
    ));
    chunks.push(await fs.readFile(file.path));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const response = await fetch(`${BASE_API_URL}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks)
  });
  const resData = await response.json();
  if (!resData.ok) throw new Error(resData.description || `Telegram API error: ${method}`);
  return resData.result;
}

async function sendLocalMedia(token, fields, filePath, fileName) {
  const normalized = String(fileName || filePath || "").toLowerCase();
  if (/\.(mp4|m4v|mov)$/i.test(normalized)) {
    const video = await probeVideoForTelegram(filePath).catch(() => ({}));
    return callApiMultipart(token, "sendVideo", {
      ...fields,
      supports_streaming: true,
      width: video.width,
      height: video.height,
      duration: video.duration
    }, "video", filePath, fileName);
  }
  if (/\.gif$/i.test(normalized)) {
    return callApiMultipart(token, "sendAnimation", fields, "animation", filePath, fileName);
  }
  if (/\.(jpe?g|png)$/i.test(normalized)) {
    return callApiMultipart(token, "sendPhoto", fields, "photo", filePath, fileName);
  }
  return callApiMultipart(token, "sendDocument", fields, "document", filePath, fileName);
}

async function sendLocalMediaGroup(token, chatId, entries, caption = "") {
  const videoMetadata = await Promise.all(entries.map((entry) =>
    isVideoFilePath(entry.name) ? probeVideoForTelegram(entry.path).catch(() => ({})) : Promise.resolve({})
  ));
  const media = entries.map((entry, index) => {
    const isVideo = isVideoFilePath(entry.name);
    return {
      type: isVideo ? "video" : "photo",
      media: `attach://media${index}`,
      ...(index === 0 && caption ? { caption, parse_mode: "HTML" } : {}),
      ...(isVideo ? {
        supports_streaming: true,
        width: videoMetadata[index].width,
        height: videoMetadata[index].height,
        duration: videoMetadata[index].duration
      } : {})
    };
  });
  const files = entries.map((entry, index) => ({
    field: `media${index}`,
    path: entry.path,
    name: entry.name
  }));
  return callApiMultipartFiles(token, "sendMediaGroup", { chat_id: chatId, media }, files);
}

// --- Screenshot profile helpers (mirrors VBAUT) ---
const SHOT_PRESETS = [
  { key: "standard", label: "2:1",  width: 2560, height: 1280 },
  { key: "square",   label: "1:1",  width: 1280, height: 1280 },
  { key: "wide",     label: "16:9", width: 2560, height: 1440 }
];

const SCENARIO_SHOT_PROFILES = new Map([
  ["POKOLENIYA", "wide"]
]);

function normShotProfile(p = {}) {
  const clamp = (v, def, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  return {
    width:  clamp(p.width,  2560, 320,  3840),
    height: clamp(p.height, 1280, 240,  5120),
    zoom:   clamp(p.zoom,   200,  50,   800),
    scroll: clamp(p.scroll, 0,    0,    20000)
  };
}

function shotPresetByKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  return SHOT_PRESETS.find((preset) => preset.key === normalized) || null;
}

function defaultShotProfileForScrape(scrapeId = "") {
  const scenarioKey = String(scrapeId || "").trim().toUpperCase();
  const presetKey = SCENARIO_SHOT_PROFILES.get(scenarioKey);
  const preset = shotPresetByKey(presetKey);
  return normShotProfile(preset || {});
}

function shotProfileKey(p)  { const n = normShotProfile(p); return `${n.width}x${n.height}@${n.zoom}S${n.scroll}`; }
function shotProfileLabel(p){ const n = normShotProfile(p); return `${n.width}×${n.height} @ ${n.zoom}%${n.scroll ? ` ↓${n.scroll}px` : ""}`; }

function sourceSiteLinkHtml(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    const label = parsed.hostname.replace(/^www\./i, "");
    return `<a href="${escapeHtml(parsed.toString())}">${escapeHtml(label)}</a>`;
  } catch {
    return escapeHtml(rawUrl || "source");
  }
}

function cycleShotFormat(p) {
  const n = normShotProfile(p);
  const ratio = n.height > 0 ? n.width / n.height : 2;
  const current = SHOT_PRESETS
    .map(ps => ({ ...ps, d: Math.abs(ps.width / ps.height - ratio) }))
    .sort((a, b) => a.d - b.d)[0];
  const idx = SHOT_PRESETS.findIndex(ps => ps.key === current.key);
  const next = SHOT_PRESETS[(idx + 1) % SHOT_PRESETS.length];
  return normShotProfile({ ...n, width: next.width, height: next.height });
}

function buildShotKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🌐",   callback_data: "sdvg:shot:format" },
        { text: "📜⬆️", callback_data: "sdvg:shot:shorter" },
        { text: "📜⬇️", callback_data: "sdvg:shot:taller" },
        { text: "🔎⬆️", callback_data: "sdvg:shot:zoomin" },
        { text: "🔎⬇️", callback_data: "sdvg:shot:zoomout" }
      ],
      [
        { text: "⬆️ Скролл", callback_data: "sdvg:shot:scrollup" },
        { text: "⬇️ Скролл", callback_data: "sdvg:shot:scrolldown" }
      ],
      [
        { text: "+",  callback_data: "sdvg:shot:add" },
        { text: "-",  callback_data: "sdvg:shot:drop" },
        { text: "📸+", callback_data: "sdvg:shot:retry" }
      ]
    ]
  };
}

/**
 * Spawns link-screenshot.js and returns the PNG buffer.
 */
async function captureScreenshot(url, profile) {
  const { width, height, zoom, scroll } = normShotProfile(profile);
  const child = (await import("node:child_process")).spawn(
    process.execPath,
    [SCREENSHOT_SCRIPT_PATH, "--url", url, "--width", String(width), "--height", String(height), "--zoom", String(zoom), "--scroll", String(scroll)],
    { windowsHide: true }
  );
  const chunks = [];
  let stderr = "";
  child.stdout.on("data", c => chunks.push(c));
  child.stderr.on("data", c => { stderr += c.toString(); });
  await new Promise((resolve, reject) => {
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`)));
    child.on("error", reject);
  });
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error("Скриншотер вернул пустой буфер");
  return buf;
}

/**
 * Extracts the first URL from a given string
 */
function extractFirstUrl(text) {
  const match = String(text ?? "").match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function extractUrlsFromTextAndEntities(text, entities = []) {
  const value = String(text || "");
  const urls = [];
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (entity?.type === "text_link" && /^https?:\/\//i.test(String(entity.url || ""))) {
      urls.push(String(entity.url));
      continue;
    }
    if (entity?.type === "url") {
      const offset = Number(entity.offset || 0);
      const length = Number(entity.length || 0);
      const url = value.slice(offset, offset + length);
      if (/^https?:\/\//i.test(url)) urls.push(url);
    }
  }
  urls.push(...value.match(/https?:\/\/[^\s<]+/gi) || []);
  return urls;
}

function extractMessageUrls(message) {
  const ownText = String(message?.text || message?.caption || "");
  const ownEntities = message?.text ? message?.entities : message?.caption_entities;
  let urls = extractUrlsFromTextAndEntities(ownText, ownEntities);
  if (!urls.length && message?.reply_to_message) {
    const replied = message.reply_to_message;
    const repliedText = String(replied.text || replied.caption || "");
    const repliedEntities = replied.text ? replied.entities : replied.caption_entities;
    urls = extractUrlsFromTextAndEntities(repliedText, repliedEntities);
  }
  const seen = new Set();
  return urls
    .map((url) => String(url || "").trim().replace(/[),.;!?]+$/g, ""))
    .filter((url) => {
      if (!/^https?:\/\//i.test(url) || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function normalizeVkDownloadUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === "vkvideo.ru" || host.endsWith(".vkvideo.ru") || host === "vk.ru" || host.endsWith(".vk.ru")) {
      parsed.hostname = "vk.com";
      return parsed.toString();
    }
  } catch {}
  return rawUrl;
}

function isVkDownloadUrl(rawUrl) {
  try {
    const parsed = new URL(normalizeVkDownloadUrl(rawUrl));
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return (host === "vk.com" || host.endsWith(".vk.com")) && (pathname.startsWith("/video") || pathname.startsWith("/clip"));
  } catch {
    return false;
  }
}

function isYtDlpCandidateUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl || "")).hostname.toLowerCase();
    return [
      "youtube.com", "youtu.be", "x.com", "twitter.com", "instagram.com", "tiktok.com",
      "twitch.tv", "vimeo.com", "dailymotion.com", "reddit.com", "redd.it", "vk.com",
      "vkvideo.ru", "rutube.ru", "ok.ru", "facebook.com", "fb.watch", "bilibili.com",
      "streamable.com", "soundcloud.com"
    ].some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
  } catch {
    return false;
  }
}

function normalizeDownloadUrlForCompare(rawUrl) {
  try {
    const parsed = new URL(normalizeVkDownloadUrl(rawUrl));
    parsed.hash = "";
    for (const key of ["s", "t", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(rawUrl || "").trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}

function candidateDownloadFileNames(meta = {}) {
  const ext = String(meta.ext || "mp4").replace(/^\.+/, "") || "mp4";
  const labels = [
    meta.requestedName,
    meta.filename,
    meta.fulltitle,
    meta.title,
    meta.description
  ].filter(Boolean);
  const names = new Set();
  for (const label of labels) {
    const raw = String(label || "").trim();
    if (!raw) continue;
    names.add(path.basename(raw.replace(/\\/g, "/")));
    names.add(safeTelegramUploadFileName(`${raw}.${ext}`, "download"));
  }
  return [...names].filter(Boolean);
}

async function probeDownloadMetadata(rawUrl) {
  const url = normalizeVkDownloadUrl(rawUrl);
  const cacheKey = normalizeDownloadUrlForCompare(url);
  const cached = downloadProbeCache.get(cacheKey);
  if (cached && Date.now() - Number(cached.createdAt || 0) < 10 * 60 * 1000) return cached.value;
  const fallback = { url, downloadable: isVkDownloadUrl(url) || isYtDlpCandidateUrl(url), names: [], size: 0 };
  if (!fallback.downloadable) return fallback;
  try {
    const tools = await botContext.resolveDownloaderTools?.();
    if (!tools?.yt_dlp_path) throw new Error("yt-dlp is not available");
    const args = [
      "--no-update",
      "--no-playlist",
      "--playlist-end", "1",
      "--socket-timeout", "15",
      "--dump-single-json",
      url
    ];
    const cookiesPath = String(process.env.MEDIA_COOKIES_PATH || "").trim();
    const cookiesFromBrowser = String(process.env.MEDIA_COOKIES_FROM_BROWSER || "").trim();
    if (cookiesPath) args.splice(args.length - 1, 0, "--cookies", cookiesPath);
    else if (cookiesFromBrowser) args.splice(args.length - 1, 0, "--cookies-from-browser", cookiesFromBrowser);
    const { stdout } = await execFileAsync(tools.yt_dlp_path, args, {
      windowsHide: true,
      timeout: 25_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const info = JSON.parse(String(stdout || "{}"));
    const requested = Array.isArray(info.requested_downloads) ? info.requested_downloads[0] || {} : {};
    const size = Number(requested.filesize || requested.filesize_approx || info.filesize || info.filesize_approx || 0) || 0;
    const value = {
      url,
      downloadable: true,
      title: cleanupCaptionText(info.title || ""),
      description: cleanupCaptionText(info.description || ""),
      ext: requested.ext || info.ext || "",
      requestedName: requested.filename || "",
      filename: info.filename || "",
      fulltitle: info.fulltitle || "",
      webpage_url: info.webpage_url || url,
      size,
      names: candidateDownloadFileNames({
        requestedName: requested.filename,
        filename: info.filename,
        fulltitle: info.fulltitle,
        title: info.title,
        description: info.description,
        ext: requested.ext || info.ext
      })
    };
    downloadProbeCache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  } catch {
    downloadProbeCache.set(cacheKey, { createdAt: Date.now(), value: fallback });
    return fallback;
  }
}

async function getSegmentDownloadState(segment) {
  const url = extractFirstUrl(segment?.text || "");
  const normalizedUrl = normalizeDownloadUrlForCompare(url);
  const downloadable = Boolean(url && (isVkDownloadUrl(url) || isYtDlpCandidateUrl(url)));
  if (!downloadable) return { url, downloadable: false, alreadyDownloaded: false };

  const probe = await probeDownloadMetadata(url);
  const expectedNames = new Set((probe.names || []).map((name) => path.basename(String(name || "")).toLowerCase()).filter(Boolean));
  const expectedSize = Number(probe.size || 0) || 0;
  const mediaItems = Array.isArray(segment?.media_items) ? segment.media_items : [];
  const indexedItems = typeof botContext.listMediaMetadata === "function"
    ? await botContext.listMediaMetadata().catch(() => [])
    : [];
  const candidates = [...mediaItems, ...(Array.isArray(indexedItems) ? indexedItems : [])];

  const match = candidates.find((item) => {
    const itemUrl = normalizeDownloadUrlForCompare(item?.source_url || item?.webpage_url || item?.url || "");
    if (itemUrl && normalizedUrl && itemUrl === normalizedUrl) return true;
    const itemName = path.basename(String(item?.name || item?.path || "").replace(/\\/g, "/")).toLowerCase();
    const itemSize = Number(item?.size || 0) || 0;
    if (!itemName || !expectedNames.has(itemName)) return false;
    return expectedSize > 0 && itemSize > 0 && itemSize === expectedSize;
  });

  return {
    url,
    downloadable: true,
    alreadyDownloaded: Boolean(match),
    match,
    probe
  };
}

function hostLabelForFileName(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "site";
  }
}

function formatMediaItemName(item) {
  const raw = String(item.name || item.path || item.url || "");
  if (!raw) return "media";
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const urlObj = new URL(raw);
      if (/\.[a-z0-9]+$/i.test(urlObj.pathname)) {
        return path.basename(urlObj.pathname.replace(/\\/g, "/"));
      }
      const label = urlObj.hostname + urlObj.pathname;
      return label.length > 30 ? label.slice(0, 27) + "..." : label;
    } catch {
      return raw.length > 30 ? raw.slice(0, 27) + "..." : raw;
    }
  }
  const base = cleanupCaptionText(path.basename(raw.replace(/\\/g, "/"))) || "media";
  return base.length > 35 ? base.slice(0, 32) + "..." : base;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DOWNLOAD_PROGRESS_STEP = 20;
const DOWNLOAD_PROGRESS_POLL_MS = 2500;
const DOWNLOAD_PROGRESS_MIN_EDIT_MS = 6000;

function downloadStageLabel(stage) {
  const value = String(stage || "").trim();
  if (value === "standard") return "обычная загрузка";
  if (value === "fallback_screenshot") return "делаю скриншот на всякий случай";
  if (value === "discovering") return "ищу видео на странице";
  if (value === "fallback_download") return "альтернативная загрузка";
  if (value === "screenshot_only") return "сохранён скриншот";
  if (value === "completed") return "завершено";
  return value || "подготовка";
}

function downloadProgressBucket(job) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(job?.progress || 0))));
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  if (progress >= 100) return 100;
  return Math.max(DOWNLOAD_PROGRESS_STEP, Math.floor(progress / DOWNLOAD_PROGRESS_STEP) * DOWNLOAD_PROGRESS_STEP);
}

function formatDownloadProgressLine(job) {
  const bucket = downloadProgressBucket(job);
  const stage = downloadStageLabel(job?.stage);
  if (bucket > 0 && bucket < 100) return `⏳ <b>Скачивание:</b> скачано ${bucket}% · ${escapeHtml(stage)}`;
  if (bucket >= 100) return `✅ <b>Скачивание:</b> скачано 100%`;
  return `⏳ <b>Скачивание:</b> ${escapeHtml(stage)}`;
}

function downloadProgressKey(job) {
  return `${String(job?.stage || "")}:${downloadProgressBucket(job)}`;
}

function startTelegramDownloadProgress(token, chatId, messageId, job, renderText) {
  const msgId = Number(messageId);
  if (!chatId || !Number.isFinite(msgId) || msgId <= 0) return () => Promise.resolve();
  let stopped = false;
  let lastKey = "";
  let lastEditAt = 0;
  let chain = Promise.resolve();

  const tick = (force = false) => {
    if (stopped && !force) return;
    const key = downloadProgressKey(job);
    const now = Date.now();
    if (!force && key === lastKey) return;
    if (!force && lastEditAt && now - lastEditAt < DOWNLOAD_PROGRESS_MIN_EDIT_MS) return;
    lastKey = key;
    lastEditAt = now;
    chain = chain.then(async () => {
      const text = renderText(job);
      if (!text) return;
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text,
        parse_mode: "HTML"
      }).catch((error) => {
        if (!/message is not modified/i.test(String(error?.message || ""))) {
          console.error("[download-progress] failed to edit status:", error.message);
        }
      });
    });
  };

  tick(true);
  const timer = setInterval(() => tick(false), DOWNLOAD_PROGRESS_POLL_MS);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await chain.catch(() => null);
  };
}

function notionTopics(scrape) {
  return [...new Set((scrape?.segments || [])
    .map((segment) => String(segment?.topic || "").trim())
    .filter(Boolean))];
}

function notionSegmentIds(scrape) {
  return (scrape?.segments || []).map((segment) => String(segment?.id || "").trim()).filter(Boolean);
}

function setNotionBaseline(session, scrape) {
  session.notionBaselineScrapeId = String(scrape?.id || "");
  session.notionKnownSegmentIds = notionSegmentIds(scrape);
  session.notionKnownTopics = notionTopics(scrape);
}

function formatNotionAdditions(scrape, addedSegments, addedTopics) {
  const lines = [
    "🆕 <b>В Notion добавился новый контент</b>",
    `<b>Сценарий:</b> ${escapeHtml(scrape?.title || scrape?.id || "Без названия")}`
  ];
  if (addedTopics.length) {
    lines.push("", `<b>Новые темы (${addedTopics.length}):</b>`);
    for (const topic of addedTopics.slice(0, 8)) lines.push(`• ${escapeHtml(topic)}`);
    if (addedTopics.length > 8) lines.push(`• …и ещё ${addedTopics.length - 8}`);
  }
  if (addedSegments.length) {
    lines.push("", `<b>Новые сегменты (${addedSegments.length}):</b>`);
    for (const segment of addedSegments.slice(0, 8)) {
      const topic = String(segment.topic || "").trim();
      const text = String(segment.text || "").replace(/\s+/g, " ").trim();
      const clipped = text.length > 150 ? `${text.slice(0, 147)}…` : text;
      lines.push(`• ${topic ? `<b>${escapeHtml(topic)}:</b> ` : ""}${escapeHtml(clipped || "Новый сегмент")}`);
    }
    if (addedSegments.length > 8) lines.push(`• …и ещё ${addedSegments.length - 8}`);
  }
  return lines.join("\n");
}

async function refreshActiveSdvgNotion(token) {
  if (notionRefreshRunning || !botRunning || !botContext || !currentSession?.sdvgActive) return;
  if (!currentSession.chatId || !currentSession.scrapeId || currentSession.downloadMode) return;
  notionRefreshRunning = true;
  const scrapeId = currentSession.scrapeId;
  const chatId = currentSession.chatId;
  try {
    const localScrape = await botContext.readScrape(scrapeId);
    if (currentSession.notionBaselineScrapeId !== scrapeId) {
      setNotionBaseline(currentSession, localScrape);
      await saveSession(botContext.DATA_DIR, currentSession);
    }
    const knownIds = new Set(currentSession.notionKnownSegmentIds || []);
    const knownTopics = new Set(currentSession.notionKnownTopics || []);
    const result = await botContext.refreshScrapeFromNotion(scrapeId);
    const scrape = result.scrape;
    const addedSegments = (scrape.segments || []).filter((segment) => !knownIds.has(String(segment.id || "")));
    const addedTopics = notionTopics(scrape).filter((topic) => !knownTopics.has(topic));

    if (!currentSession.sdvgActive || currentSession.scrapeId !== scrapeId || currentSession.chatId !== chatId) return;
    if (addedSegments.length || addedTopics.length) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: formatNotionAdditions(scrape, addedSegments, addedTopics),
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
    }
    setNotionBaseline(currentSession, scrape);
    await saveSession(botContext.DATA_DIR, currentSession);
  } catch (error) {
    console.error(`[notion-auto-refresh] ${scrapeId}: ${error.message}`);
  } finally {
    notionRefreshRunning = false;
  }
}

function scheduleNotionRefresh(token) {
  if (notionRefreshTimer) clearTimeout(notionRefreshTimer);
  notionRefreshTimer = setTimeout(async () => {
    await refreshActiveSdvgNotion(token);
    if (botRunning) scheduleNotionRefresh(token);
  }, NOTION_REFRESH_INTERVAL_MS);
  notionRefreshTimer.unref?.();
}

function sanitizeTelegramUtf8Text(value) {
  const text = String(value ?? "");
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += text[index] + text[index + 1];
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    output += text[index];
  }
  return output;
}

function formatBytes(value) {
  const size = Number(value ?? 0);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function clipLabel(value, maxLength = 140) {
  const text = sanitizeTelegramUtf8Text(value).trim();
  if (!text) return "";
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, Math.max(1, maxLength - 1)).join("").trimEnd()}\u2026`;
}

function parseTitleFromFileName(fileName) {
  const name = String(fileName ?? "").trim();
  if (!name) return "";
  return name.replace(/\.[^.]+$/g, "").replace(/\s*\[[^\]]+\]\s*$/g, "").trim();
}

function cleanupCaptionText(value) {
  return sanitizeTelegramUtf8Text(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\uFFFD+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksCorruptedText(value) {
  const text = String(value ?? "");
  if (!text) return false;
  const replacementCount = (text.match(/\uFFFD/g) ?? []).length;
  if (replacementCount >= 2) return true;
  if (/\uFFFD/.test(text)) return true;
  return false;
}

function looksGenericDownloaderTitle(value) {
  const normalized = cleanupCaptionText(value).replace(/\.[a-z0-9]{2,5}$/i, "").toLowerCase();
  const stripped = normalized.replace(/["'`«»“”„]/g, "").replace(/[._\-\s]+/g, "");
  if (!stripped) return true;
  if (/^[a-z0-9_-]{6,16}$/i.test(normalized) && /[0-9_-]/.test(normalized) && /[a-z]/i.test(normalized)) return true;
  if (/^[a-z0-9_-]{10,48}$/i.test(normalized) && /[0-9]/.test(normalized) && /(?:^|[_-])[a-f0-9]{3,}(?:[_-]|$)/i.test(normalized.replace(/[_-]?(cut|trim|final|out)$/i, ""))) return true;
  if (/^[a-z0-9_-]{10,40}$/i.test(normalized) && !/[аеёиоуыэюяaeiou]{2,}/i.test(normalized) && /[0-9]/.test(normalized)) return true;
  return [
    "preview",
    "video",
    "file",
    "download",
    "media",
    "ok_preview",
    "now",
    "current_time",
    "видео",
    "файл",
    "медиа",
    "скачанный файл"
  ].includes(normalized);
}

function extractHostLabel(rawUrl) {
  try {
    return String(new URL(String(rawUrl ?? "").trim()).hostname ?? "").replace(/^www\./i, "").trim();
  } catch {
    return "";
  }
}

function buildSafeMediaTitle({ metadataTitle, metadataDescription, fileName, sourceUrl, isVideo }) {
  const cleanedMetaTitle = cleanupCaptionText(metadataTitle);
  if (cleanedMetaTitle && !looksCorruptedText(cleanedMetaTitle) && !looksGenericDownloaderTitle(cleanedMetaTitle)) return cleanedMetaTitle;

  const cleanedMetaDescription = cleanupCaptionText(metadataDescription);
  if (cleanedMetaDescription && !looksCorruptedText(cleanedMetaDescription) && !looksGenericDownloaderTitle(cleanedMetaDescription)) return cleanedMetaDescription;

  const parsedFromFile = cleanupCaptionText(parseTitleFromFileName(fileName) || fileName);
  if (parsedFromFile && !looksCorruptedText(parsedFromFile) && !looksGenericDownloaderTitle(parsedFromFile)) return parsedFromFile;

  const host = extractHostLabel(sourceUrl);
  if (host) return isVideo ? `\u0412\u0438\u0434\u0435\u043E \u0438\u0437 ${host}` : `\u0424\u0430\u0439\u043B \u0438\u0437 ${host}`;
  return "\u0421\u043A\u0430\u0447\u0430\u043D\u043D\u044B\u0439 \u0444\u0430\u0439\u043B";
}

function safeSendFileNameFromMetadata(fileName, sourceUrl, metadata = {}, suffix = "") {
  const ext = path.extname(String(fileName || "")) || ".mp4";
  const isVideo = isVideoFilePath(fileName || ext);
  const title = buildSafeMediaTitle({
    metadataTitle: metadata?.title,
    metadataDescription: metadata?.description,
    fileName: "",
    sourceUrl: metadata?.webpage_url || sourceUrl,
    isVideo
  });
  const uploader = normalizeUploaderLabel(metadata?.uploader).replace(/^#/, "");
  const cleanSuffix = cleanupCaptionText(suffix);
  const stem = [title, uploader, cleanSuffix].filter(Boolean).join(" ");
  return safeTelegramUploadFileName(`${stem || "download"}${ext}`, "download");
}

function normalizeUploaderLabel(value) {
  const raw = cleanupCaptionText(value).replace(/^@+/, "");
  if (!raw || looksCorruptedText(raw)) return "";
  if (looksGenericDownloaderTitle(raw)) return "";
  const compact = raw.replace(/\s+/g, "_");
  return compact.startsWith("#") ? compact : `#${compact}`;
}

function extractExplicitQualityLabel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const directMatch = raw.match(/(?:^|[\s,/_-])((?:\d{3,4})p)(?:$|[\s,/_-])/i);
  if (directMatch?.[1]) return directMatch[1].toLowerCase();
  const resolutionMatch = raw.match(/(\d{2,5})x(\d{2,5})/i);
  if (resolutionMatch) {
    const width = Number(resolutionMatch[1]);
    const height = Number(resolutionMatch[2]);
    const shortSide = Math.min(width, height);
    if (Number.isFinite(shortSide) && shortSide >= 144) return `${shortSide}p`;
  }
  const normalized = raw.toLowerCase();
  if (normalized.includes("4320") || normalized.includes("8k")) return "4320p";
  if (normalized.includes("2160") || normalized.includes("4k")) return "2160p";
  if (normalized.includes("1440")) return "1440p";
  if (normalized.includes("1080") || normalized.includes("full hd") || normalized.includes("fhd")) return "1080p";
  if (normalized.includes("720") || normalized.includes(" hd")) return "720p";
  if (normalized.includes("480")) return "480p";
  if (normalized.includes("360")) return "360p";
  if (normalized.includes("240")) return "240p";
  if (normalized.includes("144")) return "144p";
  return "";
}

function isVideoFilePath(fileName) {
  return /\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(String(fileName ?? ""));
}

function supportsTimecodeFilePath(fileName) {
  return /\.(mp4|m4v|mov|mkv|webm|avi|mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(String(fileName ?? ""));
}

function deriveQualityLabel({ formatNote, resolution, fileName, isVideo }) {
  return extractExplicitQualityLabel(resolution) ||
    extractExplicitQualityLabel(fileName) ||
    extractExplicitQualityLabel(formatNote);
}

function buildReturnedMediaCaption({ fileName, sourceUrl, sizeBytes, metadata = {} }) {
  const isVideo = isVideoFilePath(fileName);
  const mediaUrl = String(metadata?.webpage_url ?? sourceUrl ?? "").trim();
  const uploaderUrl = String(metadata?.uploader_url ?? mediaUrl).trim();
  const title = clipLabel(buildSafeMediaTitle({
    metadataTitle: metadata?.title,
    metadataDescription: metadata?.description,
    fileName,
    sourceUrl: mediaUrl || sourceUrl,
    isVideo
  }), 160);
  const uploader = clipLabel(normalizeUploaderLabel(metadata?.uploader), 80);
  const quality = clipLabel(deriveQualityLabel({
    formatNote: metadata?.format_note,
    resolution: metadata?.resolution,
    fileName,
    isVideo
  }), 30);
  const lines = [];
  lines.push(mediaUrl ? `\uD83D\uDCF9 <a href="${escapeHtml(mediaUrl)}">${escapeHtml(title)}</a>` : `\uD83D\uDCF9 ${escapeHtml(title)}`);
  if (uploader) {
    lines.push(uploaderUrl ? `\uD83D\uDC64 <a href="${escapeHtml(uploaderUrl)}">${escapeHtml(uploader)}</a>` : `\uD83D\uDC64 ${escapeHtml(uploader)}`);
  }
  lines.push("");
  if (quality) lines.push(`\uD83D\uDCF9 ${escapeHtml(quality)}`);
  lines.push(`\uD83D\uDCE6 ${escapeHtml(formatBytes(sizeBytes))}`);
  const folderName = String(metadata?.folder || "").trim();
  if (folderName) lines.push(`\uD83D\uDCC1 ${escapeHtml(folderName)}`);
  let caption = lines.join("\n");
  if (caption.length > TELEGRAM_CAPTION_MAX) caption = `\uD83D\uDCF9 ${escapeHtml(clipLabel(title, 90))}\n\uD83D\uDCE6 ${escapeHtml(formatBytes(sizeBytes))}`;
  return caption;
}

function safeTelegramUploadFileName(fileName, fallback = "media", topicPrefix = "") {
  const parsed = path.parse(String(fileName || ""));
  const extPart = asciiFilePart((parsed.ext || ".bin").replace(/^\.+/, ""), "bin").slice(0, 10).toLowerCase();
  const ext = extPart ? `.${extPart}` : ".bin";
  let stem = asciiFilePart(parsed.name || fallback, fallback).slice(0, 96).replace(/[._-]+$/g, "");
  const prefix = asciiFilePart(topicPrefix, "").slice(0, 48).replace(/[._-]+$/g, "");
  if (prefix && isGenericMediaStem(stem)) {
    stem = `${prefix}_${stem}`.slice(0, 120).replace(/[._-]+$/g, "");
  }
  return `${stem || fallback}${ext}`;
}

function isGenericMediaStem(stem) {
  const value = String(stem || "").toLowerCase().replace(/[_-]+/g, "");
  if (!value) return true;
  return /^(img|image|photo|screenshot|screen|file|document|video|animation|audio|voice|videonote|download|media)\d{0,12}$/.test(value);
}

function asciiFilePart(value, fallback = "media") {
  const cyr = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
    є: "e", і: "i", ї: "yi", ґ: "g"
  };
  const transliterated = Array.from(String(value ?? "").toLowerCase()).map((ch) => cyr[ch] ?? ch).join("");
  const ascii = transliterated
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return ascii || fallback;
}

async function ensureUniqueFileNameInDir(dir, fileName, currentName = "") {
  const parsed = path.parse(safeTelegramUploadFileName(fileName));
  let candidate = `${parsed.name || "media"}${parsed.ext || ""}`;
  let index = 1;
  while (candidate.toLowerCase() !== String(currentName || "").toLowerCase()) {
    const target = path.join(dir, candidate);
    const exists = await fs.access(target).then(() => true).catch(() => false);
    if (!exists) return candidate;
    candidate = `${parsed.name || "media"}_${index}${parsed.ext || ""}`;
    index += 1;
  }
  return candidate;
}

function metadataFromDownloadJob(job = {}) {
  return {
    title: job?.meta_title,
    description: job?.meta_description,
    uploader: job?.meta_uploader,
    uploader_url: job?.meta_uploader_url,
    webpage_url: job?.meta_webpage_url || job?.url,
    format_note: job?.meta_format_note,
    resolution: job?.meta_resolution
  };
}

function metadataFromMediaItem(item = {}) {
  return {
    title: item?.title || item?.meta_title,
    description: item?.description || item?.meta_description,
    uploader: item?.uploader || item?.meta_uploader,
    uploader_url: item?.uploader_url || item?.meta_uploader_url,
    webpage_url: item?.webpage_url || item?.source_url || item?.url || item?.meta_webpage_url,
    format_note: item?.format_note || item?.meta_format_note,
    resolution: item?.resolution || item?.meta_resolution
  };
}

function findMediaItemByPath(scrape = {}, mediaPath = "") {
  const target = String(mediaPath || "").trim();
  if (!target) return null;
  for (const segment of scrape.segments || []) {
    for (const item of segment.media_items || []) {
      if (String(item?.path || "").trim() === target) return item;
    }
  }
  return null;
}

/**
 * Formats the HTML content for the segment card in Telegram
 */
function formatCardText(scrape, segment, session, linkState = {}) {
  const text = segment.text || "";
  
  const header = "";

  let quoteHtml = "";
  const trimmed = text.trim();
  const isDirection = trimmed.startsWith("/");
  const isLink = segment.type === "link" || trimmed.startsWith("http://") || trimmed.startsWith("https://");

  if (isDirection || isLink) {
    const idx = (scrape.segments || []).findIndex((s) => s.id === segment.id);
    let quoteText = null;

    if (idx > 0) {
      // Scan backwards for the nearest non-link, non-direction text segment in the same topic
      for (let i = idx - 1; i >= 0; i--) {
        const s = scrape.segments[i];
        if (s.topic !== segment.topic) {
          break; // Crossed the topic boundary
        }
        const t = (s.text || "").trim();
        if (t && !t.startsWith("/") && !t.startsWith("http://") && !t.startsWith("https://")) {
          quoteText = s.text;
          break;
        }
      }
    }

    if (quoteText) {
      quoteHtml = `<blockquote>${escapeHtml(quoteText)}</blockquote>\n\n`;
    } else if (segment.topic) {
      quoteHtml = `<blockquote><b>${escapeHtml(segment.topic)}</b></blockquote>\n\n`;
    }
  }

  let msg = header + quoteHtml + `${escapeHtml(text)}`;
  if (linkState?.alreadyDownloaded) {
    const found = linkState.match ? formatMediaItemName(linkState.match) : "";
    msg += `\n\n<b>Уже скачано</b>${found ? `: <code>${escapeHtml(found)}</code>` : ""}`;
  }
  
  if (segment.media_items && segment.media_items.length > 0) {
    msg += `\n\n<b>Прикреплено:</b>\n`;
    segment.media_items.forEach((item, index) => {
      msg += `  ${index + 1}. <code>${escapeHtml(formatMediaItemName(item))}</code>\n`;
    });
  }
  
  return msg;
}

async function startScreenshotPreview(token, chatId, scrape, segment, segmentIndex, url) {
  const safeTopic = botContext.sanitizeMediaTopicName(segment.topic || "unsorted");
  const { dir } = await botContext.ensureTopicDir(safeTopic);
  
  // Inform the user
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `📸 <b>[Скриншот]</b> Анализирую страницу и генерирую скриншот...`,
    parse_mode: "HTML"
  });

  // Try fetching og:image first
  try {
    const previewRes = await fetch(`http://localhost:${botContext.PORT}/api/link-preview?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
    if (previewRes.ok) {
      const preview = await previewRes.json();
      const ogImage = preview.image;
      if (ogImage && /^https?:\/\//i.test(ogImage)) {
        const imgRes = await fetch(ogImage, { redirect: "follow", signal: AbortSignal.timeout(12000) });
        if (imgRes.ok) {
          const imgBuf = Buffer.from(await imgRes.arrayBuffer());
          const imgExt = ogImage.split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "jpg";
          const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
          const suffix = Math.random().toString(36).slice(2, 8);
          const thumbName = `thumb_${stamp}_${suffix}.${imgExt}`;
          const thumbPath = path.join(dir, thumbName);
          await fs.writeFile(thumbPath, imgBuf);
          const relPath = `${safeTopic}/${thumbName}`;
          const mediaItem = {
            path: relPath,
            name: thumbName,
            topic: safeTopic,
            size: imgBuf.length,
            updated_at: new Date().toISOString(),
            thumbnail: `/api/media/raw?path=${encodeURIComponent(relPath)}`
          };
          const items = segment.media_items || [];
          if (!items.some(it => it.name === thumbName)) {
            items.push(mediaItem);
            scrape.segments[segmentIndex].media_items = items;
            scrape.segments[segmentIndex].media = items[0] || null;
            scrape.segments[segmentIndex].updated_at = new Date().toISOString();
            await botContext.writeScrape(scrape);

            // Send as document/photo to show it has been successfully downloaded and attached
            await sendLocalMedia(token, {
              chat_id: chatId,
              caption: `📸 <b>Скриншот</b>\n${sourceSiteLinkHtml(url)}\n🖼 og:image`,
              parse_mode: "HTML"
            }, thumbPath, thumbName);
          }
        }
      }
    }
  } catch (err) {
    console.error("[bot] og:image preview fetch failed:", err.message);
  }

  // Generate the live screenshot immediately using default profile
  const defaultProfile = defaultShotProfileForScrape(scrape?.id || currentSession.scrapeId);
  const tempPath = path.join(dir, `preview_init_${Date.now()}.png`);
  
  try {
    const buf = await captureScreenshot(url, defaultProfile);
    await fs.writeFile(tempPath, buf);

    const profileLabel = shotProfileLabel(defaultProfile);
    
    // Delete the status text message to avoid clutter
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => null);

    // Send the live screenshot as a photo with keyboard
    const photoMsg = await callApiMultipart(token, "sendPhoto", {
      chat_id: chatId,
      caption: `📸 <b>Скриншот</b>\n${sourceSiteLinkHtml(url)}\n🖥 ${profileLabel}\n\nНастройте параметры и нажмите <b>+</b> для захвата.`,
      parse_mode: "HTML",
      reply_markup: buildShotKeyboard()
    }, "photo", tempPath, "preview.png");

    currentSession.shotCtx = {
      url,
      scrapeId: currentSession.scrapeId,
      segmentId: segment.id,
      profile: defaultProfile,
      messageId: photoMsg.message_id
    };
    await saveSession(botContext.DATA_DIR, currentSession);
  } catch (err) {
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => null);
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `❌ Не удалось сгенерировать скриншот сайта: ${err.message}\nВы можете настроить / повторить попытку позже.`,
      parse_mode: "HTML"
    });
  } finally {
    await fs.unlink(tempPath).catch(() => null);
  }
}

async function saveQuickSegmentScreenshot(token, chatId, scrape, segment, segmentIndex, url) {
  const safeTopic = botContext.sanitizeMediaTopicName(segment.topic || "unsorted");
  const { dir } = await botContext.ensureTopicDir(safeTopic);
  const profile = defaultShotProfileForScrape(scrape?.id || currentSession.scrapeId);
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `📸 Делаю быстрый скриншот: <code>${escapeHtml(hostLabelForFileName(url))}</code>`,
    parse_mode: "HTML"
  });
  try {
    const buf = await captureScreenshot(url, profile);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const shotName = await ensureUniqueFileNameInDir(dir, safeTelegramUploadFileName(`${hostLabelForFileName(url)}_${stamp}.png`, "screenshot.png"));
    const shotPath = path.join(dir, shotName);
    await fs.writeFile(shotPath, buf);
    const relPath = `${safeTopic}/${shotName}`;
    const stats = await fs.stat(shotPath);
    const mediaItem = {
      path: relPath,
      name: shotName,
      topic: safeTopic,
      size: stats.size,
      source_url: url,
      webpage_url: url,
      title: `Скриншот ${hostLabelForFileName(url)}`,
      updated_at: new Date().toISOString(),
      thumbnail: `/api/media/raw?path=${encodeURIComponent(relPath)}`
    };
    const freshScrape = await botContext.readScrape(scrape.id);
    const freshSegment = freshScrape.segments?.[segmentIndex];
    if (!freshSegment) throw new Error("Сегмент больше не найден");
    const items = Array.isArray(freshSegment.media_items) ? freshSegment.media_items : [];
    items.push(mediaItem);
    freshSegment.media_items = items;
    freshSegment.media = freshSegment.media || mediaItem;
    freshSegment.updated_at = new Date().toISOString();
    await botContext.writeScrape(freshScrape);
    await botContext.upsertMediaMetadata?.(relPath, {
      derivation: "screenshot",
      source_url: url,
      title: mediaItem.title,
      size: stats.size,
      resolution: `${profile.width}x${profile.height}`,
      format_note: `zoom ${profile.zoom}, scroll ${profile.scroll}`,
      segment_id: freshSegment.id
    });
    const mediaIndex = items.length - 1;
    const renameId = rememberRenameTarget(relPath, freshSegment.id, mediaIndex, url);
    await saveSession(botContext.DATA_DIR, currentSession);
    await sendLocalMedia(token, {
      chat_id: chatId,
      caption: `📸 <b>Скриншот</b>\n${sourceSiteLinkHtml(url)}\n🖥 ${shotProfileLabel(profile)}\n📦 ${escapeHtml(formatBytes(stats.size))}`,
      parse_mode: "HTML",
      reply_markup: renameButtonMarkup(renameId)
    }, shotPath, shotName);
    await sendOrEditCard(token, currentSession, freshScrape, freshSegment).catch(() => null);
    await deleteTelegramMessages(token, chatId, [statusMsg.message_id]);
  } catch (error) {
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `Не удалось сделать быстрый скриншот: ${error.message}`
    }).catch(() => null);
  }
}

async function processDownload(token, chatId, scrape, segment, segmentIndex, url) {
  url = normalizeVkDownloadUrl(url);

  // Edit message to show downloading state
  await callApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: currentSession.messageId,
    text: `${formatCardText(scrape, segment)}\n\n${formatDownloadProgressLine({ stage: "standard", progress: 0 })}\n<code>${escapeHtml(url)}</code>`,
    parse_mode: "HTML"
  }).catch(() => null);

  const safeTopic = botContext.sanitizeMediaTopicName(segment.topic || "unsorted");
  const { dir } = await botContext.ensureTopicDir(safeTopic);

  const job = {
    id: `bot_${Date.now()}`,
    url,
    topic: safeTopic,
    segment_id: segment.id,
    state: "queued",
    progress: 0,
    output_files: [],
    error: "",
    log: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const stopProgress = startTelegramDownloadProgress(token, chatId, currentSession.messageId, job, (currentJob) =>
    `${formatCardText(scrape, segment)}\n\n${formatDownloadProgressLine(currentJob)}\n<code>${escapeHtml(url)}</code>`
  );

  try {
    await botContext.executeMediaDownload(job);
    await stopProgress();
    if (job.state === "completed" && job.output_files && job.output_files.length > 0) {
      const items = segment.media_items || [];
      const metadata = metadataFromDownloadJob(job);
      job.output_files.forEach((file) => {
        if (!items.some((item) => item.path === file.path)) {
          items.push({
            ...file,
            source_url: metadata.webpage_url || url,
            title: metadata.title || "",
            description: metadata.description || "",
            uploader: metadata.uploader || "",
            uploader_url: metadata.uploader_url || "",
            webpage_url: metadata.webpage_url || url,
            format_note: metadata.format_note || "",
            resolution: metadata.resolution || ""
          });
        }
      });
      
      scrape.segments[segmentIndex].media_items = items;
      scrape.segments[segmentIndex].media = items[0] || null;
      scrape.segments[segmentIndex].updated_at = new Date().toISOString();
      await botContext.writeScrape(scrape);
      await sendOrEditCard(token, currentSession, scrape, scrape.segments[segmentIndex]).catch(() => null);

      const mediaIndex = items.length - 1;
      const firstFile = job.output_files[0];
      const firstPath = firstFile?.path ? path.join(botContext.PAMPAM_ROOT, firstFile.path.replace(/\//g, path.sep)) : "";
      const firstName = firstFile?.name || path.basename(String(firstFile?.path || ""));
      const firstStats = firstPath ? await fs.stat(firstPath).catch(() => null) : null;
      const renameId = firstFile?.path ? rememberRenameTarget(firstFile.path, segment.id, mediaIndex, url) : "";
      const timecodeRows = supportsTimecodeFilePath(firstFile?.path || firstName) ? [[
        { text: "\u23F1\uFE0F", callback_data: `sdvg:timecode:${segment.id}:${mediaIndex}` }
      ]] : [];
      if (renameId) await saveSession(botContext.DATA_DIR, currentSession);
      let sentBack = false;
      if (firstPath && firstStats?.isFile?.()) {
        await sendLocalMedia(token, {
          chat_id: chatId,
          caption: buildReturnedMediaCaption({
            fileName: firstName,
            sourceUrl: url,
            sizeBytes: firstStats.size,
            metadata
          }),
          parse_mode: "HTML",
          reply_markup: renameButtonMarkup(renameId, timecodeRows)
        }, firstPath, safeSendFileNameFromMetadata(firstName, url, metadata))
          .then(async (sentMessage) => {
            if (sentMessage?.message_id && attachRenameTargetMessage(renameId, chatId, sentMessage.message_id)) {
              await saveSession(botContext.DATA_DIR, currentSession);
            }
            sentBack = true;
          })
          .catch(() => null);
      }
      if (!sentBack) await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `📥 Файл <code>${formatMediaItemName(job.output_files[0])}</code> успешно скачан и прикреплен к сегменту!`,
        parse_mode: "HTML",
        reply_markup: renameButtonMarkup(renameId, timecodeRows)
      });

    } else {
      throw new Error(job.error || "Не удалось загрузить медиа-файл");
    }
  } catch (error) {
    await stopProgress();
    // If downloading failed, fall back to screenshotting!
    const fallbackMsg = await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `⚠️ Не удалось скачать медиа (неподдерживаемый сайт). Запускаю скриншотер...`,
      parse_mode: "HTML"
    }).catch(() => null);
    await startScreenshotPreview(token, chatId, scrape, segment, segmentIndex, url);
    if (fallbackMsg?.message_id) {
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: fallbackMsg.message_id }).catch(() => null);
    }
  }
}

async function processUnsortedDownload(token, chatId, url, sourceMessageId = null) {
  const downloadUrl = normalizeVkDownloadUrl(url);
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `${formatDownloadProgressLine({ stage: "standard", progress: 0 })}\nВ unsorted: <code>${escapeHtml(downloadUrl)}</code>`,
    parse_mode: "HTML"
  });
  const topic = "unsorted";
  const job = {
    id: `bot_unsorted_${Date.now()}`,
    url: downloadUrl,
    topic,
    segment_id: "",
    state: "queued",
    progress: 0,
    output_files: [],
    error: "",
    log: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  let mediaDownloaded = false;
  const stopProgress = startTelegramDownloadProgress(token, chatId, statusMsg.message_id, job, (currentJob) =>
    `${formatDownloadProgressLine(currentJob)}\nВ unsorted: <code>${escapeHtml(downloadUrl)}</code>`
  );
  try {
    await botContext.executeMediaDownload(job);
    await stopProgress();
    if (job.state !== "completed" || !Array.isArray(job.output_files) || job.output_files.length === 0) {
      throw new Error(job.error || "Не удалось скачать");
    }
    mediaDownloaded = true;
    const metadata = metadataFromDownloadJob(job);
    const entries = [];
    for (const file of job.output_files) {
      const absolutePath = file?.path ? path.join(botContext.PAMPAM_ROOT, file.path.replace(/\//g, path.sep)) : "";
      const stats = absolutePath ? await fs.stat(absolutePath).catch(() => null) : null;
      if (!absolutePath || !stats?.isFile?.()) continue;
      const fileName = file.name || path.basename(absolutePath);
      entries.push({
        path: absolutePath,
        relPath: file.path,
        name: safeSendFileNameFromMetadata(fileName, downloadUrl, metadata),
        originalName: fileName,
        size: stats.size
      });
    }

    if (!entries.length) throw new Error("Локальные файлы не найдены");
    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    const caption = buildReturnedMediaCaption({
      fileName: entries[0].originalName,
      sourceUrl: downloadUrl,
      sizeBytes: totalSize,
      metadata
    });
    const renameId = entries.length > 1
      ? rememberRenameGroupTarget(entries.map((entry) => entry.relPath), downloadUrl)
      : rememberRenameTarget(entries[0].relPath, "", -1, downloadUrl);
    const videoEntries = entries.filter((entry) => isVideoFilePath(entry.originalName));
    const videoRenameIds = entries.length === 1 && videoEntries.length === 1
      ? [renameId]
      : videoEntries.map((entry) => rememberRenameTarget(entry.relPath, "", -1, downloadUrl));
    const controlsMarkup = downloadGroupMarkup(renameId, videoRenameIds);
    await saveSession(botContext.DATA_DIR, currentSession);

    let captionUsed = false;
    let controlsAttached = false;
    const albumEntries = entries.filter((entry) => /\.(jpe?g|png|mp4|m4v|mov)$/i.test(entry.name));
    const standaloneEntries = entries.filter((entry) => !albumEntries.includes(entry));
    for (let offset = 0; offset < albumEntries.length; offset += 10) {
      const chunk = albumEntries.slice(offset, offset + 10);
      if (chunk.length >= 2) {
        const sentMessages = await sendLocalMediaGroup(token, chatId, chunk, captionUsed ? "" : caption);
        const firstMessageId = Array.isArray(sentMessages) ? sentMessages[0]?.message_id : null;
        if (!controlsAttached && firstMessageId) {
          await callApi(token, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: firstMessageId,
            reply_markup: controlsMarkup
          }).catch((error) => {
            if (/message is not modified/i.test(String(error?.message || ""))) return true;
            throw error;
          });
          attachRenameTargetMessage(renameId, chatId, firstMessageId);
          await saveSession(botContext.DATA_DIR, currentSession);
          controlsAttached = true;
        }
        captionUsed = true;
      } else {
        standaloneEntries.unshift(...chunk);
      }
    }
    for (const entry of standaloneEntries) {
      const sentMessage = await sendLocalMedia(token, {
        chat_id: chatId,
        ...(!captionUsed ? { caption, parse_mode: "HTML" } : {}),
        ...(!controlsAttached ? { reply_markup: controlsMarkup } : {})
      }, entry.path, entry.name);
      if (!controlsAttached && sentMessage?.message_id) {
        attachRenameTargetMessage(renameId, chatId, sentMessage.message_id);
        await saveSession(botContext.DATA_DIR, currentSession);
        controlsAttached = true;
      }
      captionUsed = true;
    }

    scheduleDeleteTelegramMessages(token, chatId, [statusMsg.message_id]);
  } catch (error) {
    await stopProgress();
    console.error(`[download-unsorted] failed for ${downloadUrl}: ${error?.message || error}`);
    if (job.error || job.log) {
      console.error(`[download-unsorted] job details for ${downloadUrl}: ${String(job.error || job.log).slice(-2000)}`);
    }
    if (mediaDownloaded) {
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: `Медиа скачано, но Telegram не смог отправить его: ${error.message}`
      }).catch(() => null);
      return;
    }
    try {
      const { safeTopic, dir } = await botContext.ensureTopicDir("unsorted");
      const profile = defaultShotProfileForScrape(currentSession.scrapeId || "unsorted");
      const buf = await captureScreenshot(downloadUrl, profile);
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      const shotName = await ensureUniqueFileNameInDir(dir, safeTelegramUploadFileName(`${hostLabelForFileName(downloadUrl)}_${stamp}.png`, "screenshot.png"));
      const shotPath = path.join(dir, shotName);
      await fs.writeFile(shotPath, buf);
      const relPath = `${safeTopic}/${shotName}`;
      const stats = await fs.stat(shotPath).catch(() => null);
      const renameId = rememberRenameTarget(relPath);
      if (renameId) await saveSession(botContext.DATA_DIR, currentSession);
      await sendLocalMedia(token, {
        chat_id: chatId,
        caption: `📸 <b>Скриншот</b>\n${sourceSiteLinkHtml(downloadUrl)}\n🖥 ${shotProfileLabel(profile)}${stats ? `\n📦 ${escapeHtml(formatBytes(stats.size))}` : ""}`,
        parse_mode: "HTML",
        reply_markup: renameButtonMarkup(renameId)
      }, shotPath, shotName);
      scheduleDeleteTelegramMessages(token, chatId, [statusMsg.message_id]);
    } catch (shotError) {
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: `Не удалось скачать медиа или сделать скриншот: ${shotError.message}`
      }).catch(() => null);
    }
  }
}

async function runUnsortedDownloadQueue(token, chatId) {
  const queue = unsortedDownloadQueues.get(String(chatId));
  if (!queue || queue.running) return;
  queue.running = true;
  try {
    while (queue.batches.length) {
      const batch = queue.batches.shift();
      for (let index = 0; index < batch.urls.length; index += 1) {
        const url = batch.urls[index];
        await callApi(token, "editMessageText", {
          chat_id: chatId,
          message_id: batch.statusMessageId,
          text: `Очередь загрузки: ${index + 1}/${batch.urls.length}\n${escapeHtml(url)}`,
          parse_mode: "HTML",
          disable_web_page_preview: true
        }).catch(() => null);
        await processUnsortedDownload(token, chatId, url, null);
      }
      scheduleDeleteTelegramMessages(token, chatId, [batch.statusMessageId]);
    }
  } finally {
    queue.running = false;
    if (!queue.batches.length) unsortedDownloadQueues.delete(String(chatId));
  }
}

async function enqueueUnsortedDownloads(token, chatId, urls, sourceMessageId = null) {
  const normalizedUrls = [...new Set((urls || []).map(normalizeVkDownloadUrl).filter(Boolean))];
  if (!normalizedUrls.length) return;
  const key = String(chatId);
  const queue = unsortedDownloadQueues.get(key) || { running: false, batches: [] };
  const pendingBefore = queue.batches.reduce((sum, batch) => sum + batch.urls.length, 0);
  const statusMessage = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `Добавлено в очередь: ${normalizedUrls.length}. Перед этим ожидает: ${pendingBefore}.`
  });
  queue.batches.push({
    urls: normalizedUrls,
    sourceMessageId,
    statusMessageId: statusMessage.message_id
  });
  unsortedDownloadQueues.set(key, queue);
  void runUnsortedDownloadQueue(token, chatId).catch((error) => {
    console.error(`[download-queue] ${chatId}: ${error.message}`);
  });
}

const REMOTION_FORMATS = new Set([
  "quote-1x1",
  "quote-2x1",
  "news-1x1",
  "news-2x1",
  "quote-1x1-alpha",
  "quote-2x1-alpha",
  "news-1x1-alpha",
  "news-2x1-alpha",
  "quote-1x1-alpha-mov",
  "quote-2x1-alpha-mov",
  "news-1x1-alpha-mov",
  "news-2x1-alpha-mov"
]);

const REMOTION_FORMAT_OPTIONS = [
  "quote-1x1",
  "quote-2x1",
  "news-1x1",
  "news-2x1",
  "quote-1x1-alpha",
  "quote-2x1-alpha",
  "news-1x1-alpha",
  "news-2x1-alpha",
  "quote-1x1-alpha-mov",
  "quote-2x1-alpha-mov",
  "news-1x1-alpha-mov",
  "news-2x1-alpha-mov"
];
const REMOTION_SHAPE_OPTIONS = ["1x1", "2x1"];
const REMOTION_LAYOUT_OPTIONS = ["Left", "Center", "Wide", "TL", "BL"];
const REMOTION_FIELD_LABELS = {
  quote: "цитату / заголовок",
  author: "имя автора",
  role: "должность автора",
  date: "дату",
  background: "фон: путь/URL фото или видео",
  logo: "лого или источник"
};

function defaultRemotionDraft(text = "") {
  const defaults = currentSession?.remotionDefaults || {};
  const quote = String(text || "").trim();
  return {
    format: "quote-1x1",
    props: {
      type: "quote",
      layout: "Left",
      source: String(defaults.source || "UContent").trim(),
      quote,
      title: quote,
      author: "",
      role: "",
      date: "",
      meta: "",
      logoIcon: String(defaults.logoIcon || "").trim(),
      accent: "#f0b24c",
      textScale: 1,
      background: { dim: 0.7 }
    },
    logoChoices: []
  };
}

function remotionHelpText() {
  return [
    "<b>Remotion</b>",
    "Открою панель настройки карточки. Поля редактируются кнопками, результат можно перерендерить кнопками A-/A+.",
    "",
    "Логотипы храните в <code>media/logos</code>: PNG/WebP/SVG с прозрачностью; 1024x1024+ для знака или 2400px+ по ширине для горизонтального лого.",
    "",
    "Быстро: <code>/remotion Текст карточки</code>"
  ].join("\n");
}

function parseRemotionMessage(text, defaults = {}) {
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const fields = {};
  let currentKey = "";
  const keyMap = new Map([
    ["текст", "quote"], ["цитата", "quote"], ["заголовок", "quote"], ["quote", "quote"], ["text", "quote"], ["title", "quote"],
    ["автор", "author"], ["author", "author"],
    ["должность", "role"], ["роль", "role"], ["role", "role"], ["position", "role"],
    ["лого", "logoIcon"], ["логотип", "logoIcon"], ["logo", "logoIcon"], ["logoicon", "logoIcon"],
    ["издание", "source"], ["источник", "source"], ["source", "source"],
    ["фон", "background"], ["background", "background"], ["bg", "background"],
    ["формат", "format"], ["format", "format"]
  ]);

  for (const line of lines) {
    const match = line.match(/^\s*([^:：]{2,24})\s*[:：]\s*(.*)$/);
    const mapped = match ? keyMap.get(match[1].trim().toLowerCase()) : "";
    if (mapped) {
      currentKey = mapped;
      fields[currentKey] = match[2] || "";
      continue;
    }
    if (currentKey && ["quote", "role"].includes(currentKey)) {
      fields[currentKey] = `${fields[currentKey] ? `${fields[currentKey]}\n` : ""}${line}`.trim();
    }
  }

  const hasKnownFields = Object.keys(fields).length > 0;
  const quote = hasKnownFields ? String(fields.quote || "").trim() : String(text || "").trim();
  const format = REMOTION_FORMATS.has(String(fields.format || "").trim()) ? String(fields.format).trim() : "quote-1x1";
  return {
    format,
    props: {
      type: format.startsWith("news-") ? "news" : "quote",
      source: String(fields.source || defaults.source || "UContent").trim(),
      quote,
      title: quote,
      author: String(fields.author || "").trim(),
      role: String(fields.role || "").trim(),
      logoIcon: String(fields.logoIcon || defaults.logoIcon || "").trim(),
      accent: "#f0b24c",
      background: String(fields.background || "").trim()
        ? { image: String(fields.background).trim(), dim: 0.62, blur: 0 }
        : { dim: 0.7 }
    }
  };
}

async function renderTelegramRemotion(token, chatId, text) {
  if (!botContext?.renderRemotionCard) throw new Error("Remotion renderer is unavailable");
  const body = parseRemotionMessage(text, currentSession.remotionDefaults || {});
  if (!body.props.quote) throw new Error("Нужен текст заголовка или цитаты");
  return renderTelegramRemotionBody(token, chatId, body);
}

function rememberRemotionRender(body) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const renders = Array.isArray(currentSession.remotionRenders) ? currentSession.remotionRenders : [];
  currentSession.remotionRenders = [{ id, body, createdAt: new Date().toISOString() }, ...renders].slice(0, 20);
  return id;
}

function remotionResultMarkup(renameId, renderId) {
  const base = renameButtonMarkup(renameId);
  const rows = Array.isArray(base.inline_keyboard) ? [...base.inline_keyboard] : [];
  rows.unshift([
    { text: "A-", callback_data: `sdvg:remotion:font:${renderId}:-` },
    { text: "A+", callback_data: `sdvg:remotion:font:${renderId}:+` }
  ]);
  return { inline_keyboard: rows };
}

async function renderTelegramRemotionBody(token, chatId, body) {
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: "Рендерю Remotion-карточку..."
  });
  try {
    const result = await botContext.renderRemotionCard(body);
    const relPath = result?.file?.path || "";
    const filePath = relPath ? path.join(botContext.PAMPAM_ROOT, relPath.replace(/\//g, path.sep)) : "";
    const stats = filePath ? await fs.stat(filePath).catch(() => null) : null;
    if (!filePath || !stats?.isFile?.()) throw new Error("Готовый файл не найден");
    const renameId = rememberRenameTarget(relPath, "", -1, "");
    const renderId = rememberRemotionRender(body);
    const caption = buildReturnedMediaCaption({
      fileName: result.file.name || path.basename(filePath),
      sourceUrl: "",
      sizeBytes: stats.size,
      metadata: {
        title: body.props.quote,
        description: body.props.quote,
        uploader: body.props.author || body.props.source,
        format_note: body.format
      }
    });
    const sentMessage = await sendLocalMedia(token, {
      chat_id: chatId,
      caption,
      parse_mode: "HTML",
      reply_markup: remotionResultMarkup(renameId, renderId)
    }, filePath, safeTelegramUploadFileName(result.file.name || path.basename(filePath), "remotion.mp4"));
    if (sentMessage?.message_id && attachRenameTargetMessage(renameId, chatId, sentMessage.message_id)) {
      await saveSession(botContext.DATA_DIR, currentSession);
    }
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => null);
    return result;
  } catch (error) {
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `Не удалось сгенерировать Remotion: ${error.message}`
    }).catch(() => null);
    throw error;
  }
}

function logoLabel(file) {
  return String(file?.label || file?.title || file?.name || file?.path || "").trim();
}

function buildLogoPickerMarkup(ctx, page = 0) {
  const files = Array.isArray(ctx?.files) ? ctx.files : [];
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(files.length / pageSize));
  const currentPage = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const start = currentPage * pageSize;
  const rows = files.slice(start, start + pageSize).map((file, offset) => {
    const index = start + offset;
    const label = logoLabel(file) || file.path;
    return [{ text: label.length > 46 ? `${label.slice(0, 43)}...` : label, callback_data: `sdvg:logo:sel:${index}` }];
  });
  if (pages > 1) {
    rows.push([
      { text: "<", callback_data: `sdvg:logo:page:${Math.max(0, currentPage - 1)}` },
      { text: `${currentPage + 1}/${pages}`, callback_data: "sdvg:logo:noop" },
      { text: ">", callback_data: `sdvg:logo:page:${Math.min(pages - 1, currentPage + 1)}` }
    ]);
  }
  rows.push([{ text: "✖", callback_data: "sdvg:logo:close" }]);
  return { inline_keyboard: rows };
}

async function showLogoPicker(token, chatId, query = "", page = 0, messageId = null) {
  const files = await botContext.listLogoFiles(String(query || "").trim(), 80);
  currentSession.logoPickCtx = {
    query: String(query || "").trim(),
    files,
    page: Number(page) || 0
  };
  await saveSession(botContext.DATA_DIR, currentSession);
  const text = [
    files.length
      ? `Логотипы в <code>media/logos</code>${query ? ` по запросу <b>${escapeHtml(query)}</b>` : ""}:`
      : `Логотипы не найдены${query ? ` по запросу "${escapeHtml(query)}"` : ""}.`,
    "",
    "Рекомендуемый размер: PNG/WebP/SVG с прозрачностью; 1024x1024+ для знака или 2400px+ по ширине для горизонтального лого."
  ].join("\n");
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: buildLogoPickerMarkup(currentSession.logoPickCtx, page)
  };
  if (messageId) {
    await callApi(token, "editMessageText", { ...payload, message_id: messageId }).catch(async () => {
      await callApi(token, "sendMessage", payload);
    });
  } else {
    await callApi(token, "sendMessage", payload);
  }
}

function remotionDraftSummary(draft) {
  const props = draft?.props || {};
  const background = props.background?.image || "";
  return [
    "<b>Remotion</b>",
    "",
    `<b>Цитата:</b> ${props.quote ? escapeHtml(clipLabel(props.quote, 180)) : "<i>не задано</i>"}`,
    `<b>Автор:</b> ${props.author ? escapeHtml(props.author) : "<i>не задан</i>"}`,
    `<b>Должность:</b> ${props.role ? escapeHtml(props.role) : "<i>не задана</i>"}`,
    `<b>Дата:</b> ${props.date ? escapeHtml(props.date) : "<i>не задана</i>"}`,
    `<b>Источник:</b> ${props.source ? escapeHtml(props.source) : "<i>не задан</i>"}`,
    `<b>Лого:</b> ${props.logoIcon ? `<code>${escapeHtml(props.logoIcon)}</code>` : "<i>текстом</i>"}`,
    `<b>Фон:</b> ${background ? `<code>${escapeHtml(background)}</code>` : "<i>без файла</i>"}`,
    `<b>Формат:</b> <code>${escapeHtml(draft.format || "quote-1x1")}</code>`,
    `<b>Выравнивание:</b> <code>${escapeHtml(props.layout || "Left")}</code>`,
    `<b>Шрифт:</b> ${Math.round((Number(props.textScale || 1) || 1) * 100)}%`
  ].join("\n");
}

function remotionFormatParts(format) {
  const value = String(format || "quote-1x1");
  const type = value.startsWith("news-") ? "news" : "quote";
  const shape = value.includes("-2x1") ? "2x1" : "1x1";
  const output = value.endsWith("-alpha-mov") ? "alpha-mov" : value.endsWith("-alpha") ? "alpha" : "mp4";
  return { type, shape, output };
}

function remotionFormatFromParts({ type = "quote", shape = "1x1", output = "mp4" } = {}) {
  const base = `${type}-${shape}`;
  if (output === "alpha-mov") return `${base}-alpha-mov`;
  if (output === "alpha") return `${base}-alpha`;
  return base;
}

function remotionOutputLabel(output) {
  if (output === "alpha") return "WebM α";
  if (output === "alpha-mov") return "ProRes α";
  return "MP4";
}

function remotionPanelMarkup(draft) {
  const format = String(draft?.format || "quote-1x1");
  const layout = String(draft?.props?.layout || "Left");
  const parts = remotionFormatParts(format);
  const rows = [
    [
      { text: "Цитата", callback_data: "sdvg:remotion:field:quote" },
      { text: "Автор", callback_data: "sdvg:remotion:field:author" }
    ],
    [
      { text: "Должность", callback_data: "sdvg:remotion:field:role" },
      { text: "Дата", callback_data: "sdvg:remotion:field:date" }
    ],
    [
      { text: `${parts.shape === "1x1" ? "✓ " : ""}1:1`, callback_data: "sdvg:remotion:shape:1x1" },
      { text: `${parts.shape === "2x1" ? "✓ " : ""}2:1`, callback_data: "sdvg:remotion:shape:2x1" },
      { text: `Выравн.: ${layout}`, callback_data: "sdvg:remotion:cycle:layout" }
    ],
    [
      { text: `${parts.output === "mp4" ? "✓ " : ""}MP4`, callback_data: "sdvg:remotion:output:mp4" },
      { text: `${parts.output === "alpha" ? "✓ " : ""}WebM α`, callback_data: "sdvg:remotion:output:alpha" },
      { text: `${parts.output === "alpha-mov" ? "✓ " : ""}ProRes α`, callback_data: "sdvg:remotion:output:alpha-mov" }
    ],
    [
      { text: "Лого / источник", callback_data: "sdvg:remotion:field:logo" },
      { text: "Фон", callback_data: "sdvg:remotion:field:background" }
    ]
  ];
  const logoChoices = Array.isArray(draft?.logoChoices) ? draft.logoChoices.slice(0, 6) : [];
  if (logoChoices.length) {
    rows.push(...logoChoices.map((file, index) => ([{
      text: `Лого: ${clipLabel(logoLabel(file), 34)}`,
      callback_data: `sdvg:remotion:logo:${index}`
    }])));
    rows.push([{ text: "Использовать как текст источника", callback_data: "sdvg:remotion:logoText" }]);
  }
  rows.push([{ text: "Render", callback_data: "sdvg:remotion:render" }, { text: "Закрыть", callback_data: "sdvg:remotion:close" }]);
  return { inline_keyboard: rows };
}

async function showRemotionPanel(token, chatId, messageId = null) {
  const draft = currentSession.remotionCtx?.draft || defaultRemotionDraft();
  currentSession.remotionCtx = {
    ...(currentSession.remotionCtx || {}),
    draft,
    chatId,
    createdAt: currentSession.remotionCtx?.createdAt || new Date().toISOString()
  };
  await saveSession(botContext.DATA_DIR, currentSession);
  const payload = {
    chat_id: chatId,
    text: remotionDraftSummary(draft),
    parse_mode: "HTML",
    reply_markup: remotionPanelMarkup(draft)
  };
  if (messageId) {
    await callApi(token, "editMessageText", { ...payload, message_id: messageId }).catch(async () => {
      const sent = await callApi(token, "sendMessage", payload);
      currentSession.remotionCtx.panelMessageId = sent?.message_id || null;
      await saveSession(botContext.DATA_DIR, currentSession);
    });
  } else {
    const sent = await callApi(token, "sendMessage", payload);
    currentSession.remotionCtx.panelMessageId = sent?.message_id || null;
    await saveSession(botContext.DATA_DIR, currentSession);
  }
}

function remotionPromptForField(field) {
  if (field === "logo") {
    return "Введите название источника, путь/URL логотипа или поисковый запрос по media/logos.";
  }
  return `Введите ${REMOTION_FIELD_LABELS[field] || "значение"}.`;
}

async function sendActiveScrapeXml(token, chatId) {
  if (!currentSession.scrapeId) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "Нет активного сценария. Сначала откройте /sdvg или нажмите TG в веб-интерфейсе."
    });
    return;
  }
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: "Готовлю XML..."
  });
  try {
    const response = await fetch(`${UCONTENT_SELF_URL}/api/scrapes/${encodeURIComponent(currentSession.scrapeId)}/export.xml`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const fileName = safeTelegramUploadFileName(`${currentSession.scrapeId}.xml`, "ucontent.xml");
    const tempPath = path.join(botContext.DATA_DIR, `tg_xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.xml`);
    await fs.writeFile(tempPath, xml, "utf8");
    try {
      await callApiMultipart(token, "sendDocument", {
        chat_id: chatId,
        caption: `XML: <code>${escapeHtml(currentSession.scrapeId)}</code>`,
        parse_mode: "HTML"
      }, "document", tempPath, fileName);
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => null);
    } finally {
      await fs.unlink(tempPath).catch(() => null);
    }
  } catch (error) {
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `Не удалось подготовить XML: ${error.message}`
    }).catch(() => null);
  }
}

function figmaThemeRows(scrape) {
  const byTopic = new Map();
  for (const segment of scrape?.segments || []) {
    const topic = cleanupCaptionText(segment?.topic || "") || "Без темы";
    const current = byTopic.get(topic) || { total: 0, done: 0 };
    current.total += 1;
    if (segment?.is_done) current.done += 1;
    byTopic.set(topic, current);
  }
  if (!byTopic.size) {
    for (const line of String(scrape?.content || "").split(/\r?\n/)) {
      const match = line.match(/^###\s+(.+?)\s*$/);
      if (match?.[1]) byTopic.set(cleanupCaptionText(match[1]) || "Без темы", { total: 0, done: 0 });
    }
  }
  return [...byTopic.entries()].map(([topic, stats], index) => ({
    index: index + 1,
    topic,
    total: stats.total,
    done: stats.done
  }));
}

async function sendActiveScrapeFigmaThemes(token, chatId, minimal = false) {
  if (!currentSession.scrapeId) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "Нет активного сценария. Сначала откройте /sdvg или нажмите TG в веб-интерфейсе."
    });
    return;
  }
  try {
    const scrape = await botContext.readScrape(currentSession.scrapeId);
    const rows = figmaThemeRows(scrape);
    if (!rows.length) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "Темы не найдены." });
      return;
    }
    const header = minimal ? [] : [`<b>Темы для Figma</b>`, escapeHtml(scrape.title || scrape.id), ""];
    const lines = rows.map((row) => minimal
      ? escapeHtml(row.topic)
      : `${row.index}. ${escapeHtml(row.topic)}${row.total ? ` — ${row.done}/${row.total}` : ""}`);
    const chunks = [];
    let chunk = header.join("\n");
    for (const line of lines) {
      if ((chunk + "\n" + line).length > 3500) {
        chunks.push(chunk);
        chunk = line;
      } else {
        chunk += `\n${line}`;
      }
    }
    if (chunk.trim()) chunks.push(chunk);
    for (const textChunk of chunks) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: textChunk,
        parse_mode: "HTML"
      });
    }
  } catch (error) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `Не удалось получить темы: ${error.message}`
    });
  }
}

/**
 * Builds the inline keyboard reply markup for a segment card
 */
function buildCardMarkup(session, segment, linkState = {}) {
  if (segment?.is_done) {
    return { inline_keyboard: [[{ text: "\u2705 \u0413\u043E\u0442\u043E\u0432\u043E", callback_data: "noop" }]] };
  }
  const hasLink = Boolean(linkState?.hasLink);
  const downloadable = Boolean(linkState?.downloadable);
  const alreadyDownloaded = Boolean(linkState?.alreadyDownloaded);
  if (session?.screenshotLabMode) {
    const keyboard = [[
      { text: "📸", callback_data: "sdvg:screenshot" },
      { text: "✅", callback_data: "sdvg:done" },
      { text: "⏭️", callback_data: "sdvg:next" }
    ]];
    keyboard.push([{ text: "↩️ SDVG", callback_data: "sdvg:screenshotlab:off" }]);
    return { inline_keyboard: keyboard };
  }
  const keyboard = [];
  
  // Navigation buttons row
  const navRow = [
    { text: session.randomMode ? "🎲" : "📚", callback_data: "sdvg:toggle_mode" },
    { text: "✅", callback_data: "sdvg:done" },
    { text: "⏭️", callback_data: "sdvg:next" }
  ];
  keyboard.push(navRow);

  if (hasLink) {
    const linkRow = [];
    if (downloadable) {
      linkRow.push({
        text: alreadyDownloaded ? "✅📥" : "📥",
        callback_data: alreadyDownloaded ? "sdvg:downloaded" : "sdvg:download"
      });
    }
    linkRow.push({ text: "📸", callback_data: "sdvg:screenshot:auto" });
    linkRow.push({ text: "🖥️", callback_data: "sdvg:screenshot" });
    keyboard.push(linkRow);
  }

  keyboard.push([
    { text: "\uD83D\uDD0E", callback_data: "sdvg:search" },
    { text: "\uD83D\uDCC1", callback_data: "sdvg:media:open" }
  ]);
  return { inline_keyboard: keyboard };
}

function searchQueryFromSegment(segment) {
  return String(segment?.text || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/^\/+/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function normalizeSearchUrl(value) {
  return String(value || "").trim().replace(/#.*$/, "").replace(/\/$/, "");
}

function searchResultLabel(item, index) {
  const title = clipLabel(cleanupCaptionText(item?.title || item?.url || "link"), 90);
  const source = clipLabel(cleanupCaptionText(item?.source || item?.origin || extractHostLabel(item?.url) || "RSS"), 32);
  return `${index + 1}. ${title}\n${source}`;
}

function buildSearchResultsText(query, items) {
  const rows = items.map((item, index) => {
    const url = String(item?.url || "").trim();
    const label = searchResultLabel(item, index);
    return url ? `<b>${index + 1}.</b> <a href="${escapeHtml(url)}">${escapeHtml(label.replace(/^\d+\.\s*/, ""))}</a>` : `<b>${index + 1}.</b> ${escapeHtml(label)}`;
  });
  return [`\uD83D\uDD0E <b>Поиск</b>: ${escapeHtml(clipLabel(query, 120))}`, "", ...rows].join("\n");
}

function buildSearchResultsMarkup(items) {
  const rows = items.map((_, index) => [
    { text: `+${index + 1}`, callback_data: `sdvg:search:add:${index}` },
    { text: `-${index + 1}`, callback_data: `sdvg:search:drop:${index}` }
  ]);
  rows.push([{ text: "\u2715", callback_data: "sdvg:search:close" }]);
  return { inline_keyboard: rows };
}

async function runTelegramSegmentSearch(token, chatId, scrape, segment) {
  const query = searchQueryFromSegment(segment);
  if (!query) {
    await callApi(token, "sendMessage", { chat_id: chatId, text: "Не из чего искать: сегмент пустой." });
    return;
  }
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `\uD83D\uDD0E Ищу: <code>${escapeHtml(query)}</code>`,
    parse_mode: "HTML"
  });
  try {
    const response = await fetch(`${UCONTENT_SELF_URL}/api/rss-search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, hours: 504, limit: 6, searxng: true })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const existing = new Set(String(scrape.content || "").split(/\r?\n/).map(normalizeSearchUrl));
    const items = (Array.isArray(data.items) ? data.items : [])
      .filter((item) => item?.url && !existing.has(normalizeSearchUrl(item.url)))
      .slice(0, 6);
    currentSession.searchCtx = { scrapeId: scrape.id, segmentId: segment.id, query, items };
    await saveSession(botContext.DATA_DIR, currentSession);
    if (!items.length) {
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: `\uD83D\uDD0E Ничего не найдено: <code>${escapeHtml(query)}</code>`,
        parse_mode: "HTML"
      }).catch(() => null);
      return;
    }
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: buildSearchResultsText(query, items),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: buildSearchResultsMarkup(items)
    }).catch(() => null);
  } catch (error) {
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `\u274C Поиск не удался: ${escapeHtml(error.message)}`,
      parse_mode: "HTML"
    }).catch(() => null);
  }
}

async function addSearchResultToScrape(token, chatId, resultIndex, resultsMessageId) {
  const ctx = currentSession.searchCtx;
  const item = ctx?.items?.[resultIndex];
  if (!ctx || !item?.url) {
    await callApi(token, "sendMessage", { chat_id: chatId, text: "Результат поиска устарел." });
    return;
  }
  const scrape = await botContext.readScrape(ctx.scrapeId);
  const segments = Array.isArray(scrape.segments) ? scrape.segments : [];
  const segmentIndex = segments.findIndex((segment) => segment.id === ctx.segmentId);
  if (segmentIndex < 0) {
    await callApi(token, "sendMessage", { chat_id: chatId, text: "Сегмент для добавления больше не найден." });
    return;
  }
  const existing = new Set(String(scrape.content || "").split(/\r?\n/).map(normalizeSearchUrl));
  if (!existing.has(normalizeSearchUrl(item.url))) {
    const source = cleanupCaptionText(item.source || item.origin || "RSS") || "RSS";
    const title = cleanupCaptionText(item.title || item.url) || item.url;
    const lines = String(scrape.content || "").split(/\r?\n/);
    const insertAt = Math.min(lines.length, Math.max(0, Number(segments[segmentIndex].end ?? segments[segmentIndex].start ?? 0) + 1));
    lines.splice(insertAt, 0, "", `${source}: ${title}`, "", String(item.url).trim(), "");
    const response = await fetch(`${UCONTENT_SELF_URL}/api/scrapes/${encodeURIComponent(scrape.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: lines.join("\n") })
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }
  }
  ctx.items = ctx.items.filter((_, index) => index !== resultIndex);
  currentSession.searchCtx = ctx.items.length ? ctx : null;
  await saveSession(botContext.DATA_DIR, currentSession);
  if (!ctx.items.length) {
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: resultsMessageId }).catch(() => null);
    return;
  }
  await callApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: resultsMessageId,
    text: buildSearchResultsText(ctx.query, ctx.items),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildSearchResultsMarkup(ctx.items)
  }).catch(() => null);
}

async function dropSearchResult(token, chatId, resultIndex, resultsMessageId) {
  const ctx = currentSession.searchCtx;
  if (!ctx?.items?.length) return;
  ctx.items = ctx.items.filter((_, index) => index !== resultIndex);
  currentSession.searchCtx = ctx.items.length ? ctx : null;
  await saveSession(botContext.DATA_DIR, currentSession);
  if (!ctx.items.length) {
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: resultsMessageId }).catch(() => null);
    return;
  }
  await callApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: resultsMessageId,
    text: buildSearchResultsText(ctx.query, ctx.items),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: buildSearchResultsMarkup(ctx.items)
  }).catch(() => null);
}

function mediaPickerFilesForTopic(files, topic) {
  const normalizedTopic = String(topic || "").trim().toLowerCase();
  return [...files].sort((a, b) => {
    const aTopic = String(a.topic || "").trim().toLowerCase() === normalizedTopic ? 0 : 1;
    const bTopic = String(b.topic || "").trim().toLowerCase() === normalizedTopic ? 0 : 1;
    if (aTopic !== bTopic) return aTopic - bTopic;
    return String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
  });
}

function buildMediaPickerMarkup(ctx, page = 0) {
  const files = Array.isArray(ctx?.files) ? ctx.files : [];
  const pageSize = 7;
  const pages = Math.max(1, Math.ceil(files.length / pageSize));
  const currentPage = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const start = currentPage * pageSize;
  const rows = files.slice(start, start + pageSize).map((file, offset) => {
    const index = start + offset;
    const prefix = String(file.topic || "").trim() ? `${file.topic}/` : "";
    const label = `${prefix}${formatMediaItemName(file)}`;
    return [{ text: label.length > 48 ? `${label.slice(0, 45)}...` : label, callback_data: `sdvg:media:add:${index}` }];
  });
  if (pages > 1) {
    rows.push([
      { text: "<", callback_data: `sdvg:media:page:${Math.max(0, currentPage - 1)}` },
      { text: `${currentPage + 1}/${pages}`, callback_data: "sdvg:media:noop" },
      { text: ">", callback_data: `sdvg:media:page:${Math.min(pages - 1, currentPage + 1)}` }
    ]);
  }
  rows.push([{ text: "\u2716", callback_data: "sdvg:media:close" }]);
  return { inline_keyboard: rows };
}

async function showMediaPicker(token, chatId, scrape, segment, page = 0, messageId = null) {
  const safeTopic = botContext.sanitizeMediaTopicName(segment.topic || "unsorted");
  const files = mediaPickerFilesForTopic(await botContext.listMediaFiles(800), safeTopic);
  currentSession.mediaPickCtx = {
    scrapeId: scrape.id,
    segmentId: segment.id,
    topic: safeTopic,
    files,
    page: Number(page) || 0
  };
  await saveSession(botContext.DATA_DIR, currentSession);

  const text = files.length
    ? `Files for <code>${escapeHtml(safeTopic)}</code>\nPick a file to attach. Then you can set its timecode.`
    : "No media files found.";
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: buildMediaPickerMarkup(currentSession.mediaPickCtx, page)
  };
  if (messageId) {
    await callApi(token, "editMessageText", { ...payload, message_id: messageId }).catch(async () => {
      await callApi(token, "sendMessage", payload);
    });
  } else {
    await callApi(token, "sendMessage", payload);
  }
}

function resolvePickedMediaPath(file) {
  const rel = String(file?.path || "").replace(/^[/\\]+/, "");
  if (!rel) return "";
  const root = path.resolve(botContext.PAMPAM_ROOT);
  const target = path.resolve(root, rel);
  if (!target.startsWith(`${root}${path.sep}`)) return "";
  return target;
}

function resolveMediaPathFromRel(relPath) {
  const rel = String(relPath || "").replace(/^[/\\]+/, "");
  if (!rel) return "";
  const root = path.resolve(botContext.PAMPAM_ROOT);
  const target = path.resolve(root, rel);
  if (!target.startsWith(`${root}${path.sep}`)) return "";
  return target;
}

function mediaRelPathFromAbsolute(absolutePath) {
  const root = path.resolve(botContext.PAMPAM_ROOT);
  const target = path.resolve(absolutePath);
  if (!target.startsWith(`${root}${path.sep}`)) return "";
  return path.relative(root, target).split(path.sep).join("/");
}

function rememberRenameTarget(relPath, segmentId = "", mediaIndex = -1, sourceUrl = "") {
  const rel = String(relPath || "").replace(/^[/\\]+/, "");
  if (!rel) return "";
  const targets = Array.isArray(currentSession.renameTargets) ? currentSession.renameTargets : [];
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  currentSession.renameTargets = [
    { id, path: rel, segmentId, mediaIndex, sourceUrl: String(sourceUrl || "").trim(), createdAt: new Date().toISOString() },
    ...targets
  ].slice(0, 40);
  return id;
}

function rememberRenameGroupTarget(relPaths, sourceUrl = "") {
  const paths = [...new Set((relPaths || []).map((value) => String(value || "").replace(/^[/\\]+/, "")).filter(Boolean))];
  if (!paths.length) return "";
  const targets = Array.isArray(currentSession.renameTargets) ? currentSession.renameTargets : [];
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  currentSession.renameTargets = [
    { id, paths, path: paths[0], isGroup: true, sourceUrl: String(sourceUrl || "").trim(), createdAt: new Date().toISOString() },
    ...targets
  ].slice(0, 40);
  return id;
}

function attachRenameTargetMessage(renameId, chatId, messageId) {
  const id = String(renameId || "");
  const msgId = Number(messageId);
  if (!id || !Number.isFinite(msgId)) return false;
  const target = (currentSession.renameTargets || []).find((item) => item?.id === id);
  if (!target) return false;
  target.chatId = chatId;
  target.messageId = msgId;
  return true;
}

function rememberFolderMoveContext(messageId, context) {
  const key = String(messageId || "");
  if (!key || !context) return;
  const contexts = currentSession.folderMoveContexts && typeof currentSession.folderMoveContexts === "object"
    ? currentSession.folderMoveContexts
    : {};
  contexts[key] = { ...context, createdAt: new Date().toISOString() };
  const entries = Object.entries(contexts).sort((a, b) => String(b[1]?.createdAt || "").localeCompare(String(a[1]?.createdAt || "")));
  currentSession.folderMoveContexts = Object.fromEntries(entries.slice(0, 40));
}

function getFolderMoveContext(messageId) {
  return currentSession.folderMoveContexts?.[String(messageId || "")] || null;
}

function clearFolderCreateCtx() {
  const existing = currentSession.folderCreateCtx || null;
  currentSession.folderCreateCtx = null;
  return existing;
}

function currentFolderFromRelPath(relPath) {
  return String(relPath || "").replace(/^[/\\]+/, "").split(/[\\/]/)[0] || "";
}

async function listMediaTopicFolders() {
  const root = path.resolve(botContext.PAMPAM_ROOT);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const hidden = new Set(["_download_staging", "_quarantine", "_originals"]);
  const folders = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name && !hidden.has(name.toLowerCase()) && !name.startsWith("."))
    .map(async (name) => {
      const stats = await fs.stat(path.join(root, name)).catch(() => null);
      return { name, mtime: Number(stats?.mtimeMs || 0) };
    }));
  return folders.sort((a, b) => {
    if (b.mtime !== a.mtime) return b.mtime - a.mtime;
    return a.name.localeCompare(b.name, "ru", { sensitivity: "base" });
  }).map((folder) => folder.name);
}

async function resultIsConfirmedInFolder(result, folderName) {
  const safeFolder = String(folderName || "").trim().toLowerCase();
  const rel = String(result?.newRel || "").replace(/^[/\\]+/, "");
  if (!safeFolder || !rel || currentFolderFromRelPath(rel).toLowerCase() !== safeFolder) return false;
  const absolutePath = resolveMediaPathFromRel(rel);
  const stats = absolutePath ? await fs.stat(absolutePath).catch(() => null) : null;
  return Boolean(stats?.isFile?.());
}

async function movedResultsConfirmedInFolder(result, folderName) {
  const results = Array.isArray(result) ? result : [result];
  if (!results.length || results.some((item) => !item)) return false;
  for (const item of results) {
    if (!(await resultIsConfirmedInFolder(item, folderName))) return false;
  }
  return true;
}

function buildFolderPickerMarkup(context = {}) {
  const themes = Array.isArray(context.themes) ? context.themes : [];
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(themes.length / pageSize));
  const page = Math.max(0, Math.min(pages - 1, Number(context.page || 0) || 0));
  const current = String(context.currentFolder || "").toLowerCase();
  const rows = themes.slice(page * pageSize, page * pageSize + pageSize).map((theme, index) => {
    const absoluteIndex = page * pageSize + index;
    const label = `${theme.toLowerCase() === current ? "• " : ""}${theme}`;
    return [{ text: label.length > 52 ? `${label.slice(0, 49)}...` : label, callback_data: `sdvg:folder:sel:${absoluteIndex}` }];
  });
  if (pages > 1) {
    rows.push([
      { text: "<", callback_data: `sdvg:folder:page:${Math.max(0, page - 1)}` },
      { text: `${page + 1}/${pages}`, callback_data: "sdvg:folder:noop" },
      { text: ">", callback_data: `sdvg:folder:page:${Math.min(pages - 1, page + 1)}` }
    ]);
  }
  rows.push([
    { text: "+", callback_data: "sdvg:folder:new" },
    { text: "↩", callback_data: "sdvg:folder:close" }
  ]);
  return { inline_keyboard: rows };
}

async function moveMediaFileEverywhere(target, requestedTopic) {
  const oldRel = String(target?.path || "").replace(/^[/\\]+/, "");
  const oldAbs = resolveMediaPathFromRel(oldRel);
  const stats = oldAbs ? await fs.stat(oldAbs).catch(() => null) : null;
  if (!oldAbs || !stats?.isFile?.()) throw new Error("Файл не найден на диске");

  const { safeTopic, dir } = await botContext.ensureTopicDir(requestedTopic || "unsorted");
  const oldName = path.basename(oldAbs);
  const currentTopic = currentFolderFromRelPath(oldRel);
  if (currentTopic.toLowerCase() === safeTopic.toLowerCase()) {
    return { oldRel, newRel: oldRel, oldName, newName: oldName, changed: false, size: stats.size };
  }

  const nextName = await ensureUniqueFileNameInDir(dir, oldName);
  const nextAbs = path.join(dir, nextName);
  await fs.rename(oldAbs, nextAbs);
  const nextRel = mediaRelPathFromAbsolute(nextAbs);
  const nextStats = await fs.stat(nextAbs).catch(() => stats);
  await botContext.moveMediaMetadata?.(oldRel, nextRel);

  let scrapeChanged = false;
  if (currentSession.scrapeId) {
    const scrape = await botContext.readScrape(currentSession.scrapeId).catch(() => null);
    if (scrape) {
      for (const seg of scrape.segments || []) {
        let segmentChanged = false;
        for (const item of seg.media_items || []) {
          if (String(item?.path || "") !== oldRel) continue;
          item.path = nextRel;
          item.name = nextName;
          item.topic = safeTopic;
          item.size = nextStats?.size ?? item.size ?? 0;
          item.updated_at = new Date().toISOString();
          item.thumbnail = isImageFile(nextName) ? `/api/media/raw?path=${encodeURIComponent(nextRel)}` : "";
          segmentChanged = true;
        }
        if (seg.media && String(seg.media.path || "") === oldRel) {
          seg.media.path = nextRel;
          seg.media.name = nextName;
          seg.media.topic = safeTopic;
          seg.media.size = nextStats?.size ?? seg.media.size ?? 0;
          seg.media.updated_at = new Date().toISOString();
          seg.media.thumbnail = isImageFile(nextName) ? `/api/media/raw?path=${encodeURIComponent(nextRel)}` : "";
          segmentChanged = true;
        }
        if (segmentChanged) {
          seg.updated_at = new Date().toISOString();
          scrapeChanged = true;
        }
      }
      if (scrapeChanged) await botContext.writeScrape(scrape);
    }
  }

  for (const entry of currentSession.renameTargets || []) {
    if (String(entry?.path || "") === oldRel) entry.path = nextRel;
    if (Array.isArray(entry?.paths)) {
      entry.paths = entry.paths.map((item) => String(item || "") === oldRel ? nextRel : item);
    }
  }
  if (currentSession.renameCtx && String(currentSession.renameCtx.path || "") === oldRel) {
    currentSession.renameCtx.path = nextRel;
  }
  if (currentSession.mediaPickCtx?.files) {
    for (const file of currentSession.mediaPickCtx.files) {
      if (String(file?.path || "") !== oldRel) continue;
      file.path = nextRel;
      file.name = nextName;
      file.topic = safeTopic;
      file.size = nextStats?.size ?? file.size ?? 0;
      file.updated_at = new Date().toISOString();
      file.thumbnail = isImageFile(nextName) ? `/api/media/raw?path=${encodeURIComponent(nextRel)}` : "";
    }
  }

  return { oldRel, newRel: nextRel, oldName, newName: nextName, changed: true, size: nextStats?.size ?? stats.size };
}

async function moveMediaGroupEverywhere(target, requestedTopic) {
  const paths = Array.isArray(target?.paths) ? [...target.paths] : [];
  if (!paths.length) throw new Error("Группа файлов не найдена");
  const results = [];
  for (const relPath of paths) {
    results.push(await moveMediaFileEverywhere({ path: relPath }, requestedTopic));
  }
  return results;
}

function rememberScreenshotTarget(url) {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) return "";
  const targets = Array.isArray(currentSession.screenshotTargets) ? currentSession.screenshotTargets : [];
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  currentSession.screenshotTargets = [
    { id, url: targetUrl, createdAt: new Date().toISOString() },
    ...targets.filter((target) => target?.url !== targetUrl)
  ].slice(0, 40);
  return id;
}

function renameButtonMarkup(renameId, rows = [], screenshotId = "") {
  const inline_keyboard = Array.isArray(rows) ? rows.filter((row) => Array.isArray(row) && row.length) : [];
  const controlRow = [];
  if (renameId) {
    const target = (currentSession.renameTargets || []).find((item) => item?.id === renameId);
    if (target && !target.isGroup && isVideoFilePath(target.path)) {
      controlRow.push({ text: "\u2702\uFE0F", callback_data: `sdvg:cut:${renameId}` });
    }
    controlRow.push({ text: "\uD83D\uDCC1", callback_data: `sdvg:folder:open:${renameId}` });
    controlRow.push({ text: "\u270F\uFE0F", callback_data: `sdvg:rename:${renameId}` });
  }
  if (screenshotId) {
    controlRow.push({ text: "\uD83D\uDCF8", callback_data: `sdvg:snap:${screenshotId}` });
  }
  if (controlRow.length) {
    controlRow.push({ text: "\u2714\uFE0F", callback_data: "sdvg:clear_buttons" });
    inline_keyboard.push(controlRow);
  }
  return { inline_keyboard };
}

function downloadGroupMarkup(groupRenameId, videoRenameIds = []) {
  const inline_keyboard = [];
  const controlRow = [];
  if (videoRenameIds.length === 1) {
    controlRow.push({ text: "\u2702\uFE0F", callback_data: `sdvg:cut:${videoRenameIds[0]}` });
  } else if (videoRenameIds.length > 1) {
    inline_keyboard.push(videoRenameIds.map((id, index) => ({
      text: videoRenameIds.length === 1 ? "\u2702\uFE0F" : `\u2702\uFE0F ${index + 1}`,
      callback_data: `sdvg:cut:${id}`
    })));
  }
  if (groupRenameId) {
    controlRow.push({ text: "\uD83D\uDCC1", callback_data: `sdvg:folder:open:${groupRenameId}` });
    controlRow.push({ text: "\u270F\uFE0F", callback_data: `sdvg:rename:${groupRenameId}` });
  }
  if (controlRow.length) {
    controlRow.push({ text: "\u2714\uFE0F", callback_data: "sdvg:clear_buttons" });
    inline_keyboard.push(controlRow);
  }
  return { inline_keyboard };
}

async function sendStandaloneScreenshot(token, chatId, rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) throw new Error("Пустая ссылка");
  const { safeTopic, dir } = await botContext.ensureTopicDir("unsorted");
  const profile = defaultShotProfileForScrape(currentSession.scrapeId);
  const buf = await captureScreenshot(url, profile);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const shotName = await ensureUniqueFileNameInDir(dir, safeTelegramUploadFileName(`${hostLabelForFileName(url)}_${stamp}.png`, "screenshot.png"));
  const shotPath = path.join(dir, shotName);
  await fs.writeFile(shotPath, buf);
  const relPath = `${safeTopic}/${shotName}`;
  const stats = await fs.stat(shotPath).catch(() => null);
  const renameId = rememberRenameTarget(relPath);
  if (renameId) await saveSession(botContext.DATA_DIR, currentSession);
  await sendLocalMedia(token, {
    chat_id: chatId,
    caption: `📸 <b>Скриншот</b>\n${sourceSiteLinkHtml(url)}\n🖥 ${shotProfileLabel(profile)}${stats ? `\n📦 ${escapeHtml(formatBytes(stats.size))}` : ""}`,
    parse_mode: "HTML",
    reply_markup: renameButtonMarkup(renameId)
  }, shotPath, shotName);
  return { relPath, shotPath, shotName };
}

async function renameMediaFileEverywhere(target, requestedName) {
  const oldRel = String(target?.path || "").replace(/^[/\\]+/, "");
  const oldAbs = resolveMediaPathFromRel(oldRel);
  const stats = oldAbs ? await fs.stat(oldAbs).catch(() => null) : null;
  if (!oldAbs || !stats?.isFile?.()) {
    throw new Error("Файл не найден на диске");
  }

  const rawName = path.basename(String(requestedName || "").trim().replace(/[\\/]+/g, "_"));
  if (!rawName) {
    throw new Error("Пустое имя файла");
  }

  const oldName = path.basename(oldAbs);
  const oldExt = path.extname(oldName) || ".bin";
  const requestedExt = path.extname(rawName);
  const wantedName = requestedExt ? rawName : `${rawName}${oldExt}`;
  const cleanName = safeTelegramUploadFileName(wantedName, path.basename(oldName, oldExt));
  const nextName = await ensureUniqueFileNameInDir(path.dirname(oldAbs), cleanName, oldName);
  if (nextName === oldName) {
    return { oldRel, newRel: oldRel, oldName, newName: oldName, changed: false, size: stats.size };
  }

  const nextAbs = path.join(path.dirname(oldAbs), nextName);
  await fs.rename(oldAbs, nextAbs);
  const nextRel = mediaRelPathFromAbsolute(nextAbs);
  const nextStats = await fs.stat(nextAbs).catch(() => stats);
  await botContext.moveMediaMetadata?.(oldRel, nextRel);

  let scrapeChanged = false;
  if (currentSession.scrapeId) {
    const scrape = await botContext.readScrape(currentSession.scrapeId).catch(() => null);
    if (scrape) {
      for (const seg of scrape.segments || []) {
        for (const item of seg.media_items || []) {
          if (String(item?.path || "") !== oldRel) continue;
          item.path = nextRel;
          item.name = nextName;
          item.size = nextStats?.size ?? item.size ?? 0;
          item.updated_at = new Date().toISOString();
          item.thumbnail = isImageFile(nextName) ? `/api/media/raw?path=${encodeURIComponent(nextRel)}` : "";
          scrapeChanged = true;
        }
        if (seg.media && String(seg.media.path || "") === oldRel) {
          seg.media.path = nextRel;
          seg.media.name = nextName;
          seg.media.size = nextStats?.size ?? seg.media.size ?? 0;
          seg.media.updated_at = new Date().toISOString();
          seg.media.thumbnail = isImageFile(nextName) ? `/api/media/raw?path=${encodeURIComponent(nextRel)}` : "";
          scrapeChanged = true;
        }
        if (scrapeChanged) seg.updated_at = new Date().toISOString();
      }
      if (scrapeChanged) await botContext.writeScrape(scrape);
    }
  }

  for (const entry of currentSession.renameTargets || []) {
    if (String(entry?.path || "") === oldRel) entry.path = nextRel;
    if (Array.isArray(entry?.paths)) {
      entry.paths = entry.paths.map((item) => String(item || "") === oldRel ? nextRel : item);
    }
  }
  if (currentSession.renameCtx && String(currentSession.renameCtx.path || "") === oldRel) {
    currentSession.renameCtx.path = nextRel;
  }
  if (currentSession.mediaPickCtx?.files) {
    for (const file of currentSession.mediaPickCtx.files) {
      if (String(file?.path || "") !== oldRel) continue;
      file.path = nextRel;
      file.name = nextName;
      file.size = nextStats?.size ?? file.size ?? 0;
      file.updated_at = new Date().toISOString();
      file.thumbnail = isImageFile(nextName) ? `/api/media/raw?path=${encodeURIComponent(nextRel)}` : "";
    }
  }

  return { oldRel, newRel: nextRel, oldName, newName: nextName, changed: true, size: nextStats?.size ?? stats.size };
}

async function renameMediaGroupEverywhere(target, requestedName) {
  const paths = Array.isArray(target?.paths) ? [...target.paths] : [];
  if (!paths.length) throw new Error("Группа файлов не найдена");
  const rawName = path.basename(String(requestedName || "").trim().replace(/[\\/]+/g, "_"));
  const baseName = path.parse(rawName).name;
  if (!baseName) throw new Error("Пустое имя группы файлов");

  const results = [];
  for (let index = 0; index < paths.length; index += 1) {
    const currentPath = target.paths?.[index] || paths[index];
    const extension = path.extname(currentPath) || ".bin";
    results.push(await renameMediaFileEverywhere(
      { path: currentPath },
      `${baseName}_${index + 1}${extension}`
    ));
  }
  return results;
}

async function updateRenamedTelegramMessage(token, chatId, ctx, target, result, options = {}) {
  const messageId = Number(target?.messageId || ctx?.messageId || 0);
  const targetChatId = target?.chatId || ctx?.chatId || chatId;
  if (!Number.isFinite(messageId) || messageId <= 0 || !targetChatId) return false;
  const sourceUrl = String(target?.sourceUrl || ctx?.sourceUrl || "").trim();
  const caption = buildReturnedMediaCaption({
    fileName: result?.newName || path.basename(result?.newRel || target?.path || ""),
    sourceUrl,
    sizeBytes: result?.size || 0,
    metadata: { webpage_url: sourceUrl, folder: options.folderName || "" }
  });
  const replyMarkup = target?.id ? renameButtonMarkup(target.id) : undefined;
  const captionPayload = {
    chat_id: targetChatId,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  };
  const captionResult = await callApi(token, "editMessageCaption", captionPayload).catch((error) => {
    if (/message is not modified/i.test(String(error?.message || ""))) return true;
    return null;
  });
  if (captionResult) return true;
  const textPayload = {
    chat_id: targetChatId,
    message_id: messageId,
    text: caption,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  };
  const textResult = await callApi(token, "editMessageText", textPayload).catch((error) => {
    if (/message is not modified/i.test(String(error?.message || ""))) return true;
    return null;
  });
  return Boolean(textResult);
}

function derivedOutputDirectory(sourcePath) {
  const sourceDir = path.dirname(sourcePath);
  return path.basename(sourceDir).toLowerCase() === "_originals" ? path.dirname(sourceDir) : sourceDir;
}

async function archiveParentMediaFile(relPath) {
  const oldRel = String(relPath || "").replace(/^[/\\]+/, "");
  if (!oldRel || oldRel.split("/").some((part) => part.toLowerCase() === "_originals")) return oldRel;
  const oldAbs = resolveMediaPathFromRel(oldRel);
  const stats = oldAbs ? await fs.stat(oldAbs).catch(() => null) : null;
  if (!oldAbs || !stats?.isFile?.()) return oldRel;

  const archiveDir = path.join(path.dirname(oldAbs), "_originals");
  await fs.mkdir(archiveDir, { recursive: true });
  const nextName = await ensureUniqueFileNameInDir(archiveDir, path.basename(oldAbs));
  const nextAbs = path.join(archiveDir, nextName);
  await fs.rename(oldAbs, nextAbs);
  const nextRel = mediaRelPathFromAbsolute(nextAbs);
  await botContext.moveMediaMetadata?.(oldRel, nextRel);

  if (currentSession.scrapeId) {
    const scrape = await botContext.readScrape(currentSession.scrapeId).catch(() => null);
    let changed = false;
    if (scrape) {
      for (const segment of scrape.segments || []) {
        let segmentChanged = false;
        for (const item of segment.media_items || []) {
          if (String(item?.path || "") !== oldRel) continue;
          item.path = nextRel;
          item.name = nextName;
          item.updated_at = new Date().toISOString();
          item.thumbnail = "";
          changed = true;
          segmentChanged = true;
        }
        if (segment.media && String(segment.media.path || "") === oldRel) {
          segment.media.path = nextRel;
          segment.media.name = nextName;
          segment.media.updated_at = new Date().toISOString();
          segment.media.thumbnail = "";
          changed = true;
          segmentChanged = true;
        }
        if (segmentChanged) segment.updated_at = new Date().toISOString();
      }
      if (changed) await botContext.writeScrape(scrape);
    }
  }

  for (const target of currentSession.renameTargets || []) {
    if (target?.path === oldRel) target.path = nextRel;
    if (Array.isArray(target?.paths)) target.paths = target.paths.map((item) => item === oldRel ? nextRel : item);
  }
  for (const job of Object.values(currentSession.trimJobs || {})) {
    if (job?.relPath === oldRel) job.relPath = nextRel;
  }
  for (const job of Object.values(currentSession.cutJobs || {})) {
    if (job?.relPath === oldRel) job.relPath = nextRel;
  }
  if (currentSession.renameCtx?.path === oldRel) currentSession.renameCtx.path = nextRel;
  if (currentSession.mediaPickCtx?.files) {
    for (const file of currentSession.mediaPickCtx.files) {
      if (file?.path === oldRel) file.path = nextRel;
    }
  }
  await saveSession(botContext.DATA_DIR, currentSession);
  return nextRel;
}

function findPythonExecutable() {
  if (process.env.PYTHON || process.env.PYTHON_EXECUTABLE) {
    return process.env.PYTHON || process.env.PYTHON_EXECUTABLE;
  }
  const localVenv = path.resolve(process.cwd(), ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
  return existsSync(localVenv) ? localVenv : "python";
}

function sceneCutterCliPath() {
  return path.resolve(process.cwd(), "tools", "video-scene-cutter", "telegram_cli.py");
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.floor(Number(value || 0)));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function parseTrimTime(value) {
  const parts = String(value || "").trim().replace(",", ".").split(":");
  if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return NaN;
  const numbers = parts.map(Number);
  if (numbers.length === 3) return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  return numbers[0];
}

async function probeVideoForTelegram(absolutePath) {
  const tools = await botContext.resolveDownloaderTools();
  const ffmpegPath = tools.ffmpeg_path || "ffmpeg";
  const ffprobeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const ffprobePath = path.join(path.dirname(ffmpegPath), ffprobeName);
  const executable = existsSync(ffprobePath) ? ffprobePath : ffprobeName;
  const { stdout } = await execFileAsync(executable, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,sample_aspect_ratio,display_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:format=duration",
    "-of", "json",
    absolutePath
  ], { windowsHide: true, timeout: 60_000 });
  const payload = JSON.parse(String(stdout || "{}"));
  const stream = payload.streams?.[0] || {};
  let width = Number(stream.width);
  let height = Number(stream.height);
  const darMatch = String(stream.display_aspect_ratio || "").match(/^(\d+):(\d+)$/);
  if (darMatch && height > 0) {
    const displayWidth = Math.round(height * Number(darMatch[1]) / Number(darMatch[2]));
    if (Number.isFinite(displayWidth) && displayWidth > 0) width = displayWidth;
  }
  const rotation = Number(stream.tags?.rotate ?? stream.side_data_list?.[0]?.rotation ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const rawDuration = Number(payload.format?.duration);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : undefined,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : undefined,
    duration: Number.isFinite(rawDuration) && rawDuration > 0 ? Math.max(1, Math.round(rawDuration)) : undefined
  };
}

async function getVideoDurationSeconds(absolutePath) {
  const metadata = await probeVideoForTelegram(absolutePath);
  if (!metadata.duration) throw new Error("Не удалось определить длительность видео");
  return metadata.duration;
}

function trimJobText(job) {
  const lines = [
    `✂️ <b>${escapeHtml(path.basename(job.relPath))}</b>`,
    `⏱ Длительность: ${formatSeconds(job.duration)}`,
    "",
    "Отрезки видео, которые сохраняем:"
  ];
  job.segments.forEach((segment, index) => {
    lines.push(`${index + 1}️⃣ ${formatSeconds(segment.start)} ··· ${formatSeconds(segment.end)}`);
  });
  return lines.join("\n");
}

function trimJobMarkup(job) {
  const rows = [];
  job.segments.forEach((segment, index) => {
    rows.push([
      { text: `Начало | ${formatSeconds(segment.start)}`, callback_data: `sdvg:trim:set:${job.id}:${index}:start` },
      { text: `${formatSeconds(segment.end)} | Конец`, callback_data: `sdvg:trim:set:${job.id}:${index}:end` },
      { text: "🗑", callback_data: `sdvg:trim:del:${job.id}:${index}` }
    ]);
  });
  rows.push([{ text: "+ Добавить фрагмент", callback_data: `sdvg:trim:add:${job.id}` }]);
  rows.push([{ text: "✂️ Готово, обрезать", callback_data: `sdvg:trim:done:${job.id}` }]);
  rows.push([{ text: "← Назад", callback_data: `sdvg:trim:back:${job.targetId}` }]);
  return { inline_keyboard: rows };
}

async function updateTrimMessage(token, chatId, job) {
  await callApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: job.messageId,
    text: trimJobText(job),
    parse_mode: "HTML",
    reply_markup: trimJobMarkup(job)
  });
}

async function deleteTelegramMessages(token, chatId, messageIds = []) {
  const uniqueIds = [...new Set((messageIds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0))];
  for (const messageId of uniqueIds) {
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => null);
  }
}

function scheduleDeleteTelegramMessages(token, chatId, messageIds = []) {
  const uniqueIds = [...new Set((messageIds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0))];
  if (!uniqueIds.length) return;
  void deleteTelegramMessages(token, chatId, uniqueIds);
  for (const delayMs of [2000, 10000]) {
    setTimeout(() => {
      void deleteTelegramMessages(token, chatId, uniqueIds);
    }, delayMs);
  }
}

async function startManualTrim(token, chatId, target) {
  const absolutePath = resolveMediaPathFromRel(target.path);
  const stats = absolutePath ? await fs.stat(absolutePath).catch(() => null) : null;
  if (!absolutePath || !stats?.isFile?.()) throw new Error("Видео не найдено на диске");
  const duration = await getVideoDurationSeconds(absolutePath);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id,
    targetId: target.id,
    relPath: target.path,
    sourceUrl: target.sourceUrl || "",
    duration,
    segments: [{ start: 0, end: duration }],
    messageId: null,
    cleanupMessageIds: [target.menuMessageId].filter(Boolean),
    createdAt: new Date().toISOString()
  };
  const message = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: trimJobText(job),
    parse_mode: "HTML",
    reply_markup: trimJobMarkup(job)
  });
  job.messageId = message.message_id;
  job.cleanupMessageIds.push(message.message_id);
  currentSession.trimJobs[id] = job;
  const entries = Object.entries(currentSession.trimJobs);
  if (entries.length > 12) currentSession.trimJobs = Object.fromEntries(entries.slice(-12));
  await saveSession(botContext.DATA_DIR, currentSession);
  return job;
}

async function exportManualTrim(job) {
  const sourcePath = resolveMediaPathFromRel(job.relPath);
  const stats = sourcePath ? await fs.stat(sourcePath).catch(() => null) : null;
  if (!sourcePath || !stats?.isFile?.()) throw new Error("Исходное видео не найдено");
  const outDir = derivedOutputDirectory(sourcePath);
  const parsed = path.parse(path.basename(job.relPath));
  const outputName = await ensureUniqueFileNameInDir(outDir, safeTelegramUploadFileName(`${parsed.name}_trim.mp4`, "trim.mp4"));
  const outputPath = path.join(outDir, outputName);
  await execFileAsync(findPythonExecutable(), [
    sceneCutterCliPath(), "trim",
    "--video", sourcePath,
    "--segments", JSON.stringify(job.segments.map((segment) => [segment.start, segment.end])),
    "--output", outputPath
  ], { windowsHide: true, timeout: 30 * 60 * 1000 });
  return outputPath;
}

async function sendCutModeMenu(token, chatId, target) {
  if (!target.sourceUrl) {
    const indexed = await botContext.getMediaMetadata?.(target.path);
    if (indexed?.source_url) {
      target.sourceUrl = indexed.source_url;
      await saveSession(botContext.DATA_DIR, currentSession);
    }
  }
  return callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `✂️ Как обрезать <code>${escapeHtml(path.basename(target.path))}</code>?`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "⏱ Обрезать по времени", callback_data: `sdvg:trim:start:${target.id}` }],
        [{ text: "🎬 Video Cutter", callback_data: `sdvg:cut:scene:${target.id}` }]
      ]
    }
  });
}

async function analyzeVideoForTelegramCut(relPath, sourceUrl = "") {
  const absolutePath = resolveMediaPathFromRel(relPath);
  const stats = absolutePath ? await fs.stat(absolutePath).catch(() => null) : null;
  if (!absolutePath || !stats?.isFile?.()) throw new Error("Файл не найден на диске");
  if (!isVideoFilePath(absolutePath)) throw new Error("Нарезка доступна только для видео");

  const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const outDir = path.join(botContext.DATA_DIR, "video-cutter", jobId);
  await fs.mkdir(outDir, { recursive: true });
  const { stdout } = await execFileAsync(findPythonExecutable(), [
    sceneCutterCliPath(),
    "analyze",
    "--video",
    absolutePath,
    "--out-dir",
    outDir
  ], { windowsHide: true, timeout: 10 * 60 * 1000 });
  let result = {};
  const lines = String(stdout || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        result = JSON.parse(trimmed);
        break;
      } catch {}
    }
  }
  if (!result || !Object.keys(result).length) {
    result = JSON.parse(String(stdout || "{}").trim() || "{}");
  }
  const jobPath = result.job || path.join(outDir, "job.json");
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  currentSession.cutJobs[jobId] = {
    id: jobId,
    relPath,
    sourceUrl: String(sourceUrl || "").trim(),
    jobPath,
    outDir,
    decisions: {},
    page: 0,
    messageId: null,
    cleanupMessageIds: [],
    createdAt: new Date().toISOString()
  };
  const entries = Object.entries(currentSession.cutJobs);
  if (entries.length > 12) {
    currentSession.cutJobs = Object.fromEntries(entries.slice(-12));
  }
  return { jobId, jobPath, outDir, job };
}

function cutDecisionMark(decision) {
  if (decision === "cut") return "\u2702\uFE0F";
  if (decision === "keep") return "\u2705";
  return "\u2610";
}

function buildCutClusterCaption(jobId, job, cluster, decision) {
  const clusters = Array.isArray(job?.clusters) ? job.clusters : [];
  const decided = Object.keys(currentSession.cutJobs?.[jobId]?.decisions || {}).length;
  return [
    `${cutDecisionMark(decision)} Кадр ${Number(cluster.index) + 1}/${clusters.length}`,
    `\u23F1 ${formatSeconds(cluster.start)}-${formatSeconds(cluster.end)}`,
    `≈ ${Number(cluster.approx_duration || 0).toFixed(1)}s, samples: ${cluster.samples}`,
    `Выбрано: ${decided}/${clusters.length}`,
    "",
    "‹/› листать, ✂️ вырезать этот кадр, ✅ оставить."
  ].join("\n");
}

function buildCutClusterMarkup(jobId, index, decision) {
  return {
    inline_keyboard: [
      [
        { text: "\u2039", callback_data: `sdvg:cut:nav:${jobId}:-1` },
        { text: "\u2611\uFE0F", callback_data: `sdvg:cut:mark:${jobId}:${index}:cut` },
        { text: "\u2705", callback_data: `sdvg:cut:mark:${jobId}:${index}:keep` },
        { text: "\u203A", callback_data: `sdvg:cut:nav:${jobId}:1` }
      ]
    ]
  };
}

async function sendCutPreviewMessages(token, chatId, cut) {
  const clusters = Array.isArray(cut.job?.clusters) ? cut.job.clusters : [];
  if (!clusters.length) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "Не удалось найти повторяющиеся сцены для нарезки."
    });
    return;
  }
  const intro = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `✂️ Найдены кадры: ${clusters.length}. Выберите для каждого: вырезать или оставить. Когда выбраны все, рендер запустится сам.`
  });
  const first = clusters[0];
  const previewPath = path.join(cut.outDir, first.preview);
  const msg = await callApiMultipart(token, "sendPhoto", {
    chat_id: chatId,
    caption: buildCutClusterCaption(cut.jobId, cut.job, first, ""),
    reply_markup: buildCutClusterMarkup(cut.jobId, first.index, "")
  }, "photo", previewPath, `scene_${String(first.index + 1).padStart(2, "0")}.jpg`);
  const sessionCut = currentSession.cutJobs?.[cut.jobId];
  if (sessionCut) {
    sessionCut.messageId = msg?.message_id || null;
    sessionCut.introMessageId = intro?.message_id || null;
    sessionCut.cleanupMessageIds = [
      ...(Array.isArray(sessionCut.cleanupMessageIds) ? sessionCut.cleanupMessageIds : []),
      intro?.message_id,
      msg?.message_id
    ].filter(Boolean);
    await saveSession(botContext.DATA_DIR, currentSession);
  }
}

async function updateCutPreviewMessage(token, chatId, jobId) {
  const cut = currentSession.cutJobs?.[jobId];
  if (!cut) throw new Error("Сессия нарезки устарела");
  const job = JSON.parse(await fs.readFile(cut.jobPath, "utf8"));
  const clusters = Array.isArray(job.clusters) ? job.clusters : [];
  const page = Math.max(0, Math.min(clusters.length - 1, Number(cut.page || 0)));
  const cluster = clusters[page];
  if (!cluster) throw new Error("Кадр не найден");
  cut.page = page;
  const decision = cut.decisions?.[String(cluster.index)] || "";
  const previewPath = path.join(cut.outDir, cluster.preview);
  await callApiMultipart(token, "editMessageMedia", {
    chat_id: chatId,
    message_id: cut.messageId,
    media: {
      type: "photo",
      media: "attach://photo",
      caption: buildCutClusterCaption(jobId, job, cluster, decision)
    },
    reply_markup: buildCutClusterMarkup(jobId, cluster.index, decision)
  }, "photo", previewPath, `scene_${String(cluster.index + 1).padStart(2, "0")}.jpg`);
}

async function exportTelegramCutJob(token, chatId, jobId) {
  const cut = currentSession.cutJobs?.[jobId];
  if (!cut) throw new Error("Сессия нарезки устарела");
  const job = JSON.parse(await fs.readFile(cut.jobPath, "utf8"));
  const clusters = Array.isArray(job.clusters) ? job.clusters : [];
  const cutIndexes = clusters
    .filter((cluster) => cut.decisions?.[String(cluster.index)] === "cut")
    .map((cluster) => Number(cluster.index));
  const sourceName = path.basename(String(cut.relPath || "video.mp4"));
  const sourcePath = resolveMediaPathFromRel(cut.relPath);
  if (!sourcePath) throw new Error("Исходное видео не найдено");
  const parsed = path.parse(sourceName);
  const outputDir = derivedOutputDirectory(sourcePath);
  const outputName = await ensureUniqueFileNameInDir(outputDir, safeTelegramUploadFileName(`${parsed.name}_cut.mp4`, "cut.mp4"));
  const outputPath = path.join(outputDir, outputName);
  if (!cutIndexes.length) {
    await fs.copyFile(sourcePath, outputPath);
    return outputPath;
  }
  await execFileAsync(findPythonExecutable(), [
    sceneCutterCliPath(),
    "export",
    "--job",
    cut.jobPath,
    "--selected",
    cutIndexes.join(","),
    "--mode",
    "remove",
    "--output",
    outputPath
  ], { windowsHide: true, timeout: 30 * 60 * 1000 });
  return outputPath;
}

async function renamePickedMediaFileOnDisk(file) {
  const absolutePath = resolvePickedMediaPath(file);
  const stats = absolutePath ? await fs.stat(absolutePath).catch(() => null) : null;
  if (!absolutePath || !stats?.isFile?.()) return { file, absolutePath, stats };

  const dir = path.dirname(absolutePath);
  const currentName = path.basename(absolutePath);
  const cleanName = safeTelegramUploadFileName(currentName, "media", file.topic || "");
  if (cleanName === currentName) return { file, absolutePath, stats };

  const nextName = await ensureUniqueFileNameInDir(dir, cleanName, currentName);
  const nextPath = path.join(dir, nextName);
  await fs.rename(absolutePath, nextPath);
  const root = path.resolve(botContext.PAMPAM_ROOT);
  const nextRel = path.relative(root, nextPath).split(path.sep).join("/");
  const nextStats = await fs.stat(nextPath).catch(() => stats);
  return {
    file: {
      ...file,
      path: nextRel,
      name: nextName,
      size: nextStats?.size ?? file.size,
      updated_at: nextStats?.mtime?.toISOString?.() ?? new Date().toISOString(),
      thumbnail: isImageFile(nextName) ? `/api/media/raw?path=${encodeURIComponent(nextRel)}` : ""
    },
    absolutePath: nextPath,
    stats: nextStats
  };
}

async function attachPickedMedia(token, chatId, mediaIndex, pickerMessageId) {
  const ctx = currentSession.mediaPickCtx;
  let file = Array.isArray(ctx?.files) ? ctx.files[mediaIndex] : null;
  if (!ctx || !file) {
    await callApi(token, "sendMessage", { chat_id: chatId, text: "File list expired. Open Files again." });
    return;
  }

  const freshScrape = await botContext.readScrape(ctx.scrapeId);
  const segIdx = (freshScrape.segments || []).findIndex((s) => s.id === ctx.segmentId);
  if (segIdx < 0) {
    await callApi(token, "sendMessage", { chat_id: chatId, text: "Segment was not found." });
    return;
  }

  const segment = freshScrape.segments[segIdx];
  const previousPath = String(file.path || "");
  const renamed = await renamePickedMediaFileOnDisk(file);
  file = renamed.file;
  if (previousPath && previousPath !== file.path) {
    for (const seg of freshScrape.segments || []) {
      for (const item of seg.media_items || []) {
        if (String(item?.path || "") !== previousPath) continue;
        item.path = file.path;
        item.name = file.name;
        item.size = file.size;
        item.updated_at = file.updated_at;
        item.thumbnail = file.thumbnail;
      }
      if (seg.media && String(seg.media.path || "") === previousPath) {
        seg.media.path = file.path;
        seg.media.name = file.name;
        seg.media.size = file.size;
        seg.media.updated_at = file.updated_at;
        seg.media.thumbnail = file.thumbnail;
      }
    }
  }
  const items = Array.isArray(segment.media_items) ? segment.media_items : [];
  const knownItem = findMediaItemByPath(freshScrape, file.path);
  const knownMetadata = metadataFromMediaItem(knownItem || file);
  let attachedIndex = items.findIndex((item) => item.path === file.path);
  if (attachedIndex < 0) {
    items.push({
      path: file.path || "",
      name: file.name || path.basename(String(file.path || "").replace(/\\/g, "/")),
      topic: file.topic || "",
      size: file.size || 0,
      updated_at: file.updated_at || new Date().toISOString(),
      thumbnail: file.thumbnail || "",
      source_url: knownMetadata.webpage_url || "",
      title: knownMetadata.title || "",
      uploader: knownMetadata.uploader || "",
      uploader_url: knownMetadata.uploader_url || "",
      webpage_url: knownMetadata.webpage_url || "",
      format_note: knownMetadata.format_note || "",
      resolution: knownMetadata.resolution || ""
    });
    attachedIndex = items.length - 1;
  }

  freshScrape.segments[segIdx].media_items = items;
  freshScrape.segments[segIdx].media = items[0] || null;
  freshScrape.segments[segIdx].updated_at = new Date().toISOString();
  await botContext.writeScrape(freshScrape);

  currentSession.mediaPickCtx = null;
  await saveSession(botContext.DATA_DIR, currentSession);

  const absolutePath = renamed.absolutePath || resolvePickedMediaPath(file);
  const fileName = file.name || path.basename(String(file.path || "").replace(/\\/g, "/"));
  const stats = renamed.stats || (absolutePath ? await fs.stat(absolutePath).catch(() => null) : null);
  const statusText = absolutePath && stats?.isFile?.()
    ? `✅ Файл прикреплен:\n<code>${escapeHtml(fileName)}</code>\n${escapeHtml(formatBytes(stats.size))}`
    : `✅ Файл прикреплен:\n<code>${escapeHtml(formatMediaItemName(file))}</code>\n⚠️ Файл не найден на диске.`;
  const renameId = rememberRenameTarget(file.path, segment.id, attachedIndex, file.source_url || file.webpage_url || "");
  if (renameId) await saveSession(botContext.DATA_DIR, currentSession);
  await callApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: pickerMessageId,
    text: statusText,
    parse_mode: "HTML",
    reply_markup: renameButtonMarkup(renameId, supportsTimecodeFilePath(file.path) ? [[
      { text: "\u23F1\uFE0F", callback_data: `sdvg:timecode:${segment.id}:${attachedIndex}` }
    ]] : [])
  }).catch(() => null);

  await sendOrEditCard(token, currentSession, freshScrape, freshScrape.segments[segIdx]);
}

/**
 * Finds the next undone segment in the scrape
 */
function filterSegmentsForSessionMode(segments, session = {}) {
  let filtered = Array.isArray(segments) ? segments : [];
  if (session.screenshotLabMode) {
    filtered = filtered.filter((segment) => Boolean(extractFirstUrl(segment?.text || "")));
  }
  if (session.sdvgMaxMode) {
    filtered = filtered.filter((segment) => (segment.text || "").trim().startsWith("/"));
  }
  return filtered;
}

function findNextSegment(scrape, currentSegmentId, randomMode, sdvgMaxMode, screenshotLabMode = false) {
  let segments = scrape.segments || [];
  if (segments.length === 0) return null;

  segments = filterSegmentsForSessionMode(segments, { sdvgMaxMode, screenshotLabMode });
  if (segments.length === 0) return null;

  const undone = segments.filter((s) => !s.is_done);
  if (undone.length === 0) return null;

  if (randomMode) {
    const candidates = undone.filter((s) => s.id !== currentSegmentId);
    if (candidates.length === 0) return undone[0];
    const idx = Math.floor(Math.random() * candidates.length);
    return candidates[idx];
  } else {
    const currentIdx = segments.findIndex((s) => s.id === currentSegmentId);
    if (currentIdx < 0) return undone[0];

    // Find next in order
    for (let i = currentIdx + 1; i < segments.length; i++) {
      if (!segments[i].is_done) return segments[i];
    }
    // Loop back to start
    for (let i = 0; i < currentIdx; i++) {
      if (!segments[i].is_done) return segments[i];
    }
    // Only current one is undone
    if (!segments[currentIdx].is_done) return segments[currentIdx];
    return null;
  }
}

/**
 * Renders and sends or edits the segment card in Telegram
 */
async function sendOrEditCard(token, session, scrape, segment) {
  if (!session.chatId) return;
  const hasLink = segment.type === "link" || !!extractFirstUrl(segment.text);
  const downloadState = await getSegmentDownloadState(segment).catch(() => ({
    url: extractFirstUrl(segment?.text || ""),
    downloadable: false,
    alreadyDownloaded: false
  }));
  const linkState = { ...downloadState, hasLink };
  const text = formatCardText(scrape, segment, session, linkState);
  const replyMarkup = buildCardMarkup(session, segment, linkState);

  if (session.messageId) {
    try {
      await callApi(token, "editMessageText", {
        chat_id: session.chatId,
        message_id: session.messageId,
        text: text,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      });
      return;
    } catch (error) {
      console.warn("[bot-card] Failed to edit card, sending a new one:", error.message);
      // Fallback: clear messageId and let it send a new one below
      session.messageId = null;
    }
  }

  const sent = await callApi(token, "sendMessage", {
    chat_id: session.chatId,
    text: text,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  });
  session.messageId = sent.message_id;
}

function extractMessageMedia(message) {
  if (message.video) {
    return {
      type: "video",
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      fileName: message.video.file_name || `video_${Date.now()}.mp4`,
      fileSize: message.video.file_size
    };
  }
  if (message.document) {
    return {
      type: "document",
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      fileName: message.document.file_name || `document_${Date.now()}`,
      fileSize: message.document.file_size
    };
  }
  if (message.sticker && !message.sticker.is_animated && !message.sticker.is_video) {
    return {
      type: "sticker",
      fileId: message.sticker.file_id,
      fileUniqueId: message.sticker.file_unique_id,
      fileName: message.sticker.file_name || `sticker_${Date.now()}.webp`,
      fileSize: message.sticker.file_size
    };
  }
  if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    return {
      type: "photo",
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      fileName: `photo_${Date.now()}.jpg`,
      fileSize: photo.file_size
    };
  }
  if (message.animation) {
    return {
      type: "animation",
      fileId: message.animation.file_id,
      fileUniqueId: message.animation.file_unique_id,
      fileName: message.animation.file_name || `animation_${Date.now()}.mp4`,
      fileSize: message.animation.file_size
    };
  }
  if (message.audio) {
    return {
      type: "audio",
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      fileName: message.audio.file_name || `audio_${Date.now()}.mp3`,
      fileSize: message.audio.file_size
    };
  }
  if (message.voice) {
    return {
      type: "voice",
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id,
      fileName: `voice_${Date.now()}.ogg`,
      fileSize: message.voice.file_size
    };
  }
  if (message.video_note) {
    return {
      type: "video_note",
      fileId: message.video_note.file_id,
      fileUniqueId: message.video_note.file_unique_id,
      fileName: `video_note_${Date.now()}.mp4`,
      fileSize: message.video_note.file_size
    };
  }
  return null;
}

function isImageFile(filename) {
  return /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filename);
}

function telegramMessageSource(message) {
  const origin = message?.forward_origin || null;
  const channel = origin?.type === "channel" ? origin.chat : message?.forward_from_chat;
  const messageId = origin?.type === "channel" ? origin.message_id : message?.forward_from_message_id;
  const username = String(channel?.username || "").replace(/^@/, "");
  return {
    source_url: username && messageId ? `https://t.me/${username}/${messageId}` : "",
    source_type: channel ? "telegram_channel" : "telegram",
    source_title: String(channel?.title || message?.forward_sender_name || "").trim(),
    source_message_id: messageId || null
  };
}

function telegramMessageTitle(message, media = {}) {
  const source = telegramMessageSource(message);
  const caption = cleanupCaptionText(message?.caption || message?.text || "");
  const captionLine = caption.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  const sourceTitle = cleanupCaptionText(source.source_title || "");
  const mediaName = cleanupCaptionText(media?.fileName || "");
  return {
    title: captionLine || sourceTitle || mediaName,
    description: caption || sourceTitle || mediaName,
    source
  };
}

function descriptiveTelegramMediaFileName(message, media, topicPrefix = "") {
  const original = String(media?.fileName || `${media?.type || "media"}_${Date.now()}`).trim();
  const parsed = path.parse(original);
  const ext = parsed.ext || (media?.type === "photo" ? ".jpg" : media?.type === "sticker" ? ".webp" : ".bin");
  const currentStem = asciiFilePart(parsed.name || "", "");
  if (currentStem && !isGenericMediaStem(currentStem)) return safeTelegramUploadFileName(original, media?.type || "media", topicPrefix);
  const meta = telegramMessageTitle(message, media);
  const label = [meta.title, meta.description, meta.source.source_title, meta.source.source_url]
    .find((value) => {
      const stem = asciiFilePart(value, "");
      return stem && !isGenericMediaStem(stem);
    });
  return safeTelegramUploadFileName(`${label || original}${ext}`, media?.type || "media", topicPrefix);
}

function isWebpFile(filename) {
  return /\.webp$/i.test(String(filename || ""));
}

async function convertWebpToPng(sourcePath) {
  if (typeof botContext?.convertWebpToPng === "function") {
    return botContext.convertWebpToPng(sourcePath);
  }
  const parsed = path.parse(sourcePath);
  let targetPath = path.join(parsed.dir, `${parsed.name}.png`);
  let counter = 1;
  while (await fs.access(targetPath).then(() => true).catch(() => false)) {
    targetPath = path.join(parsed.dir, `${parsed.name}_${counter}.png`);
    counter += 1;
  }

  const tools = await botContext.resolveDownloaderTools();
  const ffmpeg = tools.ffmpeg_path || "ffmpeg";
  try {
    await execFileAsync(ffmpeg, ["-loglevel", "error", "-y", "-i", sourcePath, "-frames:v", "1", targetPath], { windowsHide: true });
    await fs.unlink(sourcePath);
    return targetPath;
  } catch (error) {
    await fs.unlink(targetPath).catch(() => null);
    throw error;
  }
}

async function copyTelegramSharedVolumeFile(rawFilePath, targetPath) {
  const root = path.resolve("/var/lib/telegram-bot-api");
  const raw = String(rawFilePath || "").trim().replace(/\\/g, "/");
  if (!raw) return false;
  const candidates = raw.startsWith("/")
    ? [path.resolve(raw)]
    : [path.resolve(root, raw.replace(/^\/+/, ""))];
  for (const candidate of candidates) {
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) continue;
    const stats = await fs.stat(candidate).catch(() => null);
    if (!stats?.isFile?.()) continue;
    await fs.copyFile(candidate, targetPath);
    return true;
  }
  const suffix = raw.replace(/^.*?telegram-bot-api\//, "").replace(/^\/+/, "");
  const matches = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const normalized = candidate.replace(/\\/g, "/");
      if (!normalized.endsWith(`/${suffix}`) && entry.name !== path.basename(suffix)) continue;
      const stats = await fs.stat(candidate).catch(() => null);
      if (stats?.isFile?.()) matches.push({ candidate, mtime: stats.mtimeMs });
    }
  }
  matches.sort((left, right) => right.mtime - left.mtime);
  if (matches[0]) {
    await fs.copyFile(matches[0].candidate, targetPath);
    return true;
  }
  return false;
}

async function downloadTelegramFileToPath(token, media, targetPath) {
  const fileResult = await callApi(token, "getFile", { file_id: media.fileId });
  const rawFilePath = String(fileResult?.file_path ?? "").trim();
  if (!rawFilePath) throw new Error("Telegram did not return file_path");

  const raw = rawFilePath.replace(/\\/g, "/");
  if (await copyTelegramSharedVolumeFile(raw, targetPath)) return;
  const normalizedPrefix = "/var/lib/telegram-bot-api";
  const prefixWithSlash = `${normalizedPrefix}/`;
  let filePath = raw;
  if (raw.startsWith(prefixWithSlash)) filePath = raw.slice(prefixWithSlash.length);
  filePath = filePath.replace(/^\/+/, "");

  const candidates = [];
  const isRemote = BASE_FILE_URL.includes("api.telegram.org");
  if (isRemote) {
    candidates.push(`${BASE_FILE_URL}/bot${token}/${filePath}`);
    if (raw !== filePath) candidates.push(`${BASE_FILE_URL}/bot${token}/${raw}`);
  } else {
    candidates.push(`${BASE_FILE_URL}/${filePath}`);
    candidates.push(`${BASE_FILE_URL}/bot${token}/${filePath}`);
    if (raw !== filePath) {
      candidates.push(`${BASE_FILE_URL}/${raw}`);
      candidates.push(`${BASE_FILE_URL}/bot${token}/${raw}`);
    }
  }

  let lastError = "";
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (res.ok && res.body) {
        await pipeline(Readable.fromWeb(res.body), createWriteStream(targetPath));
        return;
      }
      lastError = `HTTP ${res.status}: ${res.statusText}`;
    } catch (error) {
      lastError = error.message;
    }
  }

  const dockerContainerName = process.env.TELEGRAM_DOCKER_CONTAINER_NAME || "ucontent-telegram-bot-api";
  if (raw.startsWith(normalizedPrefix)) {
    await execFileAsync("docker", ["cp", `${dockerContainerName}:${raw}`, targetPath], { windowsHide: true });
    return;
  }
  throw new Error(`Could not download Telegram file: ${lastError}`);
}

async function handleDownloadModeMediaMessage(token, message, media) {
  const chatId = message.chat.id;
  const { dir } = await botContext.ensureTopicDir("unsorted");
  const cleanName = descriptiveTelegramMediaFileName(message, media, "unsorted");
  let targetPath = path.join(dir, cleanName);
  let counter = 1;
  const ext = path.extname(cleanName);
  const base = path.basename(cleanName, ext);
  while (await fs.access(targetPath).then(() => true).catch(() => false)) {
    targetPath = path.join(dir, `${base}_${counter}${ext}`);
    counter += 1;
  }
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `Сохраняю в unsorted: <code>${escapeHtml(path.basename(targetPath))}</code>`,
    parse_mode: "HTML"
  });
  try {
    await downloadTelegramFileToPath(token, media, targetPath);
    const stats = await fs.stat(targetPath).catch(() => null);
    let sendBackPath = targetPath;
    let sendBackStats = stats;
    if (isWebpFile(targetPath) && stats?.isFile?.()) {
      sendBackPath = await convertWebpToPng(targetPath);
      sendBackStats = await fs.stat(sendBackPath).catch(() => null);
      await fs.unlink(targetPath).catch(() => null);
    }
    const fileName = path.basename(sendBackPath);
    const relPath = mediaRelPathFromAbsolute(sendBackPath);
    const mediaMeta = telegramMessageTitle(message, media);
    const source = mediaMeta.source;
    await botContext.upsertMediaMetadata?.(relPath, {
      ...source,
      derivation: "telegram",
      title: mediaMeta.title,
      description: mediaMeta.description,
      size: sendBackStats?.size || 0
    });
    const renameId = relPath ? rememberRenameTarget(relPath, "", -1, source.source_url) : "";
    if (renameId) await saveSession(botContext.DATA_DIR, currentSession);
    if (sendBackStats?.isFile?.()) {
      const sentMessage = await sendLocalMedia(token, {
        chat_id: chatId,
        caption: buildReturnedMediaCaption({
          fileName,
          sourceUrl: source.source_url,
          sizeBytes: sendBackStats.size,
          metadata: {
            title: mediaMeta.title,
            description: mediaMeta.description,
            uploader: source.source_title,
            webpage_url: source.source_url
          }
        }),
        parse_mode: "HTML",
        reply_markup: renameButtonMarkup(renameId)
      }, sendBackPath, fileName);
      if (sentMessage?.message_id && attachRenameTargetMessage(renameId, chatId, sentMessage.message_id)) {
        await saveSession(botContext.DATA_DIR, currentSession);
      }
    }
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => null);
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => null);
  } catch (error) {
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `Не удалось сохранить: ${error.message}`
    }).catch(() => null);
  }
}

async function handleMediaMessage(token, message, media) {
  const chatId = message.chat.id;
  if (!currentSession.scrapeId || !currentSession.activeSegmentId) {
    if (currentSession.downloadMode) {
      await handleDownloadModeMediaMessage(token, message, media);
      return;
    }
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ Нет активного сегмента для прикрепления медиа-файла. Откройте сегмент с помощью команды /sdvg."
    });
    return;
  }

  // Get active segment
  const freshScrape = await botContext.readScrape(currentSession.scrapeId);
  const segIdx = (freshScrape.segments || []).findIndex(s => s.id === currentSession.activeSegmentId);
  if (segIdx < 0) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ Активный сегмент не найден в текущем сценарии."
    });
    return;
  }

  const seg = freshScrape.segments[segIdx];
  const topic = botContext.sanitizeMediaTopicName(seg.topic || "unsorted");
  const { dir: topicDir } = await botContext.ensureTopicDir(topic);

  // Send status message to user: downloading file
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `📥 <b>Скачиваю файл:</b> <code>${media.fileName}</code>...`,
    parse_mode: "HTML"
  });

  try {
    // 1. Get file_path from telegram
    const fileResult = await callApi(token, "getFile", { file_id: media.fileId });
    const rawFilePath = String(fileResult?.file_path ?? "").trim();
    if (!rawFilePath) {
      throw new Error("Telegram не вернул file_path");
    }

    // 2. Determine target file path
    const cleanName = descriptiveTelegramMediaFileName(message, media, topic);
    let targetPath = path.join(topicDir, cleanName);
    
    // Check uniqueness
    let counter = 1;
    const ext = path.extname(cleanName);
    const base = path.basename(cleanName, ext);
    while (true) {
      try {
        await fs.access(targetPath);
        targetPath = path.join(topicDir, `${base}_${counter}${ext}`);
        counter++;
      } catch {
        break;
      }
    }
    let finalPath = targetPath;

    // 3. Download from local Bot API or official API
    const raw = String(rawFilePath ?? "").trim().replace(/\\/g, "/");
    const normalizedPrefix = "/var/lib/telegram-bot-api";
    const prefixWithSlash = `${normalizedPrefix}/`;
    let filePath = raw;
    if (raw.startsWith(prefixWithSlash)) {
      filePath = raw.slice(prefixWithSlash.length);
    }
    filePath = filePath.replace(/^\/+/, "");
    let downloaded = await copyTelegramSharedVolumeFile(raw, targetPath);

    const candidates = [];
    const isRemote = BASE_FILE_URL.includes("api.telegram.org");

    if (isRemote) {
      candidates.push(`${BASE_FILE_URL}/bot${token}/${filePath}`);
      if (raw !== filePath) {
        candidates.push(`${BASE_FILE_URL}/bot${token}/${raw}`);
      }
    } else {
      // Local Bot API Candidates
      candidates.push(`${BASE_FILE_URL}/${filePath}`);
      candidates.push(`${BASE_FILE_URL}/bot${token}/${filePath}`);
      if (raw !== filePath) {
        candidates.push(`${BASE_FILE_URL}/${raw}`);
        candidates.push(`${BASE_FILE_URL}/bot${token}/${raw}`);
      }
    }

    let res = null;
    let lastError = "";
    for (const url of downloaded ? [] : candidates) {
      try {
        res = await fetch(url);
        if (res.ok && res.body) {
          break;
        }
        lastError = `HTTP ${res.status}: ${res.statusText}`;
      } catch (err) {
        lastError = err.message;
      }
    }

    if (!downloaded && res && res.ok && res.body) {
      const fileStream = createWriteStream(targetPath);
      await pipeline(Readable.fromWeb(res.body), fileStream);
      downloaded = true;
    } else if (!downloaded) {
      // Docker cp fallback
      const dockerContainerName = process.env.TELEGRAM_DOCKER_CONTAINER_NAME || "ucontent-telegram-bot-api";
      const hasDockerLocalPath = raw.startsWith(normalizedPrefix);
      if (hasDockerLocalPath) {
        try {
          console.log(`[bot] HTTP failed (${lastError}). Trying docker cp fallback: docker cp ${dockerContainerName}:${raw} ${targetPath}`);
          await execFileAsync("docker", ["cp", `${dockerContainerName}:${raw}`, targetPath], {
            windowsHide: true
          });
          downloaded = true;
        } catch (dockerErr) {
          console.error("[bot] docker cp fallback failed:", dockerErr.message);
          lastError = `HTTP download failed (${lastError}) and docker cp failed (${dockerErr.message})`;
        }
      }
    }

    if (!downloaded) {
      throw new Error(`Не удалось скачать файл. Last error: ${lastError}`);
    }

    if (isWebpFile(finalPath)) {
      const pngPath = await convertWebpToPng(finalPath);
      await fs.unlink(finalPath).catch(() => null);
      finalPath = pngPath;
    }
    const finalName = path.basename(finalPath);
    const mediaMeta = telegramMessageTitle(message, media);
    const source = mediaMeta.source;

    // 4. Attach to segment
    const relPath = `${topic}/${finalName}`;
    const stats = await fs.stat(finalPath);
    const mediaItem = {
      path: relPath,
      name: finalName,
      topic,
      size: stats.size,
      source_url: source.source_url,
      title: mediaMeta.title,
      description: mediaMeta.description,
      uploader: source.source_title,
      updated_at: new Date().toISOString(),
      thumbnail: isImageFile(finalName) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
    };
    await botContext.upsertMediaMetadata?.(relPath, {
      ...source,
      derivation: "telegram",
      title: mediaMeta.title,
      description: mediaMeta.description,
      size: stats.size,
      segment_id: seg.id
    });

    const items = seg.media_items || [];
    items.push(mediaItem);
    freshScrape.segments[segIdx].media_items = items;
    freshScrape.segments[segIdx].media = freshScrape.segments[segIdx].media || items[0];
    freshScrape.segments[segIdx].updated_at = new Date().toISOString();
    await botContext.writeScrape(freshScrape);

    const mediaIndex = items.length - 1;
    const renameId = rememberRenameTarget(relPath, seg.id, mediaIndex, source.source_url);
    if (renameId) await saveSession(botContext.DATA_DIR, currentSession);
    // 5. Update status message
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `✅ <b>Файл успешно сохранен!</b>\n📁 <code>${relPath}</code>\nПрикреплен к сегменту <b>${seg.id}</b>.`,
      parse_mode: "HTML",
      reply_markup: renameButtonMarkup(renameId, supportsTimecodeFilePath(relPath) ? [[
        { text: "\u23F1\uFE0F", callback_data: `sdvg:timecode:${seg.id}:${mediaIndex}` }
      ]] : [])
    });

    // 6. Refresh the segment card to show the attached file
    await sendOrEditCard(token, currentSession, freshScrape, freshScrape.segments[segIdx]);

  } catch (error) {
    console.error("[bot] error downloading media file:", error);
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ <b>Ошибка при скачивании файла:</b> ${error.message}`,
      parse_mode: "HTML"
    });
  }
}

/**
 * Main command router for text messages
 */
async function handleTextMessage(token, message) {
  const chatId = message.chat.id;
  const text = String(message.text || message.caption || "").trim();
  const ownUrls = extractMessageUrls({ ...message, reply_to_message: null });
  const messageUrls = extractMessageUrls(message);
  const firstUrl = ownUrls[0] || null;

  // Initialize or pair session
  if (currentSession.chatId !== chatId) {
    currentSession.chatId = chatId;
    currentSession.messageId = null;
    await saveSession(botContext.DATA_DIR, currentSession);
  }

  if (currentSession.trimInputCtx && !text.startsWith("/")) {
    const ctx = currentSession.trimInputCtx;
    const job = currentSession.trimJobs?.[ctx.jobId];
    const segment = job?.segments?.[ctx.index];
    if (!job || !segment || !["start", "end"].includes(ctx.field)) {
      currentSession.trimInputCtx = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "sendMessage", { chat_id: chatId, text: "Сессия ручной обрезки устарела." });
      return;
    }
    if (["отмена", "cancel"].includes(text.toLowerCase())) {
      currentSession.trimInputCtx = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "sendMessage", { chat_id: chatId, text: "Ввод времени отменён." });
      return;
    }
    const seconds = parseTrimTime(text);
    const valid = Number.isFinite(seconds) && seconds >= 0 && seconds <= job.duration &&
      (ctx.field === "start" ? seconds < segment.end : seconds > segment.start);
    if (!valid) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `Некорректное время. Введите ММ:СС или ЧЧ:ММ:СС в пределах видео; начало должно быть раньше конца.`
      });
      return;
    }
    segment[ctx.field] = seconds;
    currentSession.trimInputCtx = null;
    await saveSession(botContext.DATA_DIR, currentSession);
    if (ctx.promptMessageId) {
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: ctx.promptMessageId }).catch(() => null);
    }
    await updateTrimMessage(token, chatId, job).catch(() => null);
    return;
  }

  if (currentSession.renameCtx && !text.startsWith("/")) {
    const ctx = currentSession.renameCtx;
    currentSession.renameCtx = null;
    await saveSession(botContext.DATA_DIR, currentSession);

    if (ctx.promptMessageId) {
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: ctx.promptMessageId }).catch(() => null);
    }

    const lower = text.toLowerCase();
    if (lower === "отмена" || lower === "cancel") {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "Переименование отменено." });
      return;
    }

    if (firstUrl) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Похоже, это ссылка, а не имя файла. Файл не переименован."
      }).catch(() => null);
      return;
    }

    try {
      const target = (currentSession.renameTargets || []).find((item) => item?.id === ctx.targetId) || ctx;
      if (target.isGroup) {
        const results = await renameMediaGroupEverywhere(target, text);
        await saveSession(botContext.DATA_DIR, currentSession);
        await callApi(token, "deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => null);
        return;
      }
      const result = await renameMediaFileEverywhere(target, text);
      const messageUpdated = await updateRenamedTelegramMessage(token, chatId, ctx, target, result).catch(() => false);
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => null);
      if (!messageUpdated && !currentSession.scrapeId) {
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: result.changed
            ? `✅ Файл переименован:\n<code>${escapeHtml(result.oldRel)}</code>\n→ <code>${escapeHtml(result.newRel)}</code>`
            : `Имя уже такое:\n<code>${escapeHtml(result.newRel)}</code>`,
          parse_mode: "HTML"
        });
      }

      if (currentSession.scrapeId && currentSession.activeSegmentId) {
        const freshScrape = await botContext.readScrape(currentSession.scrapeId).catch(() => null);
        const seg = freshScrape?.segments?.find((segment) => segment.id === currentSession.activeSegmentId);
        if (freshScrape && seg) {
          await sendOrEditCard(token, currentSession, freshScrape, seg).catch(() => null);
        }
      }
      return;
    } catch (err) {
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `Не удалось переименовать файл: ${err.message}`
      });
      return;
    }
  }

  if (currentSession.folderCreateCtx && !text.startsWith("/")) {
    const ctx = clearFolderCreateCtx();
    await saveSession(botContext.DATA_DIR, currentSession);
    if (ctx?.promptMessageId) {
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: ctx.promptMessageId }).catch(() => null);
    }
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => null);
    const controlMessageId = Number(ctx?.controlMessageId || 0);
    try {
      const { safeTopic } = await botContext.ensureTopicDir(text);
      const context = getFolderMoveContext(controlMessageId);
      if (!context?.targetId) throw new Error("Контекст выбора папки устарел");
      const target = (currentSession.renameTargets || []).find((item) => item?.id === context.targetId);
      if (!target) throw new Error("Файл больше не найден");
      const result = target.isGroup
        ? await moveMediaGroupEverywhere(target, safeTopic)
        : await moveMediaFileEverywhere(target, safeTopic);
      const firstResult = Array.isArray(result) ? result[0] : result;
      const confirmedInFolder = await movedResultsConfirmedInFolder(result, safeTopic);
      if (confirmedInFolder && firstResult) {
        await updateRenamedTelegramMessage(token, chatId, ctx, target, firstResult, { folderName: safeTopic }).catch(() => false);
      }
      const themes = await listMediaTopicFolders();
      rememberFolderMoveContext(controlMessageId, {
        ...context,
        themes,
        currentFolder: safeTopic,
        page: 0
      });
      await callApi(token, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: controlMessageId,
        reply_markup: renameButtonMarkup(context.targetId)
      }).catch(() => null);
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `📁 Сохранено в <b>${escapeHtml(safeTopic)}</b>`,
        parse_mode: "HTML"
      }).then((sent) => {
        if (sent?.message_id) setTimeout(() => void deleteTelegramMessages(token, chatId, [sent.message_id]), 2500);
      }).catch(() => null);
      await saveSession(botContext.DATA_DIR, currentSession);
      return;
    } catch (error) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `Не удалось создать папку или перенести файл: ${error.message}`
      }).catch(() => null);
      return;
    }
  }

  if (currentSession.timecodeCtx && !text.startsWith("/")) {
    const ctx = currentSession.timecodeCtx;
    currentSession.timecodeCtx = null;
    await saveSession(botContext.DATA_DIR, currentSession);

    // Delete the prompt message now that user has responded
    if (ctx.promptMessageId) {
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: ctx.promptMessageId }).catch(() => null);
    }

    if (text.toLowerCase() === "отмена" || text.toLowerCase() === "cancel") {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `❌ Установка таймкода отменена.`
      });
      return;
    }

    if (firstUrl) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Похоже, это ссылка, а не таймкод. Таймкод не изменен."
      }).catch(() => null);
    } else {

      try {
        const freshScrape = await botContext.readScrape(currentSession.scrapeId);
        const segIdx = freshScrape.segments.findIndex(s => s.id === ctx.segmentId);
        if (segIdx !== -1) {
          const seg = freshScrape.segments[segIdx];
          const mediaItems = Array.isArray(seg.media_items) ? seg.media_items : [];
          const mediaItem = mediaItems[ctx.mediaIndex];
          if (mediaItem) {
            mediaItem.timecode = text;
            mediaItem.updated_at = new Date().toISOString();

            if (seg.media && seg.media.path === mediaItem.path) {
              seg.media.timecode = text;
            }

            await botContext.writeScrape(freshScrape);

            await callApi(token, "deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => null);

            // Refresh the card if it's the active one
            if (ctx.segmentId === currentSession.activeSegmentId) {
              await sendOrEditCard(token, currentSession, freshScrape, seg);
            }
            return;
          }
        }
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: "❌ Не удалось сохранить таймкод: файл больше не найден."
        });
        return;
      } catch (err) {
        console.error("[bot] failed to save timecode:", err.message);
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: `❌ Не удалось сохранить таймкод: ${err.message}`
        });
        return;
      }
    }
  }

  if (currentSession.remotionCtx?.awaitField && !text.startsWith("/")) {
    const ctx = currentSession.remotionCtx;
    const field = ctx.awaitField;
    const draft = ctx.draft || defaultRemotionDraft();
    const value = text.trim();
    if (ctx.promptMessageId) {
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: ctx.promptMessageId }).catch(() => null);
    }
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(() => null);
    if (field === "quote") {
      draft.props.quote = value;
      draft.props.title = value;
    } else if (field === "author") {
      draft.props.author = value;
    } else if (field === "role") {
      draft.props.role = value;
    } else if (field === "date") {
      draft.props.date = value;
      draft.props.meta = value;
    } else if (field === "background") {
      draft.props.background = value ? { image: value, dim: 0.62, blur: 0 } : { dim: 0.7 };
    } else if (field === "logo") {
      if (/^https?:\/\//i.test(value) || /\.(png|jpe?g|webp|svg)$/i.test(value) || value.includes("/")) {
        draft.props.logoIcon = value;
        draft.logoChoices = [];
      } else {
        const files = await botContext.listLogoFiles(value, 12).catch(() => []);
        draft.logoQuery = value;
        draft.logoChoices = files;
        if (!files.length) {
          draft.props.source = value || draft.props.source;
          draft.props.logoIcon = "";
        }
      }
    }
    currentSession.remotionCtx = { ...ctx, draft, awaitField: null, promptMessageId: null };
    await saveSession(botContext.DATA_DIR, currentSession);
    await showRemotionPanel(token, chatId, ctx.panelMessageId || null).catch(() => null);
    return;
  }

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: [
        "<b>Привет! Я бот UContent.</b> 🤖",
        "",
        "Я готов транслировать сценарии Notion прямо сюда.",
        "<b>Команды:</b>",
        "• /sdvg — открыть текущий сценарий",
        "• /sdvg &lt;scrape_id&gt; — открыть конкретный сценарий",
        "• /sdvgmax — режим только /указаний (сегменты со слэшем)",
        "• /screenshotlab — режим только ссылок для скриншотов",
        "• /notion — обновить активный сценарий из Notion",
        "• /download — качать ссылки в unsorted без SDVG",
        "• /app — открыть активный сценарий в веб-приложении",
        "• /remotion — сгенерировать Remotion-карточку",
        "• /xml — скачать XML активного сценария",
        "• /figma — список всех тем активного сценария",
        "• /figmamin — только названия тем",
        "• /status — показать текущее состояние сессии",
        "",
        "💡 Текстовое сообщение при активном сегменте создаёт новый сегмент-указание.",
        "Также вы можете нажать кнопку <b>TG</b> в веб-интерфейсе UContent, чтобы отправить нужный сценарий сюда."
      ].join("\n"),
      parse_mode: "HTML"
    });
    return;
  }

  if (text.startsWith("/remotion")) {
    const inlineText = text.replace(/^\/remotion(?:@\w+)?\s*/i, "").trim();
    currentSession.remotionCtx = {
      chatId,
      draft: defaultRemotionDraft(inlineText),
      awaitField: null,
      promptMessageId: null,
      createdAt: new Date().toISOString()
    };
    await saveSession(botContext.DATA_DIR, currentSession);
    if (!inlineText) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: remotionHelpText(), parse_mode: "HTML" }).catch(() => null);
    }
    await showRemotionPanel(token, chatId);
    return;
  }

  if (text.startsWith("/app")) {
    const webAppUrl = botContext?.getWebAppUrl?.(currentSession.scrapeId || "") || "";
    if (!webAppUrl) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Веб-приложение ещё запускается. Попробуйте /app через несколько секунд."
      });
      return;
    }
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: currentSession.scrapeId ? "Открыть активный сценарий:" : "Открыть UContent:",
      reply_markup: { inline_keyboard: [[{ text: "📋 Открыть сценарий", url: webAppUrl }]] }
    });
    return;
  }

  if (text.startsWith("/status")) {
    if (!currentSession.scrapeId) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Нет активной сессии сценария. Начните с команды /sdvg или кнопки TG в веб-интерфейсе."
      });
      return;
    }
    try {
      const scrape = await botContext.readScrape(currentSession.scrapeId);
      const undoneCount = (scrape.segments || []).filter((s) => !s.is_done).length;
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: [
          `<b>Активный сценарий:</b> ${scrape.title}`,
          `<b>ID:</b> <code>${scrape.id}</code>`,
          `<b>Осталось сегментов:</b> ${undoneCount} из ${(scrape.segments || []).length}`,
          `<b>Режим:</b> ${currentSession.screenshotLabMode ? "📸 Screenshot Lab" : currentSession.randomMode ? "🎲 Случайно" : "📚 По порядку"}`
        ].join("\n"),
        parse_mode: "HTML"
      });
    } catch {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Ошибка при загрузке данных активного сценария."
      });
    }
    return;
  }

  if (text.startsWith("/notion")) {
    if (!currentSession.scrapeId) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Нет активного сценария. Сначала открой /sdvg или нажми TG в веб-интерфейсе."
      });
      return;
    }
    const statusMsg = await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "Refreshing Notion..."
    });
    try {
      const result = await botContext.refreshScrapeFromNotion(currentSession.scrapeId);
      const scrape = result.scrape;
      const activeStillExists = (scrape.segments || []).some((segment) => segment.id === currentSession.activeSegmentId);
      const nextSegment = activeStillExists
        ? (scrape.segments || []).find((segment) => segment.id === currentSession.activeSegmentId)
        : findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode, currentSession.sdvgMaxMode, currentSession.screenshotLabMode);
      currentSession.scrapeId = scrape.id;
      currentSession.activeSegmentId = nextSegment?.id || null;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: `Notion refreshed: ${scrape.title || scrape.id}\nLines: ${String(scrape.content ?? "").split(/\r?\n/).length}\nSegments: ${(scrape.segments || []).length}`
      }).catch(() => null);
      if (nextSegment) {
        await sendOrEditCard(token, currentSession, scrape, nextSegment);
      }
    } catch (error) {
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: `Notion refresh failed: ${error.message}`
      }).catch(() => null);
    }
    return;
  }

  if (text.startsWith("/xml")) {
    await sendActiveScrapeXml(token, chatId);
    return;
  }

  if (text.startsWith("/figmamin")) {
    await sendActiveScrapeFigmaThemes(token, chatId, true);
    return;
  }

  if (text.startsWith("/figma")) {
    await sendActiveScrapeFigmaThemes(token, chatId);
    return;
  }

  if (text.startsWith("/download")) {
    const arg = text.split(/\s+/)[1]?.toLowerCase() || "";
    const enable = !["off", "stop", "0", "false"].includes(arg);
    currentSession.downloadMode = enable;
    if (enable) {
      currentSession.sdvgActive = false;
      currentSession.activeSegmentId = null;
      currentSession.messageId = null;
      currentSession.sdvgMaxMode = false;
      currentSession.screenshotLabMode = false;
    }
    await saveSession(botContext.DATA_DIR, currentSession);
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: enable
        ? "Режим скачивания включен. Присылайте ссылки: я скачаю их в unsorted и отправлю файлы обратно."
        : "Режим скачивания выключен."
    });
    return;
  }

  if (text.startsWith("/screenshotlab")) {
    const args = text.split(/\s+/).slice(1);
    const scrapeId = args[0] || currentSession.scrapeId || "";
    try {
      const scrape = await botContext.readScrape(scrapeId);
      currentSession.scrapeId = scrape.id;
      currentSession.messageId = null;
      currentSession.downloadMode = false;
      currentSession.sdvgMaxMode = false;
      currentSession.screenshotLabMode = true;
      currentSession.sdvgActive = true;
      setNotionBaseline(currentSession, scrape);

      const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, false, false, true);
      if (!nextSegment) {
        currentSession.activeSegmentId = null;
        await saveSession(botContext.DATA_DIR, currentSession);
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: `В сценарии <b>${escapeHtml(scrape.title || scrape.id)}</b> нет незавершённых сегментов со ссылками.`,
          parse_mode: "HTML"
        });
        return;
      }

      currentSession.activeSegmentId = nextSegment.id;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `📸 <b>Screenshot Lab</b>\nТолько ссылки из сценария: <code>${escapeHtml(scrape.id)}</code>`,
        parse_mode: "HTML"
      }).catch(() => null);
      await sendOrEditCard(token, currentSession, scrape, nextSegment);
    } catch (error) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `Не удалось открыть Screenshot Lab: ${error.message}`
      });
    }
    return;
  }

  if (text.startsWith("/sdvgmax") || text.startsWith("/sdvg")) {
    const isMax = text.startsWith("/sdvgmax");
    const args = text.split(/\s+/).slice(1);
    let scrapeId = args[0] || "";
    try {
      const scrape = await botContext.readScrape(scrapeId);
      currentSession.scrapeId = scrape.id;
      currentSession.messageId = null;
      currentSession.downloadMode = false;
      currentSession.sdvgMaxMode = isMax;
      currentSession.screenshotLabMode = false;
      currentSession.sdvgActive = true;
      setNotionBaseline(currentSession, scrape);
      
      const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode, isMax, false);
      if (!nextSegment) {
        const modeLabel = isMax ? " со слэшем" : "";
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: `🎉 Все сегменты${modeLabel} в сценарии <b>${scrape.title}</b> выполнены!`,
          parse_mode: "HTML"
        });
        currentSession.activeSegmentId = null;
        await saveSession(botContext.DATA_DIR, currentSession);
        return;
      }
      
      currentSession.activeSegmentId = nextSegment.id;
      await saveSession(botContext.DATA_DIR, currentSession);
      await sendOrEditCard(token, currentSession, scrape, nextSegment);
    } catch (error) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `Не удалось загрузить сценарий: ${error.message}`
      });
    }
    return;
  }

  const url = firstUrl;
  if (messageUrls.length && currentSession.downloadMode) {
    await enqueueUnsortedDownloads(token, chatId, messageUrls, message.message_id);
    return;
  }

  if (messageUrls.length && !currentSession.activeSegmentId) {
    return;
  }

  if (url && currentSession.scrapeId && currentSession.activeSegmentId) {
    try {
      const downloadUrl = normalizeVkDownloadUrl(url);
      const scrape = await botContext.readScrape(currentSession.scrapeId);
      const segmentIndex = (scrape.segments || []).findIndex((s) => s.id === currentSession.activeSegmentId);
      if (segmentIndex >= 0) {
        const segment = scrape.segments[segmentIndex];
        if (isVkDownloadUrl(downloadUrl) || isYtDlpCandidateUrl(downloadUrl)) {
          await processDownload(token, chatId, scrape, segment, segmentIndex, downloadUrl);
        } else {
          await startScreenshotPreview(token, chatId, scrape, segment, segmentIndex, url);
        }
      }
    } catch (error) {
      console.error("[bot] error processing text link:", error.message);
    }
    return;
  }

  // If a segment is active, and the message is plain text, create a new segment starting with /
  if (currentSession.scrapeId && currentSession.activeSegmentId) {
    try {
      const scrape = await botContext.readScrape(currentSession.scrapeId);
      const segmentIndex = (scrape.segments || []).findIndex((s) => s.id === currentSession.activeSegmentId);
      if (segmentIndex >= 0) {
        const segment = scrape.segments[segmentIndex];
        
        let directionText = text;
        if (!directionText.startsWith("/")) {
          directionText = `/${directionText}`;
        }
        
        const newSegment = {
          id: `seg_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`,
          text: directionText,
          topic: segment.topic || "unsorted",
          is_done: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        
        scrape.segments.splice(segmentIndex + 1, 0, newSegment);
        await botContext.writeScrape(scrape);
        
        currentSession.activeSegmentId = newSegment.id;
        await saveSession(botContext.DATA_DIR, currentSession);
        
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: `➕ Добавлен сегмент в тему <b>${segment.topic || "unsorted"}</b>:`,
          parse_mode: "HTML"
        });
        
        await sendOrEditCard(token, currentSession, scrape, newSegment);
        return;
      }
    } catch (error) {
      console.error("[bot] error creating direction segment:", error.message);
    }
  }

  await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: "Пришлите ссылку — я скачаю медиа в unsorted. Команды: /sdvg, /download, /status, /help."
  }).catch(() => null);
}

/**
 * Handles inline button callbacks
 */
async function handleCallbackQuery(token, callbackQuery) {
  const callbackQueryId = callbackQuery.id;
  const callbackId = callbackQueryId; // alias
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const callbackMessageId = callbackQuery.message.message_id;

  if (currentSession.chatId !== chatId) {
    currentSession.chatId = chatId;
    await saveSession(botContext.DATA_DIR, currentSession);
  }

  // Acknowledge callback query (skipped for sdvg:shot:* which answer themselves)
  if (!data.startsWith("sdvg:shot:")) {
    await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId }).catch(() => null);
  }

  if (data === "noop") {
    return;
  }

  if (data === "sdvg:downloaded") {
    await callApi(token, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Уже скачано",
      show_alert: false
    }).catch(() => null);
    return;
  }

  if (data === "sdvg:clear_buttons") {
    await callApi(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: callbackMessageId,
      reply_markup: { inline_keyboard: [] }
    }).catch(() => null);
    return;
  }

  if (data.startsWith("sdvg:snap:")) {
    const targetId = data.slice("sdvg:snap:".length);
    const target = (currentSession.screenshotTargets || []).find((item) => item?.id === targetId);
    if (!target) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Ссылка для скриншота больше не найдена."
      }).catch(() => null);
      return;
    }
    const statusMsg = await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `📸 Делаю скриншот: <code>${escapeHtml(hostLabelForFileName(target.url))}</code>`,
      parse_mode: "HTML"
    });
    try {
      await sendStandaloneScreenshot(token, chatId, target.url);
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => null);
    } catch (error) {
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: `Не удалось сделать скриншот: ${error.message}`
      }).catch(() => null);
    }
    return;
  }

  if (data.startsWith("sdvg:remotion:")) {
    const action = data.slice("sdvg:remotion:".length);
    const ctx = currentSession.remotionCtx || null;
    if (action.startsWith("font:")) {
      const [, renderId, direction] = action.match(/^font:([^:]+):([+-])$/) || [];
      const target = (currentSession.remotionRenders || []).find((item) => item?.id === renderId);
      if (!target?.body) {
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Рендер устарел.", show_alert: true }).catch(() => null);
        return;
      }
      const nextBody = JSON.parse(JSON.stringify(target.body));
      const currentScale = Number(nextBody.props?.textScale || 1) || 1;
      nextBody.props.textScale = Math.max(0.72, Math.min(1.38, currentScale + (direction === "+" ? 0.08 : -0.08)));
      await renderTelegramRemotionBody(token, chatId, nextBody).catch(() => null);
      return;
    }
    if (!ctx?.draft) {
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Панель Remotion устарела.", show_alert: true }).catch(() => null);
      return;
    }
    const draft = ctx.draft;
    if (action === "close") {
      currentSession.remotionCtx = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: callbackMessageId }).catch(() => null);
      return;
    }
    if (action === "render") {
      if (!String(draft.props?.quote || "").trim()) {
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Сначала заполните цитату.", show_alert: true }).catch(() => null);
        return;
      }
      await renderTelegramRemotionBody(token, chatId, { format: draft.format, props: draft.props }).catch(() => null);
      return;
    }
    if (action.startsWith("field:")) {
      const field = action.slice("field:".length);
      const previousPrompt = ctx.promptMessageId;
      if (previousPrompt) await callApi(token, "deleteMessage", { chat_id: chatId, message_id: previousPrompt }).catch(() => null);
      const prompt = await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: remotionPromptForField(field)
      }).catch(() => null);
      currentSession.remotionCtx = { ...ctx, awaitField: field, promptMessageId: prompt?.message_id || null, panelMessageId: callbackMessageId };
      await saveSession(botContext.DATA_DIR, currentSession);
      return;
    }
    if (action.startsWith("shape:")) {
      const shape = REMOTION_SHAPE_OPTIONS.includes(action.slice("shape:".length)) ? action.slice("shape:".length) : "1x1";
      const parts = remotionFormatParts(draft.format);
      draft.format = remotionFormatFromParts({ ...parts, shape });
      draft.props.type = draft.format.startsWith("news-") ? "news" : "quote";
      currentSession.remotionCtx = { ...ctx, draft, panelMessageId: callbackMessageId };
      await showRemotionPanel(token, chatId, callbackMessageId);
      return;
    }
    if (action.startsWith("output:")) {
      const output = action.slice("output:".length);
      const safeOutput = ["mp4", "alpha", "alpha-mov"].includes(output) ? output : "mp4";
      const parts = remotionFormatParts(draft.format);
      draft.format = remotionFormatFromParts({ ...parts, output: safeOutput });
      draft.props.type = draft.format.startsWith("news-") ? "news" : "quote";
      currentSession.remotionCtx = { ...ctx, draft, panelMessageId: callbackMessageId };
      await showRemotionPanel(token, chatId, callbackMessageId);
      return;
    }
    if (action === "cycle:layout") {
      const index = REMOTION_LAYOUT_OPTIONS.indexOf(String(draft.props.layout || "Left"));
      draft.props.layout = REMOTION_LAYOUT_OPTIONS[(index + 1 + REMOTION_LAYOUT_OPTIONS.length) % REMOTION_LAYOUT_OPTIONS.length];
      currentSession.remotionCtx = { ...ctx, draft, panelMessageId: callbackMessageId };
      await showRemotionPanel(token, chatId, callbackMessageId);
      return;
    }
    if (action.startsWith("logo:")) {
      const index = Number.parseInt(action.slice("logo:".length), 10);
      const file = Number.isFinite(index) ? draft.logoChoices?.[index] : null;
      if (!file?.path) {
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Логотип не найден.", show_alert: true }).catch(() => null);
        return;
      }
      draft.props.logoIcon = file.path;
      draft.props.source = logoLabel(file) || draft.props.source;
      draft.logoChoices = [];
      currentSession.remotionCtx = { ...ctx, draft, panelMessageId: callbackMessageId };
      await showRemotionPanel(token, chatId, callbackMessageId);
      return;
    }
    if (action === "logoText") {
      draft.props.source = draft.logoQuery || draft.props.source;
      draft.props.logoIcon = "";
      draft.logoChoices = [];
      currentSession.remotionCtx = { ...ctx, draft, panelMessageId: callbackMessageId };
      await showRemotionPanel(token, chatId, callbackMessageId);
      return;
    }
  }

  if (data.startsWith("sdvg:logo:")) {
    const action = data.slice("sdvg:logo:".length);
    const ctx = currentSession.logoPickCtx || null;
    if (action === "noop") return;
    if (action === "close") {
      currentSession.logoPickCtx = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: callbackMessageId }).catch(() => null);
      return;
    }
    if (!ctx) {
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Поиск логотипов устарел.", show_alert: true }).catch(() => null);
      return;
    }
    if (action.startsWith("page:")) {
      const page = Math.max(0, Number.parseInt(action.slice("page:".length), 10) || 0);
      await showLogoPicker(token, chatId, ctx.query || "", page, callbackMessageId);
      return;
    }
    if (action.startsWith("sel:")) {
      const index = Number.parseInt(action.slice("sel:".length), 10);
      const file = Number.isFinite(index) ? ctx.files?.[index] : null;
      if (!file?.path) {
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Логотип больше не найден.", show_alert: true }).catch(() => null);
        return;
      }
      currentSession.remotionDefaults = {
        ...(currentSession.remotionDefaults || {}),
        logoIcon: String(file.path || "").trim(),
        source: logoLabel(file) || String(file.name || "").replace(/\.[^.]+$/, "")
      };
      currentSession.logoPickCtx = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: callbackMessageId,
        text: `Логотип выбран для Remotion:\n<b>${escapeHtml(currentSession.remotionDefaults.source)}</b>\n<code>${escapeHtml(currentSession.remotionDefaults.logoIcon)}</code>\n\nТеперь можно вызвать <code>/remotion текст</code> или отправить расширенную форму.`,
        parse_mode: "HTML"
      }).catch(() => null);
      return;
    }
  }

  if (data.startsWith("sdvg:folder:")) {
    const action = data.slice("sdvg:folder:".length);
    try {
      if (action === "noop") return;

      if (action.startsWith("open:")) {
        const targetId = action.slice("open:".length);
        const target = (currentSession.renameTargets || []).find((item) => item?.id === targetId);
        if (!target) {
          await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Файл больше не найден.", show_alert: true }).catch(() => null);
          return;
        }
        const themes = await listMediaTopicFolders();
        const currentFolder = currentFolderFromRelPath(target.path);
        const context = {
          targetId,
          themes,
          currentFolder,
          page: 0
        };
        rememberFolderMoveContext(callbackMessageId, context);
        await saveSession(botContext.DATA_DIR, currentSession);
        await callApi(token, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: callbackMessageId,
          reply_markup: buildFolderPickerMarkup(context)
        }).catch(() => null);
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId }).catch(() => null);
        return;
      }

      const context = getFolderMoveContext(callbackMessageId);
      if (!context?.targetId) {
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Выбор папки устарел.", show_alert: true }).catch(() => null);
        return;
      }
      const target = (currentSession.renameTargets || []).find((item) => item?.id === context.targetId);
      if (!target) {
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Файл больше не найден.", show_alert: true }).catch(() => null);
        return;
      }

      if (action === "close") {
        await callApi(token, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: callbackMessageId,
          reply_markup: renameButtonMarkup(context.targetId)
        }).catch(() => null);
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId }).catch(() => null);
        return;
      }

      if (action === "new") {
        const previous = clearFolderCreateCtx();
        if (previous?.promptMessageId) {
          await callApi(token, "deleteMessage", { chat_id: chatId, message_id: previous.promptMessageId }).catch(() => null);
        }
        const prompt = await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: "Введите название новой папки/темы"
        }).catch(() => null);
        currentSession.folderCreateCtx = {
          controlMessageId: callbackMessageId,
          promptMessageId: prompt?.message_id || null,
          targetId: context.targetId,
          createdAt: new Date().toISOString()
        };
        await saveSession(botContext.DATA_DIR, currentSession);
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId }).catch(() => null);
        return;
      }

      if (action.startsWith("page:")) {
        const page = Math.max(0, Number.parseInt(action.slice("page:".length), 10) || 0);
        const nextContext = { ...context, page };
        rememberFolderMoveContext(callbackMessageId, nextContext);
        await saveSession(botContext.DATA_DIR, currentSession);
        await callApi(token, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: callbackMessageId,
          reply_markup: buildFolderPickerMarkup(nextContext)
        }).catch(() => null);
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId }).catch(() => null);
        return;
      }

      if (action.startsWith("sel:")) {
        const index = Number.parseInt(action.slice("sel:".length), 10);
        const themes = Array.isArray(context.themes) && context.themes.length ? context.themes : await listMediaTopicFolders();
        const selectedTheme = themes[index] || "";
        if (!selectedTheme) {
          await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Папка не найдена.", show_alert: true }).catch(() => null);
          return;
        }
        const result = target.isGroup
          ? await moveMediaGroupEverywhere(target, selectedTheme)
          : await moveMediaFileEverywhere(target, selectedTheme);
        const firstResult = Array.isArray(result) ? result[0] : result;
        const confirmedInFolder = await movedResultsConfirmedInFolder(result, selectedTheme);
        if (confirmedInFolder && firstResult) {
          await updateRenamedTelegramMessage(token, chatId, { messageId: callbackMessageId, chatId }, target, firstResult, { folderName: selectedTheme }).catch(() => false);
        }
        const nextContext = {
          ...context,
          themes: await listMediaTopicFolders(),
          currentFolder: selectedTheme
        };
        rememberFolderMoveContext(callbackMessageId, nextContext);
        await saveSession(botContext.DATA_DIR, currentSession);
        await callApi(token, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: callbackMessageId,
          reply_markup: renameButtonMarkup(context.targetId)
        }).catch(() => null);
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: `Сохранено в ${selectedTheme}` }).catch(() => null);
        return;
      }
    } catch (error) {
      await callApi(token, "answerCallbackQuery", {
        callback_query_id: callbackId,
        text: clipLabel(`Не удалось сохранить в папку: ${error.message}`, 180),
        show_alert: true
      }).catch(() => null);
      return;
    }
  }

  if (data.startsWith("sdvg:trim:start:")) {
    const targetId = data.slice("sdvg:trim:start:".length);
    const target = (currentSession.renameTargets || []).find((item) => item?.id === targetId);
    if (!target) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "Видео для обрезки больше не найдено." });
      return;
    }
    try {
      target.menuMessageId = callbackMessageId;
      await startManualTrim(token, chatId, target);
    } catch (error) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: `Не удалось открыть ручную обрезку: ${error.message}` });
    }
    return;
  }

  if (data.startsWith("sdvg:trim:set:")) {
    const [, , , jobId, rawIndex, field] = data.split(":");
    const index = Number(rawIndex);
    const job = currentSession.trimJobs?.[jobId];
    if (!job || !job.segments?.[index] || !["start", "end"].includes(field)) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "Сессия ручной обрезки устарела." });
      return;
    }
    const prompt = await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `Введите ${field === "start" ? "начало" : "конец"} фрагмента ${index + 1} в формате <code>ММ:СС</code> или <code>ЧЧ:ММ:СС</code>.`,
      parse_mode: "HTML"
    });
    currentSession.trimInputCtx = { jobId, index, field, promptMessageId: prompt.message_id };
    await saveSession(botContext.DATA_DIR, currentSession);
    return;
  }

  if (data.startsWith("sdvg:trim:add:")) {
    const jobId = data.slice("sdvg:trim:add:".length);
    const job = currentSession.trimJobs?.[jobId];
    if (!job) return;
    job.segments.push({ start: 0, end: job.duration });
    await saveSession(botContext.DATA_DIR, currentSession);
    await updateTrimMessage(token, chatId, job).catch(() => null);
    return;
  }

  if (data.startsWith("sdvg:trim:del:")) {
    const [, , , jobId, rawIndex] = data.split(":");
    const index = Number(rawIndex);
    const job = currentSession.trimJobs?.[jobId];
    if (!job || !job.segments?.[index]) return;
    if (job.segments.length === 1) job.segments[0] = { start: 0, end: job.duration };
    else job.segments.splice(index, 1);
    await saveSession(botContext.DATA_DIR, currentSession);
    await updateTrimMessage(token, chatId, job).catch(() => null);
    return;
  }

  if (data.startsWith("sdvg:trim:back:")) {
    const targetId = data.slice("sdvg:trim:back:".length);
    const target = (currentSession.renameTargets || []).find((item) => item?.id === targetId);
    if (target) await sendCutModeMenu(token, chatId, target);
    return;
  }

  if (data.startsWith("sdvg:trim:done:")) {
    const jobId = data.slice("sdvg:trim:done:".length);
    const job = currentSession.trimJobs?.[jobId];
    if (!job?.segments?.length) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "Добавьте хотя бы один фрагмент." });
      return;
    }
    const status = await callApi(token, "sendMessage", { chat_id: chatId, text: "✂️ Собираю выбранные фрагменты..." });
    try {
      const outputPath = await exportManualTrim(job);
      const stats = await fs.stat(outputPath);
      const outputName = path.basename(outputPath);
      const outputRelPath = mediaRelPathFromAbsolute(outputPath);
      await botContext.upsertMediaMetadata?.(outputRelPath, {
        derivation: "trim",
        source_url: job.sourceUrl,
        parent_path: job.relPath,
        size: stats.size
      });
      await archiveParentMediaFile(job.relPath);
      const renameId = rememberRenameTarget(outputRelPath, "", -1, job.sourceUrl);
      await saveSession(botContext.DATA_DIR, currentSession);
      const sentMessage = await sendLocalMedia(token, {
        chat_id: chatId,
        caption: buildReturnedMediaCaption({
          fileName: outputName,
          sourceUrl: job.sourceUrl,
          sizeBytes: stats.size,
          metadata: { webpage_url: job.sourceUrl }
        }),
        parse_mode: "HTML",
        reply_markup: renameButtonMarkup(renameId)
      }, outputPath, safeSendFileNameFromMetadata(outputName, job.sourceUrl, { webpage_url: job.sourceUrl }, "cut"));
      if (sentMessage?.message_id && attachRenameTargetMessage(renameId, chatId, sentMessage.message_id)) {
        await saveSession(botContext.DATA_DIR, currentSession);
      }
      await deleteTelegramMessages(token, chatId, [
        ...(Array.isArray(job.cleanupMessageIds) ? job.cleanupMessageIds : []),
        status.message_id
      ]);
      delete currentSession.trimJobs?.[jobId];
      await saveSession(botContext.DATA_DIR, currentSession);
    } catch (error) {
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: status.message_id,
        text: `Не удалось обрезать видео: ${error.message}`
      }).catch(() => null);
    }
    return;
  }

  if (data.startsWith("sdvg:cut:nav:")) {
    const [, , , jobId, rawDelta] = data.split(":");
    const delta = Number(rawDelta);
    const cut = currentSession.cutJobs?.[jobId];
    if (!cut || !Number.isFinite(delta)) {
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Сессия нарезки устарела.", show_alert: true }).catch(() => null);
      return;
    }
    const job = JSON.parse(await fs.readFile(cut.jobPath, "utf8"));
    const total = Array.isArray(job.clusters) ? job.clusters.length : 0;
    if (!total) return;
    cut.page = (Number(cut.page || 0) + delta + total) % total;
    await saveSession(botContext.DATA_DIR, currentSession);
    await updateCutPreviewMessage(token, chatId, jobId).catch(async (error) => {
      await callApi(token, "sendMessage", { chat_id: chatId, text: `Не удалось обновить превью: ${error.message}` }).catch(() => null);
    });
    return;
  }

  if (data.startsWith("sdvg:cut:mark:")) {
    const [, , , jobId, rawIndex, decision] = data.split(":");
    const index = Number(rawIndex);
    const cut = currentSession.cutJobs?.[jobId];
    if (!cut || !Number.isInteger(index) || !["cut", "keep"].includes(decision)) {
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: "Сессия нарезки устарела.", show_alert: true }).catch(() => null);
      return;
    }
    cut.decisions = cut.decisions && typeof cut.decisions === "object" ? cut.decisions : {};
    cut.decisions[String(index)] = decision;
    const job = JSON.parse(await fs.readFile(cut.jobPath, "utf8"));
    const clusters = Array.isArray(job.clusters) ? job.clusters : [];
    const currentPos = clusters.findIndex((cluster) => Number(cluster.index) === index);
    const undecided = clusters.find((cluster) => !cut.decisions[String(cluster.index)]);
    cut.page = undecided ? clusters.findIndex((cluster) => Number(cluster.index) === Number(undecided.index)) : Math.max(0, currentPos);
    await saveSession(botContext.DATA_DIR, currentSession);
    await updateCutPreviewMessage(token, chatId, jobId).catch(() => null);
    if (undecided) {
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: decision === "cut" ? "Вырезать" : "Оставить" }).catch(() => null);
      return;
    }
    const statusMsg = await callApi(token, "sendMessage", { chat_id: chatId, text: "Все кадры выбраны. Рендерю видео..." });
    try {
      const outputPath = await exportTelegramCutJob(token, chatId, jobId);
      const stats = await fs.stat(outputPath).catch(() => null);
      const sendName = path.basename(outputPath);
      const outputRelPath = mediaRelPathFromAbsolute(outputPath);
      await botContext.upsertMediaMetadata?.(outputRelPath, {
        derivation: "video_cutter",
        source_url: cut.sourceUrl,
        parent_path: cut.relPath,
        size: stats?.size || 0
      });
      await archiveParentMediaFile(cut.relPath);
      const renameId = rememberRenameTarget(outputRelPath, "", -1, cut.sourceUrl);
      await saveSession(botContext.DATA_DIR, currentSession);
      const sentMessage = await sendLocalMedia(token, {
        chat_id: chatId,
        caption: buildReturnedMediaCaption({
          fileName: sendName,
          sourceUrl: cut.sourceUrl,
          sizeBytes: stats?.size || 0,
          metadata: { webpage_url: cut.sourceUrl }
        }),
        parse_mode: "HTML",
        reply_markup: renameButtonMarkup(renameId)
      }, outputPath, safeSendFileNameFromMetadata(sendName, cut.sourceUrl, { webpage_url: cut.sourceUrl }, "cut"));
      if (sentMessage?.message_id && attachRenameTargetMessage(renameId, chatId, sentMessage.message_id)) {
        await saveSession(botContext.DATA_DIR, currentSession);
      }
      await deleteTelegramMessages(token, chatId, [
        ...(Array.isArray(cut.cleanupMessageIds) ? cut.cleanupMessageIds : []),
        cut.introMessageId,
        cut.messageId,
        statusMsg.message_id
      ]);
      delete currentSession.cutJobs?.[jobId];
      await saveSession(botContext.DATA_DIR, currentSession);
    } catch (error) {
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: `Не удалось собрать видео: ${error.message}`
      }).catch(() => null);
    }
    return;
  }

  if (data.startsWith("sdvg:cut:scene:")) {
    const targetId = data.slice("sdvg:cut:scene:".length);
    const target = (currentSession.renameTargets || []).find((item) => item?.id === targetId);
    if (!target) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Файл для нарезки больше не найден. Пришлите или выберите файл заново."
      }).catch(() => null);
      return;
    }
    const statusMsg = await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `✂️ Анализирую видео: <code>${escapeHtml(path.basename(target.path))}</code>`,
      parse_mode: "HTML"
    });
    try {
      const cut = await analyzeVideoForTelegramCut(target.path, target.sourceUrl);
      const sessionCut = currentSession.cutJobs?.[cut.jobId];
      if (sessionCut) {
        sessionCut.cleanupMessageIds = [
          ...(Array.isArray(sessionCut.cleanupMessageIds) ? sessionCut.cleanupMessageIds : []),
          callbackMessageId,
          statusMsg.message_id
        ].filter(Boolean);
      }
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: "✂️ Анализ готов, присылаю превью."
      }).catch(() => null);
      await sendCutPreviewMessages(token, chatId, cut);
    } catch (error) {
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: `Не удалось открыть нарезку: ${error.message}`
      }).catch(() => null);
    }
    return;
  }

  if (data.startsWith("sdvg:cut:")) {
    const targetId = data.slice("sdvg:cut:".length);
    const target = (currentSession.renameTargets || []).find((item) => item?.id === targetId);
    if (!target) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Файл для нарезки больше не найден. Пришлите или выберите файл заново."
      }).catch(() => null);
      return;
    }
    await sendCutModeMenu(token, chatId, target);
    return;
  }

  if (data.startsWith("sdvg:rename:")) {
    const targetId = data.slice("sdvg:rename:".length);
    const target = (currentSession.renameTargets || []).find((item) => item?.id === targetId);
    if (!target) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Файл для переименования больше не найден. Пришлите или выберите файл заново."
      }).catch(() => null);
      return;
    }
    const promptMsg = await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: target.isGroup
        ? `✏️ Пришлите новое общее имя для ${target.paths.length} файлов.\nРасширения сохранятся, к именам добавятся постфиксы <code>_1</code>, <code>_2</code> и т.д.`
        : `✏️ Пришлите новое имя файла.\nТекущий файл: <code>${escapeHtml(path.basename(target.path))}</code>\n\nМожно без расширения, тогда оно сохранится.`,
      parse_mode: "HTML"
    });
    currentSession.renameCtx = {
      targetId,
      path: target.path,
      paths: target.paths,
      isGroup: Boolean(target.isGroup),
      sourceUrl: target.sourceUrl || "",
      chatId,
      messageId: callbackMessageId,
      promptMessageId: promptMsg?.message_id ?? null
    };
    await saveSession(botContext.DATA_DIR, currentSession);
    return;
  }

  if (data.startsWith("sdvg:timecode:")) {
    const parts = data.split(":");
    const segmentId = parts[2];
    const mediaIndex = parseInt(parts[3] || "0", 10);

    let mediaName = "файла";
    let mediaPath = "";
    try {
      const freshScrape = await botContext.readScrape(currentSession.scrapeId);
      const seg = freshScrape.segments.find(s => s.id === segmentId);
      if (seg && seg.media_items && seg.media_items[mediaIndex]) {
        const mediaItem = seg.media_items[mediaIndex];
        mediaPath = String(mediaItem.path || mediaItem.url || "");
        mediaName = `"${mediaItem.name || path.basename(mediaPath) || "файл"}"`;
      }
    } catch {}

    if (!supportsTimecodeFilePath(mediaPath)) {
      await callApi(token, "answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: "Таймкод доступен только для видео и аудио",
        show_alert: true
      }).catch(() => null);
      return;
    }

    const promptMsg = await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `⏱️ <b>Установка таймкода</b>\n\nВведите таймкод для ${mediaName} (например, <code>01:23</code> или диапазон <code>01:20-01:35</code>):\n\nОтправьте <code>отмена</code> для выхода.`,
      parse_mode: "HTML"
    });

    currentSession.timecodeCtx = {
      segmentId,
      mediaIndex,
      promptMessageId: promptMsg?.message_id ?? null
    };
    await saveSession(botContext.DATA_DIR, currentSession);
    return;
  }

  if (!currentSession.scrapeId || !currentSession.activeSegmentId) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "\u041D\u0435\u0442 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0433\u043E \u0441\u0435\u0433\u043C\u0435\u043D\u0442\u0430. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u0443 /sdvg."
    });
    return;
  }

  let scrape, segmentIndex, segment;
  try {
    scrape = await botContext.readScrape(currentSession.scrapeId);
    segmentIndex = (scrape.segments || []).findIndex((s) => s.id === currentSession.activeSegmentId);
    if (segmentIndex < 0) {
      throw new Error("Сегмент не найден");
    }
    segment = scrape.segments[segmentIndex];
  } catch (error) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `Ошибка загрузки сегмента: ${error.message}`
    });
    return;
  }

  if (data === "sdvg:media:open") {
    await showMediaPicker(token, chatId, scrape, segment);
    return;
  }

  if (data.startsWith("sdvg:media:page:")) {
    const page = Number(data.split(":")[3] || "0");
    await showMediaPicker(token, chatId, scrape, segment, page, callbackMessageId);
    return;
  }

  if (data.startsWith("sdvg:media:add:")) {
    const mediaIndex = Number(data.split(":")[3] || "-1");
    await attachPickedMedia(token, chatId, mediaIndex, callbackMessageId);
    return;
  }

  if (data === "sdvg:media:close") {
    currentSession.mediaPickCtx = null;
    await saveSession(botContext.DATA_DIR, currentSession);
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: callbackMessageId }).catch(() => null);
    return;
  }

  if (data === "sdvg:media:noop") {
    return;
  }

  if (data === "sdvg:search") {
    await runTelegramSegmentSearch(token, chatId, scrape, segment);
    return;
  }

  if (data.startsWith("sdvg:search:add:")) {
    const resultIndex = Number(data.split(":")[3] || "-1");
    await addSearchResultToScrape(token, chatId, resultIndex, callbackMessageId);
    return;
  }

  if (data.startsWith("sdvg:search:drop:")) {
    const resultIndex = Number(data.split(":")[3] || "-1");
    await dropSearchResult(token, chatId, resultIndex, callbackMessageId);
    return;
  }

  if (data === "sdvg:search:close") {
    currentSession.searchCtx = null;
    await saveSession(botContext.DATA_DIR, currentSession);
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: callbackMessageId }).catch(() => null);
    return;
  }

  if (data === "sdvg:screenshotlab:off") {
    currentSession.screenshotLabMode = false;
    currentSession.messageId = callbackMessageId;
    await saveSession(botContext.DATA_DIR, currentSession);
    await sendOrEditCard(token, currentSession, scrape, segment);
    return;
  }

  if (data === "sdvg:toggle_mode") {
    currentSession.randomMode = !currentSession.randomMode;
    await saveSession(botContext.DATA_DIR, currentSession);
    await sendOrEditCard(token, currentSession, scrape, segment);
    return;
  }

  if (data === "sdvg:next") {
    const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode, currentSession.sdvgMaxMode, currentSession.screenshotLabMode);
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: callbackMessageId }).catch(() => null);
    if (!nextSegment || nextSegment.id === currentSession.activeSegmentId) {
      currentSession.activeSegmentId = null;
      currentSession.messageId = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Других незавершенных сегментов пока нет. Этот сегмент остался незавершенным и вернется позже."
      }).catch(() => null);
      return;
    }
    currentSession.activeSegmentId = nextSegment.id;
    currentSession.messageId = null;
    await saveSession(botContext.DATA_DIR, currentSession);
    await sendOrEditCard(token, currentSession, scrape, nextSegment);
    return;
  }

  if (data === "sdvg:done") {
    // Mark current as done
    scrape.segments[segmentIndex].is_done = true;
    scrape.segments[segmentIndex].updated_at = new Date().toISOString();
    await botContext.writeScrape(scrape);
    const refreshedSegment = scrape.segments[segmentIndex];
    const refreshedHasLink = refreshedSegment.type === "link" || !!extractFirstUrl(refreshedSegment.text);
    const refreshedDownloadState = await getSegmentDownloadState(refreshedSegment).catch(() => ({
      url: extractFirstUrl(refreshedSegment?.text || ""),
      downloadable: false,
      alreadyDownloaded: false
    }));
    const refreshedLinkState = { ...refreshedDownloadState, hasLink: refreshedHasLink };
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: currentSession.messageId,
      text: formatCardText(scrape, refreshedSegment, currentSession, refreshedLinkState),
      parse_mode: "HTML",
      reply_markup: buildCardMarkup(currentSession, refreshedSegment, refreshedLinkState)
    }).catch(() => null);

    const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode, currentSession.sdvgMaxMode, currentSession.screenshotLabMode);
    if (!nextSegment) {
      // Edit active card message to show final completed text
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `🎉 Все сегменты сценария <b>${scrape.title}</b> завершены!`,
        parse_mode: "HTML"
      }).catch(() => null);

      currentSession.activeSegmentId = null;
      currentSession.messageId = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      return;
    }

    currentSession.activeSegmentId = nextSegment.id;
    currentSession.messageId = null;
    await saveSession(botContext.DATA_DIR, currentSession);
    await sendOrEditCard(token, currentSession, scrape, nextSegment);
    return;
  }

  if (data === "sdvg:download") {
    const url = extractFirstUrl(segment.text);
    if (!url) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "В тексте сегмента не найдена ссылка для скачивания!" });
      return;
    }
    await processDownload(token, chatId, scrape, segment, segmentIndex, url);
    return;
  }

  if (data === "sdvg:screenshot:auto") {
    const url = extractFirstUrl(segment.text);
    if (!url) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "В тексте сегмента не найдена ссылка для скриншота!" });
      return;
    }
    await saveQuickSegmentScreenshot(token, chatId, scrape, segment, segmentIndex, url);
    return;
  }

  if (data === "sdvg:screenshot") {
    const url = extractFirstUrl(segment.text);
    if (!url) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "В тексте сегмента не найдена ссылка для скриншота!" });
      return;
    }
    await startScreenshotPreview(token, chatId, scrape, segment, segmentIndex, url);
    return;
  }

  // --- Screenshot adjustment callbacks ---
  if (data.startsWith("sdvg:shot:")) {
    const action = data.slice("sdvg:shot:".length);
    const ctx = currentSession.shotCtx;
    if (!ctx) {
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, text: "Контекст скриншота устарел.", show_alert: true }).catch(() => null);
      return;
    }

    const freshScrape = await botContext.readScrape(ctx.scrapeId);
    const seg = freshScrape.segments.find(s => s.id === ctx.segmentId);
    const safeTopic = botContext.sanitizeMediaTopicName((seg?.topic) || "unsorted");
    const { dir } = await botContext.ensureTopicDir(safeTopic);

    if (action === "drop") {
      currentSession.shotCtx = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: callbackMessageId }).catch(() => null);
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId }).catch(() => null);
      return;
    }

    // Profile mutations
    if (["format", "taller", "shorter", "zoomin", "zoomout", "scrolldown", "scrollup"].includes(action)) {
      const p = ctx.profile;
      const next =
        action === "format"  ? cycleShotFormat(p) :
        action === "taller"  ? normShotProfile({ ...p, height: Math.min(5120, p.height + 640) }) :
        action === "shorter" ? normShotProfile({ ...p, height: Math.max(240,  p.height - 640) }) :
        action === "zoomin"  ? normShotProfile({ ...p, zoom:   Math.min(800,  p.zoom   + 25)  }) :
        action === "zoomout" ? normShotProfile({ ...p, zoom:   Math.max(50,   p.zoom   - 25)  }) :
        action === "scrolldown" ? normShotProfile({ ...p, scroll: Math.min(20000, p.scroll + 200) }) :
                               normShotProfile({ ...p, scroll: Math.max(0,     p.scroll - 200) });
      if (shotProfileKey(next) === shotProfileKey(p)) {
        const tip =
          action === "taller" ? "Уже максимальная высота." :
          action === "shorter" ? "Уже минимальная высота." :
          action === "zoomin" ? "Макс. масштаб." :
          action === "zoomout" ? "Мин. масштаб." :
          action === "scrolldown" ? "Дальше прокрутить нельзя." :
          action === "scrollup" ? "Мы уже в самом верху." :
          "Форматы закончились.";
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, text: tip, show_alert: true }).catch(() => null);
        return;
      }

      // Update caption of the photo to show loading state
      await callApi(token, "editMessageCaption", {
        chat_id: chatId,
        message_id: callbackMessageId,
        caption: `📸 <b>Снимаю скриншот...</b>\n🖥 ${shotProfileLabel(next)}`,
        parse_mode: "HTML"
      }).catch(() => null);

      ctx.profile = next;
      await saveSession(botContext.DATA_DIR, currentSession);

      const tempPath = path.join(dir, `preview_adjust_${Date.now()}.png`);

      try {
        const buf = await captureScreenshot(ctx.url, next);
        await fs.writeFile(tempPath, buf);

        // Edit the photo and caption of the message live!
        await callApiMultipart(token, "editMessageMedia", {
          chat_id: chatId,
          message_id: callbackMessageId,
          media: {
            type: "photo",
            media: "attach://photo",
            caption: `📸 <b>Скриншот</b>\n${sourceSiteLinkHtml(ctx.url)}\n🖥 ${shotProfileLabel(next)}\n\nНастройте параметры и нажмите <b>+</b> для захвата.`,
            parse_mode: "HTML"
          },
          reply_markup: buildShotKeyboard()
        }, "photo", tempPath, "photo.png");

      } catch (err) {
        await callApi(token, "editMessageCaption", {
          chat_id: chatId,
          message_id: callbackMessageId,
          caption: `❌ Ошибка: ${err.message}\n🖥 ${shotProfileLabel(next)}`,
          parse_mode: "HTML",
          reply_markup: buildShotKeyboard()
        }).catch(() => null);
      } finally {
        await fs.unlink(tempPath).catch(() => null);
      }

      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId }).catch(() => null);
      return;
    }

    // Capture screenshot (+ or retry)
    if (action === "add" || action === "retry") {
      await callApi(token, "editMessageCaption", {
        chat_id: chatId,
        message_id: callbackMessageId,
        caption: `📸 <b>Сохраняю скриншот...</b>\n🖥 ${shotProfileLabel(ctx.profile)}`,
        parse_mode: "HTML"
      }).catch(() => null);
      
      try {
        const buf = await captureScreenshot(ctx.url, ctx.profile);
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
        const sfx   = Math.random().toString(36).slice(2, 8);
        const freshScrape = await botContext.readScrape(ctx.scrapeId);
        const segIdx = freshScrape.segments.findIndex(s => s.id === ctx.segmentId);
        
        if (segIdx !== -1) {
          const seg = freshScrape.segments[segIdx];
          const topic = botContext.sanitizeMediaTopicName((seg.topic) || "unsorted");
          const { dir: shotDir } = await botContext.ensureTopicDir(topic);
          const shotName = `shot_${stamp}_${sfx}.png`;
          const shotPath = path.join(shotDir, shotName);
          await fs.writeFile(shotPath, buf);
          const relPath = `${topic}/${shotName}`;
          const stats = await fs.stat(shotPath);
          const mediaItem = {
            path: relPath, name: shotName, topic,
            size: stats.size, updated_at: new Date().toISOString(),
            thumbnail: `/api/media/raw?path=${encodeURIComponent(relPath)}`
          };
          const items = seg.media_items || [];
          items.push(mediaItem);
          const mediaIndex = items.length - 1;
          freshScrape.segments[segIdx].media_items = items;
          freshScrape.segments[segIdx].media = freshScrape.segments[segIdx].media || items[0];
          freshScrape.segments[segIdx].updated_at = new Date().toISOString();
          await botContext.writeScrape(freshScrape);
          
          // Send final document to chat
          await sendLocalMedia(token, {
            chat_id: chatId,
            caption: `📸 <b>Скриншот</b>\n${sourceSiteLinkHtml(ctx.url)}\n🖥 ${shotProfileLabel(ctx.profile)}`,
            parse_mode: "HTML",
            reply_markup: renameButtonMarkup(rememberRenameTarget(relPath, seg.id, mediaIndex))
          }, shotPath, shotName);
          await saveSession(botContext.DATA_DIR, currentSession);
        }

        if (action === "add") {
          await sendOrEditCard(token, currentSession, freshScrape, freshScrape.segments.find(s => s.id === ctx.segmentId)).catch(() => null);
          currentSession.shotCtx = null;
          await saveSession(botContext.DATA_DIR, currentSession);
          await callApi(token, "deleteMessage", { chat_id: chatId, message_id: callbackMessageId }).catch(() => null);
        } else {
          // retry — keep keyboard, restore panel caption
          await callApi(token, "editMessageCaption", {
            chat_id: chatId,
            message_id: callbackMessageId,
            caption: `📸 <b>Скриншот</b>\n${sourceSiteLinkHtml(ctx.url)}\n🖥 ${shotProfileLabel(ctx.profile)}\n\nНастройте параметры и нажмите <b>+</b> для захвата.`,
            parse_mode: "HTML",
            reply_markup: buildShotKeyboard()
          }).catch(() => null);
        }
      } catch (err) {
        await callApi(token, "editMessageCaption", {
          chat_id: chatId,
          message_id: callbackMessageId,
          caption: `❌ Ошибка: ${err.message}\n🖥 ${shotProfileLabel(ctx.profile)}`,
          parse_mode: "HTML",
          reply_markup: buildShotKeyboard()
        }).catch(() => null);
      }
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId }).catch(() => null);
      return;
    }

    await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId }).catch(() => null);
    return;
  }
}

/**
 * Public function to trigger broad casting from web UI click
 */
export async function triggerWebBroadcast(scrapeId) {
  if (!botRunning || !botContext) {
    throw new Error("Telegram Bot не запущен");
  }
  const token = process.env.UCONTENT_BOT_TOKEN || process.env.BOT_TOKEN || DEFAULT_TOKEN;
  if (!currentSession.chatId) {
    throw new Error("Нет привязанного чата. Сначала отправьте боту в Telegram команду /start");
  }

  const scrape = await botContext.readScrape(scrapeId);
  currentSession.scrapeId = scrape.id;
  currentSession.messageId = null;
  currentSession.downloadMode = false;
  currentSession.sdvgActive = true;
  setNotionBaseline(currentSession, scrape);
  
  const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode, currentSession.sdvgMaxMode, currentSession.screenshotLabMode);
  if (!nextSegment) {
    await callApi(token, "sendMessage", {
      chat_id: currentSession.chatId,
      text: `🎉 Все сегменты в сценарии <b>${scrape.title}</b> выполнены!`,
      parse_mode: "HTML"
    });
    currentSession.activeSegmentId = null;
    await saveSession(botContext.DATA_DIR, currentSession);
    return { status: "completed", message: "Все сегменты уже выполнены" };
  }

  currentSession.activeSegmentId = nextSegment.id;
  await saveSession(botContext.DATA_DIR, currentSession);
  await sendOrEditCard(token, currentSession, scrape, nextSegment);
  return { status: "sent", message: `Транслирую сценарий ${scrape.title} в Telegram!` };
}

/**
 * Initializes and starts the Telegram bot long polling loop
 */
export async function startTelegramBot(context) {
  if (botRunning) return;
  botContext = context;
  botRunning = true;

  const token = process.env.UCONTENT_BOT_TOKEN || process.env.BOT_TOKEN || DEFAULT_TOKEN;
  await loadSession(context.DATA_DIR);
  await saveSession(context.DATA_DIR, currentSession);
  if (currentSession.lastUpdateId > 0) {
    offset = currentSession.lastUpdateId + 1;
  } else {
    const latestUpdates = await callApi(token, "getUpdates", {
      offset: -1,
      timeout: 0,
      allowed_updates: ["message", "callback_query"]
    }).catch(() => []);
    const latestUpdate = Array.isArray(latestUpdates) ? latestUpdates.at(-1) : null;
    if (latestUpdate?.update_id !== undefined) {
      currentSession.lastUpdateId = latestUpdate.update_id;
      offset = latestUpdate.update_id + 1;
      await saveSession(context.DATA_DIR, currentSession);
    }
  }

  console.log(`[bot] Starting Telegram Bot with token: ${token.slice(0, 12)}...`);
  console.log(`[notion-auto-refresh] Active SDVG scrape will be checked every ${Math.round(NOTION_REFRESH_INTERVAL_MS / 1000)} seconds`);
  scheduleNotionRefresh(token);

  // Start polling in background
  (async () => {
    while (botRunning) {
      try {
        const updates = await callApi(token, "getUpdates", {
          offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"]
        });

        for (const update of updates) {
          if (update.update_id <= currentSession.lastUpdateId) {
            offset = update.update_id + 1;
            continue;
          }
          offset = update.update_id + 1;
          currentSession.lastUpdateId = update.update_id;
          await saveSession(botContext.DATA_DIR, currentSession);
          console.log(`[bot] Received update_id ${update.update_id}, type: ${update.message ? "message" : update.callback_query ? "callback" : "other"}`);
          
          if (update.message) {
            const chatId = update.message.chat.id;
            if (currentSession.chatId !== chatId) {
              currentSession.chatId = chatId;
              currentSession.messageId = null;
              await saveSession(botContext.DATA_DIR, currentSession);
            }

            const hasText = Boolean(update.message.text || update.message.caption);
            const messageUrls = hasText ? extractMessageUrls(update.message) : [];
            if (messageUrls.length && (currentSession.downloadMode || !currentSession.activeSegmentId)) {
              await handleTextMessage(token, update.message);
              continue;
            }

            const media = extractMessageMedia(update.message);
            if (media) {
              await handleMediaMessage(token, update.message, media);
            } else if (hasText) {
              await handleTextMessage(token, update.message);
            }
          } else if (update.callback_query) {
            await handleCallbackQuery(token, update.callback_query);
          }
        }
      } catch (error) {
        console.error("[bot-polling] Error during getUpdates polling:", error.message);
        // Wait 4 seconds on error before retrying to prevent rapid loops
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }
  })();
}

export async function stopTelegramBot() {
  botRunning = false;
  if (notionRefreshTimer) clearTimeout(notionRefreshTimer);
  notionRefreshTimer = null;
  console.log("[bot] Telegram Bot stopped");
}
