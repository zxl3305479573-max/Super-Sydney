import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { normalizeBrandColors, normalizeWebsiteUrl, type ProductSiteResearch } from './video-product-research.ts';

export type ProductSiteCapture = ProductSiteResearch & { screenshots: string[]; capturedAt: string };

type Report = (message: string) => void;

const VIEWPORT = { width: 1440, height: 900 };
const CAPTURE_TIMEOUT_MS = 75_000;

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const EXTRACT_SCRIPT = `(() => {
  const text = value => String(value || '').replace(/\\s+/g, ' ').trim();
  const meta = name => text(document.querySelector(
    'meta[name="' + name + '"],meta[property="' + name + '"]'
  )?.getAttribute('content'));
  const visibleText = text(document.body?.innerText || '');
  const headings = [...document.querySelectorAll('h1,h2,h3')]
    .map(node => text(node.textContent)).filter(Boolean).slice(0, 30);
  const selectors = [
    'button', 'a', 'header', 'nav', '[role="button"]',
    'h1', 'h2', '.button', '.btn', '[class*="primary"]'
  ];
  const colors = [];
  for (const node of document.querySelectorAll(selectors.join(','))) {
    const style = getComputedStyle(node);
    for (const value of [style.color, style.backgroundColor, style.borderColor]) {
      if (value && value !== 'rgba(0, 0, 0, 0)' && !colors.includes(value)) colors.push(value);
      if (colors.length >= 80) break;
    }
    if (colors.length >= 80) break;
  }
  return {
    title: text(document.title) || meta('og:title'),
    description: meta('description') || meta('og:description'),
    headings,
    bodyText: visibleText.slice(0, 16000),
    colors,
    scrollHeight: Math.max(
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      ${VIEWPORT.height}
    )
  };
})()`;

type ExtractedPage = {
  title: string;
  description: string;
  headings: string[];
  bodyText: string;
  colors: string[];
  scrollHeight: number;
};

/**
 * 在独立离屏 Chromium 中打开公开官网，读取页面文案、标题结构和计算颜色，
 * 再从页面顶部开始截取最多四张视口截图。所有文件先写临时目录，全部成功后才替换旧抓取结果。
 */
export async function captureProductWebsite(rawUrl: string, outputDir: string, report: Report = () => undefined): Promise<ProductSiteCapture> {
  const url = normalizeWebsiteUrl(rawUrl);
  const tempDir = `${outputDir}.tmp`;
  const previousDir = `${outputDir}.previous`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    paintWhenInitiallyHidden: true,
    frame: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'sydney-product-capture'
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.setFrameRate(30);

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        await win.loadURL('about:blank');
        const cdp = win.webContents.debugger;
        cdp.attach('1.3');
        try {
          await cdp.sendCommand('Emulation.setDeviceMetricsOverride', {
            width: VIEWPORT.width,
            height: VIEWPORT.height,
            deviceScaleFactor: 1,
            mobile: false
          });
          report(`正在打开官网：${url}`);
          await win.loadURL(url);
          await wait(2_000);
          const extracted = await win.webContents.executeJavaScript(EXTRACT_SCRIPT, true) as ExtractedPage;
          const screenshots: string[] = [];
          const maxScroll = Math.max(0, extracted.scrollHeight - VIEWPORT.height);
          const starts = [...new Set([0, Math.round(VIEWPORT.height * 0.82), Math.round(VIEWPORT.height * 1.64), Math.round(VIEWPORT.height * 2.46)]
            .map(value => Math.min(maxScroll, value)))];
          for (const [index, y] of starts.entries()) {
            await win.webContents.executeJavaScript(`window.scrollTo({ top: ${y}, behavior: 'instant' });`, true);
            await wait(index === 0 ? 500 : 650);
            const shot = await cdp.sendCommand('Page.captureScreenshot', {
              format: 'png',
              optimizeForSpeed: true,
              clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 },
              captureBeyondViewport: false
            }) as { data: string };
            const target = path.join(tempDir, `site-${String(index + 1).padStart(2, '0')}.png`);
            fs.writeFileSync(target, Buffer.from(shot.data, 'base64'));
            screenshots.push(target);
            report(`已截取官网画面 ${index + 1}/${starts.length}`);
          }
          const capture: ProductSiteCapture = {
            url,
            title: extracted.title.trim(),
            description: extracted.description.trim(),
            headings: Array.isArray(extracted.headings) ? extracted.headings.filter(item => typeof item === 'string').slice(0, 30) : [],
            bodyText: extracted.bodyText.trim(),
            colors: normalizeBrandColors(extracted.colors),
            screenshots: screenshots.map(file => path.join(outputDir, path.basename(file))),
            capturedAt: new Date().toISOString()
          };
          if (!capture.title && !capture.description && !capture.bodyText.trim()) {
            throw new Error('官网没有可读取的公开文字，请检查页面是否需要登录或阻止了自动访问');
          }
          return capture;
        } finally {
          try { cdp.detach(); } catch { /* 窗口可能已关闭 */ }
        }
      })(),
      new Promise<ProductSiteCapture>((_, reject) => {
        timer = setTimeout(() => reject(new Error('官网抓取超时，请检查网址是否可以公开访问')), CAPTURE_TIMEOUT_MS);
      })
    ]);

    fs.rmSync(previousDir, { recursive: true, force: true });
    if (fs.existsSync(outputDir)) fs.renameSync(outputDir, previousDir);
    try {
      fs.renameSync(tempDir, outputDir);
    } catch (error) {
      if (fs.existsSync(previousDir) && !fs.existsSync(outputDir)) fs.renameSync(previousDir, outputDir);
      throw error;
    }
    fs.rmSync(previousDir, { recursive: true, force: true });
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (!win.isDestroyed()) win.destroy();
  }
}
