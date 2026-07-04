import fs from "node:fs/promises";
import path from "node:path";

const TIMECODE_RANGE_RE = /^(\d{2}:\d{2}:\d{2}:\d{1,2})\s*-\s*(\d{2}:\d{2}:\d{2}:\d{1,2})\s*$/;
const SPEAKER_RE = /^speaker\s+\d+/i;
const DEFAULT_MAX_WINDOW_BLOCKS = 3;
const DEFAULT_MIN_MATCH_SCORE = 0.55;
const TIMELINE_ANCHOR_STOPWORDS = new Set([
  "это",
  "есть",
  "может",
  "быть",
  "когда",
  "который",
  "которые",
  "которая",
  "такой",
  "такая",
  "такие",
  "сейчас",
  "потом",
  "после",
  "перед",
  "очень",
  "просто",
  "тоже",
  "тут",
  "там"
]);
const ASR_NORMALIZATION_REPLACEMENTS = [
  [/автоваза\s+два/gi, "the last of us ii"],
  [/автоваз\s+два/gi, "the last of us ii"],
  [/ласт\s+оф\s+ас\s*(?:два|2|ii)?/gi, "the last of us ii"],
  [/на\s+полу\s+в\s+юте\s+сквозь\s+двор/gi, "call of duty black ops cold war"],
  [/сквозь\s+двор/gi, "cold war"],
  [/кол\s+оф\s+дьюти/gi, "call of duty"],
  [/блек\s+опс/gi, "black ops"],
  [/блэк\s+опс/gi, "black ops"],
  [/колд\s+вор/gi, "cold war"]
];

export function timecodeToFrames(value, fps = 50) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{1,2})$/);
  if (!match) return null;
  const [, hh, mm, ss, ff] = match;
  const rate = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Math.round(Number(fps)) : 50;
  return (
    Number.parseInt(hh, 10) * 3600 * rate +
    Number.parseInt(mm, 10) * 60 * rate +
    Number.parseInt(ss, 10) * rate +
    Number.parseInt(ff, 10)
  );
}

export function framesToTimecode(frames, fps = 50) {
  const rate = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Math.round(Number(fps)) : 50;
  const total = Math.max(0, Math.round(Number(frames) || 0));
  const hh = Math.floor(total / (3600 * rate));
  const mm = Math.floor((total - hh * 3600 * rate) / (60 * rate));
  const ss = Math.floor((total - hh * 3600 * rate - mm * 60 * rate) / rate);
  const ff = total % rate;
  return [hh, mm, ss, ff].map((part) => String(part).padStart(2, "0")).join(":");
}

export async function readTranscriptText(filePath) {
  return fs.readFile(filePath, "utf8");
}

export function parseTranscriptBlocks(text, fps = 50) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rangeMatch = String(lines[index] ?? "").trim().match(TIMECODE_RANGE_RE);
    if (!rangeMatch) continue;
    const start_tc = rangeMatch[1];
    const end_tc = rangeMatch[2];
    let cursor = index + 1;
    if (SPEAKER_RE.test(String(lines[cursor] ?? "").trim())) cursor += 1;
    const textLines = [];
    while (cursor < lines.length && !TIMECODE_RANGE_RE.test(String(lines[cursor] ?? "").trim())) {
      const line = String(lines[cursor] ?? "").trim();
      if (line) textLines.push(line);
      cursor += 1;
    }
    const blockText = textLines.join(" ").replace(/\s+/g, " ").trim();
    const start_frame = timecodeToFrames(start_tc, fps);
    const end_frame = timecodeToFrames(end_tc, fps);
    if (blockText && start_frame != null && end_frame != null && end_frame > start_frame) {
      blocks.push({
        index: blocks.length,
        start_tc,
        end_tc,
        start_frame,
        end_frame,
        text: blockText,
        normalized_text: normalizeTimelineText(blockText),
        tokens: tokenizeTimelineText(blockText)
      });
    }
    index = cursor - 1;
  }
  return blocks;
}

export function normalizeTimelineText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of ASR_NORMALIZATION_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[“”„"«»'`]/g, "")
    .replace(/[\u00a0\s]+/g, " ")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeTimelineText(value) {
  const tokens = normalizeTimelineText(value)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  return tokens;
}

function isDirectiveSegment(segment) {
  const text = String(segment?.text_quote ?? "").trim();
  const normalized = normalizeTimelineText(text);
  return (
    /^\/+/.test(text) ||
    /^(кадры|фрагмент|нарезка|видео|портреты|логотипы)(?:\s|$)/.test(normalized)
  );
}

function countTokenOverlap(leftTokens = [], rightTokens = []) {
  const counts = new Map();
  rightTokens.forEach((token) => counts.set(token, (counts.get(token) ?? 0) + 1));
  let overlap = 0;
  const unmatchedRight = [];
  counts.forEach((count, token) => {
    for (let index = 0; index < count; index += 1) unmatchedRight.push(token);
  });
  const matchedLeftIndexes = new Set();

  leftTokens.forEach((token, index) => {
    const count = counts.get(token) ?? 0;
    if (count <= 0) return;
    overlap += 1;
    counts.set(token, count - 1);
    matchedLeftIndexes.add(index);
    const rightIndex = unmatchedRight.indexOf(token);
    if (rightIndex >= 0) unmatchedRight.splice(rightIndex, 1);
  });

  leftTokens.forEach((token, index) => {
    if (matchedLeftIndexes.has(index)) return;
    const matchIndex = unmatchedRight.findIndex((candidate) => areTimelineTokensSimilar(token, candidate));
    if (matchIndex < 0) return;
    overlap += 0.72;
    unmatchedRight.splice(matchIndex, 1);
  });
  return overlap;
}

function stripCommonRussianEnding(token) {
  const value = String(token ?? "").trim();
  if (value.length < 6 || !/[а-я]/i.test(value)) return value;
  return value.replace(
    /(ыми|ими|ого|ему|ому|ыми|ами|ями|ая|яя|ое|ее|ые|ие|ый|ий|ой|ую|юю|ах|ях|ам|ям|ом|ем|ов|ев|ий|ь|а|я|ы|и|у|ю|е|о)$/i,
    ""
  );
}

function areTimelineTokensSimilar(left, right) {
  const a = String(left ?? "").trim();
  const b = String(right ?? "").trim();
  if (a.length < 5 || b.length < 5) return false;
  const stemA = stripCommonRussianEnding(a);
  const stemB = stripCommonRussianEnding(b);
  if (stemA.length >= 4 && stemB.length >= 4 && (stemA.startsWith(stemB) || stemB.startsWith(stemA))) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 7 && a.slice(0, 5) === b.slice(0, 5)) return true;
  return false;
}

function scoreSegmentAgainstWindow(segmentTokens, windowTokens) {
  if (!segmentTokens.length || !windowTokens.length) return 0;
  const overlap = countTokenOverlap(segmentTokens, windowTokens);
  const recall = overlap / segmentTokens.length;
  const precision = overlap / windowTokens.length;
  return recall * 0.78 + precision * 0.22;
}

function buildTranscriptWindows(blocks, maxWindowBlocks = DEFAULT_MAX_WINDOW_BLOCKS) {
  const windows = [];
  for (let start = 0; start < blocks.length; start += 1) {
    let tokens = [];
    let text = "";
    for (let end = start; end < Math.min(blocks.length, start + maxWindowBlocks); end += 1) {
      tokens = [...tokens, ...blocks[end].tokens];
      text = `${text} ${blocks[end].normalized_text}`.trim();
      windows.push({
        start_block_index: start,
        end_block_index: end,
        start_frame: blocks[start].start_frame,
        end_frame: blocks[end].end_frame,
        start_tc: blocks[start].start_tc,
        end_tc: blocks[end].end_tc,
        text,
        tokens
      });
    }
  }
  return windows;
}

function computeWindowSubrange(segment, window, fps) {
  const normalizedSegment = normalizeTimelineText(segment?.text_quote ?? "");
  const segmentTokens = tokenizeTimelineText(segment?.text_quote ?? "");
  if (!normalizedSegment || !window?.text) {
    return { start_frame: window.start_frame, end_frame: window.end_frame };
  }
  const directIndex = window.text.indexOf(normalizedSegment);
  const duration = Math.max(1, window.end_frame - window.start_frame);
  if (directIndex >= 0) {
    const textLength = Math.max(1, window.text.length);
    const startRatio = directIndex / textLength;
    const endRatio = Math.min(1, (directIndex + normalizedSegment.length) / textLength);
    const startFrame = window.start_frame + Math.floor(duration * startRatio);
    const endFrame = window.start_frame + Math.ceil(duration * endRatio);
    return { start_frame: startFrame, end_frame: Math.max(startFrame + 1, endFrame) };
  }

  const anchorTokens = segmentTokens
    .filter((token) => token.length >= 4 && !TIMELINE_ANCHOR_STOPWORDS.has(token))
    .sort((left, right) => right.length - left.length);
  const anchorToken = anchorTokens.find((token) => window.text.indexOf(token) >= 0)
    ?? segmentTokens.find((token) => token.length >= 4 && window.text.indexOf(token) >= 0)
    ?? segmentTokens.find((token) => window.text.indexOf(token) >= 0)
    ?? "";
  const tokenIndex = anchorToken ? window.text.indexOf(anchorToken) : -1;
  if (tokenIndex >= 0) {
    const textLength = Math.max(1, window.text.length);
    const startRatio = tokenIndex / textLength;
    const estimatedRatio = Math.min(0.9, Math.max(0.04, normalizedSegment.length / textLength));
    const startFrame = window.start_frame + Math.floor(duration * startRatio);
    const endFrame = window.start_frame + Math.ceil(duration * Math.min(1, startRatio + estimatedRatio));
    return { start_frame: startFrame, end_frame: Math.max(startFrame + 1, endFrame) };
  }

  return { start_frame: window.start_frame, end_frame: window.end_frame };
}

function distributeDuplicateWindows(items) {
  const groups = new Map();
  items.forEach((item) => {
    if (item.kind !== "speech") return;
    const key = `${item.start_block_index}:${item.end_block_index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  groups.forEach((group) => {
    if (group.length <= 1) return;
    group.sort((left, right) => left.source_segment_index - right.source_segment_index);
    const start = Math.min(...group.map((item) => item.window_start_frame));
    const end = Math.max(...group.map((item) => item.window_end_frame));
    const duration = Math.max(group.length, end - start);
    const weights = group.map((item) => Math.max(12, tokenizeTimelineText(item.text_quote).length));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || group.length;
    let cursor = start;
    group.forEach((item, index) => {
      const remainingItems = group.length - index;
      const remainingFrames = Math.max(remainingItems, end - cursor);
      const rawFrames = Math.round(duration * (weights[index] / totalWeight));
      const frames = index === group.length - 1 ? remainingFrames : Math.max(1, Math.min(remainingFrames - remainingItems + 1, rawFrames));
      item.start_frame = cursor;
      item.end_frame = Math.max(cursor + 1, cursor + frames);
      item.start_tc = framesToTimecode(item.start_frame, item.fps);
      item.end_tc = framesToTimecode(item.end_frame, item.fps);
      cursor = item.end_frame;
    });
  });
}

function assignDirectiveSlots(items, fps) {
  const byIndex = [...items].sort((left, right) => left.source_segment_index - right.source_segment_index);
  for (let index = 0; index < byIndex.length; index += 1) {
    const item = byIndex[index];
    if (item.kind !== "directive") continue;
    const previous = [...byIndex.slice(0, index)].reverse().find((candidate) => candidate.kind === "speech" && candidate.matched);
    const next = byIndex.slice(index + 1).find((candidate) => candidate.kind === "speech" && candidate.matched);
    if (!previous || !next) {
      item.slot_status = "no_neighbor_speech";
      continue;
    }
    const gapStart = previous.end_frame;
    const gapEnd = next.start_frame;
    if (gapEnd - gapStart < Math.max(1, Math.round(fps * 0.2))) {
      item.slot_status = "no_timeline_slot";
      continue;
    }
    item.matched = true;
    item.slot_status = "gap";
    item.start_frame = gapStart;
    item.end_frame = gapEnd;
    item.start_tc = framesToTimecode(gapStart, fps);
    item.end_tc = framesToTimecode(gapEnd, fps);
  }
}

function trimOverlappingSpeechRanges(items, fps) {
  const matchedSpeech = items
    .filter((item) => item.kind === "speech" && item.matched)
    .sort((left, right) => left.start_frame - right.start_frame || left.source_segment_index - right.source_segment_index);
  let cursor = 0;
  for (const item of matchedSpeech) {
    const start = Math.max(cursor, Math.round(Number(item.start_frame) || 0));
    const end = Math.max(start + 1, Math.round(Number(item.end_frame) || start + 1));
    if (start !== item.start_frame || end !== item.end_frame) {
      item.start_frame = start;
      item.end_frame = end;
      item.start_tc = framesToTimecode(start, fps);
      item.end_tc = framesToTimecode(end, fps);
      item.range_adjusted = true;
    }
    cursor = item.end_frame;
  }
}

function getAlignmentOrderStart(item) {
  const windowStart = Number(item?.window_start_frame);
  if (Number.isFinite(windowStart)) return windowStart;
  return Math.round(Number(item?.start_frame) || 0);
}

function getAlignmentOrderEnd(item) {
  const windowEnd = Number(item?.window_end_frame);
  if (Number.isFinite(windowEnd)) return windowEnd;
  return Math.round(Number(item?.end_frame) || Number(item?.start_frame) + 1 || 1);
}

function redistributeOrderedTimelineRun(run, fps) {
  const ordered = run
    .filter((item) => item?.kind === "speech" && item?.matched)
    .sort((left, right) => left.source_segment_index - right.source_segment_index);
  if (ordered.length <= 1) return;

  const start = Math.min(...ordered.map((item) => getAlignmentOrderStart(item)));
  const end = Math.max(...ordered.map((item) => getAlignmentOrderEnd(item)));
  const duration = Math.max(ordered.length, end - start);
  const weights = ordered.map((item) => Math.max(6, tokenizeTimelineText(item.text_quote).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || ordered.length;
  let cursor = start;

  ordered.forEach((item, index) => {
    const remainingItems = ordered.length - index;
    const remainingFrames = Math.max(remainingItems, end - cursor);
    const rawFrames = Math.round(duration * (weights[index] / totalWeight));
    const frames = index === ordered.length - 1
      ? remainingFrames
      : Math.max(1, Math.min(remainingFrames - remainingItems + 1, rawFrames));
    item.start_frame = cursor;
    item.end_frame = Math.max(cursor + 1, cursor + frames);
    item.start_tc = framesToTimecode(item.start_frame, fps);
    item.end_tc = framesToTimecode(item.end_frame, fps);
    item.range_adjusted = true;
    item.section_order_repaired = true;
    cursor = item.end_frame;
  });
}

function repairSectionSourceOrder(items, fps) {
  const groups = new Map();
  items.forEach((item) => {
    if (item.kind !== "speech" || !item.matched) return;
    const key = String(item.section_title ?? "");
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  groups.forEach((group) => {
    const ordered = group
      .slice()
      .sort((left, right) => left.source_segment_index - right.source_segment_index);
    let run = [];
    let runHasViolation = false;

    const flush = () => {
      if (runHasViolation && run.length > 1) redistributeOrderedTimelineRun(run, fps);
      run = [];
      runHasViolation = false;
    };

    for (const item of ordered) {
      if (run.length === 0) {
        run.push(item);
        continue;
      }
      const previous = run[run.length - 1];
      if (item.start_frame < previous.end_frame) {
        run.push(item);
        runHasViolation = true;
        continue;
      }
      flush();
      run.push(item);
    }
    flush();
  });
}

export function buildTimelineAlignment({ document = {}, segments = [], transcriptBlocks = [], fps = 50, options = {} } = {}) {
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : DEFAULT_MIN_MATCH_SCORE;
  const maxWindowBlocks = Number.isFinite(Number(options.maxWindowBlocks))
    ? Math.max(1, Math.min(6, Number(options.maxWindowBlocks)))
    : DEFAULT_MAX_WINDOW_BLOCKS;
  const windows = buildTranscriptWindows(transcriptBlocks, maxWindowBlocks);
  const items = [];

  (Array.isArray(segments) ? segments : []).forEach((segment, sourceIndex) => {
    const segmentId = String(segment?.segment_id ?? "").trim();
    if (!segmentId || String(segment?.block_type ?? "").trim().toLowerCase() === "links") return;
    const textQuote = String(segment?.text_quote ?? "").trim();
    const directive = isDirectiveSegment(segment);
    const base = {
      segment_id: segmentId,
      section_title: String(segment?.section_title ?? "").trim() || null,
      source_segment_index: sourceIndex,
      text_quote: textQuote,
      kind: directive ? "directive" : "speech",
      matched: false,
      match_score: 0,
      start_tc: null,
      end_tc: null,
      start_frame: null,
      end_frame: null,
      fps
    };
    if (directive) {
      items.push(base);
      return;
    }

    const segmentTokens = tokenizeTimelineText(textQuote);
    const segmentMinScore = segmentTokens.length <= 5 ? Math.max(minScore, 0.68) : minScore;
    let best = null;
    for (const window of windows) {
      const score = scoreSegmentAgainstWindow(segmentTokens, window.tokens);
      if (!best || score > best.score) best = { score, window };
    }
    if (!best || best.score < segmentMinScore) {
      items.push(base);
      return;
    }
    const subrange = computeWindowSubrange(segment, best.window, fps);
    items.push({
      ...base,
      matched: true,
      match_score: Number(best.score.toFixed(4)),
      start_tc: framesToTimecode(subrange.start_frame, fps),
      end_tc: framesToTimecode(subrange.end_frame, fps),
      start_frame: subrange.start_frame,
      end_frame: subrange.end_frame,
      transcript_start_tc: best.window.start_tc,
      transcript_end_tc: best.window.end_tc,
      start_block_index: best.window.start_block_index,
      end_block_index: best.window.end_block_index,
      window_start_frame: best.window.start_frame,
      window_end_frame: best.window.end_frame
    });
  });

  distributeDuplicateWindows(items);
  trimOverlappingSpeechRanges(items, fps);
  assignDirectiveSlots(items, fps);

  const matchedSpeech = items.filter((item) => item.kind === "speech" && item.matched);
  const usedTranscriptBlocks = new Set();
  matchedSpeech.forEach((item) => {
    for (let index = item.start_block_index; index <= item.end_block_index; index += 1) usedTranscriptBlocks.add(index);
  });
  const alignedItems = items
    .filter((item) => item.matched)
    .sort((left, right) => left.start_frame - right.start_frame || left.source_segment_index - right.source_segment_index)
    .map((item, timelineOrder) => ({ ...item, timeline_order: timelineOrder + 1 }));
  const timelineOrderBySegment = new Map(alignedItems.map((item) => [item.segment_id, item.timeline_order]));

  return {
    document_id: String(document?.id ?? "").trim() || null,
    fps,
    created_at: new Date().toISOString(),
    transcript_blocks: transcriptBlocks.length,
    matched_segments: items.filter((item) => item.matched).length,
    total_segments: items.length,
    items: items.map((item) => ({
      ...item,
      timeline_order: timelineOrderBySegment.get(item.segment_id) ?? null
    })),
    unmatched_segments: items
      .filter((item) => !item.matched)
      .map((item) => ({
        segment_id: item.segment_id,
        section_title: item.section_title,
        kind: item.kind,
        match_score: item.match_score,
        text_quote: item.text_quote
      })),
    unmatched_transcript_blocks: transcriptBlocks
      .filter((block) => !usedTranscriptBlocks.has(block.index))
      .map((block) => ({
        index: block.index,
        start_tc: block.start_tc,
        end_tc: block.end_tc,
        text: block.text
      }))
  };
}

export function buildTimelineAlignmentMap(alignment) {
  const map = new Map();
  (Array.isArray(alignment?.items) ? alignment.items : []).forEach((item) => {
    const segmentId = String(item?.segment_id ?? "").trim();
    const startFrame = Number(item?.start_frame);
    const endFrame = Number(item?.end_frame);
    if (!segmentId || !Number.isFinite(startFrame) || !Number.isFinite(endFrame) || endFrame <= startFrame) return;
    map.set(segmentId, {
      ...item,
      start_frame: Math.round(startFrame),
      end_frame: Math.round(endFrame)
    });
  });
  return map;
}

export async function readTimelineAlignment(docDir) {
  const filePath = path.join(docDir, "timeline-alignment.json");
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function buildTimelineAlignmentReport(alignment) {
  const lines = [];
  lines.push(`# Timeline alignment: ${alignment.document_id ?? "document"}`);
  lines.push("");
  lines.push(`- FPS: ${alignment.fps}`);
  lines.push(`- Transcript blocks: ${alignment.transcript_blocks}`);
  lines.push(`- Matched segments: ${alignment.matched_segments}/${alignment.total_segments}`);
  lines.push(`- Unmatched segments: ${alignment.unmatched_segments.length}`);
  lines.push(`- Unmatched transcript blocks: ${alignment.unmatched_transcript_blocks.length}`);
  lines.push("");
  lines.push("## First aligned items");
  lines.push("");
  alignment.items
    .filter((item) => item.matched)
    .sort((left, right) => left.start_frame - right.start_frame)
    .slice(0, 60)
    .forEach((item) => {
      lines.push(
        `- ${item.start_tc} - ${item.end_tc} | ${item.segment_id} | ${item.section_title ?? ""} | score=${item.match_score}`
      );
    });
  lines.push("");
  lines.push("## Unmatched segments");
  lines.push("");
  alignment.unmatched_segments.slice(0, 200).forEach((item) => {
    lines.push(`- ${item.segment_id} | ${item.section_title ?? ""} | ${item.kind} | ${item.text_quote}`);
  });
  return `${lines.join("\n")}\n`;
}
