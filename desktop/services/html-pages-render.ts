import fs from 'node:fs';
import { BrowserWindow } from 'electron';

function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withHiddenWindow<T>(options: Electron.BrowserWindowConstructorOptions, run: (win: BrowserWindow) => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const win = new BrowserWindow({ show: false, ...options });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([run(win), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Render local static HTML pages at exact dimensions in an isolated offscreen window. */
export async function renderHtmlPages(documents: string[], width: number, height: number, targets: string[]): Promise<string[]> {
  if (documents.length !== targets.length) throw new Error('卡片页数与输出文件数不一致');
  return withHiddenWindow({
    width: 540, height: 720, paintWhenInitiallyHidden: true, frame: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'sydney-html-pages' }
  }, async win => {
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
    } finally { try { cdp.detach(); } catch { /* Window already closed. */ } }
    return targets;
  }, 30_000 + documents.length * 5_000, '图文卡片渲染');
}
