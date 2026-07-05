import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { scrapeNotionPage } from "./vendor/HeadlessNotion/notion-scraper.js";
import { createXmlExportUtils } from "./vendor/xml-export/xml-export.js";
import { startTelegramBot, triggerWebBroadcast } from "./telegram-bot.mjs";
import { createMediaIndex } from "./media-index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnv(dir) {
  try {
    const envPath = path.join(dir, ".env");
    const content = await fs.readFile(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index > 0) {
        const key = trimmed.slice(0, index).trim();
        const val = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // ignore
  }
}

await loadEnv(__dirname);
await loadEnv(path.join(__dirname, ".."));

const PORT = Number(process.env.UCONTENT_PORT || 5197);
const DATA_DIR = path.join(__dirname, "data", "scrapes");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const PUBLIC_DIR = path.join(__dirname, "public");
const REMOTION_ROOT = path.join(__dirname, "Remotion");
const PAMPAM_ROOT = process.env.PAMPAM_ROOT || process.env.MEDIA_DOWNLOAD_ROOT || path.join(__dirname, "media");
const UCONTENT_STAGING_ROOT = process.env.UCONTENT_STAGING_ROOT || path.join(__dirname, ".staging");
const DOWNLOAD_STAGING_ROOT = path.join(UCONTENT_STAGING_ROOT, "downloads");
const QUARANTINE_ROOT = path.join(UCONTENT_STAGING_ROOT, "quarantine");
const UTRENDS_ROOT = process.env.UTRENDS_ROOT || path.join(__dirname, "tools", "utrends");
const UCONTENT_VENV_BIN = path.join(__dirname, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const UCONTENT_PYTHON = process.env.UCONTENT_PYTHON || path.join(UCONTENT_VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const UTRENDS_PYTHON = process.env.UTRENDS_PYTHON || UCONTENT_PYTHON || process.env.PYTHON || "python";
const MEDIA_JOBS = new Map();
const NOTION_REFRESH_JOBS = new Map();
const MEDIA_JOB_LIMIT = 100;
const MEDIA_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_COMMAND_STALL_TIMEOUT_MS = Number(process.env.DOWNLOAD_COMMAND_STALL_TIMEOUT_MS || 120_000);
const DOWNLOAD_COMMAND_MAX_TIMEOUT_MS = Number(process.env.DOWNLOAD_COMMAND_MAX_TIMEOUT_MS || 30 * 60_000);
const MEDIA_DISCOVERY_MAX_HTML_BYTES = 2 * 1024 * 1024;
const MEDIA_DISCOVERY_MAX_CANDIDATES = 20;
const REMOTION_RENDER_TIMEOUT_MS = Number(process.env.REMOTION_RENDER_TIMEOUT_MS || 10 * 60_000);
const execFileAsync = promisify(execFile);
const WEBAPP_TOKEN_PATH = path.join(DATA_DIR, "webapp-access-token");
const MEDIA_INDEX = createMediaIndex({ filePath: path.join(__dirname, "data", "media-index.json") });
let quickTunnelUrl = "";
let quickTunnelProcess = null;
const DEFAULT_YTDLP_FORMAT = [
  "bv*[height<=1080][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a]/",
  "b[height<=1080][vcodec^=avc1][ext=mp4]/",
  "bv*[height<=1080]+ba/",
  "b[height<=1080]/best[height<=1080]/best"
].join("");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"]
]);

async function getWebAppAccessToken() {
  const existing = await fs.readFile(WEBAPP_TOKEN_PATH, "utf8").catch(() => "");
  if (existing.trim()) return existing.trim();
  const token = randomBytes(32).toString("hex");
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(WEBAPP_TOKEN_PATH, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

const WEBAPP_ACCESS_TOKEN = await getWebAppAccessToken();

async function migrateKnownMediaMetadata() {
  const scrapeFiles = (await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "tg-session.json");
  for (const entry of scrapeFiles) {
    const scrape = JSON.parse(await fs.readFile(path.join(DATA_DIR, entry.name), "utf8").catch(() => "null"));
    if (!scrape?.id) continue;
    for (const segment of scrape.segments || []) {
      for (const item of segment.media_items || []) {
        if (!item?.path) continue;
        const existing = await MEDIA_INDEX.get(item.path);
        await MEDIA_INDEX.upsert(item.path, {
          derivation: existing?.derivation || "scenario",
          source_url: item.source_url || item.webpage_url || item.url || "",
          title: item.title || "",
          uploader: item.uploader || "",
          scrape_id: scrape.id,
          segment_id: segment.id || "",
          size: item.size || 0
        });
      }
    }
  }
  const session = JSON.parse(await fs.readFile(path.join(DATA_DIR, "tg-session.json"), "utf8").catch(() => "null"));
  for (const target of session?.renameTargets || []) {
    if (!target?.path || await MEDIA_INDEX.get(target.path)) continue;
    await MEDIA_INDEX.upsert(target.path, {
      derivation: "session",
      source_url: target.sourceUrl || "",
      segment_id: target.segmentId || ""
    });
  }
}

await migrateKnownMediaMetadata();

function getTelegramWebAppUrl(scrapeId = "") {
  if (!quickTunnelUrl) return "";
  const url = new URL("/script-text", quickTunnelUrl);
  url.searchParams.set("access", WEBAPP_ACCESS_TOKEN);
  if (scrapeId) url.searchParams.set("scrape", scrapeId);
  url.searchParams.set("mini", "1");
  return url.toString();
}

function startQuickTunnel() {
  if (process.env.UCONTENT_QUICK_TUNNEL === "0" || quickTunnelProcess) return;
  const executable = process.env.CLOUDFLARED_PATH || "cloudflared";
  const child = spawn(executable, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  quickTunnelProcess = child;
  const inspect = (chunk) => {
    const value = String(chunk || "");
    const match = value.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && quickTunnelUrl !== match[0]) {
      quickTunnelUrl = match[0].replace(/\/$/, "");
      console.log(`[webapp] Quick Tunnel ready: ${quickTunnelUrl}`);
    }
  };
  child.stdout.on("data", inspect);
  child.stderr.on("data", inspect);
  child.on("error", (error) => console.error(`[webapp] cloudflared failed: ${error.message}`));
  child.on("close", (code) => {
    console.warn(`[webapp] Quick Tunnel stopped (${code}); retrying...`);
    quickTunnelProcess = null;
    quickTunnelUrl = "";
    setTimeout(startQuickTunnel, 5000);
  });
}

function cookieValue(req, name) {
  const prefix = `${name}=`;
  return String(req.headers.cookie || "").split(";").map((value) => value.trim())
    .find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

function authorizeQuickTunnelRequest(req, res, reqUrl) {
  const hostname = String(req.headers.host || "").split(":")[0].toLowerCase();
  if (!hostname.endsWith(".trycloudflare.com")) return true;
  if (reqUrl.searchParams.get("access") === WEBAPP_ACCESS_TOKEN) {
    reqUrl.searchParams.delete("access");
    res.writeHead(302, {
      location: `${reqUrl.pathname}${reqUrl.search}`,
      "set-cookie": `ucontent_access=${WEBAPP_ACCESS_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      "cache-control": "no-store"
    });
    res.end();
    return false;
  }
  if (cookieValue(req, "ucontent_access") === WEBAPP_ACCESS_TOKEN) return true;
  text(res, 401, "Unauthorized");
  return false;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

function normalizeNotionUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!/notion\.(site|so)$/i.test(parsed.hostname) && !/\.notion\.(site|so)$/i.test(parsed.hostname)) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function scrapeIdFromUrl(url) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 7).padEnd(5, "x");
  return `doc_${timestamp}_${suffix}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function listScrapes() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (["latest.json", "tg-session.json", "media-index.json"].includes(entry.name)) continue;
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, entry.name), "utf8");
      const parsed = JSON.parse(raw);
      items.push({
        id: parsed.id,
        url: parsed.url,
        title: parsed.title,
        created_at: parsed.created_at,
        updated_at: parsed.updated_at,
        segments: Array.isArray(parsed.segments) ? parsed.segments.length : 0,
        lines: String(parsed.content ?? "").split(/\r?\n/).length,
        chars: String(parsed.content ?? "").length
      });
    } catch {
      // Ignore broken local scratch files.
    }
  }
  return items.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

async function saveScrape({ id, url, content }) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const title = String(content).split(/\r?\n/).find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() || "Untitled";
  const segmentState = assignSegmentIds(content);
  const payload = {
    id,
    url,
    title,
    content,
    segments: segmentState.segments,
    segment_report: segmentState.report,
    created_at: new Date().toISOString()
  };
  await fs.writeFile(path.join(DATA_DIR, `${id}.json`), JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(path.join(DATA_DIR, `${id}.md`), content, "utf8");
  await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function importMarkdownScrape({ id, url, content }) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const safeId = safeScrapeId(id);
  if (!safeId) throw new Error("id is required");
  if (!String(content ?? "").trim()) throw new Error("content is required");

  let existing = null;
  try {
    existing = await readScrape(safeId);
  } catch {
    existing = null;
  }

  const segmentState = assignSegmentIds(content, existing?.segments || []);
  const now = new Date().toISOString();
  const payload = {
    ...(existing || {}),
    id: safeId,
    url: String(url || existing?.url || `import://${safeId}`),
    title: titleFromContent(content),
    content,
    segments: segmentState.segments,
    segment_report: segmentState.report,
    created_at: existing?.created_at || now,
    updated_at: now
  };
  await writeScrape(payload);
  return payload;
}

function safeScrapeId(id) {
  return String(id ?? "").replace(/[^a-z0-9_.-]/gi, "");
}

async function readScrape(id) {
  const safeId = safeScrapeId(id);
  const target = safeId ? path.join(DATA_DIR, `${safeId}.json`) : path.join(DATA_DIR, "latest.json");
  const raw = await fs.readFile(target, "utf8");
  return JSON.parse(raw);
}

async function writeScrape(scrape, { writeMarkdown = true } = {}) {
  if (!scrape?.id) throw new Error("scrape id is required");
  await enrichScrapeLinkPreviews(scrape);
  dedupeScrapeImageAssignments(scrape);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, `${scrape.id}.json`), JSON.stringify(scrape, null, 2), "utf8");
  if (writeMarkdown) {
    await fs.writeFile(path.join(DATA_DIR, `${scrape.id}.md`), String(scrape.content ?? ""), "utf8");
  }
  await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(scrape, null, 2), "utf8");
}

async function snapshotScrape(scrape, reason = "snapshot") {
  if (!scrape?.id) return null;
  const safeId = safeScrapeId(scrape.id);
  if (!safeId) return null;
  const dir = path.join(HISTORY_DIR, safeId);
  await fs.mkdir(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const snapshot = {
    id: `${createdAt.replace(/[:.]/g, "-")}-${reason}`,
    reason,
    created_at: createdAt,
    scrape
  };
  const fileName = `${snapshot.id}.json`;
  await fs.writeFile(path.join(dir, fileName), JSON.stringify(snapshot, null, 2), "utf8");
  const entries = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(entries.slice(10).map((entry) => fs.unlink(path.join(dir, entry)).catch(() => null)));
  return { ...snapshot, file: fileName };
}

async function latestScrapeSnapshot(id) {
  const safeId = safeScrapeId(id);
  if (!safeId) return null;
  const dir = path.join(HISTORY_DIR, safeId);
  const entries = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const entry of entries) {
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.scrape?.id) return { ...parsed, file: entry };
    } catch {
      // Ignore broken history snapshots.
    }
  }
  return null;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeMediaFilePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function normalizeSectionTitleForMatch(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function stableSectionId(value) {
  const normalized = normalizeSectionTitleForMatch(value || "document");
  if (!normalized) return "document";
  return `section-${createHash("sha1").update(normalized).digest("hex").slice(0, 12)}`;
}

function normalizeVisualDecisionInput(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      media_file_path: "",
      media_file_paths: [],
      media_file_timecodes: {},
      duration_hint_sec: null,
      format_hint: ""
    };
  }
  const paths = Array.isArray(raw.media_file_paths)
    ? raw.media_file_paths.map(normalizeMediaFilePath).filter(Boolean)
    : normalizeMediaFilePath(raw.media_file_path)
      ? [normalizeMediaFilePath(raw.media_file_path)]
      : [];
  return {
    ...raw,
    media_file_path: paths[0] || "",
    media_file_paths: paths,
    media_file_timecodes: raw.media_file_timecodes && typeof raw.media_file_timecodes === "object" ? raw.media_file_timecodes : {},
    duration_hint_sec: raw.duration_hint_sec ?? null,
    format_hint: String(raw.format_hint || "").trim()
  };
}

function safeResolveMediaPathForRoot(mediaRoot, relativePath) {
  const clean = normalizeMediaFilePath(relativePath);
  if (!clean) return "";
  const base = path.resolve(mediaRoot || PAMPAM_ROOT);
  const target = path.resolve(base, clean);
  if (target === base) return "";
  if (!target.startsWith(`${base}${path.sep}`)) return "";
  return target;
}

function titleFromContent(content) {
  return String(content).split(/\r?\n/).find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() || "Untitled";
}

function sanitizeMediaTopicName(rawTitle) {
  const fallbackTopic = "Без темы";
  const value = String(rawTitle ?? "").trim();
  if (!value) return fallbackTopic;
  const replaced = value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\(\s*\d+\s*\)\s*$/g, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const normalized = replaced || fallbackTopic;
  const clipped = normalized.length > 96 ? normalized.slice(0, 96).trim() : normalized;
  if (!clipped) return fallbackTopic;
  const reserved = new Set(["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);
  return reserved.has(clipped.toUpperCase()) ? `_${clipped}` : clipped;
}

function sanitizeFileName(value, fallback = "file") {
  const parsed = path.parse(String(value ?? "").trim());
  const extPart = asciiFilePart((parsed.ext || "").replace(/^\.+/, ""), "").slice(0, 10).toLowerCase();
  const ext = extPart ? `.${extPart}` : "";
  const stem = asciiFilePart(parsed.name || fallback, fallback).slice(0, 120).replace(/[._-]+$/g, "");
  return `${stem || fallback}${ext || ""}`;
}

function asciiFilePart(value, fallback = "file") {
  const cyr = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
    є: "e", і: "i", ї: "yi", ґ: "g"
  };
  const transliterated = Array.from(String(value ?? "").toLowerCase())
    .map((ch) => cyr[ch] ?? ch)
    .join("");
  const ascii = transliterated
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return ascii || fallback;
}

function makeFileNameUnique(fileName) {
  const parsed = path.parse(fileName);
  const genericPatterns = [
    /^image/i,
    /^img/i,
    /^file/i,
    /^clipboard/i,
    /^photo/i,
    /^screenshot/i
  ];
  const isGeneric = genericPatterns.some((pat) => pat.test(parsed.name));
  if (isGeneric) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${parsed.name}_${stamp}_${suffix}${parsed.ext}`;
  }
  return fileName;
}

function looksGenericMediaFileStem(value) {
  const normalized = asciiFilePart(String(value || ""), "").replace(/[._-]+/g, "");
  if (!normalized) return true;
  return /^(img|image|photo|screenshot|screen|file|document|video|animation|audio|voice|videonote|download|media)\d{0,16}$/i.test(normalized);
}

function hostLabelFromUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function descriptiveDownloadFileName(job, originalName, index = 1) {
  const parsed = path.parse(String(originalName || ""));
  const ext = parsed.ext || ".bin";
  const title = normalizeYtDlpMetaValue(job?.meta_title);
  const description = normalizeYtDlpMetaValue(job?.meta_description);
  const uploader = normalizeYtDlpMetaValue(job?.meta_uploader).replace(/^@+/, "");
  const host = hostLabelFromUrl(job?.meta_webpage_url || job?.url);
  const rawLabel = [description, title, uploader, host].find((value) => {
    const stem = asciiFilePart(value, "");
    return stem && !looksGenericMediaFileStem(stem);
  });
  if (!rawLabel) return originalName;
  const stem = asciiFilePart(rawLabel, "media").slice(0, 90).replace(/[._-]+$/g, "");
  const suffix = index > 1 ? `_${String(index).padStart(2, "0")}` : "";
  return `${stem || "media"}${suffix}${ext}`;
}

function titleFromDownloadedFileName(fileName) {
  const stem = path.parse(String(fileName || "")).name
    .replace(/^\d{8,24}[_ -]+/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stem || looksGenericMediaFileStem(stem)) return "";
  return stem.replace(/\b\w/g, (match) => match.toUpperCase());
}

async function ensureUniqueFileNameInDir(dir, fileName, currentName = "") {
  const parsed = path.parse(sanitizeFileName(fileName, "media"));
  let candidate = `${parsed.name || "media"}${parsed.ext || ""}`;
  let index = 1;
  while (candidate.toLowerCase() !== String(currentName || "").toLowerCase()) {
    const target = path.join(dir, candidate);
    if (!(await pathExists(target))) return candidate;
    candidate = `${parsed.name || "media"}_${index}${parsed.ext || ""}`;
    index += 1;
  }
  return candidate;
}

async function normalizeMediaFileNameOnDisk(dir, fileName) {
  const cleanName = sanitizeFileName(fileName, "media");
  let currentName = fileName;
  if (cleanName !== fileName) {
    const source = path.join(dir, fileName);
    const targetName = await ensureUniqueFileNameInDir(dir, cleanName, fileName);
    const target = path.join(dir, targetName);
    if (source !== target) await fs.rename(source, target);
    currentName = targetName;
  }
  if (path.extname(currentName).toLowerCase() === ".webp") {
    const convertedPath = await convertWebpFileToPng(path.join(dir, currentName));
    currentName = path.basename(convertedPath);
  }
  return currentName;
}

async function convertWebpFileToPng(sourcePath) {
  if (path.extname(sourcePath).toLowerCase() !== ".webp") return sourcePath;
  const stats = await fs.stat(sourcePath).catch(() => null);
  if (!stats?.isFile()) throw new Error("WebP source file not found");
  const parsed = path.parse(sourcePath);
  const targetName = await ensureUniqueFileNameInDir(parsed.dir, `${parsed.name}.png`);
  const targetPath = path.join(parsed.dir, targetName);
  const tools = await resolveDownloaderTools();
  const ffmpeg = tools.ffmpeg_path || "ffmpeg";
  try {
    await execFileAsync(ffmpeg, ["-loglevel", "error", "-y", "-i", sourcePath, "-frames:v", "1", targetPath], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const converted = await fs.stat(targetPath).catch(() => null);
    if (!converted?.isFile() || converted.size === 0) throw new Error("PNG conversion produced no output");
    await fs.unlink(sourcePath);
    return targetPath;
  } catch (error) {
    await fs.unlink(targetPath).catch(() => null);
    throw new Error(`WebP to PNG conversion failed: ${error.message}`);
  }
}

function safeResolveMediaPath(relativePath) {
  const clean = String(relativePath ?? "").replace(/^[/\\]+/, "");
  if (!clean) return "";
  const root = path.resolve(PAMPAM_ROOT);
  const target = path.resolve(PAMPAM_ROOT, clean);
  if (target === root) return "";
  if (!target.startsWith(`${root}${path.sep}`)) return "";
  return target;
}

function shouldHideMediaFile(fileName) {
  const normalized = String(fileName ?? "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("newfile")) return true;
  return [".txt", ".xml", ".db", ".py", ".sqlite", ".sqlite-shm", ".sqlite-wal"].some((ext) => normalized.endsWith(ext));
}

function isImageFile(filePath) {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(path.extname(filePath).toLowerCase());
}

function isVideoMediaFile(filePath) {
  return [".mp4", ".mov", ".webm", ".mkv"].includes(path.extname(filePath).toLowerCase());
}

function isPreviewableMediaFile(filePath) {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm"].includes(path.extname(filePath).toLowerCase());
}

async function ensureTopicDir(topic) {
  const safeTopic = sanitizeMediaTopicName(topic);
  const dir = path.join(PAMPAM_ROOT, safeTopic);
  await fs.mkdir(dir, { recursive: true });
  return { safeTopic, dir };
}

function assertPathInsideRoot(root, targetPath, label = "path") {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing unsafe ${label} outside ${resolvedRoot}: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

async function createDownloadStagingDir(jobId) {
  const safeId = sanitizeFileName(jobId || makeJobId(), "job");
  const dir = path.join(DOWNLOAD_STAGING_ROOT, safeId);
  assertPathInsideRoot(DOWNLOAD_STAGING_ROOT, dir, "download staging directory");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function quarantineStagingDir(stagingDir, jobId = "") {
  if (!stagingDir) return "";
  const source = assertPathInsideRoot(DOWNLOAD_STAGING_ROOT, stagingDir, "staging cleanup source");
  const entries = await fs.readdir(source).catch(() => []);
  if (!entries.length) {
    await fs.rmdir(source).catch(() => null);
    return "";
  }
  const date = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const safeId = sanitizeFileName(jobId || path.basename(source), "job");
  const quarantineDir = path.join(QUARANTINE_ROOT, date, `${stamp}_${safeId}`);
  assertPathInsideRoot(QUARANTINE_ROOT, quarantineDir, "quarantine target");
  await fs.mkdir(path.dirname(quarantineDir), { recursive: true });
  await fs.rename(source, quarantineDir).catch(async () => {
    await fs.mkdir(quarantineDir, { recursive: true });
    for (const entry of entries) {
      const from = path.join(source, entry);
      const to = path.join(quarantineDir, entry);
      await fs.rename(from, to).catch(() => null);
    }
    await fs.rmdir(source).catch(() => null);
  });
  return quarantineDir;
}

async function publishDownloadedFilesFromStaging(job, stagingDir, outputFiles, safeTopic) {
  const finalDir = path.join(PAMPAM_ROOT, safeTopic);
  assertPathInsideRoot(PAMPAM_ROOT, finalDir, "publish final directory");
  await fs.mkdir(finalDir, { recursive: true });
  const published = [];
  for (const file of outputFiles || []) {
    const relName = String(file?.name || "").replace(/^[/\\]+/, "");
    if (!relName || relName.split(/[\\/]+/).some((part) => part === "..")) continue;
    const source = assertPathInsideRoot(stagingDir, path.join(stagingDir, relName), "publish source");
    const stats = await fs.stat(source).catch(() => null);
    if (!stats?.isFile() || stats.size <= 0) continue;
    const baseName = path.basename(relName);
    const parsedBase = path.parse(baseName);
    const descriptiveName = looksGenericMediaFileStem(parsedBase.name) || isXOrTwitter(job?.url)
      ? descriptiveDownloadFileName(job, baseName, published.length + 1)
      : baseName;
    const targetName = await ensureUniqueFileNameInDir(finalDir, descriptiveName);
    const target = assertPathInsideRoot(finalDir, path.join(finalDir, targetName), "publish target");
    await fs.rename(source, target).catch(async () => {
      await fs.copyFile(source, target);
    });
    const finalName = await normalizeMediaFileNameOnDisk(finalDir, targetName);
    const finalPath = path.join(finalDir, finalName);
    const finalStats = await fs.stat(finalPath);
    const relPath = path.join(safeTopic, finalName).split(path.sep).join("/");
    published.push({
      path: relPath,
      name: finalName,
      topic: safeTopic,
      size: finalStats.size,
      updated_at: finalStats.mtime.toISOString(),
      thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
    });
  }
  if (!published.length) throw new Error("Download finished, but no final files were published");
  return published;
}

async function listMediaFiles(maxFiles = 800) {
  await fs.mkdir(PAMPAM_ROOT, { recursive: true });
  const ignoredRootFolders = new Set(["unsorted", "archive_projects", "graphics"]);
  const files = [];
  const stack = [""];
  while (stack.length && files.length < maxFiles) {
    const currentRel = stack.pop();
    const currentDir = currentRel ? path.join(PAMPAM_ROOT, currentRel) : PAMPAM_ROOT;
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const relPath = currentRel ? path.join(currentRel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.trim().toLowerCase() === "_originals") continue;
        if (!currentRel && ignoredRootFolders.has(entry.name.trim().toLowerCase())) continue;
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile() || shouldHideMediaFile(entry.name)) continue;
      const absolutePath = path.join(PAMPAM_ROOT, relPath);
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats?.isFile()) continue;
      const normalizedRel = relPath.split(path.sep).join("/");
      const indexed = await MEDIA_INDEX.get(normalizedRel);
      files.push({
        ...(indexed || {}),
        path: normalizedRel,
        name: entry.name,
        topic: normalizedRel.split("/")[0] || "",
        size: stats.size,
        updated_at: stats.mtime?.toISOString?.() ?? null,
        thumbnail: isImageFile(normalizedRel) ? `/api/media/raw?path=${encodeURIComponent(normalizedRel)}` : ""
      });
    }
  }
  return files.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

async function registerDownloadedMedia(job, outputFiles) {
  await Promise.all((outputFiles || []).map((file) => MEDIA_INDEX.upsert(file.path, {
    derivation: "download",
    source_url: job.meta_webpage_url || job.url,
    title: job.meta_title || "",
    description: job.meta_description || "",
    uploader: job.meta_uploader || "",
    uploader_url: job.meta_uploader_url || "",
    format_note: job.meta_format_note || "",
    resolution: job.meta_resolution || "",
    size: file.size || 0
  })));
}

async function pathExists(targetPath) {
  if (!targetPath) return false;
  return fs.access(targetPath).then(() => true).catch(() => false);
}

async function resolveFirstExisting(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (await pathExists(candidate)) return candidate;
  }
  return "";
}

async function probeExecutable(command, args = []) {
  if (!command) return false;
  try {
    await execFileAsync(command, args, { windowsHide: true, timeout: 12000 });
    return true;
  } catch {
    return false;
  }
}

async function resolveDownloaderTools() {
  const isWindows = process.platform === "win32";
  const ytDlp = await resolveFirstExisting([
    process.env.UCONTENT_YTDLP_PATH,
    process.env.MEDIA_YTDLP_PATH,
    process.env.YTDLP_PATH,
    path.join(__dirname, "tools", isWindows ? "yt-dlp.exe" : "yt-dlp"),
    path.join(UCONTENT_VENV_BIN, isWindows ? "yt-dlp.exe" : "yt-dlp"),
    "yt-dlp"
  ]);
  let ffmpeg = await resolveFirstExisting([
    process.env.FFMPEG_PATH,
    process.env.MEDIA_FFMPEG_PATH,
    path.join(__dirname, "tools", isWindows ? "ffmpeg.exe" : "ffmpeg"),
    "ffmpeg"
  ]);
  if (!ffmpeg && await probeExecutable("ffmpeg", ["-version"])) ffmpeg = "ffmpeg";
  let galleryDl = await resolveFirstExisting([
    process.env.UCONTENT_GALLERYDL_PATH,
    process.env.MEDIA_GALLERYDL_PATH,
    path.join(__dirname, "tools", isWindows ? "gallery-dl.exe" : "gallery-dl"),
    path.join(UCONTENT_VENV_BIN, isWindows ? "gallery-dl.exe" : "gallery-dl")
  ]);
  let galleryDlMode = galleryDl ? "binary" : "";
  if (!galleryDl && await probeExecutable(UCONTENT_PYTHON, ["-m", "gallery_dl", "--version"])) {
    galleryDl = UCONTENT_PYTHON;
    galleryDlMode = "python_module";
  }
  if (!galleryDl && await probeExecutable(process.env.GALLERYDL_PYTHON, ["-m", "gallery_dl", "--version"])) {
    galleryDl = process.env.GALLERYDL_PYTHON;
    galleryDlMode = "python_module";
  }
  if (!galleryDl && await probeExecutable("python", ["-m", "gallery_dl", "--version"])) {
    galleryDl = "python";
    galleryDlMode = "python_module";
  }
  if (!galleryDl && await probeExecutable("py", ["-m", "gallery_dl", "--version"])) {
    galleryDl = "py";
    galleryDlMode = "python_module";
  }
  return {
    yt_dlp_path: ytDlp,
    ffmpeg_path: ffmpeg,
    gallery_dl_path: galleryDl,
    gallery_dl_mode: galleryDlMode,
    available: Boolean(ytDlp || galleryDl)
  };
}

function normalizeHttpUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function extractHttpUrls(value) {
  const seen = new Set();
  return (String(value || "").match(/https?:\/\/[^\s<]+/gi) || [])
    .map((url) => normalizeHttpUrl(String(url || "").trim().replace(/[),.;!?]+$/g, "")))
    .filter((url) => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function screenshotLabProfileFromParams(params) {
  const preset = String(params.get("preset") || "").trim().toLowerCase();
  const presets = new Map([
    ["2x1", { width: 2560, height: 1280, zoom: 200 }],
    ["1x1", { width: 1280, height: 1280, zoom: 200 }],
    ["16x9", { width: 2560, height: 1440, zoom: 200 }]
  ]);
  const base = presets.get(preset) || presets.get("16x9");
  return {
    width: Math.round(clampNumber(params.get("width"), base.width, 320, 3840)),
    height: Math.round(clampNumber(params.get("height"), base.height, 240, 5120)),
    zoom: Math.round(clampNumber(params.get("zoom"), base.zoom, 50, 800)),
    scroll: Math.round(clampNumber(params.get("scroll"), 0, 0, 50000))
  };
}

function screenshotLabLinksFromScrape(scrape) {
  const items = [];
  for (const segment of Array.isArray(scrape?.segments) ? scrape.segments : []) {
    const urls = extractHttpUrls(segment?.text || "");
    for (const url of urls) {
      items.push({
        url,
        segment_id: String(segment.id || ""),
        topic: String(segment.topic || ""),
        text: String(segment.text || ""),
        is_done: Boolean(segment.is_done)
      });
    }
  }
  return items;
}

function screenshotLabTopicForScrape(scrapeId) {
  return sanitizeMediaTopicName(`${safeScrapeId(scrapeId)}_screenshotlab`);
}

function screenshotLabHostLabel(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return host.replace(/[^a-z0-9.-]+/g, "_") || "site";
  } catch {
    return "site";
  }
}

async function attachScreenshotLabFiles(scrapeId, links) {
  const safeTopic = screenshotLabTopicForScrape(scrapeId);
  const dir = path.join(PAMPAM_ROOT, safeTopic);
  const files = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const pngFiles = files
    .filter((file) => file.isFile() && file.name.toLowerCase().endsWith(".png"))
    .map((file) => file.name);
  if (!pngFiles.length) return links;
  const byIndex = new Map();
  for (const fileName of pngFiles) {
    const match = /^(\d+)_/i.exec(fileName);
    if (!match) continue;
    const index = Number(match[1]);
    if (Number.isFinite(index) && index > 0 && !byIndex.has(index)) byIndex.set(index, fileName);
  }
  return Promise.all(links.map(async (item, index) => {
    const fileName = byIndex.get(index + 1);
    if (!fileName) return item;
    const absolutePath = path.join(dir, fileName);
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats?.isFile()) return item;
    const relPath = path.join(safeTopic, fileName).split(path.sep).join("/");
    return {
      ...item,
      screenshot: {
        path: relPath,
        name: fileName,
        url: `/api/media/raw?path=${encodeURIComponent(relPath)}`,
        size: stats.size,
        updated_at: stats.mtime.toISOString()
      }
    };
  }));
}

async function saveScreenshotLabCapture({ scrapeId, linkIndex, url, preset, profile, buffer }) {
  const safeTopic = screenshotLabTopicForScrape(scrapeId);
  if (!safeTopic || safeTopic === "_screenshotlab") return null;
  const numericIndex = Math.round(clampNumber(linkIndex, 0, 1, 999));
  const indexPrefix = String(numericIndex).padStart(2, "0");
  const dir = path.join(PAMPAM_ROOT, safeTopic);
  assertPathInsideRoot(PAMPAM_ROOT, dir, "screenshot lab directory");
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readdir(dir).catch(() => []);
  await Promise.all(existing
    .filter((fileName) => fileName.toLowerCase().endsWith(".png") && fileName.startsWith(`${indexPrefix}_`))
    .map((fileName) => fs.unlink(path.join(dir, fileName)).catch(() => null)));
  const fileName = `${indexPrefix}_${screenshotLabHostLabel(url)}_${String(preset || "16x9").replace(/[^a-z0-9_-]+/gi, "")}_z${profile.zoom}.png`;
  const target = path.join(dir, fileName);
  assertPathInsideRoot(PAMPAM_ROOT, target, "screenshot lab file");
  await fs.writeFile(target, buffer);
  const stats = await fs.stat(target);
  const relPath = path.join(safeTopic, fileName).split(path.sep).join("/");
  await MEDIA_INDEX.upsert(relPath, {
    derivation: "screenshot-lab",
    source_url: url,
    size: stats.size,
    resolution: `${profile.width}x${profile.height}`,
    format_note: `zoom ${profile.zoom}, scroll ${profile.scroll}`
  });
  return {
    path: relPath,
    name: fileName,
    url: `/api/media/raw?path=${encodeURIComponent(relPath)}`,
    size: stats.size,
    updated_at: stats.mtime.toISOString()
  };
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

function isXOrTwitter(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

function makeJobId() {
  return `job_${Date.now().toString(36)}_${createHash("sha1").update(`${Date.now()}_${Math.random()}`).digest("hex").slice(0, 8)}`;
}

async function listImmediateFiles(dir) {
  const files = [];
  const stack = [""];
  while (stack.length) {
    const relDir = stack.pop();
    const absoluteDir = path.join(dir, relDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(dir, relPath);
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats?.isFile()) continue;
      files.push({ name: relPath, size: stats.size, mtime: stats.mtimeMs });
    }
  }
  return files;
}

async function listNewOutputFiles(topic, dir, beforeFiles) {
  const before = new Map(beforeFiles.map((file) => [file.name, `${file.size}:${file.mtime}`]));
  const after = await listImmediateFiles(dir);
  const newFiles = after
    .filter((file) => before.get(file.name) !== `${file.size}:${file.mtime}`)
    .filter((file) => isPreviewableMediaFile(file.name))
    .sort((a, b) => b.mtime - a.mtime);
  const normalizedFiles = [];
  for (const file of newFiles) {
    const relDir = path.dirname(file.name);
    const sourceDir = relDir === "." ? dir : path.join(dir, relDir);
    const nextBase = await normalizeMediaFileNameOnDisk(sourceDir, path.basename(file.name));
    const nextName = relDir === "." ? nextBase : path.join(relDir, nextBase);
    const absolutePath = path.join(dir, nextName);
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats?.isFile()) continue;
    normalizedFiles.push({
      name: nextName,
      size: stats.size,
      mtime: stats.mtimeMs
    });
  }
  return normalizedFiles.map((file) => {
      const relPath = path.join(topic, file.name).split(path.sep).join("/");
      return {
        path: relPath,
        name: file.name,
        topic,
        size: file.size,
        updated_at: new Date(file.mtime).toISOString(),
        thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
      };
    });
}

function flattenMetadataValues(value, prefix = "", out = {}) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenMetadataValues(item, `${prefix}.${index}`, out));
    return out;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      flattenMetadataValues(nested, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (["string", "number", "boolean"].includes(typeof value)) {
    out[prefix] = normalizeYtDlpMetaValue(value);
  }
  return out;
}

function firstMetadataValue(flat, patterns) {
  for (const [key, value] of Object.entries(flat || {})) {
    if (!value) continue;
    if (patterns.some((pattern) => pattern.test(key))) return value;
  }
  return "";
}

function applyDownloadedMetadata(job, metadata = {}) {
  const flat = flattenMetadataValues(metadata);
  const title = firstMetadataValue(flat, [
    /(^|\.)title$/i,
    /(^|\.)caption$/i,
    /(^|\.)text$/i
  ]);
  const description = firstMetadataValue(flat, [
    /(^|\.)description$/i,
    /(^|\.)desc$/i,
    /(^|\.)caption$/i,
    /(^|\.)text$/i
  ]);
  const uploader = firstMetadataValue(flat, [
    /(^|\.)(uploader|username|unique_id|uniqueid|screen_name|nickname|author)$/i,
    /author\.(username|unique_id|uniqueid|nickname)$/i,
    /user\.(username|unique_id|uniqueid|nickname)$/i
  ]);
  const uploaderUrl = firstMetadataValue(flat, [
    /(^|\.)(uploader_url|author_url|user_url|profile_url)$/i
  ]);
  const webpageUrl = firstMetadataValue(flat, [
    /(^|\.)(webpage_url|post_url|url|source_url)$/i
  ]);
  const width = Number(firstMetadataValue(flat, [/(^|\.)width$/i]) || 0) || 0;
  const height = Number(firstMetadataValue(flat, [/(^|\.)height$/i]) || 0) || 0;
  const patch = {};
  if (!job.meta_title && title) patch.meta_title = title;
  if (!job.meta_description && description) patch.meta_description = description;
  if (!job.meta_uploader && uploader) patch.meta_uploader = String(uploader).replace(/^@+/, "");
  if (!job.meta_uploader_url && uploaderUrl) patch.meta_uploader_url = uploaderUrl;
  if (!job.meta_webpage_url && webpageUrl) patch.meta_webpage_url = webpageUrl;
  if (!job.meta_resolution && width && height) patch.meta_resolution = `${width}x${height}`;
  if (Object.keys(patch).length) updateJob(job, patch);
}

async function applyGalleryMetadataSidecars(job, dir) {
  const files = await listImmediateFiles(dir);
  const jsonFiles = files.filter((file) => path.extname(file.name).toLowerCase() === ".json");
  for (const file of jsonFiles) {
    const absolutePath = path.join(dir, file.name);
    try {
      const metadata = JSON.parse(await fs.readFile(absolutePath, "utf8"));
      applyDownloadedMetadata(job, metadata);
    } catch {
      // ignore malformed downloader sidecars
    }
  }
}

function applyOutputFileMetadataFallback(job, files = []) {
  if (job.meta_title || job.meta_description) return;
  const first = files.find((file) => isVideoMediaFile(file.name)) || files[0];
  const title = titleFromDownloadedFileName(first?.name || "");
  if (title) updateJob(job, { meta_title: title });
}

async function probeVideoQuality(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,bit_rate",
      "-show_entries", "format=duration,size,bit_rate",
      "-of", "json",
      filePath
    ], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(String(stdout || "{}"));
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] || {} : {};
    const format = parsed.format || {};
    const stats = await fs.stat(filePath).catch(() => null);
    const width = Number(stream.width || 0) || 0;
    const height = Number(stream.height || 0) || 0;
    const duration = Number(format.duration || 0) || 0;
    const videoBitrate = Number(stream.bit_rate || 0) || 0;
    const totalBitrate = Number(format.bit_rate || 0) || 0;
    const size = Number(format.size || stats?.size || 0) || 0;
    return { width, height, duration, videoBitrate, totalBitrate, size };
  } catch {
    const stats = await fs.stat(filePath).catch(() => null);
    return { width: 0, height: 0, duration: 0, videoBitrate: 0, totalBitrate: 0, size: Number(stats?.size || 0) || 0 };
  }
}

function duplicateVideoKey(probe) {
  const width = Number(probe?.width || 0) || 0;
  const height = Number(probe?.height || 0) || 0;
  const duration = Number(probe?.duration || 0) || 0;
  if (!width || !height || !duration) return "";
  const durationKey = Math.round(duration);
  const aspectKey = Math.round((width / height) * 1000);
  return `${durationKey}:${aspectKey}`;
}

function videoQualityScore(probe) {
  const pixels = (Number(probe?.width || 0) || 0) * (Number(probe?.height || 0) || 0);
  const bitrate = Number(probe?.videoBitrate || probe?.totalBitrate || 0) || 0;
  const size = Number(probe?.size || 0) || 0;
  return (pixels * 1_000_000_000) + (bitrate * 1_000) + size;
}

async function pruneLowerQualityDuplicateVideos(job, dir, beforeFiles) {
  const files = await listNewOutputFiles(job.topic, dir, beforeFiles);
  if (!isXOrTwitter(job.url)) return files;
  const videos = [];
  for (const file of files.filter((item) => isVideoMediaFile(item.name))) {
    const absolutePath = path.join(dir, file.name);
    const probe = await probeVideoQuality(absolutePath);
    const key = duplicateVideoKey(probe);
    if (!key) continue;
    videos.push({ file, absolutePath, probe, key, score: videoQualityScore(probe) });
  }
  const groups = new Map();
  for (const item of videos) {
    const group = groups.get(item.key) || [];
    group.push(item);
    groups.set(item.key, group);
  }
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.score - a.score);
    const keep = group[0];
    if (keep.probe.width && keep.probe.height) {
      const qualityHeight = Math.min(keep.probe.width, keep.probe.height);
      updateJob(job, {
        meta_resolution: `${keep.probe.width}x${keep.probe.height}`,
        meta_format_note: `${qualityHeight}p`
      });
    }
    for (const drop of group.slice(1)) {
      await fs.unlink(drop.absolutePath).catch(() => null);
      removed += 1;
      updateJob(job, {
        log: `${job.log || ""}\nKept higher-quality X/Twitter media ${keep.probe.width}x${keep.probe.height} (${keep.file.name}); removed duplicate ${drop.probe.width}x${drop.probe.height} (${drop.file.name}).`.slice(-2000)
      });
    }
  }
  return removed ? listNewOutputFiles(job.topic, dir, beforeFiles) : files;
}

async function removeNewStandaloneAudioFiles(dir, beforeFiles) {
  const beforeNames = new Set(beforeFiles.map((file) => file.name));
  const after = await listImmediateFiles(dir);
  const audioExtensions = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
  await Promise.all(after
    .filter((file) => !beforeNames.has(file.name))
    .filter((file) => audioExtensions.has(path.extname(file.name).toLowerCase()))
    .map((file) => fs.unlink(path.join(dir, file.name)).catch(() => null)));
}

function isDownloadTempFileName(fileName) {
  return /\.(part|ytdl|tmp|temp)$/i.test(String(fileName || ""));
}

async function removeDownloadTempFiles(dir, beforeFiles = []) {
  const before = new Map(beforeFiles.map((file) => [file.name, `${file.size}:${file.mtime}`]));
  const now = Date.now();
  const staleMs = 10 * 60 * 1000;
  const after = await listImmediateFiles(dir);
  await Promise.all(after
    .filter((file) => isDownloadTempFileName(file.name))
    .filter((file) => before.get(file.name) !== `${file.size}:${file.mtime}` || now - Number(file.mtime || 0) > staleMs)
    .map((file) => fs.unlink(path.join(dir, file.name)).catch(() => null)));
}

function trimMediaJobs() {
  const jobs = [...MEDIA_JOBS.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const job of jobs.slice(MEDIA_JOB_LIMIT)) MEDIA_JOBS.delete(job.id);
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updated_at: new Date().toISOString() });
  MEDIA_JOBS.set(job.id, job);
  trimMediaJobs();
  return job;
}

function parseDownloadProgress(textChunk) {
  const textValue = String(textChunk ?? "");
  const percentMatch = textValue.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (percentMatch) {
    const progress = Math.max(0, Math.min(100, Number(percentMatch[1])));
    if (Number.isFinite(progress)) return Math.round(progress);
  }
  return null;
}

function normalizeYtDlpMetaValue(value) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text === "NA" || text === "None" || text === "null") return "";
  return text;
}

function parseYtDlpMetadataLine(job, textChunk) {
  const lines = String(textChunk ?? "").split(/\r?\n/);
  const pairs = [
    ["__META_TITLE__", "meta_title"],
    ["__META_DESCRIPTION__", "meta_description"],
    ["__META_UPLOADER__", "meta_uploader"],
    ["__META_UPLOADER_URL__", "meta_uploader_url"],
    ["__META_WEBPAGE_URL__", "meta_webpage_url"],
    ["__META_FORMAT_NOTE__", "meta_format_note"],
    ["__META_RESOLUTION__", "meta_resolution"]
  ];
  for (const line of lines) {
    const text = line.trim();
    for (const [prefix, key] of pairs) {
      if (!text.startsWith(prefix)) continue;
      const value = normalizeYtDlpMetaValue(text.slice(prefix.length));
      if (value) updateJob(job, { [key]: value });
      break;
    }
  }
}

function runCommand(job, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true
    });
    job.process = child;
    let output = "";
    let settled = false;
    const killChild = (reason) => {
      if (settled) return;
      const error = new Error(reason);
      error.code = "DOWNLOAD_TIMEOUT";
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 5000).unref?.();
      } catch {}
      settled = true;
      reject(error);
    };
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        killChild(`Downloader stalled: no output for ${Math.round(DOWNLOAD_COMMAND_STALL_TIMEOUT_MS / 1000)} seconds`);
      }, DOWNLOAD_COMMAND_STALL_TIMEOUT_MS);
      stallTimer.unref?.();
    };
    let stallTimer = null;
    const maxTimer = setTimeout(() => {
      killChild(`Downloader timed out after ${Math.round(DOWNLOAD_COMMAND_MAX_TIMEOUT_MS / 60000)} minutes`);
    }, DOWNLOAD_COMMAND_MAX_TIMEOUT_MS);
    maxTimer.unref?.();
    resetStallTimer();
    const onData = (chunk) => {
      resetStallTimer();
      const textChunk = chunk.toString("utf8");
      output += textChunk;
      output = output.slice(-12000);
      parseYtDlpMetadataLine(job, textChunk);
      const progress = parseDownloadProgress(textChunk);
      if (progress !== null) updateJob(job, { progress, log: output.slice(-2000) });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      clearTimeout(maxTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      clearTimeout(maxTimer);
      if (code === 0) {
        resolve(output);
      } else {
        const error = new Error(output.trim() || `Downloader exited with code ${code}`);
        error.code = code;
        reject(error);
      }
    });
  });
}

async function downloadDirectFile(job, url, topic, dir, nameHint = "", requestHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const response = await fetch(url, {
    redirect: "follow",
    signal: controller.signal,
    headers: { "user-agent": "Mozilla/5.0 UContent/0.1 media downloader", ...requestHeaders }
  }).finally(() => clearTimeout(timer));
  if (!response.ok) throw new Error(`Direct download failed: HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MEDIA_DOWNLOAD_MAX_BYTES) {
    await response.body?.cancel().catch(() => null);
    throw new Error(`Direct download exceeds ${Math.round(MEDIA_DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB limit`);
  }
  const parsed = new URL(url);
  const hintedName = String(nameHint || "").trim();
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const fallbackExt = contentType.includes("video/mp4") ? ".mp4" : ".bin";
  const baseName = sanitizeFileName(hintedName || decodeURIComponent(path.basename(parsed.pathname || "")), "download");
  const ext = path.extname(baseName) || fallbackExt;
  const rawFileName = sanitizeFileName(`${path.parse(baseName).name || "download"}${ext}`, "download");
  const fileName = await ensureUniqueFileNameInDir(dir, makeFileNameUnique(rawFileName));
  const target = path.join(dir, fileName);
  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > MEDIA_DOWNLOAD_MAX_BYTES) {
        callback(new Error(`Direct download exceeds ${Math.round(MEDIA_DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB limit`));
        return;
      }
      updateJob(job, { progress: declaredSize > 0 ? Math.min(99, Math.round((received / declaredSize) * 100)) : job.progress });
      callback(null, chunk);
    }
  });
  try {
    if (!response.body) throw new Error("Direct download response has no body");
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(target));
  } catch (error) {
    await fs.unlink(target).catch(() => null);
    throw error;
  }
  const normalizedName = await normalizeMediaFileNameOnDisk(dir, fileName);
  const normalizedPath = path.join(dir, normalizedName);
  const normalizedStats = await fs.stat(normalizedPath);
  const relPath = path.join(topic, normalizedName).split(path.sep).join("/");
  updateJob(job, { progress: 100 });
  return [{
    path: relPath,
    name: normalizedName,
    topic,
    size: normalizedStats.size,
    updated_at: normalizedStats.mtime.toISOString(),
    thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
  }];
}

function decodeDiscoveredMediaUrl(value) {
  return String(value ?? "")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#x2f;/gi, "/")
    .trim();
}

async function readTextLimited(response, maxBytes = MEDIA_DISCOVERY_MAX_HTML_BYTES) {
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxBytes) throw new Error("HTML page exceeds discovery limit");
  if (!response.body) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("HTML page exceeds discovery limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function collectVideoCandidates(html, pageUrl) {
  const found = new Map();
  const pageHost = new URL(pageUrl).hostname;
  const add = (rawUrl, source, baseScore) => {
    const decoded = decodeDiscoveredMediaUrl(rawUrl);
    if (!decoded || decoded.startsWith("data:") || decoded.startsWith("blob:")) return;
    let absoluteUrl = "";
    try {
      absoluteUrl = new URL(decoded, pageUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(absoluteUrl)) return;
    const parsed = new URL(absoluteUrl);
    if (!/\.(mp4|m4v|mov|webm|mkv|m3u8)(?:$|[?#])/i.test(parsed.pathname + parsed.search)) return;
    if (/(?:^|[\/_-])(live|livestream)(?:[\/_-]|$)/i.test(parsed.pathname)) return;
    let score = baseScore;
    if (parsed.hostname === pageHost) score += 20;
    if (/\.mp4(?:$|[?#])/i.test(parsed.pathname + parsed.search)) score += 15;
    const existing = found.get(absoluteUrl);
    if (!existing || score > existing.score) found.set(absoluteUrl, { url: absoluteUrl, source, score });
  };
  const patterns = [
    { source: "json-ld contentUrl", score: 100, regex: /["']contentUrl["']\s*:\s*["']([^"']+)["']/gi },
    { source: "og:video", score: 90, regex: /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi },
    { source: "og:video", score: 90, regex: /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::url)?["'][^>]*>/gi },
    { source: "video/source", score: 80, regex: /<(?:video|source)[^>]+src=["']([^"']+)["'][^>]*>/gi },
    { source: "direct URL", score: 70, regex: /["']((?:https?:)?\/\/[^"']+?\.(?:mp4|m4v|mov|webm|mkv|m3u8)(?:\?[^"']*)?)["']/gi },
    { source: "relative media URL", score: 65, regex: /["'](\/[^"']+?\.(?:mp4|m4v|mov|webm|mkv|m3u8)(?:\?[^"']*)?)["']/gi }
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern.regex)) add(match[1], pattern.source, pattern.score);
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, MEDIA_DISCOVERY_MAX_CANDIDATES);
}

async function probeVideoCandidate(candidate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    let response = await fetch(candidate.url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 UContent/0.1 media discovery" }
    });
    if (!response.ok || (!response.headers.get("content-type") && !response.headers.get("content-length"))) {
      response = await fetch(candidate.url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { range: "bytes=0-0", "user-agent": "Mozilla/5.0 UContent/0.1 media discovery" }
      });
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const contentLength = Number(response.headers.get("content-length") || 0);
    await response.body?.cancel().catch(() => null);
    if (!response.ok && response.status !== 206) return null;
    if (contentLength > MEDIA_DOWNLOAD_MAX_BYTES) return null;
    if (!contentType.startsWith("video/") && !contentType.includes("mpegurl") && !/\.(mp4|m4v|mov|webm|mkv|m3u8)(?:$|[?#])/i.test(candidate.url)) return null;
    return { ...candidate, content_type: contentType, content_length: contentLength };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverFallbackVideo(pageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(pageUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 UContent/0.1 media discovery" }
    });
    if (!response.ok) throw new Error(`Fallback page request failed: HTTP ${response.status}`);
    const html = await readTextLimited(response);
    const candidates = collectVideoCandidates(html, response.url || pageUrl);
    for (const candidate of candidates.slice(0, 8)) {
      const probed = await probeVideoCandidate(candidate);
      if (probed) return { candidate: probed, candidate_count: candidates.length };
    }
    return { candidate: null, candidate_count: candidates.length };
  } finally {
    clearTimeout(timer);
  }
}

async function captureDownloadFallbackScreenshot(job, pageUrl, topic, dir) {
  const scriptPath = path.join(__dirname, "tools", "screenshot-engine", "link-screenshot.js");
  if (!(await pathExists(scriptPath))) throw new Error("Screenshot engine is unavailable");
  const host = asciiFilePart(new URL(pageUrl).hostname, "page");
  const fileName = await ensureUniqueFileNameInDir(dir, `download_fallback_${host}.png`);
  const target = path.join(dir, fileName);
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    "--url", pageUrl,
    "--width", "1920",
    "--height", "1080",
    "--zoom", "100",
    "--timeout_ms", "30000"
  ], { windowsHide: true, timeout: 45000, encoding: "buffer", maxBuffer: 24 * 1024 * 1024 });
  if (!Buffer.isBuffer(stdout) || stdout.length < 1024) throw new Error("Screenshot engine returned no image");
  await fs.writeFile(target, stdout);
  const relPath = path.join(topic, fileName).split(path.sep).join("/");
  const file = {
    path: relPath,
    name: fileName,
    topic,
    size: stdout.length,
    updated_at: new Date().toISOString(),
    thumbnail: `/api/media/raw?path=${encodeURIComponent(relPath)}`
  };
  updateJob(job, { fallback_screenshot: file });
  return file;
}

function isDirectDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|wav|jpg|jpeg|png|webp|gif)(?:$|[?#])/i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

async function runYtDlpDownload(job, tools, url, dir) {
  if (!tools.yt_dlp_path) throw new Error("yt-dlp is not available");
  const outputTemplate = path.join(dir, "%(title).120B [%(id)s].%(ext)s");
  const formatSelector = isVkDownloadUrl(url)
    ? `url1080/url720/url480/url360/${DEFAULT_YTDLP_FORMAT}`
    : DEFAULT_YTDLP_FORMAT;
  const args = [
    "--newline",
    "--no-update",
    "--no-mtime",
    "--no-playlist",
    "--playlist-end", "1",
    "--max-filesize", "1G",
    "--socket-timeout", "30",
    "--retries", "3",
    "--fragment-retries", "3",
    "--match-filter", "!is_live",
    "--windows-filenames",
    "--restrict-filenames",
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
    "--print",
    "before_dl:__META_TITLE__%(title)s",
    "--print",
    "before_dl:__META_DESCRIPTION__%(description)s",
    "--print",
    "before_dl:__META_UPLOADER__%(uploader)s",
    "--print",
    "before_dl:__META_UPLOADER_URL__%(uploader_url)s",
    "--print",
    "before_dl:__META_WEBPAGE_URL__%(webpage_url)s",
    "--print",
    "before_dl:__META_FORMAT_NOTE__%(format_note)s",
    "--print",
    "before_dl:__META_RESOLUTION__%(resolution)s",
    "--format",
    formatSelector,
    "--merge-output-format",
    "mp4",
    "--output",
    outputTemplate,
    url
  ];
  const cookiesPath = String(process.env.MEDIA_COOKIES_PATH || "").trim();
  const cookiesFromBrowser = String(process.env.MEDIA_COOKIES_FROM_BROWSER || "").trim();
  if (cookiesPath) args.splice(args.length - 1, 0, "--cookies", cookiesPath);
  else if (cookiesFromBrowser) args.splice(args.length - 1, 0, "--cookies-from-browser", cookiesFromBrowser);
  if (tools.ffmpeg_path && (tools.ffmpeg_path.includes("/") || tools.ffmpeg_path.includes("\\"))) {
    args.splice(args.length - 1, 0, "--ffmpeg-location", path.dirname(tools.ffmpeg_path));
  }
  await runCommand(job, tools.yt_dlp_path, args, { cwd: dir });
}

async function runGalleryDlDownload(job, tools, url, dir, options = {}) {
  if (!tools.gallery_dl_path) throw new Error("gallery-dl is not available");
  const galleryArgs = ["--range", "1", "--post-range", "1", "--write-metadata"];
  if (options.childRange) galleryArgs.push("--child-range", String(options.childRange));
  galleryArgs.push("--filesize-max", "1G", "-D", dir, url);
  const args = tools.gallery_dl_mode === "python_module"
    ? ["-m", "gallery_dl", ...galleryArgs]
    : galleryArgs;
  await runCommand(job, tools.gallery_dl_path, args, { cwd: dir });
}

async function getYtDlpDirectUrl(job, tools, url, formatSelector) {
  if (!tools.yt_dlp_path) throw new Error("yt-dlp is not available");
  const args = [
    "--no-update",
    "--no-playlist",
    "--playlist-end", "1",
    "--socket-timeout", "30",
    "--retries", "3",
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
    "--print", "__META_TITLE__%(title)s",
    "--print", "__META_DESCRIPTION__%(description)s",
    "--print", "__META_UPLOADER__%(uploader)s",
    "--print", "__META_UPLOADER_URL__%(uploader_url)s",
    "--print", "__META_WEBPAGE_URL__%(webpage_url)s",
    "--print", "__META_FORMAT_NOTE__%(format_note)s",
    "--print", "__META_RESOLUTION__%(resolution)s",
    "--format", formatSelector,
    "--get-url",
    url
  ];
  const cookiesPath = String(process.env.MEDIA_COOKIES_PATH || "").trim();
  const cookiesFromBrowser = String(process.env.MEDIA_COOKIES_FROM_BROWSER || "").trim();
  if (cookiesPath) args.splice(args.length - 1, 0, "--cookies", cookiesPath);
  else if (cookiesFromBrowser) args.splice(args.length - 1, 0, "--cookies-from-browser", cookiesFromBrowser);
  const output = await runCommand(job, tools.yt_dlp_path, args, { cwd: process.cwd() });
  const urls = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => /^https?:\/\//i.test(line));
  return urls[urls.length - 1] || "";
}

async function executeMediaDownload(job) {
  let downloadDir = "";
  let before = [];
  let stagingDir = "";
  try {
    updateJob(job, { state: "running", stage: "standard", progress: 0 });
    job.url = normalizeVkDownloadUrl(job.url);
    const safeTopic = sanitizeMediaTopicName(job.topic);
    await fs.mkdir(PAMPAM_ROOT, { recursive: true });
    stagingDir = await createDownloadStagingDir(job.id);
    const dir = stagingDir;
    job.topic = safeTopic;
    job.output_dir = dir;
    downloadDir = dir;
    before = await listImmediateFiles(dir);
    const tools = await resolveDownloaderTools();
    updateJob(job, { tools });
    if (isDirectDownloadUrl(job.url)) {
      const stagedFiles = await downloadDirectFile(job, job.url, safeTopic, dir);
      const outputFiles = await publishDownloadedFilesFromStaging(job, dir, stagedFiles, safeTopic);
      await registerDownloadedMedia(job, outputFiles);
      updateJob(job, { state: "completed", progress: 100, output_files: outputFiles, output_dir: path.join(PAMPAM_ROOT, safeTopic) });
      return;
    }
    let downloadSucceeded = false;
    let ytDlpError = null;
    let galleryDlError = null;

    if (isVkDownloadUrl(job.url)) {
      updateJob(job, { stage: "vk_direct", progress: 0 });
      try {
        const directUrl = await getYtDlpDirectUrl(job, tools, job.url, "url1080/url720/url480/url360/best[ext=mp4]/best");
        if (!directUrl) throw new Error("yt-dlp did not return a VK direct media URL");
        const titleName = sanitizeFileName(`${job.meta_title || "vk_video"}.mp4`, "vk_video.mp4");
        const stagedFiles = await downloadDirectFile(job, directUrl, safeTopic, dir, titleName, {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
          "referer": "https://vk.com/"
        });
        const outputFiles = await publishDownloadedFilesFromStaging(job, dir, stagedFiles, safeTopic);
        await registerDownloadedMedia(job, outputFiles);
        updateJob(job, { state: "completed", stage: "completed", progress: 100, output_files: outputFiles, output_dir: path.join(PAMPAM_ROOT, safeTopic) });
        return;
      } catch (error) {
        ytDlpError = error;
        updateJob(job, { log: `${job.log || ""}\nVK direct download failed: ${error.message}`.slice(-2000) });
      }
    }

    try {
      await runYtDlpDownload(job, tools, job.url, dir);
      await removeNewStandaloneAudioFiles(dir, before);
      const afterYt = await listNewOutputFiles(safeTopic, dir, before);
      if (afterYt.length > 0) {
        downloadSucceeded = true;
        if (isXOrTwitter(job.url) && tools.gallery_dl_path) {
          try {
            updateJob(job, { stage: "twitter_quality_compare" });
            await runGalleryDlDownload(job, tools, job.url, dir, { childRange: "1-10" });
            await removeNewStandaloneAudioFiles(dir, before);
            await applyGalleryMetadataSidecars(job, dir);
            await pruneLowerQualityDuplicateVideos(job, dir, before);
          } catch (error) {
            galleryDlError = error;
            updateJob(job, { log: `${job.log || ""}\ngallery-dl quality comparison failed: ${error.message}`.slice(-2000) });
          }
        }
      } else {
        ytDlpError = new Error("yt-dlp completed but produced no output files");
      }
    } catch (error) {
      ytDlpError = error;
    }

    if (!downloadSucceeded && tools.gallery_dl_path) {
      const reason = ytDlpError ? ytDlpError.message : "no files produced";
      updateJob(job, { log: `${job.log || ""}\nyt-dlp failed or got no media (${reason}), trying gallery-dl fallback...`.slice(-2000) });
      try {
        await runGalleryDlDownload(job, tools, job.url, dir, { childRange: isXOrTwitter(job.url) ? "1-10" : "1" });
        await removeNewStandaloneAudioFiles(dir, before);
        await applyGalleryMetadataSidecars(job, dir);
        const afterGallery = await listNewOutputFiles(safeTopic, dir, before);
        downloadSucceeded = afterGallery.length > 0;
        if (!downloadSucceeded) galleryDlError = new Error("gallery-dl completed but produced no output files");
      } catch (error) {
        galleryDlError = error;
      }
    }

    if (!downloadSucceeded) {
      updateJob(job, { stage: "discovering", progress: 0 });
      let discovery = { candidate: null, candidate_count: 0 };
      try {
        discovery = await discoverFallbackVideo(job.url);
      } catch (error) {
        updateJob(job, { log: `${job.log || ""}\nFallback discovery failed: ${error.message}`.slice(-2000) });
      }
      updateJob(job, { discovered_candidates: discovery.candidate_count, fallback_candidate: discovery.candidate || null });
      if (discovery.candidate) {
        updateJob(job, {
          stage: "fallback_download",
          log: `${job.log || ""}\nSelected ${discovery.candidate.source}: ${discovery.candidate.url}`.slice(-2000)
        });
        if (/\.m3u8(?:$|[?#])/i.test(discovery.candidate.url)) {
          await runYtDlpDownload(job, tools, discovery.candidate.url, dir);
        } else {
          await downloadDirectFile(job, discovery.candidate.url, safeTopic, dir);
        }
        downloadSucceeded = true;
      }
    }

    if (!downloadSucceeded) {
      updateJob(job, { stage: "fallback_screenshot", progress: 0 });
      if (job.capture_fallback_screenshot) {
        try {
          await captureDownloadFallbackScreenshot(job, job.url, safeTopic, dir);
        } catch (error) {
          updateJob(job, { log: `${job.log || ""}\nFallback screenshot failed: ${error.message}`.slice(-2000) });
        }
      }
      const screenshotFiles = job.fallback_screenshot ? [job.fallback_screenshot] : [];
      if (screenshotFiles.length) {
        const outputFiles = await publishDownloadedFilesFromStaging(job, dir, screenshotFiles, safeTopic);
        await registerDownloadedMedia(job, outputFiles);
        updateJob(job, {
          state: "completed",
          stage: "screenshot_only",
          progress: 100,
          fallback_only: true,
          warning: "Video download failed; saved a page screenshot instead",
          output_files: outputFiles,
          output_dir: path.join(PAMPAM_ROOT, safeTopic)
        });
        return;
      }
      const reasons = [ytDlpError?.message, galleryDlError?.message].filter(Boolean).join(" | ");
      throw new Error(reasons || "No media downloader or safe fallback succeeded");
    }

    const stagedFiles = await listNewOutputFiles(safeTopic, dir, before);
    if (!stagedFiles.length) throw new Error("Download finished, but no media output files were found");
    applyOutputFileMetadataFallback(job, stagedFiles);
    const outputFiles = await publishDownloadedFilesFromStaging(job, dir, stagedFiles, safeTopic);
    await registerDownloadedMedia(job, outputFiles);
    updateJob(job, { state: "completed", stage: "completed", progress: 100, output_files: outputFiles, output_dir: path.join(PAMPAM_ROOT, safeTopic) });
  } catch (error) {
    updateJob(job, { state: "failed", error: error?.message || "Download failed" });
  } finally {
    if (downloadDir) {
      await removeDownloadTempFiles(downloadDir, before).catch(() => null);
    }
    if (stagingDir) {
      const quarantineDir = await quarantineStagingDir(stagingDir, job.id).catch(() => "");
      if (quarantineDir) updateJob(job, { quarantine_dir: quarantineDir });
    }
    delete job.process;
  }
}

async function handleMediaDownload(req, res) {
  const body = await readBody(req);
  const url = normalizeHttpUrl(body.url);
  if (!url) {
    json(res, 400, { error: "url must be http(s)" });
    return;
  }
  const topic = String(body.topic || "").trim();
  const job = {
    id: makeJobId(),
    url,
    topic,
    segment_id: String(body.segmentId || body.segment_id || "").trim(),
    capture_fallback_screenshot: body.captureFallbackScreenshot !== false && body.capture_fallback_screenshot !== false,
    state: "queued",
    progress: 0,
    output_files: [],
    meta_title: null,
    meta_description: null,
    meta_uploader: null,
    meta_uploader_url: null,
    meta_webpage_url: null,
    meta_format_note: null,
    meta_resolution: null,
    error: "",
    log: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  MEDIA_JOBS.set(job.id, job);
  setTimeout(() => void executeMediaDownload(job), 0);
  json(res, 200, { job });
}

function handleMediaDownloadJob(reqUrl, res) {
  const id = decodeURIComponent(reqUrl.pathname.split("/").filter(Boolean)[2] || "");
  const job = MEDIA_JOBS.get(id);
  if (!job) {
    json(res, 404, { error: "job not found" });
    return;
  }
  json(res, 200, { job });
}

function segmentKind(text) {
  const trimmed = String(text ?? "").trim();
  if (/^https?:\/\/\S+$/i.test(trimmed) && !trimmed.includes("\n")) return "link";
  if (trimmed.startsWith("/")) return "direction";
  return trimmed ? "text" : "";
}

function shouldIgnoreContentLine(line) {
  return String(line ?? "").trim() === "Оформление видео";
}

function normalizeSegmentText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeTextForMatch(text) {
  return normalizeSegmentText(text)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForMatch(text) {
  const normalized = normalizeTextForMatch(text);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length > 1);
}

function jaccardSimilarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function countTokenIntersection(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const left = new Set(tokensA);
  let count = 0;
  for (const token of new Set(tokensB)) {
    if (left.has(token)) count += 1;
  }
  return count;
}

function hasMeaningfulTokenOverlap(tokensA = [], tokensB = []) {
  if (!Array.isArray(tokensA) || !Array.isArray(tokensB) || !tokensA.length || !tokensB.length) return false;
  const right = new Set(tokensB);
  let overlap = 0;
  let significantOverlap = 0;
  for (const token of new Set(tokensA)) {
    if (!right.has(token)) continue;
    overlap += 1;
    if (String(token).length >= 6) significantOverlap += 1;
  }
  return overlap >= 2 || significantOverlap >= 1;
}

function segmentMatchKey(segment, includeTopic = true) {
  const topic = includeTopic ? normalizeSegmentText(segment.topic) : "";
  return [topic, segment.kind, normalizeSegmentText(segment.text)].join("\u001f");
}

function sectionMatchKey(segment) {
  return normalizeTextForMatch(segment?.topic || "");
}

function segmentIdSeed(segment, index) {
  const hash = createHash("sha1")
    .update([segment.kind, segment.topic, segment.text].join("\u001f"))
    .digest("hex")
    .slice(0, 12);
  return `seg_${hash}_${index + 1}`;
}

function uniqueSegmentId(seed, usedIds) {
  let id = seed;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${seed}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function parseContentSegments(content) {
  const segments = [];
  let topic = "";
  let current = null;

  function flush() {
    if (!current) return;
    const text = current.lines.join("\n").trim();
    const kind = segmentKind(text);
    if (text && kind) {
      segments.push({ start: current.start, end: current.end, topic, kind, text });
    }
    current = null;
  }

  String(content ?? "").split(/\r?\n/).forEach((line, index) => {
    const trimmed = String(line ?? "").trim();
    if (trimmed.startsWith("### ")) {
      flush();
      topic = trimmed.replace(/^###\s+/, "").trim();
      return;
    }
    if (!trimmed || trimmed.startsWith("# ") || shouldIgnoreContentLine(trimmed)) {
      flush();
      return;
    }
    if (!current) current = { start: index, lines: [] };
    current.end = index;
    current.lines.push(line);
  });
  flush();
  return segments;
}

function parseMarkdownTopics(content) {
  return String(content ?? "")
    .split(/\r?\n/)
    .map((line) => String(line ?? "").trim())
    .filter((line) => line.startsWith("### "))
    .map((line) => line.replace(/^###\s+/, "").trim())
    .filter(Boolean)
    .filter((topic) => !/^(intro|интро|outro|аутро|конец|финал)$/i.test(topic));
}

function existingContentUrls(content) {
  const urls = new Set();
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const value = line.trim();
    if (/^https?:\/\/\S+$/i.test(value)) urls.add(value.replace(/#.*$/, "").replace(/\/$/, ""));
  }
  return urls;
}

async function runUtrendsJson(args) {
  const { stdout, stderr } = await execFileAsync(
    UTRENDS_PYTHON,
    ["-m", "utrends.rss_candidates", ...args],
    {
      cwd: UTRENDS_ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      maxBuffer: 10 * 1024 * 1024
    }
  );
  const text = String(stdout || "").trim();
  if (!text) {
    throw new Error(String(stderr || "UTrends returned empty response").trim());
  }
  return JSON.parse(text);
}

async function handleRssCandidates(reqUrl, res, id) {
  const scrape = await readScrape(id);
  const topics = parseMarkdownTopics(scrape.content || "");
  const hours = Math.max(1, Math.min(24 * 90, Number(reqUrl.searchParams.get("hours") || 504)));
  const limit = Math.max(1, Math.min(12, Number(reqUrl.searchParams.get("limit") || 5)));
  const useSearxng = reqUrl.searchParams.get("searxng") !== "0";
  const payload = await runUtrendsJson([
    "candidates",
    "--topics-json", JSON.stringify(topics),
    "--hours", String(hours),
    "--limit", String(limit),
    ...(useSearxng ? [] : ["--no-searxng"])
  ]);
  const existing = existingContentUrls(scrape.content || "");
  const byTopic = {};
  for (const [topic, items] of Object.entries(payload.topics || {})) {
    byTopic[topic] = (Array.isArray(items) ? items : []).filter((item) => {
      const url = String(item?.url || "").replace(/#.*$/, "").replace(/\/$/, "");
      return url && !existing.has(url);
    });
  }
  json(res, 200, { topics: byTopic, hours, limit, scrape_id: scrape.id });
}

async function handleRejectRssCandidate(req, res) {
  const body = await readBody(req);
  const topic = String(body.topic || "").trim();
  const url = String(body.url || "").trim();
  if (!topic || !url) {
    json(res, 400, { error: "topic and url are required" });
    return;
  }
  const payload = await runUtrendsJson(["reject", "--topic", topic, "--url", url]);
  json(res, 200, payload);
}

async function handleRssSearch(req, res) {
  const body = await readBody(req);
  const query = String(body.query || "").trim();
  if (!query) {
    json(res, 400, { error: "query is required" });
    return;
  }
  const hours = Math.max(1, Math.min(24 * 90, Number(body.hours || 504)));
  const limit = Math.max(1, Math.min(12, Number(body.limit || 6)));
  const useSearxng = body.searxng !== false;
  const payload = await runUtrendsJson([
    "search",
    "--query", query,
    "--hours", String(hours),
    "--limit", String(limit),
    ...(useSearxng ? [] : ["--no-searxng"])
  ]);
  json(res, 200, payload);
}

function buildSegmentIndexes(previousSegments) {
  const byTopic = new Map();
  const byText = new Map();
  const meta = [];
  for (const [index, segment] of (previousSegments || []).entries()) {
    if (!segment?.id) continue;
    const topicKey = segmentMatchKey(segment, true);
    const textKey = segmentMatchKey(segment, false);
    if (!byTopic.has(topicKey)) byTopic.set(topicKey, []);
    if (!byText.has(textKey)) byText.set(textKey, []);
    byTopic.get(topicKey).push(segment);
    byText.get(textKey).push(segment);
    meta.push({
      segment,
      index,
      normalized: normalizeTextForMatch(segment.text),
      tokens: tokenizeForMatch(segment.text),
      sectionKey: sectionMatchKey(segment)
    });
  }
  const bySection = new Map();
  for (const item of meta) {
    if (!item.sectionKey) continue;
    if (!bySection.has(item.sectionKey)) bySection.set(item.sectionKey, []);
    bySection.get(item.sectionKey).push(item);
  }
  return { byTopic, byText, bySection, meta };
}

function takeFirstUnused(queue, usedIds) {
  if (!queue) return null;
  while (queue.length) {
    const candidate = queue.shift();
    if (candidate?.id && !usedIds.has(candidate.id)) return candidate;
  }
  return null;
}

function findBestFuzzySegment({
  segment,
  normalized,
  tokens,
  sectionKey,
  candidates,
  usedIds,
  minScore,
  targetIndex
}) {
  if (!normalized || normalized.length < 35 || tokens.length < 4) return null;
  let best = null;
  let bestScore = 0;
  for (const item of candidates || []) {
    const candidate = item.segment;
    if (!candidate?.id || usedIds.has(candidate.id)) continue;
    if (segment.kind && candidate.kind && segment.kind !== candidate.kind) continue;
    if (!item.tokens.length) continue;
    if (sectionKey && item.sectionKey && sectionKey !== item.sectionKey) continue;
    const overlap = countTokenIntersection(tokens, item.tokens);
    if (overlap < 3) continue;
    const similarity = jaccardSimilarity(tokens, item.tokens);
    if (similarity <= 0) continue;
    const sectionBonus = sectionKey && item.sectionKey && sectionKey === item.sectionKey ? 0.12 : 0;
    const kindBonus = segment.kind === candidate.kind ? 0.08 : 0;
    const lengthRatio = Math.min(normalized.length, item.normalized.length) / Math.max(normalized.length, item.normalized.length);
    const lengthBonus = Number.isFinite(lengthRatio) ? lengthRatio * 0.08 : 0;
    const indexPenalty = Math.min(0.24, Math.abs(Number(item.index || 0) - Number(targetIndex || 0)) * 0.02);
    const score = similarity + sectionBonus + kindBonus + lengthBonus - indexPenalty;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best && bestScore >= minScore ? { ...best, score: Number(bestScore.toFixed(4)) } : null;
}

function pickSectionSlotFallback({ segment, sectionKey, newIndex, newMeta, oldBySection, usedIds }) {
  if (!sectionKey) return null;
  const newSectionItems = newMeta.filter((item) => item.sectionKey === sectionKey && item.segment.kind === segment.kind);
  const oldSectionItems = (oldBySection.get(sectionKey) || []).filter((item) => item.segment.kind === segment.kind);
  if (!newSectionItems.length || !oldSectionItems.length) return null;
  if (newSectionItems.length !== oldSectionItems.length) return null;
  const slotIndex = newSectionItems.findIndex((item) => item.index === newIndex);
  if (slotIndex < 0) return null;
  const candidate = oldSectionItems[slotIndex];
  if (!candidate?.segment?.id || usedIds.has(candidate.segment.id)) return null;
  const newItem = newSectionItems[slotIndex];
  if (!hasMeaningfulTokenOverlap(candidate.tokens, newItem.tokens)) return null;
  return candidate;
}

function cloneSegmentState(source) {
  const mediaItems = normalizeMediaItems(source);
  return {
    media: mediaItems[0] || null,
    media_items: mediaItems,
    media_layout: normalizeMediaLayout(source?.media_layout),
    is_done: Boolean(source?.is_done),
    suppressed_link_previews: normalizeSuppressedLinkPreviews(source?.suppressed_link_previews)
  };
}

function normalizeMediaLayout() {
  // ponytail: layout toggle is hidden for now; restore "sequential" here if the UI comes back.
  return "stacked";
}

function normalizeMediaItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mediaLocator = String(raw.path || raw.url || raw.thumbnail || "").split(/[?#]/, 1)[0];
  const isStaticImage = /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(mediaLocator);
  const item = {
    url: String(raw.url || "").trim(),
    path: String(raw.path || "").trim(),
    thumbnail: String(raw.thumbnail || "").trim(),
    timecode: isStaticImage ? "" : String(raw.timecode || raw.start_timecode || raw.media_start_timecode || "").trim(),
    source_url: String(raw.source_url || raw.webpage_url || "").trim(),
    title: String(raw.title || raw.meta_title || "").trim(),
    description: String(raw.description || raw.meta_description || "").trim(),
    uploader: String(raw.uploader || raw.meta_uploader || "").trim(),
    uploader_url: String(raw.uploader_url || raw.meta_uploader_url || "").trim(),
    webpage_url: String(raw.webpage_url || raw.source_url || raw.url || "").trim(),
    format_note: String(raw.format_note || raw.meta_format_note || "").trim(),
    resolution: String(raw.resolution || raw.meta_resolution || "").trim()
  };
  return item.url || item.path || item.thumbnail ? item : null;
}

function normalizeMediaItems(segmentOrItems) {
  const rawItems = Array.isArray(segmentOrItems)
    ? segmentOrItems
    : Array.isArray(segmentOrItems?.media_items)
      ? segmentOrItems.media_items
      : [];
  const items = rawItems.map(normalizeMediaItem).filter(Boolean);
  const legacy = Array.isArray(segmentOrItems) ? null : normalizeMediaItem(segmentOrItems?.media);
  if (legacy && !items.some((item) => item.url === legacy.url && item.path === legacy.path && item.thumbnail === legacy.thumbnail)) {
    items.unshift(legacy);
  }
  return items.slice(0, 50);
}

function isImageMediaPath(value) {
  return /\.(png|jpe?g|webp|gif|avif)$/i.test(String(value || "").split(/[?#]/, 1)[0]);
}

function normalizeSuppressedLinkPreviews(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => normalizeHttpUrl(item))
    .filter(Boolean))].slice(0, 200);
}

function isAutomaticPreviewItem(item) {
  return /^preview_[a-f0-9]{12}\./i.test(path.posix.basename(String(item?.path || "").replace(/\\/g, "/")));
}

async function deleteAutomaticPreviewFile(item) {
  if (!isAutomaticPreviewItem(item)) return false;
  const rel = String(item?.path || "").replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (!rel || rel.split("/").some((part) => part === "..")) return false;
  const absolutePath = safeResolveMediaPathForRoot(PAMPAM_ROOT, rel);
  if (!absolutePath) return false;
  await fs.unlink(absolutePath).catch(() => null);
  await MEDIA_INDEX.remove?.(rel).catch(() => null);
  return true;
}

function dedupeScrapeImageAssignments(scrape) {
  const segments = Array.isArray(scrape?.segments) ? scrape.segments : [];
  const previewOwners = new Map();
  for (const segment of segments) {
    const type = String(segment?.type || segment?.kind || "").toLowerCase();
    const source = String(segment?.text || "").trim();
    if (type === "link" && /^https?:\/\/\S+$/i.test(source) && !previewOwners.has(source)) {
      previewOwners.set(source, segment.id);
    }
  }
  const seenPaths = new Set();
  const seenAutomaticPreviewSources = new Set();
  for (const segment of segments) {
    const nextItems = [];
    for (const item of normalizeMediaItems(segment)) {
      if (item.path) {
        const rel = String(item.path).replace(/^[/\\]+/, "").replace(/\\/g, "/");
        if (rel && !rel.split("/").some((part) => part === "..")) {
          const absolutePath = safeResolveMediaPathForRoot(PAMPAM_ROOT, rel);
          if (!absolutePath || !existsSync(absolutePath)) continue;
        }
      }
      const mediaPath = String(item.path || "").replace(/\\/g, "/");
      const imageKey = isImageMediaPath(mediaPath || item.url || item.thumbnail) ? mediaPath.toLowerCase() : "";
      const isAutomaticPreview = /^preview_[a-f0-9]{12}\./i.test(path.posix.basename(mediaPath));
      const previewSource = isAutomaticPreview ? String(item.source_url || item.webpage_url || "").trim() : "";
      const previewOwner = previewSource ? previewOwners.get(previewSource) : "";
      if (previewOwner && previewOwner !== segment.id) continue;
      if (imageKey && seenPaths.has(imageKey)) continue;
      if (previewSource && seenAutomaticPreviewSources.has(previewSource)) continue;
      if (imageKey) seenPaths.add(imageKey);
      if (previewSource) seenAutomaticPreviewSources.add(previewSource);
      nextItems.push(item);
    }
    segment.media_items = nextItems;
    segment.media = nextItems[0] || null;
  }
  return scrape;
}

function assignSegmentIds(content, previousSegments = []) {
  const parsed = parseContentSegments(content);
  const indexes = buildSegmentIndexes(previousSegments);
  const usedIds = new Set();
  let reused = 0;
  let created = 0;
  let changed = 0;
  let moved = 0;
  const syncDebug = [];
  const newMeta = parsed.map((segment, index) => ({
    segment,
    index,
    normalized: normalizeTextForMatch(segment.text),
    tokens: tokenizeForMatch(segment.text),
    sectionKey: sectionMatchKey(segment)
  }));
  const segments = parsed.map((segment, index) => {
    const exactTopic = takeFirstUnused(indexes.byTopic.get(segmentMatchKey(segment, true)), usedIds);
    const exactText = exactTopic || takeFirstUnused(indexes.byText.get(segmentMatchKey(segment, false)), usedIds);
    const sectionKey = sectionMatchKey(segment);
    const normalized = normalizeTextForMatch(segment.text);
    const tokens = tokenizeForMatch(segment.text);
    let matched = exactText;
    let status = exactTopic ? "same" : exactText ? "moved" : "";
    let matchMethod = exactTopic ? "exact_topic" : exactText ? "exact_text" : "";
    let matchScore = exactTopic || exactText ? 1 : null;

    if (!matched) {
      const sectionFuzzy = findBestFuzzySegment({
        segment,
        normalized,
        tokens,
        sectionKey,
        candidates: indexes.bySection.get(sectionKey) || [],
        usedIds,
        minScore: 0.62,
        targetIndex: index
      });
      const globalFuzzy = sectionFuzzy || findBestFuzzySegment({
        segment,
        normalized,
        tokens,
        sectionKey,
        candidates: indexes.meta,
        usedIds,
        minScore: 0.78,
        targetIndex: index
      });
      if (globalFuzzy) {
        matched = globalFuzzy.segment;
        status = "changed";
        matchMethod = sectionFuzzy ? "fuzzy_section" : "fuzzy_global";
        matchScore = globalFuzzy.score ?? null;
      }
    }

    if (!matched) {
      const slotFallback = pickSectionSlotFallback({
        segment,
        sectionKey,
        newIndex: index,
        newMeta,
        oldBySection: indexes.bySection,
        usedIds
      });
      if (slotFallback) {
        matched = slotFallback.segment;
        status = "changed";
        matchMethod = "slot_fallback";
        matchScore = null;
      }
    }

    if (matched) {
      usedIds.add(matched.id);
      reused += 1;
      if (status === "changed") changed += 1;
      if (status === "moved") moved += 1;
      syncDebug.push({
        id: matched.id,
        new_index: index,
        old_index: indexes.meta.find((item) => item.segment.id === matched.id)?.index ?? null,
        status,
        match_method: matchMethod,
        match_score: matchScore,
        topic: segment.topic || "",
        text: segment.text.slice(0, 160)
      });
      return {
        ...segment,
        id: matched.id,
        type: segment.kind,
        ...cloneSegmentState(matched),
        status,
        sync_debug: {
          matched_from: matched.id,
          match_method: matchMethod,
          match_score: matchScore
        }
      };
    }
    created += 1;
    syncDebug.push({
      id: null,
      new_index: index,
      old_index: null,
      status: "new",
      match_method: "new",
      match_score: null,
      topic: segment.topic || "",
      text: segment.text.slice(0, 160)
    });
    return {
      ...segment,
      id: uniqueSegmentId(segmentIdSeed(segment, index), usedIds),
      type: segment.kind,
      media: null,
      media_items: [],
      media_layout: "stacked",
      is_done: false,
      status: "new",
      sync_debug: {
        matched_from: "",
        match_method: "new",
        match_score: null
      }
    };
  });
  const previousCount = Array.isArray(previousSegments) ? previousSegments.length : 0;
  return {
    segments,
    report: {
      total: segments.length,
      reused,
      created,
      changed,
      moved,
      same: Math.max(0, reused - changed - moved),
      removed: Math.max(0, previousCount - reused),
      debug: syncDebug
    }
  };
}

function preserveEnrichedLinkSegments(content, previousSegments = []) {
  const lines = String(content ?? "").replace(/\r\n/g, "\n").split("\n");
  const existingUrls = new Set(lines.map((line) => normalizeHttpUrl(line)).filter(Boolean));
  const candidates = (Array.isArray(previousSegments) ? previousSegments : [])
    .filter((segment) => (segment.kind === "link" || segment.type === "link"))
    .map((segment) => ({ url: normalizeHttpUrl(segment.text), topic: String(segment.topic || "").trim() }))
    .filter((item) => item.url && !existingUrls.has(item.url));
  const preserved = [];
  for (const candidate of candidates) {
    const headingIndex = lines.findIndex((line) => {
      const match = line.match(/^#{2,6}\s+(.+?)\s*$/);
      return match && normalizeTextForMatch(match[1]) === normalizeTextForMatch(candidate.topic);
    });
    if (headingIndex >= 0) {
      let insertAt = headingIndex + 1;
      while (insertAt < lines.length && !lines[insertAt].trim()) insertAt += 1;
      lines.splice(insertAt, 0, candidate.url, "");
    } else if (candidate.topic) {
      if (lines.length && lines.at(-1)?.trim()) lines.push("");
      lines.push(`### ${candidate.topic}`, "", candidate.url);
    } else {
      lines.push("", candidate.url);
    }
    existingUrls.add(candidate.url);
    preserved.push(candidate.url);
  }
  return { content: lines.join("\n"), preserved };
}

function buildXmlForScrape(scrape) {
  const title = titleFromContent(scrape?.content ?? "");
  const segments = Array.isArray(scrape?.segments) && scrape.segments.length
    ? scrape.segments
    : assignSegmentIds(scrape?.content ?? "").segments;
  const markers = segments
    .map((segment, index) => {
      const start = index * 150;
      const end = start + 150;
      const markerName = segment.text;
      return [
        "    <marker>",
        "      <comment></comment>",
        `      <name>${xmlEscape(markerName)}</name>`,
        `      <in>${start}</in>`,
        `      <out>${end}</out>`,
        "      <pproColor>MarkerColor.1</pproColor>",
        `      <comment>${xmlEscape(segment.text)}</comment>`,
        "    </marker>"
      ].join("\n");
    })
    .join("\n");

  const duration = Math.max(150, segments.length * 150);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    "    <uuid>00000000-0000-0000-0000-000000000000</uuid>",
    `    <name>${xmlEscape(title)}</name>`,
    `    <duration>${duration}</duration>`,
    "    <rate>",
    "      <timebase>50</timebase>",
    "      <ntsc>FALSE</ntsc>",
    "    </rate>",
    "    <media>",
    "      <video>",
    "        <format>",
    "          <samplecharacteristics>",
    "            <rate>",
    "              <timebase>50</timebase>",
    "              <ntsc>FALSE</ntsc>",
    "            </rate>",
    "            <width>1920</width>",
    "            <height>1080</height>",
    "            <anamorphic>FALSE</anamorphic>",
    "            <pixelaspectratio>square</pixelaspectratio>",
    "            <fielddominance>none</fielddominance>",
    "            <colordepth>24</colordepth>",
    "          </samplecharacteristics>",
    "        </format>",
    "        <track>",
    "          <enabled>TRUE</enabled>",
    "          <locked>FALSE</locked>",
    "        </track>",
    "      </video>",
    "      <audio>",
    "        <numOutputChannels>2</numOutputChannels>",
    "        <format>",
    "          <samplecharacteristics>",
    "            <depth>16</depth>",
    "            <samplerate>48000</samplerate>",
    "          </samplecharacteristics>",
    "        </format>",
    "        <outputs>",
    "          <group>",
    "            <index>1</index>",
    "            <numchannels>1</numchannels>",
    "            <downmix>0</downmix>",
    "            <channel>",
    "              <index>1</index>",
    "            </channel>",
    "          </group>",
    "          <group>",
    "            <index>2</index>",
    "            <numchannels>1</numchannels>",
    "            <downmix>0</downmix>",
    "            <channel>",
    "              <index>2</index>",
    "            </channel>",
    "          </group>",
    "        </outputs>",
    "        <track>",
    "          <enabled>TRUE</enabled>",
    "          <locked>FALSE</locked>",
    "          <outputchannelindex>1</outputchannelindex>",
    "        </track>",
    "        <track>",
    "          <enabled>TRUE</enabled>",
    "          <locked>FALSE</locked>",
    "          <outputchannelindex>2</outputchannelindex>",
    "        </track>",
    "      </audio>",
    "    </media>",
    markers,
    "    <timecode>",
    "      <rate>",
    "        <timebase>50</timebase>",
    "        <ntsc>FALSE</ntsc>",
    "      </rate>",
    "      <string>00:00:00:00</string>",
    "      <frame>0</frame>",
    "      <displayformat>NDF</displayformat>",
    "    </timecode>",
    "  </sequence>",
    "</xmeml>"
  ].filter(Boolean).join("\n");
}

async function buildVbautXmlForScrape(scrape) {
  const segments = Array.isArray(scrape?.segments) && scrape.segments.length
    ? scrape.segments
    : assignSegmentIds(scrape?.content ?? "").segments;
  const vbautSegments = [];
  const decisionsBySegment = new Map();

  for (const segment of segments) {
    const mediaItems = normalizeMediaItems(segment);
    const mediaPaths = [];
    const mediaTimecodes = [];
    for (const item of mediaItems) {
      const mediaPath = normalizeMediaFilePath(item.path);
      if (!mediaPath) continue;
      const absolutePath = safeResolveMediaPathForRoot(PAMPAM_ROOT, mediaPath);
      if (!absolutePath) continue;
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats?.isFile()) continue;
      mediaPaths.push(mediaPath);
      mediaTimecodes.push(String(item.timecode || "").trim());
    }
    const segmentId = String(segment.id || "").trim();
    if (!segmentId) continue;
    vbautSegments.push({
      segment_id: segmentId,
      section_id: stableSectionId(segment.topic || "document"),
      section_title: String(segment.topic || titleFromContent(scrape?.content ?? "") || "Document").trim(),
      text_quote: String(segment.text || "").trim(),
      block_type: "segment",
      is_done: Boolean(segment.is_done)
    });
    decisionsBySegment.set(segmentId, {
      visual: {
        media_file_path: mediaPaths[0] || "",
        media_file_paths: mediaPaths,
        media_layout: normalizeMediaLayout(segment.media_layout),
        media_file_timecodes_list: mediaTimecodes,
        duration_hint_sec: null,
        format_hint: "",
        media_file_timecodes: Object.fromEntries(
          mediaPaths.map((mediaPath, index) => [mediaPath, mediaTimecodes[index] || ""]).filter((entry) => entry[1])
        )
      }
    });
  }

  const tools = await resolveDownloaderTools();
  const ffmpegLocation = tools.ffmpeg_path ? path.dirname(tools.ffmpeg_path) : "";
  const { buildXmlExportPayload } = createXmlExportUtils({
    execFileAsync,
    downloaderTools: { ffmpegLocation },
    getMediaDir: () => PAMPAM_ROOT,
    normalizeMediaFilePath,
    normalizeSectionTitleForMatch,
    normalizeVisualDecisionInput,
    safeResolveMediaPath: safeResolveMediaPathForRoot
  });

  return buildXmlExportPayload({
    document: {
      id: scrape?.id || "ucontent",
      title: scrape?.title || titleFromContent(scrape?.content ?? "")
    },
    segments: vbautSegments,
    decisionsBySegment,
    timelineAlignment: null,
    mediaDir: PAMPAM_ROOT,
    mediaPathRootOverride: null,
    fps: 50,
    defaultDurationSec: 5,
    sectionId: "",
    sectionTitle: ""
  });
}

function parseMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["'][^>]*>`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return "";
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

async function fetchLinkPreviewMetadata(target) {
  const response = await fetch(target, {
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
    headers: { "user-agent": "UContent/0.1 link preview" }
  });
  if (!response.ok) throw new Error(`preview page HTTP ${response.status}`);
  const html = await response.text();
  const title = parseMeta(html, "og:title") || decodeHtmlEntities(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "");
  const rawImage = parseMeta(html, "og:image");
  let image = "";
  if (rawImage) {
    try {
      image = new URL(rawImage, response.url || target).toString();
    } catch {
      image = "";
    }
  }
  return {
    title,
    description: parseMeta(html, "og:description") || parseMeta(html, "description"),
    image,
    siteName: parseMeta(html, "og:site_name")
  };
}

function previewExtension(contentType, imageUrl) {
  const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/avif") return ".avif";
  if (mime === "image/jpeg") return ".jpg";
  const ext = path.extname(new URL(imageUrl).pathname).toLowerCase();
  return [".png", ".webp", ".gif", ".avif", ".jpg", ".jpeg"].includes(ext) ? ext : ".jpg";
}

async function attachLinkPreview(segment) {
  const sourceUrl = String(segment?.text || "").trim();
  if (!/^https?:\/\/\S+$/i.test(sourceUrl)) return false;
  const normalizedSourceUrl = normalizeHttpUrl(sourceUrl);
  const suppressed = normalizeSuppressedLinkPreviews(segment?.suppressed_link_previews);
  if (normalizedSourceUrl && suppressed.includes(normalizedSourceUrl)) return false;
  const originalMediaItems = normalizeMediaItems(segment);
  const mediaItems = originalMediaItems.filter((item) => !isAutomaticPreviewItem(item) || item.source_url === sourceUrl);
  if (mediaItems.length !== originalMediaItems.length) {
    segment.media_items = mediaItems;
    segment.media = mediaItems[0] || null;
  }
  if (mediaItems.some((item) => item.source_url === sourceUrl && isAutomaticPreviewItem(item))) {
    return false;
  }
  const preview = await fetchLinkPreviewMetadata(sourceUrl);
  if (!/^https?:\/\//i.test(preview.image)) return false;
  const imageResponse = await fetch(preview.image, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": "UContent/0.1 link preview" }
  });
  if (!imageResponse.ok) throw new Error(`preview image HTTP ${imageResponse.status}`);
  const contentType = String(imageResponse.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.startsWith("image/")) throw new Error(`preview is not an image: ${contentType}`);
  const declaredLength = Number(imageResponse.headers.get("content-length") || 0);
  if (declaredLength > 15 * 1024 * 1024) throw new Error("preview image exceeds 15 MB");
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw new Error("invalid preview image size");
  const { safeTopic, dir } = await ensureTopicDir(segment.topic || "Без темы");
  const digest = createHash("sha256").update(`${sourceUrl}\n${preview.image}`).digest("hex").slice(0, 12);
  const fileName = `preview_${digest}${previewExtension(contentType, preview.image)}`;
  const absolutePath = path.join(dir, fileName);
  await fs.writeFile(absolutePath, buffer);
  const normalizedName = await normalizeMediaFileNameOnDisk(dir, fileName);
  const normalizedStats = await fs.stat(path.join(dir, normalizedName));
  const relPath = path.posix.join(safeTopic, normalizedName);
  const item = {
    path: relPath,
    thumbnail: `/api/media/raw?path=${encodeURIComponent(relPath)}`,
    source_url: sourceUrl,
    webpage_url: sourceUrl,
    title: preview.title || "Link preview"
  };
  segment.media_items = [...mediaItems, item].slice(0, 50);
  segment.media = segment.media_items[0] || null;
  segment.updated_at = new Date().toISOString();
  await MEDIA_INDEX.upsert(relPath, {
    derivation: "link_preview",
    source_url: sourceUrl,
    title: preview.title || "",
    size: normalizedStats.size
  });
  return true;
}

async function enrichScrapeLinkPreviews(scrape) {
  const links = (Array.isArray(scrape?.segments) ? scrape.segments : []).filter((segment) => {
    const type = String(segment?.type || segment?.kind || "").toLowerCase();
    return type === "link" && /^https?:\/\/\S+$/i.test(String(segment?.text || "").trim());
  });
  for (const segment of links) {
    try {
      await attachLinkPreview(segment);
    } catch (error) {
      console.warn(`[link-preview] ${String(segment.text || "")}: ${error?.message || error}`);
    }
  }
}

async function handlePreview(reqUrl, res) {
  const target = String(reqUrl.searchParams.get("url") ?? "").trim();
  if (!/^https?:\/\//i.test(target)) {
    json(res, 400, { error: "url is required" });
    return;
  }
  try {
    json(res, 200, await fetchLinkPreviewMetadata(target));
  } catch (error) {
    json(res, 502, { error: error?.message ?? "preview failed" });
  }
}

async function handleMediaLibrary(reqUrl, res) {
  const topic = String(reqUrl.searchParams.get("topic") || "").trim();
  const { safeTopic, dir } = await ensureTopicDir(topic);
  const files = await listMediaFiles();
  json(res, 200, {
    root: PAMPAM_ROOT,
    topic: safeTopic,
    topic_dir: dir,
    topic_files: files.filter((file) => file.topic.toLowerCase() === safeTopic.toLowerCase()),
    files
  });
}

async function handleMediaUpload(req, res) {
  const body = await readBody(req);
  const topic = String(body.topic || "").trim();
  const rawFileName = sanitizeFileName(body.fileName, "upload");
  const fileName = makeFileNameUnique(rawFileName);
  const dataBase64 = String(body.dataBase64 || "");
  if (!dataBase64) {
    json(res, 400, { error: "dataBase64 is required" });
    return;
  }
  const { safeTopic, dir } = await ensureTopicDir(topic);
  const target = path.join(dir, fileName);
  await fs.writeFile(target, Buffer.from(dataBase64, "base64"));
  const normalizedName = await normalizeMediaFileNameOnDisk(dir, fileName);
  const normalizedTarget = path.join(dir, normalizedName);
  const relPath = path.join(safeTopic, normalizedName).split(path.sep).join("/");
  const stats = await fs.stat(normalizedTarget).catch(() => null);
  await MEDIA_INDEX.upsert(relPath, {
    derivation: "upload",
    size: stats?.size ?? 0
  });
  json(res, 200, {
    file: {
      path: relPath,
      name: normalizedName,
      topic: safeTopic,
      size: stats?.size ?? 0,
      updated_at: stats?.mtime?.toISOString?.() ?? null,
      thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
    }
  });
}

async function handleCheckGraphics(reqUrl, res) {
  const fileName = sanitizeFileName(reqUrl.searchParams.get("name") || "", "file");
  if (!fileName || fileName === "file") {
    json(res, 200, { exists: false });
    return;
  }
  const target = path.join(PAMPAM_ROOT, "graphics", fileName);
  try {
    const stats = await fs.stat(target);
    const relPath = `graphics/${fileName}`;
    json(res, 200, {
      exists: true,
      file: {
        path: relPath,
        name: fileName,
        topic: "graphics",
        size: stats.size,
        updated_at: stats.mtime.toISOString(),
        thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
      }
    });
  } catch {
    json(res, 200, { exists: false });
  }
}

const REMOTION_PRESETS = new Map([
  ["news-2x1", { ext: ".mp4" }],
  ["news-2x1-alpha", { ext: ".webm" }],
  ["news-1x1", { ext: ".mp4" }],
  ["news-1x1-alpha", { ext: ".webm" }],
  ["quote-2x1", { ext: ".mp4" }],
  ["quote-2x1-alpha", { ext: ".webm" }],
  ["quote-1x1", { ext: ".mp4" }],
  ["quote-1x1-alpha", { ext: ".webm" }]
]);

function cleanRemotionText(value, maxLength = 1200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function buildRemotionProps(body = {}) {
  const props = body.props && typeof body.props === "object" && !Array.isArray(body.props) ? body.props : {};
  const quote = cleanRemotionText(props.quote || props.title || body.quote || body.title, 1400);
  const source = cleanRemotionText(props.source || props.logo || body.source || body.logo, 80);
  const author = cleanRemotionText(props.author || body.author, 120);
  const role = cleanRemotionText(props.role || body.role, 180);
  const date = cleanRemotionText(props.date || props.meta || body.date || body.meta, 80);
  const label = cleanRemotionText(props.label || body.label, 80);
  const accent = /^#[0-9a-f]{6}$/i.test(String(props.accent || body.accent || "")) ? String(props.accent || body.accent) : "#f0b24c";
  const type = ["news", "quote"].includes(String(props.type || body.type || "")) ? String(props.type || body.type) : undefined;
  const layout = cleanRemotionText(props.layout || body.layout, 24);
  const transparent = Boolean(props.transparent || body.transparent);
  const background = props.background && typeof props.background === "object" && !Array.isArray(props.background)
    ? {
        dim: Number.isFinite(Number(props.background.dim)) ? Math.max(0, Math.min(1, Number(props.background.dim))) : undefined,
        blur: Number.isFinite(Number(props.background.blur)) ? Math.max(0, Math.min(80, Number(props.background.blur))) : undefined,
        image: cleanRemotionText(props.background.image, 600) || undefined
      }
    : undefined;
  return {
    variant: cleanRemotionText(props.variant || body.variant, 40) || "editorial",
    ...(type ? { type } : {}),
    ...(layout ? { layout } : {}),
    source,
    quote,
    title: quote,
    author,
    role,
    date,
    meta: date,
    label,
    accent,
    transparent,
    ...(background ? { background } : { background: { dim: 0.7 } })
  };
}

async function handleRemotionRender(req, res) {
  const body = await readBody(req);
  const format = String(body.format || "quote-1x1").trim();
  const preset = REMOTION_PRESETS.get(format);
  if (!preset) {
    json(res, 400, { error: "Unsupported Remotion format" });
    return;
  }
  const props = buildRemotionProps(body);
  if (!props.quote) {
    json(res, 400, { error: "quote/title is required" });
    return;
  }
  const scriptPath = path.join(REMOTION_ROOT, "scripts", "render.mjs");
  if (!(await pathExists(scriptPath))) {
    json(res, 500, { error: "Remotion render script is unavailable" });
    return;
  }
  const nodeModulesPath = path.join(REMOTION_ROOT, "node_modules");
  if (!(await pathExists(nodeModulesPath))) {
    json(res, 500, { error: "Remotion dependencies are not installed" });
    return;
  }

  const graphicsDir = path.join(PAMPAM_ROOT, "graphics");
  assertPathInsideRoot(PAMPAM_ROOT, graphicsDir, "Remotion graphics directory");
  await fs.mkdir(graphicsDir, { recursive: true });
  const label = asciiFilePart([props.source, props.author, props.quote].filter(Boolean).join(" "), "remotion").slice(0, 72);
  const fileName = await ensureUniqueFileNameInDir(graphicsDir, `remotion_${format}_${label}${preset.ext}`);
  const outputPath = path.join(graphicsDir, fileName);
  assertPathInsideRoot(graphicsDir, outputPath, "Remotion output");

  const propsDir = path.join(UCONTENT_STAGING_ROOT, "remotion-props");
  await fs.mkdir(propsDir, { recursive: true });
  const propsPath = path.join(propsDir, `${Date.now()}_${randomBytes(4).toString("hex")}.json`);
  await fs.writeFile(propsPath, JSON.stringify(props, null, 2), "utf8");
  try {
    await execFileAsync(process.execPath, [scriptPath, format, propsPath, outputPath], {
      cwd: REMOTION_ROOT,
      windowsHide: true,
      timeout: REMOTION_RENDER_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    });
    const stats = await fs.stat(outputPath);
    if (!stats.isFile() || stats.size <= 0) throw new Error("Remotion produced no output");
    const relPath = path.posix.join("graphics", fileName);
    const file = {
      path: relPath,
      name: fileName,
      topic: "graphics",
      size: stats.size,
      updated_at: stats.mtime.toISOString(),
      thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
    };
    await MEDIA_INDEX.upsert(relPath, {
      derivation: "remotion",
      title: props.quote,
      description: props.quote,
      uploader: props.author || props.source || "",
      format_note: format,
      size: stats.size
    });
    json(res, 200, { file, props, format });
  } catch (error) {
    await fs.unlink(outputPath).catch(() => null);
    json(res, 500, { error: `Remotion render failed: ${error.message}` });
  } finally {
    await fs.unlink(propsPath).catch(() => null);
  }
}

async function handleScreenshotLabLinks(reqUrl, res) {
  const scrapeId = String(reqUrl.searchParams.get("scrape") || "").trim();
  const scrape = await readScrape(scrapeId);
  const links = await attachScreenshotLabFiles(scrape.id, screenshotLabLinksFromScrape(scrape));
  json(res, 200, {
    scrape: {
      id: scrape.id,
      title: scrape.title,
      updated_at: scrape.updated_at || scrape.created_at || "",
      segments: Array.isArray(scrape.segments) ? scrape.segments.length : 0
    },
    links
  });
}

async function handleScreenshotLabCapture(reqUrl, res) {
  const url = normalizeHttpUrl(reqUrl.searchParams.get("url") || "");
  if (!url) {
    text(res, 400, "url is required");
    return;
  }
  const scriptPath = path.join(__dirname, "tools", "screenshot-engine", "link-screenshot.js");
  if (!(await pathExists(scriptPath))) {
    text(res, 500, "Screenshot engine is unavailable");
    return;
  }
  const profile = screenshotLabProfileFromParams(reqUrl.searchParams);
  const saveScrapeId = String(reqUrl.searchParams.get("scrape") || "").trim();
  const saveIndex = reqUrl.searchParams.get("index");
  const shouldSave = Boolean(saveScrapeId && saveIndex);
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "--url", url,
      "--width", String(profile.width),
      "--height", String(profile.height),
      "--zoom", String(profile.zoom),
      "--scroll", String(profile.scroll),
      "--timeout_ms", "45000"
    ], { windowsHide: true, timeout: 70000, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    if (!Buffer.isBuffer(stdout) || stdout.length < 1024) {
      text(res, 502, "Screenshot engine returned no image");
      return;
    }
    const saved = shouldSave
      ? await saveScreenshotLabCapture({
        scrapeId: saveScrapeId,
        linkIndex: saveIndex,
        url,
        preset: reqUrl.searchParams.get("preset") || "16x9",
        profile,
        buffer: stdout
      }).catch(() => null)
      : null;
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
      "x-screenshot-width": String(profile.width),
      "x-screenshot-height": String(profile.height),
      "x-screenshot-zoom": String(profile.zoom),
      ...(saved?.path ? { "x-screenshot-path": encodeURIComponent(saved.path) } : {})
    });
    res.end(stdout);
  } catch (error) {
    text(res, 502, String(error?.message || "screenshot failed"));
  }
}

async function handleMediaRaw(reqUrl, res) {
  const relPath = String(reqUrl.searchParams.get("path") || "");
  const target = safeResolveMediaPath(relPath);
  if (!target) {
    text(res, 403, "Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(target);
    const contentType = MIME_TYPES.get(path.extname(target).toLowerCase()) || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    res.end(body);
  } catch {
    text(res, 404, "Not found");
  }
}

async function serveStatic(reqUrl, res) {
  const pathname = reqUrl.pathname === "/" ? "/script-text" : reqUrl.pathname;
  const fileName =
    pathname === "/script-text" ? "script-text.html" :
    pathname === "/screenshot-lab" ? "screenshot-lab.html" :
    pathname.replace(/^\/+/, "");
  const targetPath = path.resolve(PUBLIC_DIR, fileName);
  if (!targetPath.startsWith(PUBLIC_DIR)) {
    text(res, 403, "Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(targetPath);
    const contentType = MIME_TYPES.get(path.extname(targetPath).toLowerCase()) || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  } catch {
    text(res, 404, "Not found");
  }
}

async function refreshScrapeFromNotion(id) {
  const safeId = safeScrapeId(id);
  const running = NOTION_REFRESH_JOBS.get(safeId);
  if (running) return running;
  const refreshPromise = refreshScrapeFromNotionOnce(safeId);
  NOTION_REFRESH_JOBS.set(safeId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    if (NOTION_REFRESH_JOBS.get(safeId) === refreshPromise) NOTION_REFRESH_JOBS.delete(safeId);
  }
}

async function refreshScrapeFromNotionOnce(id) {
  const existing = await readScrape(id);
  const url = normalizeNotionUrl(existing.url);
  if (!url) {
    const error = new Error("Saved scrape has no valid Notion URL");
    error.statusCode = 400;
    throw error;
  }
  const progress = [];
  const notionContent = await scrapeNotionPage(url, (message) => {
    progress.push(String(message ?? ""));
    console.log(`[notion-refresh] ${message}`);
  });
  const protectedLinks = preserveEnrichedLinkSegments(notionContent, existing.segments || []);
  const content = protectedLinks.content;
  if (content === existing.content) {
    return {
      scrape: existing,
      progress,
      unchanged: true,
      report: {
        total: Array.isArray(existing.segments) ? existing.segments.length : 0,
        reused: Array.isArray(existing.segments) ? existing.segments.length : 0,
        created: 0,
        changed: 0,
        moved: 0,
        same: Array.isArray(existing.segments) ? existing.segments.length : 0,
        removed: 0,
        debug: [],
        preserved_links: protectedLinks.preserved
      }
    };
  }
  const snapshot = await snapshotScrape(existing, "refresh");
  const segmentState = assignSegmentIds(content, existing.segments || []);
  segmentState.report.preserved_links = protectedLinks.preserved;
  const updated = {
    ...existing,
    title: titleFromContent(content),
    content,
    segments: segmentState.segments,
    segment_report: segmentState.report,
    last_snapshot: snapshot ? { id: snapshot.id, reason: snapshot.reason, created_at: snapshot.created_at, file: snapshot.file } : null,
    updated_at: new Date().toISOString()
  };
  await writeScrape(updated);
  return { scrape: updated, progress, report: segmentState.report, unchanged: false };
}

async function handleRequest(req, res) {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (!authorizeQuickTunnelRequest(req, res, reqUrl)) return;
    if (req.method === "GET" && reqUrl.pathname === "/api/scrapes") {
      json(res, 200, { scrapes: await listScrapes() });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname.startsWith("/api/scrapes/")) {
      const parts = reqUrl.pathname.split("/").filter(Boolean);
      const id = decodeURIComponent(parts[2] || "");
      if (parts[3] === "export.xml") {
        const scrape = await readScrape(id);
        const xmlPayload = await buildVbautXmlForScrape(scrape);
        const tools = await resolveDownloaderTools();
        const ffmpegLocation = tools.ffmpeg_path ? path.dirname(tools.ffmpeg_path) : "";
        const { buildContentDisposition } = createXmlExportUtils({
          execFileAsync,
          downloaderTools: { ffmpegLocation },
          getMediaDir: () => PAMPAM_ROOT,
          normalizeMediaFilePath,
          normalizeSectionTitleForMatch,
          normalizeVisualDecisionInput,
          safeResolveMediaPath: safeResolveMediaPathForRoot
        });
        const fileName = `${scrape.id}.xml`;
        res.writeHead(200, {
          "content-type": "application/xml; charset=utf-8",
          "content-disposition": buildContentDisposition(fileName),
          "cache-control": "no-store"
        });
        res.end(xmlPayload?.clipCount > 0 ? xmlPayload.xml : buildXmlForScrape(scrape));
        return;
      }
      if (parts[3] === "rss-candidates") {
        await handleRssCandidates(reqUrl, res, id);
        return;
      }
      json(res, 200, { scrape: await readScrape(id) });
      return;
    }
    if (req.method === "POST" && reqUrl.pathname.startsWith("/api/scrapes/")) {
      const parts = reqUrl.pathname.split("/").filter(Boolean);
      const id = decodeURIComponent(parts[2] || "");
      if (parts[3] === "refresh") {
        const result = await refreshScrapeFromNotion(id);
        json(res, 200, result);
        return;
      }
      if (parts[3] === "send-to-tg") {
        try {
          const result = await triggerWebBroadcast(id);
          json(res, 200, result);
        } catch (error) {
          json(res, 500, { error: error.message });
        }
        return;
      }
      if (parts[3] === "restore-latest") {
        const existing = await readScrape(id);
        const snapshot = await latestScrapeSnapshot(existing.id);
        if (!snapshot?.scrape) {
          json(res, 404, { error: "No refresh snapshot found" });
          return;
        }
        await snapshotScrape(existing, "restore");
        const restored = {
          ...snapshot.scrape,
          restored_from: {
            id: snapshot.id,
            reason: snapshot.reason,
            created_at: snapshot.created_at,
            file: snapshot.file
          },
          updated_at: new Date().toISOString()
        };
        await writeScrape(restored);
        json(res, 200, { scrape: restored, restored_from: restored.restored_from });
        return;
      }
      text(res, 404, "Not found");
      return;
    }
    if (req.method === "PATCH" && reqUrl.pathname.startsWith("/api/scrapes/")) {
      const parts = reqUrl.pathname.split("/").filter(Boolean);
      const id = decodeURIComponent(parts[2] || "");
      const segmentId = decodeURIComponent(parts[4] || "");
      if (parts[3] !== "segments" || !segmentId) {
        text(res, 404, "Not found");
        return;
      }
      const existing = await readScrape(id);
      const body = await readBody(req);
      const segments = Array.isArray(existing.segments) ? existing.segments : assignSegmentIds(existing.content || "").segments;
      const index = segments.findIndex((segment) => segment.id === segmentId);
      if (index < 0) {
        json(res, 404, { error: "segment not found" });
        return;
      }
      const current = segments[index];
      let mediaItems = normalizeMediaItems(current);
      if (Array.isArray(body.media_items)) {
        mediaItems = normalizeMediaItems(body.media_items);
      } else if (body.media === null) {
        mediaItems = [];
      } else if (body.media !== undefined) {
        mediaItems = normalizeMediaItems([body.media]);
      }
      if (body.add_media !== undefined) {
        const nextItem = normalizeMediaItem(body.add_media);
        if (nextItem) mediaItems = [...mediaItems, nextItem].slice(0, 50);
      }
      if (Number.isInteger(body.update_media_index) && body.media_item && typeof body.media_item === "object") {
        const nextItem = normalizeMediaItem(body.media_item);
        if (nextItem) {
          mediaItems = mediaItems.map((item, itemIndex) => itemIndex === body.update_media_index ? nextItem : item);
        }
      }
      let suppressedLinkPreviews = normalizeSuppressedLinkPreviews(current.suppressed_link_previews);
      if (Number.isInteger(body.remove_media_index)) {
        const removedItem = mediaItems[body.remove_media_index] || null;
        if (removedItem && isAutomaticPreviewItem(removedItem)) {
          const sourceUrl = normalizeHttpUrl(removedItem.source_url || removedItem.webpage_url || current.text);
          if (sourceUrl) suppressedLinkPreviews = [...new Set([...suppressedLinkPreviews, sourceUrl])].slice(0, 200);
          if (body.delete_media_file !== false) {
            await deleteAutomaticPreviewFile(removedItem);
          }
        }
        mediaItems = mediaItems.filter((_, itemIndex) => itemIndex !== body.remove_media_index);
      }
      segments[index] = {
        ...current,
        type: String(body.type || current.type || current.kind || "text").trim(),
        is_done: typeof body.is_done === "boolean" ? body.is_done : Boolean(current.is_done),
        suppressed_link_previews: suppressedLinkPreviews,
        media_layout: body.media_layout !== undefined ? normalizeMediaLayout(body.media_layout) : normalizeMediaLayout(current.media_layout),
        media: mediaItems[0] || null,
        media_items: mediaItems,
        updated_at: new Date().toISOString()
      };
      const updated = {
        ...existing,
        segments,
        updated_at: new Date().toISOString()
      };
      dedupeScrapeImageAssignments(updated);
      await fs.writeFile(path.join(DATA_DIR, `${existing.id}.json`), JSON.stringify(updated, null, 2), "utf8");
      await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(updated, null, 2), "utf8");
      json(res, 200, { scrape: updated, segment: segments[index] });
      return;
    }
    if (req.method === "PUT" && reqUrl.pathname.startsWith("/api/scrapes/")) {
      const id = decodeURIComponent(reqUrl.pathname.split("/").filter(Boolean)[2] || "");
      const existing = await readScrape(id);
      const body = await readBody(req);
      const content = String(body.content ?? "");
      if (!content.trim()) {
        json(res, 400, { error: "content is required" });
        return;
      }
      const segmentState = assignSegmentIds(content, existing.segments || []);
      const snapshot = await snapshotScrape(existing, "edit");
      const updated = {
        ...existing,
        title: titleFromContent(content),
        content,
        segments: segmentState.segments,
        segment_report: segmentState.report,
        last_snapshot: snapshot ? { id: snapshot.id, reason: snapshot.reason, created_at: snapshot.created_at, file: snapshot.file } : existing.last_snapshot || null,
        updated_at: new Date().toISOString()
      };
      await writeScrape(updated);
      json(res, 200, { scrape: updated });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/latest") {
      json(res, 200, { scrape: await readScrape("") });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/link-preview") {
      await handlePreview(reqUrl, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/media") {
      await handleMediaLibrary(reqUrl, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/media-download") {
      await handleMediaDownload(req, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname.startsWith("/api/media-download/")) {
      handleMediaDownloadJob(reqUrl, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/media/raw") {
      await handleMediaRaw(reqUrl, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/media/check-graphics") {
      await handleCheckGraphics(reqUrl, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/remotion/render") {
      await handleRemotionRender(req, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/screenshot-lab/links") {
      await handleScreenshotLabLinks(reqUrl, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/screenshot-lab/capture") {
      await handleScreenshotLabCapture(reqUrl, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/media/upload") {
      await handleMediaUpload(req, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/import-markdown") {
      const body = await readBody(req);
      try {
        const saved = await importMarkdownScrape({
          id: body.id,
          url: body.url,
          content: String(body.content ?? "")
        });
        json(res, 200, { scrape: saved });
      } catch (error) {
        json(res, 400, { error: error?.message || "import failed" });
      }
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/rss-candidates/reject") {
      await handleRejectRssCandidate(req, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/rss-search") {
      await handleRssSearch(req, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/scrape") {
      const body = await readBody(req);
      const url = normalizeNotionUrl(body.url);
      if (!url) {
        json(res, 400, { error: "Valid Notion URL is required" });
        return;
      }
      const progress = [];
      const content = await scrapeNotionPage(url, (message) => {
        progress.push(String(message ?? ""));
        console.log(`[notion] ${message}`);
      });
      const saved = await saveScrape({ id: scrapeIdFromUrl(url), url, content });
      json(res, 200, { scrape: saved, progress });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(reqUrl, res);
      return;
    }
    text(res, 405, "Method not allowed");
  } catch (error) {
    json(res, 500, { error: error?.message ?? "Internal error" });
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`UContent port ${PORT} is already in use.`);
    console.error(`Open http://localhost:${PORT}/script-text if it is already running, or start another port:`);
    console.error(`  $env:UCONTENT_PORT=5198; npm run dev`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`UContent: http://localhost:${PORT}/script-text`);
  startQuickTunnel();
  startTelegramBot({
    PORT,
    readScrape,
    writeScrape,
    refreshScrapeFromNotion,
    executeMediaDownload,
    PAMPAM_ROOT,
    DATA_DIR,
    sanitizeMediaTopicName,
    ensureTopicDir,
    listMediaFiles,
    getMediaMetadata: MEDIA_INDEX.get,
    upsertMediaMetadata: MEDIA_INDEX.upsert,
    moveMediaMetadata: MEDIA_INDEX.move,
    listMediaMetadata: MEDIA_INDEX.entries,
    resolveDownloaderTools,
    convertWebpToPng: convertWebpFileToPng,
    spawn,
    getWebAppUrl: getTelegramWebAppUrl
  }).catch((err) => {
    console.error("Failed to start Telegram Bot:", err);
  });
});
