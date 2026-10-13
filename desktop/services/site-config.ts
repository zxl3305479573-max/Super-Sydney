import fs from 'node:fs';
import path from 'node:path';
import type { SiteEntry, SiteViewBounds } from '../shared.ts';
import { writeFileAtomic } from './atomic-file.ts';

/**
 * 变现模块的站点配置：一串「要嵌进来的站点」，加一个当前选中的。
 *
 * 站点自己的账号、订单与 cookie 都在它的会话分区里（Electron userData/Partitions），
 * 不进这里，也不进应用的数据库。
 */
export type SiteModuleConfig = { sites: SiteEntry[]; activeId: string };

const CONFIG_FILE = 'site.json';
/** 每个打开过的站点在会话里都要占一个渲染进程，列表给个上限，免得手滑贴进来一整屏。 */
const MAX_SITES = 20;

export function readSiteConfig(dataDir: string): SiteModuleConfig {
  try {
    return normalizeStoredConfig(JSON.parse(fs.readFileSync(path.join(dataDir, CONFIG_FILE), 'utf8').replace(/^\uFEFF/, '')) as unknown);
  } catch {
    return { sites: [], activeId: '' };
  }
}

export function writeSiteConfig(dataDir: string, config: SiteModuleConfig): void {
  writeFileAtomic(path.join(dataDir, CONFIG_FILE), JSON.stringify({ sites: config.sites, activeId: config.activeId }, null, 2));
}

/**
 * 读盘时一律宽松处理：坏掉的条目直接丢掉，整个文件读不动就当没配过。
 * 兼容最早只有 `{ url }` 的单站点格式——那时还没有列表，把它当成唯一一个站点。
 */
export function normalizeStoredConfig(raw: unknown): SiteModuleConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { sites: [], activeId: '' };
  const record = raw as { sites?: unknown; activeId?: unknown; url?: unknown };
  const legacy = typeof record.url === 'string' && record.url.trim() ? [{ id: 'site-1', name: '', url: record.url }] : [];
  const source = Array.isArray(record.sites) ? record.sites : legacy;
  const sites: SiteEntry[] = [];
  for (const item of source) {
    const entry = coerceStoredEntry(item, sites.length + 1, sites);
    if (entry) sites.push(entry);
  }
  const wanted = typeof record.activeId === 'string' ? record.activeId : '';
  return { sites, activeId: sites.some(site => site.id === wanted) ? wanted : sites[0]?.id ?? '' };
}

/**
 * 界面提交的站点列表：这一层是硬校验，坏数据不进配置文件。
 * 名称留空用域名兜底，列表里至少能认出是哪个站。
 */
export function sanitizeSiteEntries(input: unknown): SiteEntry[] {
  if (!Array.isArray(input)) throw new Error('站点列表格式不正确');
  if (input.length > MAX_SITES) throw new Error(`站点最多 ${MAX_SITES} 个`);
  const sites: SiteEntry[] = [];
  input.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 个站点格式不正确`);
    const { id, name, url } = item as Partial<SiteEntry>;
    const key = String(id ?? '').trim();
    if (!key || key.length > 64) throw new Error(`第 ${index + 1} 个站点缺少标识`);
    if (sites.some(site => site.id === key)) throw new Error('站点标识重复，请重新打开这个模块再试');
    sites.push({ id: key, name: String(name ?? '').trim().slice(0, 40) || hostLabel(url), url: normalizeForEntry(url, index) });
  });
  return sites;
}

/** 站点名留空时的兜底名字：域名比「未命名」好用。 */
export function hostLabel(url: unknown): string {
  try {
    return new URL(String(url ?? '')).host || '未命名站点';
  } catch {
    return '未命名站点';
  }
}

function normalizeForEntry(url: unknown, index: number): string {
  try {
    return normalizeSiteUrl(url);
  } catch (error) {
    throw new Error(`第 ${index + 1} 个站点：${error instanceof Error ? error.message : String(error)}`);
  }
}

function coerceStoredEntry(item: unknown, index: number, taken: SiteEntry[]): SiteEntry | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const { id, name, url } = item as Partial<SiteEntry>;
  let address: string;
  try {
    address = normalizeSiteUrl(url);
  } catch {
    return null;
  }
  let key = typeof id === 'string' && id.trim() ? id.trim().slice(0, 64) : `site-${index}`;
  while (taken.some(site => site.id === key)) key = `${key}-${index}`;
  return { id: key, name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : hostLabel(address), url: address };
}

/**
 * 站点地址只接受 http/https，没写协议时补 https。
 *
 * 这个地址会直接喂给一个真实的浏览器视图，所以不能让 file:（读本地文件）、
 * javascript:（执行脚本）这类协议混进来。
 *
 * 难点是分清「写了协议」和「主机:端口」：localhost:3000 与 pay.example.com:8080
 * 都是没写协议的地址，不能当成协议头。这里只在冒号后面不跟数字时才认作协议——
 * javascript:、data:、file:// 都在那一支被拦下。
 */
export function normalizeSiteUrl(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('请先填写站点地址');
  const scheme = /^([a-z][a-z0-9+.-]*):(?![0-9])/i.exec(text);
  if (scheme && !/^https?$/i.test(scheme[1])) throw new Error(`站点地址只支持 http 与 https，不认 ${scheme[1]}: 协议`);
  let parsed: URL;
  try {
    parsed = new URL(scheme ? text : `https://${text}`);
  } catch {
    throw new Error('站点地址格式不正确，请填写完整网址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('站点地址只支持 http 与 https');
  if (!parsed.hostname) throw new Error('站点地址缺少域名');
  return parsed.toString();
}

/**
 * 把界面报上来的矩形夹进窗口可视区。视图浮在页面之上，
 * 越出窗口的部分不会自己裁掉，会直接盖住旁边的界面。
 * 小到看不出是块区域时返回 null：这时候宁可先不挂视图。
 */
export function clampSiteBounds(input: unknown, viewport: { width: number; height: number }): SiteViewBounds | null {
  if (!input || typeof input !== 'object') return null;
  const { x, y, width, height } = input as Partial<SiteViewBounds>;
  if (![x, y, width, height].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
  const left = Math.max(0, Math.round(x as number));
  const top = Math.max(0, Math.round(y as number));
  const right = Math.min(Math.round(viewport.width), Math.round((x as number) + (width as number)));
  const bottom = Math.min(Math.round(viewport.height), Math.round((y as number) + (height as number)));
  const clamped = { x: left, y: top, width: right - left, height: bottom - top };
  return clamped.width < 80 || clamped.height < 80 ? null : clamped;
}
