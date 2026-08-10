import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildTimelineAlignmentMap } from "./timeline-alignment.js";

export function createXmlExportUtils(deps) {
  const {
    execFileAsync,
    downloaderTools,
    getMediaDir,
    normalizeMediaFilePath,
    normalizeSectionTitleForMatch,
    normalizeVisualDecisionInput,
    safeResolveMediaPath
  } = deps;

  const XML_EXPORT_FPS = Number.isFinite(Number(process.env.XML_EXPORT_FPS))
    ? Math.max(1, Number(process.env.XML_EXPORT_FPS))
    : 50;
  const XML_EXPORT_DEFAULT_DURATION_SEC = Number.isFinite(Number(process.env.XML_EXPORT_DEFAULT_DURATION_SEC))
    ? Math.max(0.2, Number(process.env.XML_EXPORT_DEFAULT_DURATION_SEC))
    : 5;
  const XML_SECTION_MARKER_DURATION_SEC = Number.isFinite(Number(process.env.XML_SECTION_MARKER_DURATION_SEC))
    ? Math.max(0, Number(process.env.XML_SECTION_MARKER_DURATION_SEC))
    : 2;
  const XML_SECTION_GAP_SEC = Number.isFinite(Number(process.env.XML_SECTION_GAP_SEC))
    ? Math.max(0, Number(process.env.XML_SECTION_GAP_SEC))
    : 7;
  const XML_UNMATCHED_TAIL_GAP_SEC = Number.isFinite(Number(process.env.XML_UNMATCHED_TAIL_GAP_SEC))
    ? Math.max(0, Number(process.env.XML_UNMATCHED_TAIL_GAP_SEC))
    : 60;
  const XML_SEQUENCE_WIDTH = 1920;
  const XML_SEQUENCE_HEIGHT = 960;
  const XML_SECTION_MARKER_COLOR = "4294741314";
  const XML_DONE_MARKER_COLOR = "4294967295";
  const XML_REQUIRED_MARKER_COLOR = "4294901760";
  const XML_RECOMMENDED_MARKER_COLOR = "4294967040";
  const XML_OPTIONAL_MARKER_COLOR = "4278255360";
  const XML_DEFAULT_CENTER = {
    x: XML_SEQUENCE_WIDTH / 2,
    y: XML_SEQUENCE_HEIGHT / 2
  };
  const XML_PPRO_TICKS_PER_FRAME = 5080320000;
  const XML_RESERVED_VIDEO_TRACKS = 2;
  const XML_RESERVED_AUDIO_TRACKS = 0;
  const XML_TIMELINE_ALIGNMENT_ENABLED = String(process.env.XML_TIMELINE_ALIGNMENT_ENABLED ?? "").trim() === "1";
  const XML_AUTO_BACKGROUNDS_ENABLED = String(process.env.XML_AUTO_BACKGROUNDS_ENABLED ?? "1").trim() !== "0";
  const XML_ALLOW_CROSS_TOPIC_MEDIA = String(process.env.XML_ALLOW_CROSS_TOPIC_MEDIA ?? "").trim() === "1";
  const XML_BACKGROUND_ROOT = process.env.XML_BACKGROUND_ROOT || path.join(getMediaDir(), "Graphics");
  const XML_BACKGROUND_FILES = Object.freeze({
    whirl: "bg_whirl.mov",
    lines: "bg_lines.mov",
    ribbon: "bg_ribbon.mov"
  });
  const XML_BACKGROUND_SCALES = Object.freeze({
    whirl: 51.4,
    lines: 50,
    ribbon: 50.5
  });
  const XML_DEFAULT_MOTION_TEMPLATE = {
    scale: 100,
    center: XML_DEFAULT_CENTER
  };
  const XML_BASIC_MOTION_TEMPLATES = new Map(
    [
      [1920, 1080, 100, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [1920, 960, 90, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [1920, 1920, 50, null, null],
      [960, 960, 100, null, null],
      [3840, 1920, 50, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [872, 480, 222, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [852, 480, 226, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [854, 480, 225, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [1024, 1024, 94, null, null],
      [1280, 720, 150, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [1200, 630, 137.0, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [1080, 1080, 88.9, null, null],
      [720, 1280, 75, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [1080, 1920, 50, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [1280, 700, 150, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [480, 854, 115, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [2160, 2160, 45, null, null],
      [2358, 2358, 40.7, null, null],
      [4209, 1645, 41.1, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [3970, 1273, 43.5, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [3696, 790, 46.8, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [2452, 683, 70.4, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
      [4096, 1379, 42.2, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y],
    [2007, 562, 86.1, XML_DEFAULT_CENTER.x, XML_DEFAULT_CENTER.y]
  ].map(([w, h, scale, cx, cy]) => [
      `${w}x${h}`,
      {
        scale,
        center: cx == null || cy == null ? null : { x: cx, y: cy }
      }
    ])
  );
  const XML_WIDTH_SCALE_OVERRIDES = new Map([
    [4096, 42.2],
    [2452, 70.4]
  ]);
  const XML_VIDEO_EXTENSIONS = new Set([
    ".mp4",
    ".mov",
    ".m4v",
    ".mkv",
    ".webm",
    ".avi",
    ".mts",
    ".m2ts",
    ".ts"
  ]);
  const XML_IMAGE_EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
    ".heic",
    ".avif"
  ]);
  const XML_AUDIO_EXTENSIONS = new Set([
    ".mp3",
    ".wav",
    ".aac",
    ".m4a",
    ".flac",
    ".ogg",
    ".opus",
    ".aiff"
  ]);
  const XML_DIMENSIONS_CACHE = new Map();
  const XML_MEDIA_INFO_CACHE = new Map();
  let XML_FFPROBE_CANDIDATES = null;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function secondsToFrames(seconds, fps) {
  const duration = Number(seconds);
  const rate = Number(fps);
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  if (!Number.isFinite(rate) || rate <= 0) return Math.max(1, Math.round(duration * 50));
  return Math.max(1, Math.round(duration * rate));
}

function secondsToFramesAllowZero(seconds, fps) {
  const duration = Number(seconds);
  const rate = Number(fps);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return Math.max(0, Math.round(duration * 50));
  return Math.max(0, Math.round(duration * rate));
}

function parseXmlStartTimecodeToSeconds(value, fps) {
  if (value == null) return 0;
  let raw = String(value).trim();
  if (raw.includes("-")) {
    raw = raw.split("-")[0].trim();
  }
  if (!raw) return 0;

  const normalizedRaw = raw.replace(",", ".");
  if (/^\d+(?:\.\d+)?$/.test(normalizedRaw)) {
    const numeric = Number(normalizedRaw);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  }

  const parts = raw.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 4) return 0;
  if (parts.some((part) => !/^\d+(?:[.,]\d+)?$/.test(part))) return 0;
  const nums = parts.map((part) => Number(part.replace(",", ".")));
  if (nums.some((num) => !Number.isFinite(num) || num < 0)) return 0;

  const rate = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : XML_EXPORT_FPS;
  if (parts.length === 2) {
    const [mm, ss] = nums;
    return mm * 60 + ss;
  }
  if (parts.length === 3) {
    const [hh, mm, ss] = nums;
    return hh * 3600 + mm * 60 + ss;
  }
  const [hh, mm, ss, ff] = nums;
  return hh * 3600 + mm * 60 + ss + ff / rate;
}

function parseXmlFrameRate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const rational = text.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (rational) {
    const numerator = Number(rational[1]);
    const denominator = Number(rational[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && numerator > 0 && denominator > 0) {
      return numerator / denominator;
    }
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeXmlNativeTimebase(value, fallback) {
  const parsed = parseXmlFrameRate(value);
  const rate = parsed ?? (Number.isFinite(Number(fallback)) && Number(fallback) > 0 ? Number(fallback) : null);
  if (!rate) return null;
  return Math.max(1, Math.round(rate));
}

function detectXmlMediaCategory(filePath) {
  const ext = String(path.extname(filePath ?? "")).toLowerCase();
  if (XML_AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (XML_IMAGE_EXTENSIONS.has(ext)) return "image";
  if (XML_VIDEO_EXTENSIONS.has(ext)) return "video";
  return "video";
}

function normalizeXmlDurationSeconds(rawValue, fallbackValue, category) {
  const parsed = Number(rawValue);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  const fallback = Number.isFinite(Number(fallbackValue)) ? Math.max(0.2, Number(fallbackValue)) : 5;
  let duration = fallback;
  if (category === "image") {
    duration = Math.max(5, duration);
  }
  return duration;
}

function normalizeXmlTopicNameForCompare(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\\/]+/g, " ")
    .replace(/\s*\(\d+\)\s*$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isXmlMediaPathCompatibleWithSegment(mediaPath, segment) {
  if (XML_ALLOW_CROSS_TOPIC_MEDIA) return true;
  const raw = String(mediaPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const [folder] = raw.split("/");
  if (!folder || folder === raw) return true;
  if (folder.toLowerCase() === "graphics") return true;
  const sectionTitle = String(segment?.section_title ?? "").trim();
  if (!sectionTitle) return true;
  return normalizeXmlTopicNameForCompare(folder) === normalizeXmlTopicNameForCompare(sectionTitle);
}

function getXmlSequentialSlot({ startFrame, endFrame, index, count }) {
  const start = Math.max(0, Math.round(Number(startFrame) || 0));
  const end = Math.max(start + 1, Math.round(Number(endFrame) || start + 1));
  const total = Math.max(1, end - start);
  const safeCount = Math.max(1, Math.round(Number(count) || 1));
  const safeIndex = Math.max(0, Math.min(safeCount - 1, Math.round(Number(index) || 0)));
  const slotStart = start + Math.floor((total * safeIndex) / safeCount);
  const slotEnd = safeIndex === safeCount - 1
    ? end
    : start + Math.floor((total * (safeIndex + 1)) / safeCount);
  return {
    startFrame: slotStart,
    endFrame: Math.max(slotStart + 1, slotEnd)
  };
}

function buildXmlBackgroundLoopEntries({
  backgroundAsset,
  durationFrames,
  videoTrackIndex,
  entryPrefix,
  motion
}) {
  if (!backgroundAsset || !Number.isFinite(Number(durationFrames)) || Number(durationFrames) <= 0) return [];
  const totalFrames = Math.max(1, Math.round(Number(durationFrames)));
  const entries = [];
  entries.push({
    entryId: `${entryPrefix}-entry-1`,
    segmentId: `${entryPrefix}-segment`,
    segmentQuote: "",
    segmentBlockType: "background",
    visualFormatHint: "",
    fileId: `${entryPrefix}-file-1`,
    masterClipId: `${entryPrefix}-masterclip-1`,
    fileName: backgroundAsset.fileName,
    pathUrl: toXmlFileUrl(backgroundAsset.absolutePath),
    durationFrames: totalFrames,
    sourceTotalFrames: null,
    sourceInFrame: 0,
    sourceOutFrame: totalFrames,
    startFrame: 0,
    endFrame: totalFrames,
    category: "video",
    hasAudio: false,
    hasVideo: true,
    audioChannelCount: 0,
    sourceDimensions: backgroundAsset.sourceDimensions,
    videoTrackIndex,
    audioTrackHint: null,
    motion
  });
  return entries;
}

function getXmlFfprobeCandidates() {
  if (Array.isArray(XML_FFPROBE_CANDIDATES)) return XML_FFPROBE_CANDIDATES;
  const list = [];
  const push = (value) => {
    const item = String(value ?? "").trim();
    if (!item) return;
    if (!list.includes(item)) list.push(item);
  };

  push(process.env.MEDIA_FFPROBE_PATH);

  const ffmpegLocation = String(downloaderTools?.ffmpegLocation ?? "").trim();
  if (ffmpegLocation) {
    const base = path.basename(ffmpegLocation).toLowerCase();
    if (base.startsWith("ffprobe")) {
      push(ffmpegLocation);
    } else {
      push(path.join(ffmpegLocation, process.platform === "win32" ? "ffprobe.exe" : "ffprobe"));
    }
  }

  push(process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  XML_FFPROBE_CANDIDATES = list;
  return list;
}

async function probeXmlMediaInfo(filePath) {
  const absolute = path.resolve(String(filePath ?? ""));
  if (!absolute) return null;
  const cacheKey = absolute.toLowerCase();
  if (XML_MEDIA_INFO_CACHE.has(cacheKey)) return XML_MEDIA_INFO_CACHE.get(cacheKey);

  const args = [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,width,height,duration,channels,avg_frame_rate,r_frame_rate,nb_frames:format=duration",
    "-of",
    "json",
    absolute
  ];

  for (const executable of getXmlFfprobeCandidates()) {
    try {
      const { stdout } = await execFileAsync(executable, args, {
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      const payload = JSON.parse(String(stdout ?? "{}"));
      const streams = Array.isArray(payload?.streams) ? payload.streams : [];
      let hasVideo = false;
      let hasAudio = false;
      let width = null;
      let height = null;
      let audioChannels = 0;
      let audioStreamCount = 0;
      let nativeFps = null;
      const streamDurations = [];

      for (const stream of streams) {
        const codecType = String(stream?.codec_type ?? "").toLowerCase();
        if (codecType === "video") {
          hasVideo = true;
          nativeFps = nativeFps ?? parseXmlFrameRate(stream?.avg_frame_rate) ?? parseXmlFrameRate(stream?.r_frame_rate);
          if (width == null || height == null) {
            const w = Number(stream?.width);
            const h = Number(stream?.height);
            if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
              width = Math.round(w);
              height = Math.round(h);
            }
          }
          const streamDuration = Number(stream?.duration);
          if (Number.isFinite(streamDuration) && streamDuration > 0) {
            streamDurations.push(streamDuration);
          }
        } else if (codecType === "audio") {
          hasAudio = true;
          audioStreamCount += 1;
          const channels = Number(stream?.channels);
          if (Number.isFinite(channels) && channels > audioChannels) {
            audioChannels = Math.max(1, Math.round(channels));
          }
          const streamDuration = Number(stream?.duration);
          if (Number.isFinite(streamDuration) && streamDuration > 0) {
            streamDurations.push(streamDuration);
          }
        }
      }

      const formatDuration = Number(payload?.format?.duration);
      const durationSec = Number.isFinite(formatDuration) && formatDuration > 0
        ? formatDuration
        : streamDurations.length > 0
          ? Math.max(...streamDurations)
          : null;
      // Some sources expose stereo as two mono audio streams.
      const effectiveAudioChannels = hasAudio
        ? Math.max(1, Math.round(Math.max(audioChannels || 0, audioStreamCount || 0)))
        : 0;

      const result = {
        hasVideo,
        hasAudio,
        audioChannels: effectiveAudioChannels,
        durationSec: Number.isFinite(Number(durationSec)) && Number(durationSec) > 0 ? Number(durationSec) : null,
        nativeFps: normalizeXmlNativeTimebase(nativeFps, null),
        sourceDimensions:
          Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
            ? { width, height }
            : null
      };
      XML_MEDIA_INFO_CACHE.set(cacheKey, result);
      XML_DIMENSIONS_CACHE.set(cacheKey, result.sourceDimensions ?? null);
      return result;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      break;
    }
  }

  XML_MEDIA_INFO_CACHE.set(cacheKey, null);
  if (!XML_DIMENSIONS_CACHE.has(cacheKey)) {
    XML_DIMENSIONS_CACHE.set(cacheKey, null);
  }
  return null;
}

async function getXmlMediaInfo(filePath, hintedCategory) {
  const absolute = path.resolve(String(filePath ?? ""));
  if (!absolute) {
    return {
      category: hintedCategory,
      hasAudio: hintedCategory === "audio",
      hasVideo: hintedCategory !== "audio",
      audioChannels: hintedCategory === "audio" ? 2 : 0,
      durationSec: null,
      nativeFps: null,
      sourceDimensions: null
    };
  }

  if (hintedCategory === "image") {
    const info = await probeXmlMediaInfo(absolute);
    return {
      category: "image",
      hasAudio: false,
      hasVideo: true,
      audioChannels: 0,
      durationSec: null,
      nativeFps: info?.nativeFps ?? null,
      sourceDimensions: info?.sourceDimensions ?? null
    };
  }

  const info = await probeXmlMediaInfo(absolute);
  if (!info) {
    return {
      category: hintedCategory,
      hasAudio: hintedCategory === "audio",
      hasVideo: hintedCategory !== "audio",
      audioChannels: hintedCategory === "audio" ? 2 : 0,
      durationSec: null,
      nativeFps: null,
      sourceDimensions: XML_DIMENSIONS_CACHE.get(absolute.toLowerCase()) ?? null
    };
  }

  if (info.hasVideo && info.hasAudio) {
    return {
      category: hintedCategory === "image" ? "image" : "video",
      hasAudio: true,
      hasVideo: true,
      audioChannels: Math.max(1, Math.min(2, Number(info.audioChannels) || 2)),
      durationSec: info.durationSec ?? null,
      nativeFps: info.nativeFps ?? null,
      sourceDimensions: info.sourceDimensions ?? null
    };
  }
  if (info.hasVideo && !info.hasAudio) {
    return {
      category: hintedCategory === "image" ? "image" : "video",
      hasAudio: false,
      hasVideo: true,
      audioChannels: 0,
      durationSec: info.durationSec ?? null,
      nativeFps: info.nativeFps ?? null,
      sourceDimensions: info.sourceDimensions ?? null
    };
  }
  if (!info.hasVideo && info.hasAudio) {
    return {
      category: "audio",
      hasAudio: true,
      hasVideo: false,
      audioChannels: Math.max(1, Math.min(2, Number(info.audioChannels) || 2)),
      durationSec: info.durationSec ?? null,
      nativeFps: info.nativeFps ?? null,
      sourceDimensions: null
    };
  }
  return {
    category: hintedCategory,
    hasAudio: hintedCategory === "audio",
    hasVideo: hintedCategory !== "audio",
    audioChannels: hintedCategory === "audio" ? 2 : 0,
    durationSec: info.durationSec ?? null,
    nativeFps: info.nativeFps ?? null,
    sourceDimensions: info.sourceDimensions ?? null
  };
}

function isXmlSquareFormatHint(formatHint) {
  const compact = String(formatHint ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  return compact === "1:1" || compact === "1x1" || compact === "square";
}

function isXmlTitleQuoteFormatHint(formatHint) {
  const raw = String(formatHint ?? "").trim().toLowerCase();
  if (!raw) return false;
  const compact = raw.replace(/\s+/g, "");
  if (compact === "2:1" || compact === "1:1" || compact === "1x1") return false;
  if (/(document|long)/i.test(raw)) return false;
  if (/(title|quote|headline)/i.test(raw)) return true;
  return compact.includes("/");
}

function isXmlSquareByDimensions(sourceDimensions) {
  const width = Number(sourceDimensions?.width);
  const height = Number(sourceDimensions?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width === height;
}

function isXmlSequenceAspectByDimensions(sourceDimensions) {
  const width = Number(sourceDimensions?.width);
  const height = Number(sourceDimensions?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const sourceAspect = width / height;
  const sequenceAspect = XML_SEQUENCE_WIDTH / XML_SEQUENCE_HEIGHT;
  return Math.abs(sourceAspect - sequenceAspect) < 0.01;
}

function isXmlPortraitDimensions(sourceDimensions) {
  const width = Number(sourceDimensions?.width);
  const height = Number(sourceDimensions?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width < height;
}

async function resolveXmlBackgroundAssets({ fps }) {
  const assets = new Map();
  for (const [kind, fileName] of Object.entries(XML_BACKGROUND_FILES)) {
    const absolutePath = path.resolve(XML_BACKGROUND_ROOT, fileName);
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats?.isFile?.()) continue;
    const mediaInfo = await getXmlMediaInfo(absolutePath, "video");
    if (!mediaInfo?.hasVideo) continue;
    const durationFrames = Number.isFinite(Number(mediaInfo.durationSec)) && Number(mediaInfo.durationSec) > 0
      ? secondsToFramesAllowZero(mediaInfo.durationSec, fps)
      : null;
    const sourceTimebase = normalizeXmlNativeTimebase(mediaInfo.nativeFps, fps) ?? fps;
    const sourceDurationFrames = Number.isFinite(Number(mediaInfo.durationSec)) && Number(mediaInfo.durationSec) > 0
      ? secondsToFramesAllowZero(mediaInfo.durationSec, sourceTimebase)
      : null;
    assets.set(kind, {
      kind,
      absolutePath,
      fileName: path.basename(absolutePath),
      sourceDimensions: mediaInfo.sourceDimensions ?? null,
      sourceTotalFrames: Number.isFinite(Number(durationFrames)) && Number(durationFrames) > 0 ? durationFrames : null,
      sourceTimebase,
      sourceDurationFrames: Number.isFinite(Number(sourceDurationFrames)) && Number(sourceDurationFrames) > 0
        ? sourceDurationFrames
        : null
    });
  }
  return assets;
}

function toSafeXmlFileNamePart(value, fallback = "export") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const clipped = normalized.slice(0, 64);
  return clipped || fallback;
}

function transliterateRuForFileName(value) {
  const table = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return String(value ?? "")
    .split("")
    .map((char) => {
      const lower = char.toLowerCase();
      if (!(lower in table)) return char;
      const translit = table[lower];
      return char === lower ? translit : translit.charAt(0).toUpperCase() + translit.slice(1);
    })
    .join("");
}

function sanitizeRawExportFileNamePart(value, fallback = "export") {
  const cleaned = String(value ?? "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function formatXmlExportTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

function buildXmlExportFileName({ documentId, sectionId, sectionTitle }) {
  const timestamp = formatXmlExportTimestamp();
  const rawSection = String(sectionTitle || sectionId || "").trim();
  if (rawSection) {
    const sectionBase = sanitizeRawExportFileNamePart(rawSection, "Тема");
    return `${sectionBase} - ${timestamp}.xml`;
  }
  return `UT - ${timestamp}.xml`;
}

function buildXmlSequenceName({ document, sectionId, sectionTitle }) {
  const docName = String(document?.id ?? "document").trim() || "document";
  const sectionName = String(sectionTitle ?? "").trim() || String(sectionId ?? "").trim();
  return sectionName ? `${docName} - ${sectionName}` : docName;
}

function getXmlSectionMarkerName(segment) {
  const title = String(segment?.section_title ?? "").trim();
  if (title) return title;
  const sectionId = String(segment?.section_id ?? "").trim();
  if (sectionId) return sectionId;
  return "Без темы";
}

function getXmlSectionMarkerKey(segment) {
  const titleKey = normalizeSectionTitleForMatch(segment?.section_title ?? "");
  if (titleKey) return `title:${titleKey}`;
  const sectionId = String(segment?.section_id ?? "").trim().toLowerCase();
  if (sectionId) return `id:${sectionId}`;
  return "section:unknown";
}

function getXmlSegmentMarkerName(segment) {
  const quote = String(segment?.text_quote ?? "").replace(/\s+/g, " ").trim();
  if (quote) {
    return quote.length > 96 ? `${quote.slice(0, 93)}...` : quote;
  }
  return getXmlSectionMarkerName(segment);
}

function resolveXmlSegmentMarkerColor({ segment, visual }) {
  const textQuote = String(segment?.text_quote || segment?.text || "").trim();
  const isLink = String(segment?.block_type || segment?.type || segment?.kind || "").toLowerCase() === "link" || /^https?:\/\/\S+/i.test(textQuote);
  const isDirectiveOrSearchHint = textQuote.startsWith("/");

  if (isLink || isDirectiveOrSearchHint) {
    return XML_SECTION_MARKER_COLOR; // Blue marker for links and search directives/hints
  }

  const priority = String(visual?.priority ?? "").trim().toLowerCase();
  if (/(обяз|нужн|required|high)/i.test(priority)) return XML_REQUIRED_MARKER_COLOR;
  if (/(рекоменд|recommend|medium)/i.test(priority)) return XML_RECOMMENDED_MARKER_COLOR;
  if (/(при\s*налич|если\s*есть|optional|low)/i.test(priority)) return XML_OPTIONAL_MARKER_COLOR;

  // Plain text segments get White marker
  return XML_DONE_MARKER_COLOR;
}

function buildContentDisposition(fileName) {
  const raw = String(fileName ?? "").trim();
  const extRaw = path.extname(raw).toLowerCase();
  const ext = [".xml", ".md", ".jsonl"].includes(extRaw) ? extRaw : ".xml";
  const baseRaw = extRaw ? raw.slice(0, -extRaw.length) : raw;
  const utfBase = sanitizeRawExportFileNamePart(baseRaw, "export");
  const utfName = `${utfBase}${ext}`;
  const fallbackBase = toSafeXmlFileNamePart(transliterateRuForFileName(utfBase), "export");
  const fallbackName = `${fallbackBase}${ext}`;
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(utfName)}`;
}

function resolveXmlPathWithMediaRootOverride({ mediaPath, absolutePath, mediaPathRootOverride }) {
  const overrideRoot = String(mediaPathRootOverride ?? "").trim();
  if (!overrideRoot) return absolutePath;
  const normalizedMediaPath = String(mediaPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalizedMediaPath) return absolutePath;

  if (/^[a-zA-Z]:[\\/]/.test(overrideRoot) || /^\\\\/.test(overrideRoot)) {
    return path.win32.join(overrideRoot, normalizedMediaPath.replace(/\//g, "\\"));
  }
  if (overrideRoot.startsWith("/")) {
    const trimmedRoot = overrideRoot.replace(/\/+$/, "");
    return `${trimmedRoot}/${normalizedMediaPath}`;
  }
  return path.join(overrideRoot, normalizedMediaPath);
}

function toXmlFileUrl(pathLike) {
  const raw = String(pathLike ?? "").trim();
  if (!raw) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  if (/^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) {
    const normalized = raw.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const encoded = parts.map((part, index) => (index === 0 ? part : encodeURIComponent(part))).join("/");
    return `file://localhost/${encoded}`;
  }
  if (raw.startsWith("/")) {
    const normalized = raw.replace(/\\/g, "/");
    const encodedPath = normalized
      .split("/")
      .map((part, index) => (index === 0 ? "" : encodeURIComponent(part)))
      .join("/");
    return `file://${encodedPath}`;
  }
  return pathToFileURL(path.resolve(raw)).href;
}

function formatXmlNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  if (Math.abs(numeric - Math.round(numeric)) < 0.0001) return String(Math.round(numeric));
  return numeric.toFixed(4).replace(/\.?0+$/, "");
}

function framesToXmlPproTicks(frameValue) {
  const frame = Number.isFinite(Number(frameValue)) ? Math.max(0, Math.round(Number(frameValue))) : 0;
  return String(BigInt(frame) * BigInt(XML_PPRO_TICKS_PER_FRAME));
}

function pickXmlMotionTemplate(sourceDimensions) {
  if (!sourceDimensions) return XML_DEFAULT_MOTION_TEMPLATE;
  return XML_BASIC_MOTION_TEMPLATES.get(`${sourceDimensions.width}x${sourceDimensions.height}`) ?? XML_DEFAULT_MOTION_TEMPLATE;
}

function resolveXmlMotionScale(sourceDimensions) {
  if (sourceDimensions && sourceDimensions.width > 0 && sourceDimensions.width === sourceDimensions.height) {
    const squareScale = (960 / sourceDimensions.width) * 100;
    const normalized = Number.isFinite(squareScale) ? Number(squareScale.toFixed(1)) : 100;
    return Math.max(5, Math.min(400, normalized));
  }

  if (sourceDimensions && sourceDimensions.width === 3840) {
    return 45;
  }

  const template = pickXmlMotionTemplate(sourceDimensions);
  let scale = Number(template.scale ?? XML_DEFAULT_MOTION_TEMPLATE.scale);
  if (
    sourceDimensions &&
    !XML_BASIC_MOTION_TEMPLATES.has(`${sourceDimensions.width}x${sourceDimensions.height}`) &&
    sourceDimensions.width === 1920 &&
    sourceDimensions.height !== 1080
  ) {
    scale = 90;
  } else if (
    sourceDimensions &&
    !XML_BASIC_MOTION_TEMPLATES.has(`${sourceDimensions.width}x${sourceDimensions.height}`) &&
    XML_WIDTH_SCALE_OVERRIDES.has(sourceDimensions.width)
  ) {
    scale = Number(XML_WIDTH_SCALE_OVERRIDES.get(sourceDimensions.width));
  } else if (
    sourceDimensions &&
    !XML_BASIC_MOTION_TEMPLATES.has(`${sourceDimensions.width}x${sourceDimensions.height}`) &&
    sourceDimensions.width > 0 &&
    sourceDimensions.height > 0 &&
    sourceDimensions.width !== sourceDimensions.height &&
    sourceDimensions.width > sourceDimensions.height
  ) {
    scale = Number(((XML_SEQUENCE_WIDTH / sourceDimensions.width) * 100).toFixed(4));
  }
  return Number.isFinite(scale) && scale > 0 ? scale : 100;
}

function resolveXmlMotionCenterPx({ category, sourceDimensions, scale }) {
  if (sourceDimensions && sourceDimensions.width > 0 && sourceDimensions.width === sourceDimensions.height) {
    const centerNorm = -scale / 200;
    const centerX = centerNorm * (XML_SEQUENCE_WIDTH / 2) + XML_SEQUENCE_WIDTH / 2;
    return { x: centerX, y: XML_DEFAULT_CENTER.y };
  }

  const template = pickXmlMotionTemplate(sourceDimensions);
  if (template?.center && Number.isFinite(template.center.x) && Number.isFinite(template.center.y)) {
    return template.center;
  }
  return XML_DEFAULT_CENTER;
}

function encodeXmlMotionCenter(centerPx) {
  const halfW = XML_SEQUENCE_WIDTH / 2;
  const halfH = XML_SEQUENCE_HEIGHT / 2;
  const x = (Number(centerPx?.x ?? XML_DEFAULT_CENTER.x) - halfW) / halfW;
  const y = (Number(centerPx?.y ?? XML_DEFAULT_CENTER.y) - halfH) / halfH;
  return { x, y };
}

function renderXmlBasicMotionFilter(clip) {
  const scale = formatXmlNumber(clip.motion.scale);
  const centerX = formatXmlNumber(clip.motion.center.x);
  const centerY = formatXmlNumber(clip.motion.center.y);

  return [
    "            <filter>",
    "              <effect>",
    "                <name>Basic Motion</name>",
    "                <effectid>basic</effectid>",
    "                <effectcategory>motion</effectcategory>",
    "                <effecttype>motion</effecttype>",
    "                <mediatype>video</mediatype>",
    "                <pproBypass>false</pproBypass>",
    '                <parameter authoringApp="PremierePro">',
    "                  <parameterid>scale</parameterid>",
    "                  <name>Scale</name>",
    "                  <valuemin>0</valuemin>",
    "                  <valuemax>1000</valuemax>",
    `                  <value>${scale}</value>`,
    "                </parameter>",
    '                <parameter authoringApp="PremierePro">',
    "                  <parameterid>rotation</parameterid>",
    "                  <name>Rotation</name>",
    "                  <valuemin>-8640</valuemin>",
    "                  <valuemax>8640</valuemax>",
    "                  <value>0</value>",
    "                </parameter>",
    '                <parameter authoringApp="PremierePro">',
    "                  <parameterid>center</parameterid>",
    "                  <name>Center</name>",
    "                  <value>",
    `                    <horiz>${centerX}</horiz>`,
    `                    <vert>${centerY}</vert>`,
    "                  </value>",
    "                </parameter>",
    '                <parameter authoringApp="PremierePro">',
    "                  <parameterid>centerOffset</parameterid>",
    "                  <name>Anchor Point</name>",
    "                  <value>",
    "                    <horiz>0</horiz>",
    "                    <vert>0</vert>",
    "                  </value>",
    "                </parameter>",
    '                <parameter authoringApp="PremierePro">',
    "                  <parameterid>antiflicker</parameterid>",
    "                  <name>Anti-flicker Filter</name>",
    "                  <valuemin>0.0</valuemin>",
    "                  <valuemax>1.0</valuemax>",
    "                  <value>0</value>",
    "                </parameter>",
    "              </effect>",
    "            </filter>"
  ];
}

function renderXmlLinkBlock({ targetClipId, mediaType, trackIndex, clipIndex, groupIndex = null }) {
  const lines = [
    "            <link>",
    `              <linkclipref>${escapeXml(targetClipId)}</linkclipref>`,
    `              <mediatype>${mediaType}</mediatype>`,
    `              <trackindex>${trackIndex}</trackindex>`,
    `              <clipindex>${clipIndex}</clipindex>`
  ];
  if (groupIndex != null) {
    lines.push(`              <groupindex>${groupIndex}</groupindex>`);
  }
  lines.push("            </link>");
  return lines;
}

function renderXmlFileElement({ clip, fps, includeVideo, includeAudio }) {
  const sourceWidth = Number(clip?.sourceDimensions?.width);
  const sourceHeight = Number(clip?.sourceDimensions?.height);
  const sourceTotalFrames = Number(clip?.sourceTotalFrames);
  const sourceFileTimebase = Number.isFinite(Number(clip?.sourceFileTimebase)) && Number(clip.sourceFileTimebase) > 0
    ? Math.max(1, Math.round(Number(clip.sourceFileTimebase)))
    : fps;
  const sourceFileDurationFrames = Number(clip?.sourceFileDurationFrames);
  const fileDurationFrames = Number.isFinite(sourceFileDurationFrames) && sourceFileDurationFrames > 0
    ? Math.max(1, Math.round(sourceFileDurationFrames))
    : Math.max(
        Number.isFinite(sourceTotalFrames) && sourceTotalFrames > 0 ? sourceTotalFrames : 0,
        Number(clip?.durationFrames) || 0,
        Number(clip?.sourceOutFrame) || 0,
        1
      );
  const lines = [
    `            <file id="${escapeXml(clip.entry.fileId)}">`,
    `              <name>${escapeXml(clip.fileName)}</name>`,
    `              <pathurl>${escapeXml(clip.pathUrl)}</pathurl>`,
    "              <rate>",
    `                <timebase>${sourceFileTimebase}</timebase>`,
    "                <ntsc>FALSE</ntsc>",
    "              </rate>",
    `              <duration>${fileDurationFrames}</duration>`,
    "              <timecode>",
    "                <rate>",
    `                  <timebase>${sourceFileTimebase}</timebase>`,
    "                  <ntsc>FALSE</ntsc>",
    "                </rate>",
    "                <string>00:00:00:00</string>",
    "                <frame>0</frame>",
    "                <displayformat>NDF</displayformat>",
    "              </timecode>",
    "              <media>"
  ];

  if (includeVideo) {
    lines.push(
      "                <video>",
      "                  <samplecharacteristics>",
      "                    <rate>",
      `                      <timebase>${sourceFileTimebase}</timebase>`,
      "                      <ntsc>FALSE</ntsc>",
      "                    </rate>",
      `                    <width>${Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : XML_SEQUENCE_WIDTH}</width>`,
      `                    <height>${Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : XML_SEQUENCE_HEIGHT}</height>`,
      "                    <anamorphic>FALSE</anamorphic>",
      "                    <pixelaspectratio>square</pixelaspectratio>",
      "                    <fielddominance>none</fielddominance>",
      "                  </samplecharacteristics>",
      "                </video>"
    );
  }

  if (includeAudio) {
    const audioChannelCount = Math.max(1, Math.min(2, Number(clip?.audioChannelCount) || 2));
    if (audioChannelCount > 1) {
      [
        { sourceChannel: 1, label: "left" },
        { sourceChannel: 2, label: "right" }
      ].forEach((channel) => {
        lines.push(
          "                <audio>",
          "                  <samplecharacteristics>",
          "                    <depth>16</depth>",
          "                    <samplerate>48000</samplerate>",
          "                  </samplecharacteristics>",
          "                  <channelcount>1</channelcount>",
          "                  <layout>stereo</layout>",
          "                  <audiochannel>",
          `                    <sourcechannel>${channel.sourceChannel}</sourcechannel>`,
          `                    <channellabel>${channel.label}</channellabel>`,
          "                  </audiochannel>",
          "                </audio>"
        );
      });
    } else {
      lines.push(
        "                <audio>",
        "                  <samplecharacteristics>",
        "                    <depth>16</depth>",
        "                    <samplerate>48000</samplerate>",
        "                  </samplecharacteristics>",
        "                  <channelcount>1</channelcount>",
        "                </audio>"
      );
    }
  }

  lines.push("              </media>", "            </file>");
  return lines;
}

function resolveXmlClipItemDurationFrames(clip) {
  const sourceTotalFrames = Number(clip?.sourceTotalFrames);
  if (Number.isFinite(sourceTotalFrames) && sourceTotalFrames > 0) {
    return Math.max(1, Math.round(sourceTotalFrames));
  }

  const sourceOutFrame = Number(clip?.sourceOutFrame);
  if (Number.isFinite(sourceOutFrame) && sourceOutFrame > 0) {
    return Math.max(1, Math.round(sourceOutFrame));
  }

  const clipDurationFrames = Number(clip?.durationFrames);
  if (Number.isFinite(clipDurationFrames) && clipDurationFrames > 0) {
    return Math.max(1, Math.round(clipDurationFrames));
  }

  return 1;
}

function renderXmlVideoClipItem({ clip, fps, audioPeers = [] }) {
  const sourceInFrame = Math.max(0, Math.round(Number(clip?.sourceInFrame) || 0));
  const sourceOutFrame = Math.max(sourceInFrame, Math.round(Number(clip?.sourceOutFrame) || 0));
  const pproTicksIn = framesToXmlPproTicks(sourceInFrame);
  const pproTicksOut = framesToXmlPproTicks(sourceOutFrame);
  const clipItemDurationFrames = resolveXmlClipItemDurationFrames(clip);
  const lines = [
    `          <clipitem id="${escapeXml(clip.clipId)}">`,
    `            <masterclipid>${escapeXml(clip.entry.masterClipId)}</masterclipid>`,
    `            <name>${escapeXml(clip.fileName)}</name>`,
    "            <enabled>TRUE</enabled>",
    `            <duration>${clipItemDurationFrames}</duration>`,
    "            <rate>",
    `              <timebase>${fps}</timebase>`,
    "              <ntsc>FALSE</ntsc>",
    "            </rate>",
    `            <start>${clip.startFrame}</start>`,
    `            <end>${clip.endFrame}</end>`,
    `            <in>${sourceInFrame}</in>`,
    `            <out>${sourceOutFrame}</out>`,
    `            <pproTicksIn>${pproTicksIn}</pproTicksIn>`,
    `            <pproTicksOut>${pproTicksOut}</pproTicksOut>`,
    `            <alphatype>${clip.category === "image" ? "straight" : "none"}</alphatype>`,
    "            <pixelaspectratio>square</pixelaspectratio>",
    "            <anamorphic>FALSE</anamorphic>"
  ];

  lines.push(
    ...renderXmlFileElement({
      clip,
      fps,
      includeVideo: true,
      includeAudio: Boolean(clip.hasAudio)
    })
  );

  lines.push(...renderXmlBasicMotionFilter(clip));
  lines.push(...renderXmlLinkBlock({
    targetClipId: clip.clipId,
    mediaType: "video",
    trackIndex: clip.videoTrackIndex ?? 1,
    clipIndex: clip.clipIndexInTrack ?? clip.clipIndex
  }));

  audioPeers
    .slice()
    .sort((left, right) => (Number(left?.audioTrackIndex) || 0) - (Number(right?.audioTrackIndex) || 0))
    .forEach((audioPeer) => {
      lines.push(...renderXmlLinkBlock({
        targetClipId: audioPeer.clipId,
        mediaType: "audio",
        trackIndex: audioPeer.audioTrackIndex ?? 1,
        clipIndex: audioPeer.clipIndexInTrack ?? audioPeer.clipIndex
      }));
    });

  lines.push("          </clipitem>");
  return lines;
}

function renderXmlAudioClipItem({ clip, fps, videoPeer, audioPeers = [] }) {
  const sourceInFrame = Math.max(0, Math.round(Number(clip?.sourceInFrame) || 0));
  const sourceOutFrame = Math.max(sourceInFrame, Math.round(Number(clip?.sourceOutFrame) || 0));
  const pproTicksIn = framesToXmlPproTicks(sourceInFrame);
  const pproTicksOut = framesToXmlPproTicks(sourceOutFrame);
  const clipItemDurationFrames = resolveXmlClipItemDurationFrames(clip);
  const channelType = clip?.audioChannelCount === 1 ? "mono" : "stereo";
  const lines = [
    `          <clipitem id="${escapeXml(clip.clipId)}" premiereChannelType="${channelType}">`,
    `            <masterclipid>${escapeXml(clip.entry.masterClipId)}</masterclipid>`,
    `            <name>${escapeXml(clip.fileName)}</name>`,
    "            <enabled>TRUE</enabled>",
    `            <duration>${clipItemDurationFrames}</duration>`,
    "            <rate>",
    `              <timebase>${fps}</timebase>`,
    "              <ntsc>FALSE</ntsc>",
    "            </rate>",
    `            <start>${clip.startFrame}</start>`,
    `            <end>${clip.endFrame}</end>`,
    `            <in>${sourceInFrame}</in>`,
    `            <out>${sourceOutFrame}</out>`,
    `            <pproTicksIn>${pproTicksIn}</pproTicksIn>`,
    `            <pproTicksOut>${pproTicksOut}</pproTicksOut>`
  ];

  if (videoPeer) {
    lines.push(`            <file id="${escapeXml(clip.entry.fileId)}"/>`);
  } else {
    lines.push(
      ...renderXmlFileElement({
        clip,
        fps,
        includeVideo: false,
        includeAudio: true
      })
    );
  }

  lines.push(
    "            <sourcetrack>",
    "              <mediatype>audio</mediatype>",
    `              <trackindex>${Math.max(1, Math.round(Number(clip?.sourceTrackIndex) || Number(clip?.audioTrackIndex) || 1))}</trackindex>`,
    "            </sourcetrack>",
    ...(videoPeer
      ? renderXmlLinkBlock({
          targetClipId: videoPeer.clipId,
          mediaType: "video",
          trackIndex: videoPeer.videoTrackIndex ?? 1,
          clipIndex: videoPeer.clipIndexInTrack ?? videoPeer.clipIndex
        })
      : []),
  );

  audioPeers
    .slice()
    .sort((left, right) => (Number(left?.audioTrackIndex) || 0) - (Number(right?.audioTrackIndex) || 0))
    .forEach((audioPeer) => {
      lines.push(...renderXmlLinkBlock({
        targetClipId: audioPeer.clipId,
        mediaType: "audio",
        trackIndex: audioPeer.audioTrackIndex ?? 1,
        clipIndex: audioPeer.clipIndexInTrack ?? audioPeer.clipIndex
      }));
    });

  lines.push("          </clipitem>");
  return lines;
}

function renderXmlSequenceMarker({ name, inFrame, outFrame, color }) {
  const markerIn = Math.max(0, Math.round(Number(inFrame) || 0));
  const markerOut = Math.max(markerIn, Math.round(Number(outFrame) || markerIn));
  const markerColor = String(color ?? XML_SECTION_MARKER_COLOR).trim() || XML_SECTION_MARKER_COLOR;
  return [
    "    <marker>",
    "      <comment></comment>",
    `      <name>${escapeXml(name || "Тема")}</name>`,
    `      <in>${markerIn}</in>`,
    `      <out>${markerOut}</out>`,
    `      <pproColor>${markerColor}</pproColor>`,
    "    </marker>"
  ];
}

function buildXmemlTimeline({
  sequenceName,
  fps,
  totalFrames,
  videoClips,
  audioClips,
  sectionMarkers = [],
  audioTrackCount = 1
}) {
  const audioByEntryId = new Map();
  audioClips.forEach((clip) => {
    const key = clip?.entry?.entryId;
    if (!key) return;
    if (!audioByEntryId.has(key)) {
      audioByEntryId.set(key, []);
    }
    audioByEntryId.get(key).push(clip);
  });
  const videoByEntryId = new Map(videoClips.map((clip) => [clip.entry.entryId, clip]));
  const videoTracks = new Map();
  videoClips.forEach((clip) => {
    const trackIndex = Number.isFinite(Number(clip?.videoTrackIndex))
      ? Math.max(1, Math.round(Number(clip.videoTrackIndex)))
      : 1;
    if (!videoTracks.has(trackIndex)) {
      videoTracks.set(trackIndex, []);
    }
    videoTracks.get(trackIndex).push(clip);
  });
  const maxClipVideoTrackIndex = videoTracks.size > 0 ? Math.max(...videoTracks.keys()) : 0;
  const totalVideoTracks = Math.max(maxClipVideoTrackIndex, XML_RESERVED_VIDEO_TRACKS);
  const orderedVideoTrackIndexes = Array.from({ length: Math.max(1, totalVideoTracks) }, (_, index) => index + 1);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    "    <uuid>00000000-0000-0000-0000-000000000000</uuid>",
    `    <name>${escapeXml(sequenceName)}</name>`,
    `    <duration>${Math.max(1, totalFrames)}</duration>`,
    "    <rate>",
    `      <timebase>${fps}</timebase>`,
    "      <ntsc>FALSE</ntsc>",
    "    </rate>",
    "    <media>",
    "      <video>",
    "        <format>",
    "          <samplecharacteristics>",
    "            <rate>",
    `              <timebase>${fps}</timebase>`,
    "              <ntsc>FALSE</ntsc>",
    "            </rate>",
    `            <width>${XML_SEQUENCE_WIDTH}</width>`,
    `            <height>${XML_SEQUENCE_HEIGHT}</height>`,
    "            <anamorphic>FALSE</anamorphic>",
    "            <pixelaspectratio>square</pixelaspectratio>",
    "            <fielddominance>none</fielddominance>",
    "            <colordepth>24</colordepth>",
    "          </samplecharacteristics>",
    "        </format>"
  ];

  orderedVideoTrackIndexes.forEach((trackIndex) => {
    const trackTargeted = trackIndex === 1 ? 1 : 0;
    const isReservedVideoTrack = trackIndex <= XML_RESERVED_VIDEO_TRACKS;
    const trackLocked = isReservedVideoTrack ? "TRUE" : "FALSE";
    lines.push(
      `        <track TL.SQTrackShy="0" TL.SQTrackExpandedHeight="41" TL.SQTrackExpanded="0" MZ.TrackTargeted="${trackTargeted}">`
    );
    const clipsForTrack = (videoTracks.get(trackIndex) ?? []).slice().sort((left, right) => {
      const startDiff = (Number(left?.startFrame) || 0) - (Number(right?.startFrame) || 0);
      if (startDiff !== 0) return startDiff;
      return (Number(left?.clipIndexInTrack) || 0) - (Number(right?.clipIndexInTrack) || 0);
    });
    clipsForTrack.forEach((clip) => {
      lines.push(...renderXmlVideoClipItem({
        clip,
        fps,
        audioPeers: audioByEntryId.get(clip.entry.entryId) ?? []
      }));
    });
    lines.push("          <enabled>TRUE</enabled>", `          <locked>${trackLocked}</locked>`);
    lines.push("        </track>");
  });

  lines.push(
    "      </video>",
    "      <audio>",
    "        <numOutputChannels>1</numOutputChannels>",
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
    "        </outputs>"
  );

  const audioTracks = new Map();
  audioClips.forEach((clip) => {
    const trackIndex = Number.isFinite(Number(clip?.audioTrackIndex))
      ? Math.max(1, Math.round(Number(clip.audioTrackIndex)))
      : 1;
    if (!audioTracks.has(trackIndex)) {
      audioTracks.set(trackIndex, []);
    }
    audioTracks.get(trackIndex).push(clip);
  });
  const maxClipAudioTrackIndex = audioTracks.size > 0 ? Math.max(...audioTracks.keys()) : 1;
  const forcedAudioTrackCount = Number.isFinite(Number(audioTrackCount))
    ? Math.max(1, Math.round(Number(audioTrackCount)))
    : 1;
  const totalAudioTracks = Math.max(forcedAudioTrackCount, maxClipAudioTrackIndex);
  const orderedAudioTrackIndexes = Array.from({ length: totalAudioTracks }, (_, index) => index + 1);

  orderedAudioTrackIndexes.forEach((trackIndex) => {
    const outputChannelIndex = ((trackIndex - 1) % 2) + 1;
    const explodedTrackIndex = (trackIndex - 1) % 2;
    const isReservedAudioTrack = trackIndex <= XML_RESERVED_AUDIO_TRACKS;
    const trackLocked = isReservedAudioTrack ? "TRUE" : "FALSE";
    lines.push(
      `        <track TL.SQTrackAudioKeyframeStyle="0" TL.SQTrackShy="0" TL.SQTrackExpandedHeight="41" TL.SQTrackExpanded="0" MZ.TrackTargeted="1" PannerCurrentValue="0.5" PannerStartKeyframe="-91445760000000000,0.5,0,0,0,0,0,0" PannerName="Balance" currentExplodedTrackIndex="${explodedTrackIndex}" totalExplodedTrackCount="2" premiereTrackType="Mono">`
    );
    const clipsForTrack = (audioTracks.get(trackIndex) ?? []).slice().sort((left, right) => {
      const startDiff = (Number(left?.startFrame) || 0) - (Number(right?.startFrame) || 0);
      if (startDiff !== 0) return startDiff;
      return (Number(left?.clipIndexInTrack) || 0) - (Number(right?.clipIndexInTrack) || 0);
    });
    clipsForTrack.forEach((clip) => {
      lines.push(...renderXmlAudioClipItem({
        clip,
        fps,
        videoPeer: videoByEntryId.get(clip.entry.entryId) ?? null,
        audioPeers: audioByEntryId.get(clip.entry.entryId) ?? []
      }));
    });
    lines.push(
      "          <enabled>TRUE</enabled>",
      `          <locked>${trackLocked}</locked>`,
      `          <outputchannelindex>${outputChannelIndex}</outputchannelindex>`
    );
    lines.push("        </track>");
  });

  lines.push(
    "      </audio>",
    "    </media>",
  );

  sectionMarkers.forEach((marker) => {
    lines.push(...renderXmlSequenceMarker(marker));
  });

  lines.push(
    "    <timecode>",
    "      <rate>",
    `        <timebase>${fps}</timebase>`,
    "        <ntsc>FALSE</ntsc>",
    "      </rate>",
    "      <string>00:00:00:00</string>",
    "      <frame>0</frame>",
    "      <displayformat>NDF</displayformat>",
    "    </timecode>",
    "  </sequence>",
    "</xmeml>",
    ""
  );

  return lines.join("\n");
}

async function buildXmlExportPayload({
  document,
  segments,
  decisionsBySegment,
  timelineAlignment,
  mediaDir,
  mediaPathRootOverride,
  fps,
  defaultDurationSec,
  sectionId,
  sectionTitle
}) {
  const fpsValue = Number.isFinite(Number(fps)) ? Math.max(1, Math.round(Number(fps))) : XML_EXPORT_FPS;
  const fallbackDuration = Number.isFinite(Number(defaultDurationSec))
    ? Math.max(0.2, Number(defaultDurationSec))
    : XML_EXPORT_DEFAULT_DURATION_SEC;
  const mediaRoot = path.resolve(String(mediaDir ?? getMediaDir()));
  const exportFileName = buildXmlExportFileName({
    documentId: document?.id ?? "document",
    sectionId,
    sectionTitle
  });

  const markerDurationFrames = secondsToFrames(XML_SECTION_MARKER_DURATION_SEC, fpsValue);
  const sectionGapFrames = XML_SECTION_GAP_SEC > 0 ? secondsToFrames(XML_SECTION_GAP_SEC, fpsValue) : 0;
  const sectionMarkers = [];
  const mediaEntries = [];
  const timelineAlignmentMap = XML_TIMELINE_ALIGNMENT_ENABLED ? buildTimelineAlignmentMap(timelineAlignment) : new Map();
  const useTimelineAlignment = timelineAlignmentMap.size > 0;
  const fallbackAlignmentMap = new Map();
  if (useTimelineAlignment) {
    let index = 0;
    while (index < segments.length) {
      const segmentId = String(segments[index]?.segment_id ?? "").trim();
      if (!segmentId || timelineAlignmentMap.has(segmentId)) {
        index += 1;
        continue;
      }

      const runStart = index;
      while (index < segments.length) {
        const runSegmentId = String(segments[index]?.segment_id ?? "").trim();
        if (!runSegmentId || timelineAlignmentMap.has(runSegmentId)) break;
        index += 1;
      }
      const runEnd = index;

      let previousAlignment = null;
      for (let cursor = runStart - 1; cursor >= 0; cursor -= 1) {
        const previousId = String(segments[cursor]?.segment_id ?? "").trim();
        previousAlignment = timelineAlignmentMap.get(previousId) ?? fallbackAlignmentMap.get(previousId) ?? null;
        if (previousAlignment) break;
      }
      let nextAlignment = null;
      for (let cursor = runEnd; cursor < segments.length; cursor += 1) {
        const nextId = String(segments[cursor]?.segment_id ?? "").trim();
        nextAlignment = timelineAlignmentMap.get(nextId) ?? null;
        if (nextAlignment) break;
      }

      const gapStart = Number(previousAlignment?.end_frame);
      const gapEnd = Number(nextAlignment?.start_frame);
      if (!Number.isFinite(gapStart) || !Number.isFinite(gapEnd) || gapEnd <= gapStart) continue;
      const runLength = runEnd - runStart;
      const gapFrames = Math.max(runLength, Math.round(gapEnd - gapStart));
      let cursorFrame = Math.round(gapStart);
      for (let runIndex = runStart; runIndex < runEnd; runIndex += 1) {
        const runSegmentId = String(segments[runIndex]?.segment_id ?? "").trim();
        if (!runSegmentId) continue;
        const remainingItems = runEnd - runIndex;
        const remainingFrames = Math.max(remainingItems, Math.round(gapEnd) - cursorFrame);
        const frames = runIndex === runEnd - 1
          ? remainingFrames
          : Math.max(1, Math.floor(gapFrames / runLength));
        const startFrame = cursorFrame;
        const endFrame = Math.max(startFrame + 1, Math.min(Math.round(gapEnd), startFrame + frames));
        fallbackAlignmentMap.set(runSegmentId, {
          segment_id: runSegmentId,
          matched: true,
          fallback_timeline_slot: true,
          start_frame: startFrame,
          end_frame: endFrame
        });
        cursorFrame = endFrame;
      }
    }
  }
  let frameCursor = 0;
  let activeSectionKey = null;
  let maxAudioFilesPerSegment = 1;
  let contentClipCount = 0;
  let alternatingBackgroundCursor = 0;
  const backgroundAssets = XML_AUTO_BACKGROUNDS_ENABLED ? await resolveXmlBackgroundAssets({ fps: fpsValue }) : new Map();

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const segmentId = String(segment?.segment_id ?? "").trim();
    const alignmentItem = segmentId ? timelineAlignmentMap.get(segmentId) ?? fallbackAlignmentMap.get(segmentId) ?? null : null;

    const sectionKey = getXmlSectionMarkerKey(segment);
    if (sectionKey !== activeSectionKey) {
      const markerStartFrame = alignmentItem?.start_frame ?? frameCursor;
      if (!useTimelineAlignment && activeSectionKey && sectionGapFrames > 0) {
        sectionMarkers.push({
          name: getXmlSectionMarkerName(segment),
          inFrame: frameCursor,
          outFrame: frameCursor + sectionGapFrames,
          color: XML_SECTION_MARKER_COLOR
        });
        frameCursor += sectionGapFrames;
      }
      sectionMarkers.push({
        name: getXmlSectionMarkerName(segment),
        inFrame: markerStartFrame,
        outFrame: markerStartFrame + markerDurationFrames,
        color: XML_SECTION_MARKER_COLOR
      });
      activeSectionKey = sectionKey;
    }

    const decision = segmentId ? decisionsBySegment.get(segmentId) ?? {} : {};
    const rawVisual = decision.visual ?? decision.visual_decision ?? null;
    const visual = normalizeVisualDecisionInput(rawVisual);
    const mediaLayout = String(rawVisual?.media_layout ?? "").trim() === "stacked" ? "stacked" : "sequential";
    const visualMediaTimecodes =
      visual?.media_file_timecodes && typeof visual.media_file_timecodes === "object"
        ? visual.media_file_timecodes
        : {};
    const mediaPathCandidates = [];
    if (Array.isArray(visual.media_file_paths)) {
      mediaPathCandidates.push(...visual.media_file_paths);
    } else if (visual.media_file_paths != null) {
      mediaPathCandidates.push(visual.media_file_paths);
    }
    const primaryMediaPath = normalizeMediaFilePath(visual.media_file_path ?? null);
    if (primaryMediaPath && !mediaPathCandidates.map((candidate) => normalizeMediaFilePath(candidate)).includes(primaryMediaPath)) {
      mediaPathCandidates.push(primaryMediaPath);
    }

    const indexedMediaTimecodes = Array.isArray(visual.media_file_timecodes_list)
      ? visual.media_file_timecodes_list
      : [];
    const mediaCandidates = [];
    mediaPathCandidates.forEach((candidate, candidateIndex) => {
      const normalizedPath = normalizeMediaFilePath(candidate);
      if (!normalizedPath) return;
      mediaCandidates.push({
        mediaPath: normalizedPath,
        sourceStartRaw: indexedMediaTimecodes[candidateIndex] ?? visualMediaTimecodes[normalizedPath] ?? visual.media_start_timecode
      });
    });

    const resolvedMediaFiles = [];
    for (let { mediaPath, sourceStartRaw } of mediaCandidates) {
      if (/\.(avif|webp|webm|mkv)$/i.test(mediaPath)) {
        const ext = path.extname(mediaPath).toLowerCase();
        const targetExt = (ext === ".avif" || ext === ".webp") ? ".jpg" : ".mp4";
        const convertedPath = mediaPath.slice(0, -ext.length) + targetExt;
        const convertedAbs = safeResolveMediaPath(mediaRoot, convertedPath);
        if (convertedAbs && (await fs.stat(convertedAbs).catch(() => null))?.isFile()) {
          mediaPath = convertedPath;
        }
      }
      if (!isXmlMediaPathCompatibleWithSegment(mediaPath, segment)) continue;
      const absolutePath = safeResolveMediaPath(mediaRoot, mediaPath);
      if (!absolutePath) continue;
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats || !stats.isFile()) continue;
      resolvedMediaFiles.push({ mediaPath, absolutePath, sourceStartRaw });
    }

    // Resolve TTS audio if available
    const ttsAudioCandidate = normalizeMediaFilePath(visual.tts_audio_path ?? null);
    let resolvedTtsAudio = null;
    if (ttsAudioCandidate) {
      const ttsAbsPath = safeResolveMediaPath(mediaRoot, ttsAudioCandidate);
      if (ttsAbsPath) {
        const ttsStats = await fs.stat(ttsAbsPath).catch(() => null);
        if (ttsStats?.isFile() && ttsStats.size > 0) {
          const ttsInfo = await getXmlMediaInfo(ttsAbsPath, "audio");
          resolvedTtsAudio = {
            mediaPath: ttsAudioCandidate,
            absolutePath: ttsAbsPath,
            durationSec: ttsInfo?.durationSec ?? visual.duration_hint_sec
          };
        }
      }
    }

    if (!resolvedMediaFiles.length && !resolvedTtsAudio) {
      const segmentStartFrame = alignmentItem?.start_frame ?? frameCursor;
      const segmentDurationSec = normalizeXmlDurationSeconds(visual.duration_hint_sec, fallbackDuration, "video");
      const segmentDurationFrames = alignmentItem
        ? Math.max(1, alignmentItem.end_frame - alignmentItem.start_frame)
        : secondsToFrames(segmentDurationSec, fpsValue);
      const segmentEndFrame = alignmentItem?.end_frame ?? segmentStartFrame + segmentDurationFrames;
      sectionMarkers.push({
        name: getXmlSegmentMarkerName(segment),
        inFrame: segmentStartFrame,
        outFrame: segmentEndFrame,
        color: resolveXmlSegmentMarkerColor({ segment, visual })
      });
      frameCursor = useTimelineAlignment ? Math.max(frameCursor, segmentEndFrame) : segmentEndFrame;
      continue;
    }
    let segmentAudioTrackCursor = 0;
    let segmentAudioFilesCount = 0;

    const primaryCategory = resolvedMediaFiles.length ? detectXmlMediaCategory(resolvedMediaFiles[0].absolutePath) : "video";
    let rangeDurationSec = null;
    const firstMedia = resolvedMediaFiles[0];
    if (firstMedia && firstMedia.sourceStartRaw && firstMedia.sourceStartRaw.includes("-")) {
      const parts = firstMedia.sourceStartRaw.split("-").map((p) => p.trim());
      if (parts[0] && parts[1]) {
        const startSec = parseXmlStartTimecodeToSeconds(parts[0], fpsValue);
        const endSec = parseXmlStartTimecodeToSeconds(parts[1], fpsValue);
        if (endSec > startSec) {
          rangeDurationSec = endSec - startSec;
        }
      }
    }
    const ttsDuration = Number(resolvedTtsAudio?.durationSec || visual.duration_hint_sec);
    const desiredDurationSec = Number.isFinite(ttsDuration) && ttsDuration > 0
      ? ttsDuration
      : (rangeDurationSec !== null
          ? rangeDurationSec
          : normalizeXmlDurationSeconds(visual.duration_hint_sec, fallbackDuration, primaryCategory));
    const desiredDurationFrames = alignmentItem
      ? Math.max(1, alignmentItem.end_frame - alignmentItem.start_frame)
      : secondsToFrames(desiredDurationSec, fpsValue);
    const segmentStartFrame = alignmentItem?.start_frame ?? frameCursor;
    const segmentEndFrame = alignmentItem?.end_frame ?? segmentStartFrame + desiredDurationFrames;
    const segmentMarkerName = getXmlSegmentMarkerName(segment);
    const segmentMarkerColor = resolveXmlSegmentMarkerColor({ segment, visual });
    const segmentEntries = [];
    let segmentVideoTrackCursor = 0;

    for (let mediaOffset = 0; mediaOffset < resolvedMediaFiles.length; mediaOffset += 1) {
      const { mediaPath, absolutePath, sourceStartRaw } = resolvedMediaFiles[mediaOffset];
      const hintedCategory = detectXmlMediaCategory(absolutePath);
      const mediaInfo = await getXmlMediaInfo(absolutePath, hintedCategory);
      const mediaSlot = mediaLayout === "stacked"
        ? { startFrame: segmentStartFrame, endFrame: segmentEndFrame }
        : getXmlSequentialSlot({
          startFrame: segmentStartFrame,
          endFrame: segmentEndFrame,
          index: mediaOffset,
          count: resolvedMediaFiles.length
        });
      const mediaSlotDurationFrames = Math.max(1, mediaSlot.endFrame - mediaSlot.startFrame);
      const audioChannelCount = mediaInfo.hasAudio
        ? Math.max(1, Math.min(2, Number(mediaInfo.audioChannels) || 2))
        : 0;
      const segmentVideoTrackIndex = mediaInfo.hasVideo ? segmentVideoTrackCursor + 1 : null;
      if (mediaInfo.hasVideo) {
        segmentVideoTrackCursor = segmentVideoTrackIndex;
      }
      const segmentAudioTrackIndex = mediaInfo.hasAudio ? segmentAudioTrackCursor + 1 : null;
      if (mediaInfo.hasAudio) {
        segmentAudioTrackCursor += audioChannelCount;
        segmentAudioFilesCount = Math.max(segmentAudioFilesCount, segmentAudioTrackCursor);
      }
      const category = mediaInfo.category;
      const sourceStartSec = category === "video"
        ? parseXmlStartTimecodeToSeconds(sourceStartRaw, fpsValue)
        : 0;
      const sourceInFrame = secondsToFramesAllowZero(sourceStartSec, fpsValue);
      const sourceTotalFrames = Number.isFinite(Number(mediaInfo.durationSec)) && Number(mediaInfo.durationSec) > 0
        ? secondsToFramesAllowZero(mediaInfo.durationSec, fpsValue)
        : null;
      const availableFrames = Number.isFinite(sourceTotalFrames)
        ? Math.max(0, sourceTotalFrames - sourceInFrame)
        : null;
      const entryDurationFrames = Number.isFinite(availableFrames)
        ? Math.max(1, Math.min(mediaSlotDurationFrames, availableFrames))
        : mediaSlotDurationFrames;
      const sourceOutFrame = sourceInFrame + entryDurationFrames;
      const sourceDimensions = mediaInfo.sourceDimensions;
      const motionScale = resolveXmlMotionScale(sourceDimensions);
      const motionCenterPx = resolveXmlMotionCenterPx({
        category,
        sourceDimensions,
        scale: motionScale
      });
      const motionCenter = encodeXmlMotionCenter(motionCenterPx);
      const mediaIndex = mediaEntries.length + segmentEntries.length + 1;
      const mediaXmlPath = resolveXmlPathWithMediaRootOverride({
        mediaPath,
        absolutePath,
        mediaPathRootOverride
      });
      segmentEntries.push({
        entryId: `entry-${mediaIndex}`,
        segmentId: segmentId || `segment_${index + 1}`,
        segmentQuote: String(segment?.text_quote ?? ""),
        segmentBlockType: String(segment?.block_type ?? ""),
        visualFormatHint: String(visual?.format_hint ?? ""),
        fileId: `file-${mediaIndex}`,
        masterClipId: `masterclip-${mediaIndex}`,
        fileName: path.basename(absolutePath),
        pathUrl: toXmlFileUrl(mediaXmlPath),
        durationFrames: entryDurationFrames,
        sourceTotalFrames: Number.isFinite(Number(sourceTotalFrames)) && Number(sourceTotalFrames) > 0
          ? sourceTotalFrames
          : null,
        sourceInFrame,
        sourceOutFrame,
        startFrame: mediaSlot.startFrame,
        endFrame: mediaSlot.startFrame + entryDurationFrames,
        category,
        hasAudio: Boolean(mediaInfo.hasAudio),
        hasVideo: Boolean(mediaInfo.hasVideo),
        audioChannelCount,
        sourceDimensions,
        videoTrackIndex: segmentVideoTrackIndex,
        audioTrackHint: segmentAudioTrackIndex,
        motion: {
          scale: motionScale,
          center: motionCenter
        }
      });
    }
    contentClipCount += segmentEntries.length;

    const backgroundCandidateEntries = segmentEntries.filter((entry) => {
      if (!entry?.hasVideo) return false;
      if (isXmlSquareByDimensions(entry.sourceDimensions)) return false;
      if (isXmlSquareFormatHint(entry.visualFormatHint)) return false;
      if (isXmlSequenceAspectByDimensions(entry.sourceDimensions)) return false;
      return true;
    });

    const needsAutoBackground = backgroundCandidateEntries.length > 0;
    if (needsAutoBackground && backgroundAssets.size > 0) {
      const hasPortraitEntry = backgroundCandidateEntries.some((entry) => isXmlPortraitDimensions(entry.sourceDimensions));
      const hasImageEntry = backgroundCandidateEntries.some((entry) => String(entry?.category ?? "") === "image");
      const titleQuoteMode = isXmlTitleQuoteFormatHint(visual?.format_hint);
      let backgroundKind = null;
      if (hasPortraitEntry) {
        backgroundKind = "whirl";
      } else if (titleQuoteMode) {
        backgroundKind = "ribbon";
      } else if (hasImageEntry) {
        backgroundKind = alternatingBackgroundCursor % 2 === 0 ? "ribbon" : "whirl";
        alternatingBackgroundCursor += 1;
      } else {
        backgroundKind = alternatingBackgroundCursor % 3 === 0 ? "whirl" : alternatingBackgroundCursor % 3 === 1 ? "lines" : "ribbon";
        alternatingBackgroundCursor += 1;
      }

      const backgroundAsset = backgroundAssets.get(backgroundKind) ?? null;
      if (backgroundAsset) {
        segmentEntries.forEach((entry) => {
          if (!entry?.hasVideo) return;
          entry.videoTrackIndex = Math.max(1, Math.round(Number(entry.videoTrackIndex) || 1)) + 1;
        });

        const backgroundMotionScale = Number(XML_BACKGROUND_SCALES[backgroundKind] ?? 50);
        const backgroundMotionCenterPx = resolveXmlMotionCenterPx({
          category: "video",
          sourceDimensions: backgroundAsset.sourceDimensions,
          scale: backgroundMotionScale
        });
        const backgroundMotionCenter = encodeXmlMotionCenter(backgroundMotionCenterPx);
        const backgroundEntries = [];
        const backgroundMediaIndex = mediaEntries.length + segmentEntries.length + 1;
        backgroundEntries.push({
            entryId: `entry-${backgroundMediaIndex}`,
            segmentId: segmentId || `segment_${index + 1}`,
            segmentQuote: String(segment?.text_quote ?? ""),
            segmentBlockType: String(segment?.block_type ?? ""),
            visualFormatHint: String(visual?.format_hint ?? ""),
            fileId: `file-${backgroundMediaIndex}`,
            masterClipId: `masterclip-${backgroundMediaIndex}`,
            fileName: backgroundAsset.fileName,
            pathUrl: toXmlFileUrl(backgroundAsset.absolutePath),
            durationFrames: desiredDurationFrames,
            sourceTotalFrames: backgroundAsset.sourceTotalFrames ?? null,
            sourceFileTimebase: backgroundAsset.sourceTimebase ?? fpsValue,
            sourceFileDurationFrames: backgroundAsset.sourceDurationFrames ?? null,
            sourceInFrame: 0,
            sourceOutFrame: desiredDurationFrames,
            startFrame: segmentStartFrame,
            endFrame: segmentStartFrame + desiredDurationFrames,
            category: "video",
            hasAudio: false,
            hasVideo: true,
            audioChannelCount: 0,
            sourceDimensions: backgroundAsset.sourceDimensions,
            videoTrackIndex: 1,
            audioTrackHint: null,
            motion: {
              scale: backgroundMotionScale,
              center: backgroundMotionCenter
            }
        });

        if (backgroundEntries.length > 0) {
          segmentEntries.unshift(...backgroundEntries);
        }
      }
    }

    // Attach TTS audio clip on Track A1 if present
    if (resolvedTtsAudio) {
      const ttsMediaIndex = mediaEntries.length + segmentEntries.length + 1;
      const ttsXmlPath = resolveXmlPathWithMediaRootOverride({
        mediaPath: resolvedTtsAudio.mediaPath,
        absolutePath: resolvedTtsAudio.absolutePath,
        mediaPathRootOverride
      });
      const ttsTotalFrames = secondsToFramesAllowZero(resolvedTtsAudio.durationSec, fpsValue);
      segmentEntries.push({
        entryId: `entry-tts-${ttsMediaIndex}`,
        segmentId: segmentId || `segment_${index + 1}`,
        segmentQuote: String(segment?.text_quote ?? ""),
        segmentBlockType: String(segment?.block_type ?? ""),
        visualFormatHint: String(visual?.format_hint ?? ""),
        fileId: `file-tts-${ttsMediaIndex}`,
        masterClipId: `masterclip-tts-${ttsMediaIndex}`,
        fileName: path.basename(resolvedTtsAudio.absolutePath),
        pathUrl: toXmlFileUrl(ttsXmlPath),
        durationFrames: desiredDurationFrames,
        sourceTotalFrames: ttsTotalFrames > 0 ? ttsTotalFrames : desiredDurationFrames,
        sourceInFrame: 0,
        sourceOutFrame: desiredDurationFrames,
        startFrame: segmentStartFrame,
        endFrame: segmentEndFrame,
        category: "audio",
        hasAudio: true,
        hasVideo: false,
        audioChannelCount: 1,
        sourceDimensions: null,
        videoTrackIndex: null,
        audioTrackHint: 1,
        motion: null
      });
      segmentAudioFilesCount = Math.max(segmentAudioFilesCount, 1);
    }

    maxAudioFilesPerSegment = Math.max(maxAudioFilesPerSegment, segmentAudioFilesCount || 1);
    sectionMarkers.push({
      name: segmentMarkerName,
      inFrame: segmentStartFrame,
      outFrame: segmentEndFrame,
      color: segmentMarkerColor
    });

    frameCursor = useTimelineAlignment ? Math.max(frameCursor, segmentEndFrame) : segmentEndFrame;
    mediaEntries.push(...segmentEntries);
  }

  if (!mediaEntries.length) {
    return {
      clipCount: 0,
      fileName: exportFileName,
      xml: ""
    };
  }

  const videoClips = [];
  const audioClips = [];
  let videoClipIndex = 1;
  let audioClipIndex = 1;
  const videoTrackClipCounters = new Map();
  const audioTrackClipCounters = new Map();
  mediaEntries.forEach((entry) => {
    if (entry.hasVideo) {
      const trackIndex = Number.isFinite(Number(entry.videoTrackIndex))
        ? Math.max(1, Math.round(Number(entry.videoTrackIndex)))
        : 1;
      const shiftedTrackIndex = trackIndex + XML_RESERVED_VIDEO_TRACKS;
      const trackClipIndex = (videoTrackClipCounters.get(trackIndex) ?? 0) + 1;
      videoTrackClipCounters.set(trackIndex, trackClipIndex);
      videoClips.push({
        ...entry,
        entry,
        startFrame: entry.startFrame,
        endFrame: entry.endFrame,
        clipId: null,
        clipIndex: videoClipIndex,
        clipIndexInTrack: trackClipIndex,
        videoTrackIndex: shiftedTrackIndex
      });
      videoClipIndex += 1;
    }

    if (entry.hasAudio) {
      const baseTrackIndex = Number.isFinite(Number(entry.audioTrackHint))
        ? Math.max(1, Math.round(Number(entry.audioTrackHint)))
        : 1;
      const channelCount = Math.max(1, Math.min(2, Number(entry.audioChannelCount) || 2));
      for (let channelOffset = 0; channelOffset < channelCount; channelOffset += 1) {
        const trackIndex = baseTrackIndex + channelOffset;
        const shiftedTrackIndex = trackIndex + XML_RESERVED_AUDIO_TRACKS;
        const sourceTrackIndex = ((shiftedTrackIndex - 1) % 2) + 1;
        const trackClipIndex = (audioTrackClipCounters.get(trackIndex) ?? 0) + 1;
        audioTrackClipCounters.set(trackIndex, trackClipIndex);
        audioClips.push({
          ...entry,
          entry,
          startFrame: entry.startFrame,
          endFrame: entry.endFrame,
          clipId: null,
          clipIndex: audioClipIndex,
          clipIndexInTrack: trackClipIndex,
          audioTrackIndex: shiftedTrackIndex,
          sourceTrackIndex
        });
        audioClipIndex += 1;
      }
    }
  });
  let xmlClipItemCounter = 1;
  videoClips.forEach((clip) => {
    clip.clipId = `clipitem-${xmlClipItemCounter}`;
    xmlClipItemCounter += 1;
  });
  audioClips.forEach((clip) => {
    clip.clipId = `clipitem-${xmlClipItemCounter}`;
    xmlClipItemCounter += 1;
  });

  const xml = buildXmemlTimeline({
    sequenceName: buildXmlSequenceName({ document, sectionId, sectionTitle }),
    fps: fpsValue,
    totalFrames: frameCursor,
    videoClips,
    audioClips,
    sectionMarkers,
    audioTrackCount: maxAudioFilesPerSegment
  });

  return {
    clipCount: mediaEntries.length,
    fileName: exportFileName,
    xml
  };
}



  return {
    XML_EXPORT_DEFAULT_DURATION_SEC,
    XML_EXPORT_FPS,
    buildContentDisposition,
    buildXmlExportPayload
  };
}
