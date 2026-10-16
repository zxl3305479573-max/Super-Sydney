import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 应用里所有「在浏览器打开」统一走这里：优先用 Chrome，找不到再交给系统默认浏览器。
 * 嵌入站点（闲鱼、公众号后台、小红书…）的支付、客服、扫码这些页面在 Chrome 里最稳。
 */

type Env = Record<string, string | undefined>;

/** Chrome 的常见安装位置（按优先级）；SYDNEY_CHROME 可以指定别的路径。 */
export function chromeCandidates(env: Env, platform: string): string[] {
  const list: string[] = [];
  if (env.SYDNEY_CHROME) list.push(env.SYDNEY_CHROME);
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (root) list.push(path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium');
  }
  return list;
}

export function findChrome(env: Env = process.env, platform = process.platform, exists: (file: string) => boolean = fs.existsSync): string | null {
  return chromeCandidates(env, platform).find(file => exists(file)) ?? null;
}

let cached: string | null | undefined;

/** 只接受 http(s) 地址；Chrome 起不来时退回系统默认浏览器。 */
export async function openInBrowser(url: string, fallback: (url: string) => Promise<void>): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (cached === undefined) cached = findChrome();
  const chrome = cached;
  if (!chrome) { await fallback(url); return; }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(chrome, [url], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch {
    cached = null;
    await fallback(url);
  }
}
