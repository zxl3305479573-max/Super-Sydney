import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-file.ts';

/**
 * 嵌入网页上次停在哪一页（公众号后台、闲鱼、16688、小红书窗口、AI 代充站点）。
 *
 * 切模块时页面进程本来就常驻，这里管的是重启应用之后：第一次打开视图时回到上次的页面，
 * 而不是站点首页。只存地址，不存 cookie 或页面内容；登录态由 session-cookies.ts 负责。
 * 每个视图用自己的 key（例如 embed:xianyu、xhs:3、site:<id>），调用方负责校验地址仍属于该站点。
 */
const FILE = 'last-pages.json';
const MAX_URL = 2048;

export class LastPages {
  private pages: Record<string, string> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly dir: string;

  constructor(dir: string) { this.dir = dir; }

  get(key: string): string {
    return this.load()[key] ?? '';
  }

  /** 记一笔；导航很频繁，落盘合并到稍后一次。 */
  set(key: string, url: string): void {
    if (!isRememberable(url)) return;
    const pages = this.load();
    if (pages[key] === url) return;
    pages[key] = url;
    this.schedule();
  }

  forget(key: string): void {
    const pages = this.load();
    if (!(key in pages)) return;
    delete pages[key];
    this.schedule();
  }

  /** 退出前把还没落盘的写进去。 */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pages) return;
    try { writeFileAtomic(path.join(this.dir, FILE), JSON.stringify(this.pages, null, 2)); } catch { /* 写不了顶多下次从首页开始 */ }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1500);
    this.timer.unref?.();
  }

  private load(): Record<string, string> {
    if (this.pages) return this.pages;
    this.pages = readPages(path.join(this.dir, FILE));
    return this.pages;
  }
}

export function isRememberable(url: string): boolean {
  if (!url || url.length > MAX_URL) return false;
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}

export function readPages(file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const pages: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string' && isRememberable(value)) pages[key] = value;
    return pages;
  } catch {
    return {};
  }
}
