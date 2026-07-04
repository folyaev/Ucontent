import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const extensions = new Set([
  ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".py",
  ".sh", ".ts", ".tsx", ".yaml", ".yml"
]);
const excludedDirectories = new Set([".git", ".venv", "data", "media", "node_modules"]);
const mojibakeTokens = [
  "\u0420\u045f", // UTF-8 emoji bytes decoded as Cyrillic
  "\u0420\u0405",
  "\u0421\u0403",
  "\u0432\u0402",
  "\u0432\u045a",
  "\u0440\u045f",
  "\u043f\u0451"
];

async function collectFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(target));
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(target);
  }
  return files;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const failures = [];
for (const file of await collectFiles(root)) {
  let text;
  try {
    text = decoder.decode(await fs.readFile(file));
  } catch (error) {
    failures.push(`${path.relative(root, file)}: invalid UTF-8 (${error.message})`);
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes("\uFFFD")) failures.push(`${path.relative(root, file)}:${index + 1}: replacement character`);
    if (/\?{4,}/.test(line)) failures.push(`${path.relative(root, file)}:${index + 1}: suspicious question-mark run`);
    if (mojibakeTokens.some((token) => line.includes(token))) {
      failures.push(`${path.relative(root, file)}:${index + 1}: probable mojibake`);
    }
  });
}

if (failures.length) {
  console.error("Encoding check failed:\n" + failures.join("\n"));
  process.exit(1);
}

console.log("Encoding check passed.");
