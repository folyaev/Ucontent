const statusEl = document.querySelector("#shotlab-status");
const formEl = document.querySelector("#shotlab-form");
const scrapeInput = document.querySelector("#shotlab-scrape");
const scrapeListEl = document.querySelector("#shotlab-scrapes-list");
const presetEl = document.querySelector("#shotlab-preset");
const heightInput = document.querySelector("#shotlab-height");
const zoomInput = document.querySelector("#shotlab-zoom");
const scrollInput = document.querySelector("#shotlab-scroll");
const captureButton = document.querySelector("#shotlab-capture");
const sessionButton = document.querySelector("#shotlab-session");
const manualButton = document.querySelector("#shotlab-manual");
const listEl = document.querySelector("#shotlab-list");
const titleEl = document.querySelector("#shotlab-title");
const urlEl = document.querySelector("#shotlab-url");
const imageEl = document.querySelector("#shotlab-image");
const emptyEl = document.querySelector("#shotlab-empty");
const downloadEl = document.querySelector("#shotlab-download");

const PRESETS = {
  "16x9": { width: 2560, height: 1440, zoom: 200, label: "16:9" },
  "2x1": { width: 2560, height: 1280, zoom: 200, label: "2:1" },
  "1x1": { width: 1280, height: 1280, zoom: 200, label: "1:1" }
};
const PRESET_ORDER = ["16x9", "2x1", "1x1"];

let scrapeId = new URLSearchParams(window.location.search).get("scrape") || "";
let links = [];
let selectedIndex = 0;
let objectUrl = "";
let browserSessionRunning = false;

function setStatus(text) {
  statusEl.textContent = text;
}

function updateSessionButton() {
  if (!sessionButton) return;
  sessionButton.textContent = browserSessionRunning ? "Stop Session" : "Session";
  sessionButton.classList.toggle("is-active", browserSessionRunning);
  captureButton.disabled = browserSessionRunning;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function selectedLink() {
  return links[selectedIndex] || null;
}

function applyPreset() {
  const preset = PRESETS[presetEl.value] || PRESETS["16x9"];
  heightInput.value = String(preset.height);
  zoomInput.value = String(preset.zoom);
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function mutateProfile(action) {
  if (action === "format") {
    const currentIndex = PRESET_ORDER.indexOf(presetEl.value);
    presetEl.value = PRESET_ORDER[(currentIndex + 1 + PRESET_ORDER.length) % PRESET_ORDER.length];
    applyPreset();
    setStatus(`format ${PRESETS[presetEl.value].label}`);
    return;
  }
  if (action === "taller") {
    heightInput.value = String(clamp(Number(heightInput.value || 0) + 640, 240, 5120));
    setStatus(`height ${heightInput.value}`);
    return;
  }
  if (action === "shorter") {
    heightInput.value = String(clamp(Number(heightInput.value || 0) - 640, 240, 5120));
    setStatus(`height ${heightInput.value}`);
    return;
  }
  if (action === "zoomin") {
    zoomInput.value = String(clamp(Number(zoomInput.value || 0) + 25, 50, 800));
    setStatus(`zoom ${zoomInput.value}%`);
    return;
  }
  if (action === "zoomout") {
    zoomInput.value = String(clamp(Number(zoomInput.value || 0) - 25, 50, 800));
    setStatus(`zoom ${zoomInput.value}%`);
    return;
  }
  if (action === "scrolldown") {
    scrollInput.value = String(clamp(Number(scrollInput.value || 0) + 200, 0, 50000));
    setStatus(`scroll ${scrollInput.value}`);
    return;
  }
  if (action === "scrollup") {
    scrollInput.value = String(clamp(Number(scrollInput.value || 0) - 200, 0, 50000));
    setStatus(`scroll ${scrollInput.value}`);
  }
}

function profileParams(url) {
  const preset = PRESETS[presetEl.value] || PRESETS["16x9"];
  const params = new URLSearchParams({
    scrape: scrapeId,
    index: String(selectedIndex + 1),
    url,
    preset: presetEl.value,
    width: String(preset.width),
    height: String(heightInput.value || preset.height),
    zoom: String(zoomInput.value || preset.zoom),
    scroll: String(scrollInput.value || 0),
    v: String(Date.now())
  });
  return params;
}

function revokeImage() {
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  objectUrl = "";
}

function renderList() {
  if (!links.length) {
    listEl.innerHTML = '<div class="empty">Ссылок нет.</div>';
    return;
  }
  listEl.innerHTML = links.map((item, index) => {
    const active = index === selectedIndex ? " active" : "";
    const done = item.screenshot ? " ✓" : "";
    const topic = item.topic || hostOf(item.url);
    return `
      <button class="shotlab-item${active}" type="button" data-index="${index}">
        <span>${index + 1}. ${escapeHtml(hostOf(item.url))}${done}</span>
        <small>${escapeHtml(topic)}</small>
      </button>
    `;
  }).join("");
  for (const button of listEl.querySelectorAll("[data-index]")) {
    button.addEventListener("click", () => {
      selectedIndex = Number(button.dataset.index || 0);
      render();
    });
  }
}

function showExistingScreenshot(item) {
  revokeImage();
  if (!item?.screenshot?.url) {
    imageEl.hidden = true;
    imageEl.removeAttribute("src");
    downloadEl.hidden = true;
    downloadEl.removeAttribute("href");
    emptyEl.hidden = false;
    emptyEl.textContent = "Скриншота ещё нет. Нажмите 📸.";
    return;
  }
  const imageUrl = `${item.screenshot.url}&v=${encodeURIComponent(item.screenshot.updated_at || "")}`;
  imageEl.src = imageUrl;
  imageEl.hidden = false;
  emptyEl.hidden = true;
  downloadEl.href = imageUrl;
  downloadEl.download = item.screenshot.name || `${hostOf(item.url)}_${presetEl.value}.png`;
  downloadEl.hidden = false;
}

function render() {
  const item = selectedLink();
  renderList();
  if (!item) {
    titleEl.textContent = "No link selected";
    urlEl.textContent = "";
    urlEl.removeAttribute("href");
    showExistingScreenshot(null);
    return;
  }
  titleEl.textContent = item.topic || hostOf(item.url);
  urlEl.textContent = item.url;
  urlEl.href = item.url;
  showExistingScreenshot(item);
}

async function refreshScrapeOptions() {
  if (!scrapeListEl) return;
  const response = await fetch("/api/scrapes");
  if (!response.ok) return;
  const data = await response.json();
  const items = Array.isArray(data.scrapes) ? data.scrapes : [];
  scrapeListEl.innerHTML = "";
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id || "";
    option.label = `${item.title || item.id || "Untitled"} ${item.updated_at || item.created_at || ""}`.trim();
    scrapeListEl.append(option);
  }
}

async function loadLinks() {
  scrapeInput.value = scrapeId;
  setStatus("loading links");
  const response = await fetch(`/api/screenshot-lab/links?scrape=${encodeURIComponent(scrapeId)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  scrapeId = data.scrape?.id || scrapeId;
  scrapeInput.value = scrapeId;
  if (scrapeId) {
    const url = new URL(window.location.href);
    url.searchParams.set("scrape", scrapeId);
    window.history.replaceState(null, "", url);
  }
  links = Array.isArray(data.links) ? data.links : [];
  selectedIndex = 0;
  setStatus(`${data.scrape?.id || scrapeId}: ${links.length} links`);
  render();
}

async function captureSelected() {
  const item = selectedLink();
  if (!item?.url) return;
  setStatus("capturing");
  captureButton.disabled = true;
  emptyEl.hidden = false;
  emptyEl.textContent = "Делаю скриншот...";
  imageEl.hidden = true;
  downloadEl.hidden = true;
  revokeImage();
  try {
    const response = await fetch(`/api/screenshot-lab/capture?${profileParams(item.url).toString()}`);
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    const savedPath = decodeURIComponent(response.headers.get("x-screenshot-path") || "");
    objectUrl = URL.createObjectURL(blob);
    imageEl.src = objectUrl;
    imageEl.hidden = false;
    emptyEl.hidden = true;
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    downloadEl.href = objectUrl;
    downloadEl.download = `${hostOf(item.url)}_${presetEl.value}_${stamp}.png`;
    downloadEl.hidden = false;
    if (savedPath) {
      item.screenshot = {
        path: savedPath,
        name: savedPath.split("/").pop() || downloadEl.download,
        url: `/api/media/raw?path=${encodeURIComponent(savedPath)}`,
        updated_at: new Date().toISOString()
      };
      renderList();
    }
    setStatus("screenshot ready");
  } catch (error) {
    revokeImage();
    imageEl.removeAttribute("src");
    imageEl.hidden = true;
    downloadEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = `Ошибка: ${error.message}`;
    setStatus("capture failed");
  } finally {
    captureButton.disabled = browserSessionRunning;
    void refreshBrowserSessionStatus().catch(() => null);
  }
}

async function refreshBrowserSessionStatus() {
  const response = await fetch("/api/browser-session");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  browserSessionRunning = Boolean(data.running);
  updateSessionButton();
  return data;
}

async function toggleBrowserSession() {
  if (!sessionButton) return;
  sessionButton.disabled = true;
  try {
    const current = await refreshBrowserSessionStatus();
    if (current.running) {
      const response = await fetch("/api/browser-session", { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      browserSessionRunning = Boolean(data.running);
      updateSessionButton();
      setStatus("browser session stopped");
      return;
    }
    const item = selectedLink();
    const params = new URLSearchParams();
    if (item?.url) params.set("url", item.url);
    const response = await fetch(`/api/browser-session${params.size ? `?${params.toString()}` : ""}`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    browserSessionRunning = Boolean(data.running);
    updateSessionButton();
    setStatus("browser session ready");
    const sessionUrl = data.vnc_url || data.devtools_url || "";
    if (sessionUrl) window.open(sessionUrl, "ucontent_browser_session", "popup=yes,width=1280,height=900,left=80,top=60,resizable=yes,scrollbars=yes");
  } catch (error) {
    setStatus(error.message || "browser session failed");
  } finally {
    sessionButton.disabled = false;
  }
}

function openManualWindow() {
  const item = selectedLink();
  if (!item?.url) return;
  window.open(
    item.url,
    "ucontent_screenshot_manual",
    "popup=yes,width=1280,height=900,left=80,top=60,resizable=yes,scrollbars=yes,noopener,noreferrer"
  );
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  scrapeId = scrapeInput.value.trim();
  const url = new URL(window.location.href);
  if (scrapeId) url.searchParams.set("scrape", scrapeId);
  else url.searchParams.delete("scrape");
  window.history.replaceState(null, "", url);
  void loadLinks().catch((error) => setStatus(error.message));
});

presetEl.addEventListener("change", applyPreset);
captureButton.addEventListener("click", () => void captureSelected());
sessionButton?.addEventListener("click", () => void toggleBrowserSession());
manualButton.addEventListener("click", openManualWindow);
for (const button of document.querySelectorAll("[data-shot-action]")) {
  button.addEventListener("click", () => mutateProfile(button.dataset.shotAction || ""));
}

applyPreset();
void refreshBrowserSessionStatus().catch(() => null);
void refreshScrapeOptions().catch(() => null);
void loadLinks().catch((error) => {
  setStatus(error.message);
  listEl.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
});
