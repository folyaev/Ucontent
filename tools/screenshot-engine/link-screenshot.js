import { loadCookiesFromPath, normalizeCookiesForPuppeteer } from "./cookie-utils.js";

let puppeteerModule = null;
try {
  puppeteerModule = await import("puppeteer");
} catch {
  puppeteerModule = await import("../HeadlessNotion/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js");
}
const puppeteer = puppeteerModule?.default ?? puppeteerModule;

function parseArgs(argv = []) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "").trim();
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = String(argv[index + 1] ?? "");
    result[key] = value;
    index += 1;
  }
  return result;
}

function toNumber(value, fallback, min, max) {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ""));
}

const args = parseArgs(process.argv.slice(2));
const rawUrl = String(args.url ?? "").trim();
if (!isHttpUrl(rawUrl)) {
  process.stderr.write("url must be http(s)\\n");
  process.exit(2);
}

const debugAdblock = String(process.env.SCREENSHOT_DEBUG_ADBLOCK ?? "").trim() === "1";
const cookiesPath = String(args.cookies_path ?? "").trim();
const outputWidth = Math.round(toNumber(args.width, 2560, 320, 3840));
const outputHeight = Math.round(toNumber(args.height, 1280, 240, 2160));
const zoomPercent = toNumber(args.zoom, 200, 50, 800);
const scrollOffset = Math.round(toNumber(args.scroll, 0, 0, 50000));
const timeoutMs = Math.round(toNumber(args.timeout_ms, 22000, 3000, 120000));

let rawHost = "";
try {
  rawHost = new URL(rawUrl).hostname.toLowerCase();
} catch {
  rawHost = "";
}
const isRbcHost = rawHost === "rbc.ru" || rawHost.endsWith(".rbc.ru");

// Browser-like zoom: smaller CSS viewport + higher DPR to keep output bitmap size.
const zoomFactor = zoomPercent / 100;
const viewportWidth = Math.max(320, Math.round(outputWidth / zoomFactor));
const viewportHeight = Math.max(240, Math.round(outputHeight / zoomFactor));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hideScrollbarsForCapture(page) {
  try {
    await page.evaluate(() => {
      const styleId = "__vbaut_hide_scrollbars__";
      const css = `
        html, body, * {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        *::-webkit-scrollbar {
          width: 0 !important;
          height: 0 !important;
          display: none !important;
          background: transparent !important;
        }
      `;
      let style = document.getElementById(styleId);
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        document.documentElement.appendChild(style);
      }
      style.textContent = css;

      document.documentElement.style.setProperty("overflow-x", "hidden", "important");
      document.documentElement.style.setProperty("overflow-y", "scroll", "important");
      if (document.body) {
        document.body.style.setProperty("overflow-x", "hidden", "important");
        document.body.style.setProperty("overflow-y", "scroll", "important");
      }

      const active = document.activeElement;
      if (active && typeof active.blur === "function") {
        try {
          active.blur();
        } catch {
          // noop
        }
      }
    });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (message.includes("Execution context was destroyed") || message.includes("Cannot find context with specified id")) {
      return;
    }
    throw error;
  }
}

const AD_HOST_PATTERNS = [
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googlesyndication\.com$/i,
  /(^|\.)googleadservices\.com$/i,
  /(^|\.)adnxs\.com$/i,
  /(^|\.)advertising\.com$/i,
  /(^|\.)scorecardresearch\.com$/i,
  /(^|\.)taboola\.com$/i,
  /(^|\.)outbrain\.com$/i,
  /(^|\.)mgid\.com$/i,
  /(^|\.)adriver\.ru$/i,
  /(^|\.)yandexadnet\.ru$/i,
  /(^|\.)betweendigital\.com$/i
];

const AD_PATH_PATTERNS = [
  /[/?&]ad(s|server|fox|service|unit|slot|id)?[=/&#]/i,
  /\/banner(s)?[/?#]/i,
  /prebid/i,
  /promoads/i
];

function isLikelyAdRequest(requestUrl, pageHost) {
  let target;
  try {
    target = new URL(requestUrl);
  } catch {
    return false;
  }
  const host = String(target.hostname || "").toLowerCase();
  if (!host) return false;

  if (AD_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return true;
  }

  const isThirdParty = Boolean(pageHost) && host !== pageHost && !host.endsWith(`.${pageHost}`);
  const full = `${target.pathname || ""}${target.search || ""}`;
  if (isThirdParty && AD_PATH_PATTERNS.some((pattern) => pattern.test(full))) {
    return true;
  }

  return false;
}

async function enableAdblockLikeFiltering(page, pageUrl) {
  let pageHost = "";
  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    pageHost = "";
  }

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    try {
      const resourceType = request.resourceType();
      if (resourceType === "document") {
        request.continue();
        return;
      }
      const reqUrl = request.url();
      if (isLikelyAdRequest(reqUrl, pageHost)) {
        if (debugAdblock) {
          process.stderr.write(`[adblock] ${resourceType} ${reqUrl}\\n`);
        }
        request.abort("blockedbyclient");
        return;
      }
      request.continue();
    } catch {
      try {
        request.continue();
      } catch {
        // noop
      }
    }
  });
}

async function dismissOverlays(page) {
  try {
    await page.evaluate(() => {
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;

    const candidates = Array.from(document.querySelectorAll("body *"));
    for (const node of candidates) {
      const style = window.getComputedStyle(node);
      if (!style) continue;
      if (style.position !== "fixed" && style.position !== "sticky") continue;

      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const areaRatio = (rect.width * rect.height) / Math.max(1, screenW * screenH);
      const centered = rect.top > screenH * 0.06 && rect.left > screenW * 0.04 && rect.right < screenW * 0.96;
      const bottomBanner = rect.top > screenH * 0.68 && areaRatio > 0.02;
      const modalLike = centered && areaRatio > 0.08 && areaRatio < 0.75;
      const text = String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 600);
      const rbcPushModal = text.includes("уведомления от рбк") || text.includes("получайте уведомления");

      // Keep top site header/nav; remove only popup-like or cookie-like overlays.
      const isTopHeader = rect.top <= 4 && rect.height < screenH * 0.42 && rect.width > screenW * 0.9;
      if (isTopHeader) continue;

      if (modalLike || bottomBanner || rbcPushModal) {
        node.style.setProperty("display", "none", "important");
        node.style.setProperty("visibility", "hidden", "important");
      }
    }

    // Try to press soft-close buttons if visible.
    const closeLike = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const el of closeLike) {
      const text = String(el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) continue;
      if (!(text === "close" || text.includes("dismiss") || text.includes("later") || text.includes("not now") || text.includes("не сейчас") || text.includes("закрыть"))) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 16) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      try {
        el.click();
      } catch {
        // noop
      }
    }

    const cookieAcceptLike = Array.from(document.querySelectorAll("button, [role='button']"));
    const acceptTokens = [
      "accept all",
      "accept",
      "agree",
      "i agree",
      "allow all",
      "принять все",
      "принять",
      "согласен",
      "разрешить все"
    ];
    for (const el of cookieAcceptLike) {
      const text = String(el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text || text.length > 120) continue;
      if (!acceptTokens.some((token) => text.includes(token))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 16) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      try {
        el.click();
      } catch {
        // noop
      }
      break;
    }
    });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (message.includes("Execution context was destroyed") || message.includes("Cannot find context with specified id")) {
      return;
    }
    throw error;
  }
}

async function sanitizeCaptureViewport(page) {
  try {
    await page.evaluate(() => {
      const screenW = window.innerWidth;
      const screenH = window.innerHeight;
      const viewportArea = Math.max(1, screenW * screenH);
      const hide = (node) => {
        node.style.setProperty("display", "none", "important");
        node.style.setProperty("visibility", "hidden", "important");
        node.setAttribute("aria-hidden", "true");
      };

      for (const host of document.querySelectorAll("*")) {
        const root = host.shadowRoot;
        if (!root) continue;
        const shadowDialog = root.querySelector("[role='dialog'], [aria-modal='true'], dialog[open]");
        const shadowText = String(root.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const shadowConsent = /accept all|allow all|принять все|согласен|разрешить все|privacy|приватност/.test(shadowText);
        if (shadowDialog || shadowConsent) hide(host);
      }

      for (const node of document.querySelectorAll("[role='dialog'], [aria-modal='true'], dialog[open]")) {
        const rect = node.getBoundingClientRect();
        if ((rect.width * rect.height) / viewportArea > 0.08) hide(node);
      }

      const consentButtons = Array.from(document.querySelectorAll("button, [role='button']"));
      const consentTokens = ["accept all", "allow all", "agree", "принять все", "согласен", "разрешить все"];
      for (const button of consentButtons) {
        const text = String(button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!consentTokens.some((token) => text === token || text.includes(token))) continue;
        const buttonRect = button.getBoundingClientRect();
        if (buttonRect.width < 20 || buttonRect.height < 16 || buttonRect.bottom < 0 || buttonRect.top > screenH) continue;
        let candidate = button.parentElement;
        for (let depth = 0; candidate && depth < 8; depth += 1, candidate = candidate.parentElement) {
          const rect = candidate.getBoundingClientRect();
          const areaRatio = (rect.width * rect.height) / viewportArea;
          const style = getComputedStyle(candidate);
          if (areaRatio > 0.12 && areaRatio < 0.92 && (style.position === "fixed" || style.position === "absolute" || depth >= 2)) {
            hide(candidate);
            break;
          }
        }
      }

      for (const frame of document.querySelectorAll("iframe")) {
        const rect = frame.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const src = String(frame.getAttribute("src") || "").toLowerCase();
        let parent = frame;
        let floating = false;
        for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.position === "fixed" || style.position === "sticky") {
            floating = true;
            break;
          }
        }
        const areaRatio = (rect.width * rect.height) / viewportArea;
        const externalPlayer = /youtube|youtu\.be|vimeo|rutube|vkvideo|player\./i.test(src);
        if (floating || (externalPlayer && areaRatio > 0.18)) hide(frame);
      }

      for (const node of document.querySelectorAll("body *")) {
        const style = getComputedStyle(node);
        if (style.position !== "fixed" && style.position !== "sticky") continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const areaRatio = (rect.width * rect.height) / viewportArea;
        const topNavigation = rect.top <= 3 && rect.width > screenW * 0.85 && rect.height < screenH * 0.18;
        if (!topNavigation && areaRatio > 0.12) hide(node);
      }

      document.documentElement.style.setProperty("scroll-behavior", "auto", "important");
      if (document.body) document.body.style.setProperty("scroll-behavior", "auto", "important");
    });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (message.includes("Execution context was destroyed") || message.includes("Cannot find context with specified id")) return;
    throw error;
  }
}

function sameSiteHost(left, right) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/^www\./, "");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

async function findHeadingTop(page) {
  const scanOffsets = [0, 120, 240, 360, 520, 680, 860, 1060, 1280, 1520, 1780, 2060, 2360, 2680, 3040];
  let bestAbsTop = null;
  for (const y of scanOffsets) {
    try {
      await page.evaluate((offset) => window.scrollTo(0, offset), y);
      await sleep(220);

      const found = await page.evaluate(() => {
        const selectors = "article h1, main h1, [itemprop='headline'], h1, article h2, main h2";
        const nodes = Array.from(document.querySelectorAll(selectors));
        let best = null;
        for (const node of nodes) {
          if (!node || node.closest("nav,aside,footer")) continue;
          const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
          if (text.length < 20) continue;
          const rect = node.getBoundingClientRect();
          const absTop = rect.top + window.scrollY;
          if (!Number.isFinite(absTop) || absTop < 0) continue;
          if (!best || absTop < best.absTop) {
            best = { absTop, textLen: text.length };
          }
        }
        return best;
      });
      if (!found) continue;

      if (Number.isFinite(found.absTop)) {
        if (bestAbsTop == null || found.absTop < bestAbsTop) {
          bestAbsTop = found.absTop;
        }
      }
    } catch (error) {
      const message = String(error?.message ?? "");
      if (message.includes("Execution context was destroyed") || message.includes("Cannot find context with specified id")) {
        continue;
      }
      throw error;
    }
  }
  return Number.isFinite(bestAbsTop) ? bestAbsTop : null;
}

async function assessPageState(page) {
  try {
    return await page.evaluate(() => {
    const text = String(document.body?.innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const title = String(document.title || "").toLowerCase();
    const combined = `${title} ${text.slice(0, 2500)}`;
    const antiBotMarkers = [
      "checking your browser",
      "verify you are human",
      "just a moment",
      "forbidden",
      "if you are not a bot",
      "captcha",
      "cloudflare",
      "проверка браузера",
      "защита от ботов",
      "доступ ограничен"
    ];
    const isAntiBot = antiBotMarkers.some((marker) => combined.includes(marker));
    return {
      isAntiBot,
      textLen: text.length,
      title
    };
    });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (message.includes("Execution context was destroyed") || message.includes("Cannot find context with specified id")) {
      return { isAntiBot: false, textLen: 0, title: "" };
    }
    throw error;
  }
}

let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-breakpad",
      "--disable-renderer-backgrounding",
      "--lang=ru-RU",
      `--window-size=${outputWidth},${outputHeight}`
    ],
    defaultViewport: {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: zoomFactor
    }
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, "language", { get: () => "ru-RU" });
      Object.defineProperty(navigator, "languages", { get: () => ["ru-RU", "ru", "en-US", "en"] });
    } catch {
      // noop
    }
  });
  await page.setViewport({ width: viewportWidth, height: viewportHeight, deviceScaleFactor: zoomFactor });
  await enableAdblockLikeFiltering(page, rawUrl);
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "accept-language": "ru-RU,ru;q=0.9,en;q=0.8" });

  if (cookiesPath) {
    try {
      const cookiesLoaded = await loadCookiesFromPath(cookiesPath);
      const cookies = normalizeCookiesForPuppeteer(cookiesLoaded, rawUrl);
      if (cookies.length) {
        await page.setCookie(...cookies);
      }
    } catch (error) {
      process.stderr.write(`cookies load warning: ${String(error?.message ?? "failed")}\\n`);
    }
  }

  try {
    await page.goto(rawUrl, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: timeoutMs });
  } catch (error) {
    const message = String(error?.message ?? "").toLowerCase();
    if (!message.includes("timeout")) throw error;
  }

  await sleep(1200);
  await dismissOverlays(page);
  await sleep(300);

  let currentHost = "";
  try {
    currentHost = new URL(page.url()).hostname.toLowerCase();
  } catch {
    currentHost = "";
  }
  if (rawHost && currentHost && !sameSiteHost(rawHost, currentHost)) {
    await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await sleep(1000);
  }

  let pageState = await assessPageState(page);
  if (pageState?.isAntiBot) {
    throw new Error("anti-bot-page");
  }

  let headingTop = await findHeadingTop(page);
  if (!Number.isFinite(headingTop) && Number(pageState?.textLen ?? 0) < 120) {
    // Some pages render late; one additional settle pass avoids blank/spinner screenshots.
    await sleep(1500);
    await dismissOverlays(page);
    await sleep(300);
    pageState = await assessPageState(page);
    if (pageState?.isAntiBot) {
      throw new Error("anti-bot-page");
    }
    headingTop = await findHeadingTop(page);
    if (!Number.isFinite(headingTop) && Number(pageState?.textLen ?? 0) < 120) {
      throw new Error("empty-or-loading-page");
    }
  }

  if (Number.isFinite(headingTop)) {
    let targetTop = Math.max(0, Math.round(headingTop - 185));
    if (isRbcHost) {
      // For RBC the top bar is critical in frame. Any downward scroll can hide it.
      targetTop = 0;
    }
    targetTop = Math.max(0, targetTop + scrollOffset);
    await page.evaluate((offset) => window.scrollTo(0, offset), targetTop);
  } else {
    await page.evaluate((offset) => window.scrollTo(0, offset), scrollOffset);
  }

  await sleep(700);
  await dismissOverlays(page);
  await sleep(250);
  await sanitizeCaptureViewport(page);
  await sleep(120);
  await hideScrollbarsForCapture(page);
  await sleep(90);

  const buffer = await page.screenshot({
    type: "png",
    fullPage: false,
    captureBeyondViewport: false
  });

  process.stdout.write(buffer);
  await browser.close();
  process.exit(0);
} catch (error) {
  if (browser) {
    try {
      await browser.close();
    } catch {
      // noop
    }
  }
  const message = String(error?.message ?? "failed to capture screenshot");
  process.stderr.write(`${message}\\n`);
  process.exit(1);
}
