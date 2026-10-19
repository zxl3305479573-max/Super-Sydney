import fs from 'node:fs';
import { BrowserWindow, nativeImage } from 'electron';
import type { VideoPlatform, XhsHotNote } from '../shared';
import { padToThreeFour, XHS_COVER_SIZE } from './xhs-image-fit';
import { BING_EXTRACT_SCRIPT, bingSearchUrls, normalizeWebResults } from './xhs-page-parse';

/**
 * 依赖 Electron 的小红书渲染工具：图文卡片逐页截图、生成图补边成 3:4、必应结果页读取。
 * 都用不显示的独立窗口完成，窗口用完即关；纯 Node 单测加载不了这个文件。
 */

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withHiddenWindow<T>(options: Electron.BrowserWindowConstructorOptions, run: (win: BrowserWindow) => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const win = new BrowserWindow({ show: false, ...options });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(win),
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 把一组 HTML 文档逐个渲染成 PNG（尺寸固定为 width×height）。
 *
 * 不靠窗口尺寸：窗口高度会被系统夹到屏幕高度以内（1440 高的卡片在笔记本上放不下），
 * 所以用 Chromium 的设备模拟把视口设成精确尺寸，再按裁剪框截图——和屏幕多大、缩放多少都无关。
 * 用离屏渲染（offscreen）：普通隐藏窗口在主窗口显示时不出帧，稍复杂的页面截图会一直挂起（实测）。
 * 卡片文档是本地模板生成的静态页面：关掉脚本、独立的内存分区，不联网。
 */
export async function renderHtmlPages(documents: string[], width: number, height: number, targets: string[]): Promise<string[]> {
  if (documents.length !== targets.length) throw new Error('卡片页数与输出文件数不一致');
  return withHiddenWindow({
    width: 540, height: 720, paintWhenInitiallyHidden: true, frame: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'sydney-xhs-cards' }
  }, async win => {
    // 必须先让窗口载入一个页面再挂调试器：对还没导航过的 webContents 发调试命令会让整个主进程崩掉（实测）。
    await win.loadURL('about:blank');
    const cdp = win.webContents.debugger;
    cdp.attach('1.3');
    try {
      await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      for (let index = 0; index < documents.length; index += 1) {
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(documents[index])}`);
        await wait(150);
        const shot = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: true }) as { data: string };
        fs.writeFileSync(targets[index], Buffer.from(shot.data, 'base64'));
      }
    } finally {
      try { cdp.detach(); } catch { /* 窗口已关闭 */ }
    }
    return targets;
  }, 30_000 + documents.length * 5_000, '图文卡片渲染');
}

/**
 * 生图接口通常给 2:3 竖图，小红书按 3:4 展示：先在短边补边，再统一缩放到 1080×1440。
 * 不裁切——以前居中裁成 3:4 会把顶部的标题、底部的要点切掉一截；统一尺寸也避免不同
 * 网关返回 1024×1365、1152×1536 或 1536×2048 时，预览和发布包里出现不同比例体验。
 */
export function fitToThreeFour(file: string): string {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error('生成的图片无法读取');
  const { width, height } = image.getSize();
  const padded = padToThreeFour({ data: image.toBitmap(), width, height });
  if (padded.width === width && padded.height === height
    && width === XHS_COVER_SIZE.width && height === XHS_COVER_SIZE.height) return file;
  const normalized = nativeImage.createFromBitmap(padded.data, { width: padded.width, height: padded.height })
    .resize({ ...XHS_COVER_SIZE, quality: 'best' });
  fs.writeFileSync(file, normalized.toPNG());
  return file;
}

/**
 * 联网搜索兜底：用不显示的浏览器窗口打开必应结果页，读取已渲染的结果列表。
 * 用真实浏览器而不是 Node 直接请求——后者拿到的是给爬虫的降级页面（实测返回无关结果）。
 * 两个查询之间间隔 1.5 秒；任何一页失败不影响另一页。
 */
export async function searchBing(keyword: string, platform: VideoPlatform = 'xiaohongshu'): Promise<XhsHotNote[]> {
  return withHiddenWindow({
    width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:sydney-websearch' }
  }, async win => {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const rows: unknown[] = [];
    const errors: string[] = [];
    for (const [index, url] of bingSearchUrls(keyword, platform).entries()) {
      if (index > 0) await wait(1500);
      try {
        await win.loadURL(url);
        await wait(800);
        const extracted = await win.webContents.executeJavaScript(BING_EXTRACT_SCRIPT, true) as unknown;
        if (Array.isArray(extracted)) rows.push(...extracted);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const results = normalizeWebResults(rows, 20);
    if (!results.length) throw new Error(`联网搜索没有拿到结果${errors.length ? `：${errors[0]}` : ''}`);
    return results;
  }, 45_000, '联网搜索');
}
