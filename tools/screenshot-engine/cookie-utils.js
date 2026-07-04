import fs from "node:fs/promises";
import path from "node:path";

function normalizeSameSite(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (text === "strict") return "Strict";
  if (text === "lax") return "Lax";
  if (text === "none" || text === "no_restriction") return "None";
  return undefined;
}

function safeBoolean(value, fallback = undefined) {
  if (value === true || value === false) return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function normalizeCookieObject(raw, fallbackUrl = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  const value = String(raw.value ?? "");
  const normalized = { name, value };

  const rawUrl = String(raw.url ?? "").trim();
  if (/^https?:\/\//i.test(rawUrl)) {
    normalized.url = rawUrl;
  }

  const domain = String(raw.domain ?? "").trim();
  const cookiePath = String(raw.path ?? "").trim() || "/";
  if (!normalized.url && domain) {
    normalized.domain = domain;
    normalized.path = cookiePath;
  } else if (!normalized.url && fallbackUrl) {
    normalized.url = fallbackUrl;
  }

  const secure = safeBoolean(raw.secure, undefined);
  const httpOnly = safeBoolean(raw.httpOnly, undefined);
  if (typeof secure === "boolean") normalized.secure = secure;
  if (typeof httpOnly === "boolean") normalized.httpOnly = httpOnly;

  const sameSite = normalizeSameSite(raw.sameSite);
  if (sameSite) normalized.sameSite = sameSite;

  const expires = Number(raw.expires ?? raw.expirationDate ?? NaN);
  if (Number.isFinite(expires) && expires > 0) {
    normalized.expires = expires;
  }

  if (!normalized.url && !normalized.domain) return null;
  return normalized;
}

function parseNetscapeCookies(text) {
  const cookies = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = String(lineRaw ?? "").trim();
    if (!line) continue;
    if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) continue;

    const parts = line.split("\t");
    if (parts.length < 7) continue;

    let domain = String(parts[0] ?? "").trim();
    let httpOnly = false;
    if (domain.startsWith("#HttpOnly_")) {
      domain = domain.slice("#HttpOnly_".length);
      httpOnly = true;
    }

    const pathValue = String(parts[2] ?? "/").trim() || "/";
    const secure = String(parts[3] ?? "").trim().toUpperCase() === "TRUE";
    const expiresRaw = Number.parseInt(String(parts[4] ?? "0").trim(), 10);
    const name = String(parts[5] ?? "").trim();
    const value = String(parts[6] ?? "");
    if (!domain || !name) continue;

    const cookie = {
      name,
      value,
      domain,
      path: pathValue,
      secure,
      httpOnly
    };
    if (Number.isFinite(expiresRaw) && expiresRaw > 0) {
      cookie.expires = expiresRaw;
    }
    cookies.push(cookie);
  }
  return cookies;
}

function parseCookiesText(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.cookies)
        ? parsed.cookies
        : [];
    if (list.length) {
      return list
        .map((item) => normalizeCookieObject(item, ""))
        .filter(Boolean);
    }
  } catch {
    // fallback to Netscape format
  }

  return parseNetscapeCookies(text)
    .map((item) => normalizeCookieObject(item, ""))
    .filter(Boolean);
}

export async function loadCookiesFromPath(cookiesPath) {
  const value = String(cookiesPath ?? "").trim();
  if (!value) return [];
  const resolved = path.resolve(value);
  const raw = await fs.readFile(resolved, "utf8");
  return parseCookiesText(raw);
}

export function normalizeCookiesForPuppeteer(cookies, fallbackUrl = "") {
  if (!Array.isArray(cookies) || !cookies.length) return [];
  return cookies
    .map((item) => normalizeCookieObject(item, fallbackUrl))
    .filter(Boolean);
}
