import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const PAMPAM_ROOT = "C:/Users/Nemifist/YandexDisk/PAMPAM";

function sanitizeFileName(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[\x00-\x1f\x80-\x9f]/g, "_")
    .trim();
}

async function ensureTopicDir(topic) {
  const safeTopic = sanitizeFileName(topic) || "Без темы";
  const dir = path.join(PAMPAM_ROOT, safeTopic);
  await fs.mkdir(dir, { recursive: true });
  return { safeTopic, dir };
}

async function run() {
  const file = 'c:/Ucontent/data/scrapes/latest.json';
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  const segments = data.segments || [];
  
  const links = segments.filter(s => !s.is_done && s.kind === 'link');
  console.log(`Found ${links.length} remaining incomplete link segments for Puppeteer crawler.`);
  
  if (links.length === 0) {
    console.log("No links to process!");
    return;
  }
  
  console.log("Launching Puppeteer...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  for (const segment of links) {
    const url = segment.text.trim();
    console.log(`\nNavigating to: ${url} (Topic: "${segment.topic}")`);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 3500));
      
      const pageInfo = await page.evaluate(() => {
        const title = document.querySelector('meta[property="og:title"]')?.content || document.title || "";
        const description = document.querySelector('meta[property="og:description"]')?.content || 
                            document.querySelector('meta[name="description"]')?.content || "";
        const ogImage = document.querySelector('meta[property="og:image"]')?.content || "";
        return { title, description, ogImage };
      });
      
      console.log(`Page Info: Title="${pageInfo.title}", ogImage="${pageInfo.ogImage}"`);
      
      const { safeTopic, dir } = await ensureTopicDir(segment.topic);
      const digest = crypto.createHash("sha256").update(`${url}\n${pageInfo.ogImage || url}`).digest("hex").slice(0, 12);
      const fileName = `preview_${digest}.png`;
      const absolutePath = path.join(dir, fileName);
      
      // If we have an og:image and it's not empty, try downloading it first.
      let imageBuffer = null;
      if (pageInfo.ogImage && /^https?:\/\//i.test(pageInfo.ogImage)) {
        try {
          console.log(`Downloading og:image: ${pageInfo.ogImage}`);
          const imgRes = await fetch(pageInfo.ogImage, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (imgRes.ok) {
            imageBuffer = Buffer.from(await imgRes.arrayBuffer());
          }
        } catch (imgErr) {
          console.warn(`Failed to download og:image, fallback to screenshot. Error: ${imgErr.message}`);
        }
      }
      
      if (!imageBuffer) {
        console.log(`Taking screenshot as preview...`);
        imageBuffer = await page.screenshot({ type: 'png' });
      }
      
      await fs.writeFile(absolutePath, imageBuffer);
      console.log(`Saved preview to ${absolutePath}`);
      
      const relPath = `${safeTopic}/${fileName}`.replace(/\\/g, '/');
      const item = {
        path: relPath,
        thumbnail: `/api/media/raw?path=${encodeURIComponent(relPath)}`,
        source_url: url,
        webpage_url: url,
        title: pageInfo.title || "Link preview"
      };
      
      segment.media_items = [item];
      segment.media = item;
      segment.is_done = true;
      segment.updated_at = new Date().toISOString();
      console.log(`Successfully completed link segment: ${segment.id}`);
    } catch (err) {
      console.error(`Failed to process link ${url}:`, err.message);
    }
  }
  
  await browser.close();
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  console.log("\nUpdated latest.json successfully!");
}

run().catch(console.error);
