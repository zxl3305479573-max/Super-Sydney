import { BrowserWindow } from 'electron';
import type { VideoPlatform, XhsHotNote } from '../shared';
import { BING_EXTRACT_SCRIPT, bingSearchUrls, normalizeWebResults } from './web-topic-search';

function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withHiddenWindow<T>(run: (win: BrowserWindow) => Promise<T>, timeoutMs: number): Promise<T> {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:sydney-websearch' } });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([run(win), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('联网搜索超时')), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Public web search in an isolated browser window, without importing any platform module. */
export async function searchPublicWeb(keyword: string, platform: VideoPlatform = 'general'): Promise<XhsHotNote[]> {
  return withHiddenWindow(async win => {
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
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    const results = normalizeWebResults(rows, 20);
    if (!results.length) throw new Error(`联网搜索没有拿到结果${errors.length ? `：${errors[0]}` : ''}`);
    return results;
  }, 45_000);
}
