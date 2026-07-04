import fs from "node:fs/promises";

const SOURCE_FILE = "ПОКОЛЕНИЯ_2_ЕГОРИК,_ИЗАГАРЯН,_СОЛОДКОВ.md";
const SCRAPE_ID = "POKOLENIYA";

function getSection(content, heading, nextHeading) {
  const start = content.indexOf(heading);
  if (start < 0) throw new Error(`Section not found: ${heading}`);
  const end = content.indexOf(nextHeading, start);
  if (end < 0) throw new Error(`Next section not found: ${nextHeading}`);
  return content.slice(start, end).trim();
}

function splitTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function parseLinks(markdown) {
  const links = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match = null;
  while ((match = pattern.exec(markdown))) {
    links.push({ label: match[1].trim(), url: match[2].trim() });
  }
  return links;
}

function cleanTimecode(value) {
  return String(value || "").replace(/`/g, "").trim();
}

function buildScenario(source) {
  const title = (source.match(/^# .+$/m) || ["# ПОКОЛЕНИЯ №2 — карта Google Doc-контента"])[0];
  const section = getSection(
    source,
    "## Карта Google Doc-контента по таймкодам",
    "\n## Визуальные вставки / что подставлять"
  );

  const rows = section
    .split(/\r?\n/)
    .map(splitTableRow)
    .filter((cells) => cells.length === 4)
    .filter(([timecode]) => /`\d\d:\d\d:\d\d:\d\d`/.test(timecode));

  const lines = [
    title,
    ""
  ];

  for (const [rawTimecode, marker, rawSources, binding] of rows) {
    const timecode = cleanTimecode(rawTimecode);
    lines.push(`### ${timecode} — ${marker}`);
    lines.push("");
    lines.push(`Таймкод: ${timecode}`);
    lines.push(`Маркер: ${marker}`);
    lines.push(`Привязка: ${binding}`);
    lines.push("");

    const links = parseLinks(rawSources);
    for (const link of links) {
      lines.push(link.url);
      lines.push("");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

const source = await fs.readFile(SOURCE_FILE, "utf8");
const content = buildScenario(source);

const response = await fetch("http://127.0.0.1:5197/api/import-markdown", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    id: SCRAPE_ID,
    url: `file://C:/Ucontent/${SOURCE_FILE}#google-doc-map`,
    content
  })
});

const payload = await response.json();
if (!response.ok) {
  throw new Error(payload?.error || "import failed");
}

console.log(JSON.stringify({
  id: payload.scrape.id,
  title: payload.scrape.title,
  segments: payload.scrape.segments.length,
  updated_at: payload.scrape.updated_at
}, null, 2));
