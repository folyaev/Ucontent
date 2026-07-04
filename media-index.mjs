import { promises as fs } from "node:fs";
import path from "node:path";

export function createMediaIndex({ filePath }) {
  let cache = null;
  let writeQueue = Promise.resolve();

  const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      cache = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      cache = {};
    }
    cache.version = 1;
    cache.items = cache.items && typeof cache.items === "object" ? cache.items : {};
    return cache;
  }

  async function persist() {
    const index = await load();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    writeQueue = writeQueue.then(() => fs.writeFile(filePath, JSON.stringify(index, null, 2), "utf8"));
    await writeQueue;
  }

  async function get(relPath) {
    const key = normalize(relPath);
    if (!key) return null;
    return (await load()).items[key] || null;
  }

  async function upsert(relPath, metadata = {}) {
    const key = normalize(relPath);
    if (!key) return null;
    const index = await load();
    const existing = index.items[key] || {};
    const now = new Date().toISOString();
    const next = {
      ...existing,
      ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null && value !== "")),
      path: key,
      name: path.posix.basename(key),
      topic: key.split("/")[0] || "",
      source_url: String(metadata.source_url || existing.source_url || "").trim(),
      parent_path: normalize(metadata.parent_path || existing.parent_path || ""),
      created_at: existing.created_at || metadata.created_at || now,
      updated_at: now
    };
    index.items[key] = next;
    await persist();
    return next;
  }

  async function move(oldPath, newPath) {
    const oldKey = normalize(oldPath);
    const newKey = normalize(newPath);
    if (!oldKey || !newKey) return null;
    const index = await load();
    const existing = index.items[oldKey] || {};
    delete index.items[oldKey];
    index.items[newKey] = {
      ...existing,
      path: newKey,
      name: path.posix.basename(newKey),
      topic: newKey.split("/")[0] || "",
      updated_at: new Date().toISOString()
    };
    for (const item of Object.values(index.items)) {
      if (item?.parent_path === oldKey) item.parent_path = newKey;
    }
    await persist();
    return index.items[newKey];
  }

  async function remove(relPath) {
    const key = normalize(relPath);
    if (!key) return false;
    const index = await load();
    const existed = Boolean(index.items[key]);
    delete index.items[key];
    await persist();
    return existed;
  }

  async function entries() {
    return Object.values((await load()).items);
  }

  return { get, upsert, move, remove, entries };
}
