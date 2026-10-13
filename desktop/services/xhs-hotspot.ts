import type { XhsHotNote, XhsHotspotQuery, XhsHotspotResult } from '../shared.ts';

/**
 * 小红书热点数据：红狐 API 客户端与结果归一化。
 *
 * 纯逻辑，没有 Node / Electron 依赖：fetch 与等待由调用方注入，方便单测；
 * 渲染进程也直接引用这里的 fuzzyCount 做互动数展示。
 * 数据源说明见设计草案「热点选题」：红狐是自建库，每天 7 点更新昨日数据，覆盖昨天 ~ 30 天前。
 */

export const REDFOX_SEARCH_URL = 'https://redfox.hk/story/api/xhs/search/search';
export const REDFOX_KEY_URL = 'https://redfox.hk/settings/api-keys';
export const REDFOX_MAX_PAGE_SIZE = 50;
export const DEFAULT_HOTSPOT_DAYS = 7;
export const DEFAULT_HOTSPOT_PAGE_SIZE = 20;
/** 红狐每天只更新一次，24 小时内同样的查询直接用缓存，不重复花额度。 */
export const HOTSPOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export type RedfoxOptions = {
  apiKey: string;
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
  /** 计算默认日期用；测试里固定时间。 */
  now?: () => Date;
};

/** 可以重试的错误（网络、超时、5xx）与不该重试的错误（key 无效、参数错）分开。 */
class RedfoxError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 把用户输入整理成一次确定的查询：日期默认近 7 天，条数夹在 1~50。缓存键也由它决定。 */
export function normalizeHotspotQuery(query: XhsHotspotQuery, now: Date = new Date()): { keyword: string; startDate: string; endDate: string; pageSize: number } {
  const keyword = String(query.keyword ?? '').replace(/\s+/g, ' ').trim();
  const startDate = String(query.startDate ?? '').trim();
  const endDate = String(query.endDate ?? '').trim();
  if (startDate && !DATE.test(startDate)) throw new Error('开始日期格式应为 yyyy-MM-dd');
  if (endDate && !DATE.test(endDate)) throw new Error('结束日期格式应为 yyyy-MM-dd');
  if (startDate && endDate && startDate > endDate) throw new Error('开始日期不能晚于结束日期');
  const fallbackStart = new Date(now.getTime() - DEFAULT_HOTSPOT_DAYS * 24 * 60 * 60 * 1000);
  const size = Math.round(Number(query.pageSize ?? DEFAULT_HOTSPOT_PAGE_SIZE));
  return {
    keyword,
    startDate: startDate || localDate(fallbackStart),
    endDate,
    pageSize: Number.isFinite(size) ? Math.min(REDFOX_MAX_PAGE_SIZE, Math.max(1, size)) : DEFAULT_HOTSPOT_PAGE_SIZE
  };
}

export function hotspotCacheKey(query: ReturnType<typeof normalizeHotspotQuery>, source: 'redfox' | 'web' = 'redfox'): string {
  return [source, query.keyword, source === 'web' ? '' : query.startDate, source === 'web' ? '' : query.endDate, query.pageSize].join('|');
}

/** 只放行小红书自己的 https 链接，避免把任意地址交给系统浏览器。 */
export function isXhsLink(value: unknown): boolean {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' && /(^|\.)(xiaohongshu\.com|xhslink\.com)$/.test(url.hostname);
  } catch {
    return false;
  }
}

/** 交给系统浏览器打开的链接只放行 http/https（联网搜索的结果来自各种网站）。 */
export function isHttpLink(value: unknown): boolean {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** 数据源偶尔给 "1.2w"、"5000+" 这类字符串，统一转成数字；解析不了的记 0。 */
export function parseCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const text = String(value ?? '').replace(/[+,\s]/g, '').toLowerCase();
  if (!text) return 0;
  const wan = text.endsWith('w') || text.endsWith('万');
  const number = Number(wan ? text.slice(0, -1) : text);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(wan ? number * 10000 : number);
}

/** 展示用的模糊互动数：<5000 原值，5000~9999 显示 5000+，过万按万向下取整。 */
export function fuzzyCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value < 5000) return String(Math.round(value));
  if (value < 10000) return '5000+';
  return `${Math.floor(value / 10000)}w+`;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function topicList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value).split(/[,，#\s]+/).map(item => item.trim()).filter(Boolean);
}

function score(row: Record<string, unknown>): XhsHotNote['score'] {
  if (row.totalScore === null || row.totalScore === undefined) return null;
  const read = (value: unknown) => { const number = Number(value); return Number.isFinite(number) ? number : 0; };
  return { total: read(row.totalScore), relevance: read(row.relevanceScore), popularity: read(row.popularityScore), recency: read(row.recencyScore) };
}

export function normalizeHotNote(raw: unknown): XhsHotNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = text(row.id ?? row.noteId);
  if (!id) return null;
  const desc = text(row.desc);
  const title = text(row.title) || desc.replace(/\s+/g, ' ').slice(0, 30) || '无标题';
  const liked = parseCount(row.likedCount);
  const collected = parseCount(row.collectedCount);
  const comments = parseCount(row.commentsCount);
  const shared = parseCount(row.sharedCount);
  return {
    id, title, desc,
    cover: text(row.cover),
    link: text(row.shareInfoLink ?? row.noteLink) || `https://www.xiaohongshu.com/explore/${id}`,
    createTime: text(row.createTime),
    topics: topicList(row.topicsName),
    author: { id: text(row.authorId), nickname: text(row.authorNickname) || '未知', fans: parseCount(row.authorFans) },
    interactive: parseCount(row.interactiveCount) || liked + collected + comments + shared,
    liked, collected, comments, shared,
    score: score(row)
  };
}

function notes(value: unknown): XhsHotNote[] {
  const seen = new Set<string>();
  const result: XhsHotNote[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const note = normalizeHotNote(item);
    if (note && !seen.has(note.id)) { seen.add(note.id); result.push(note); }
  }
  return result;
}

/** 把红狐返回的 data 字段整理成模块内部的结果形状。 */
export function normalizeRedfoxData(data: unknown, query: ReturnType<typeof normalizeHotspotQuery>, fetchedAt: string): XhsHotspotResult {
  const row = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const list = <T>(value: unknown, map: (item: Record<string, unknown>) => T | null): T[] =>
    (Array.isArray(value) ? value : []).flatMap(item => { const mapped = item && typeof item === 'object' ? map(item as Record<string, unknown>) : null; return mapped ? [mapped] : []; });
  // 红狐偶尔多给几条（实测 pageSize 3 返回 4 条），按请求条数截断。
  const items = notes(row.articles).slice(0, query.pageSize);
  return {
    source: 'redfox',
    keyword: query.keyword,
    startDate: query.startDate,
    endDate: query.endDate,
    total: parseCount(row.total) || items.length,
    notes: items,
    latest: notes(row.latestHotArticles),
    relatedSearches: list(row.relatedSearches, item => { const keyword = text(item.keyword); return keyword ? { keyword, count: parseCount(item.articleCount) } : null; }),
    hotTopics: list(row.hotTopics, item => { const topic = text(item.topic); return topic ? { topic, count: parseCount(item.articleCount), interactive: parseCount(item.totalInteractiveCount) } : null; }),
    tips: text(row.tips),
    fetchedAt,
    cached: false
  };
}

async function requestOnce(options: RedfoxOptions, body: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let status: number;
  let raw: string;
  try {
    const response = await options.fetch(REDFOX_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-API-KEY': options.apiKey },
      body,
      signal: controller.signal
    });
    status = response.status;
    raw = await response.text();
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new RedfoxError(aborted ? '红狐请求超时' : `红狐请求失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    clearTimeout(timer);
  }
  if (status === 401 || status === 403) throw new RedfoxError(`红狐 API Key 无效或已过期，请到 ${REDFOX_KEY_URL} 重新获取`, false);
  if (status >= 500) throw new RedfoxError(`红狐服务暂时不可用（HTTP ${status}）`, true);
  if (status < 200 || status >= 300) throw new RedfoxError(`红狐请求失败（HTTP ${status}）：${raw.slice(0, 120)}`, false);
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { throw new RedfoxError('红狐返回的不是有效 JSON', true); }
  if (Number(payload.code) !== 2000) throw new RedfoxError(`红狐返回错误：${text(payload.msg) || '未知错误'}（请检查关键词与日期）`, false);
  return payload.data;
}

/** 查询红狐热门笔记。网络 / 超时 / 5xx 指数退避重试；key 无效与参数错误立即抛出。 */
export async function searchRedfox(query: XhsHotspotQuery, options: RedfoxOptions): Promise<XhsHotspotResult> {
  if (!options.apiKey.trim()) throw new Error('还没有配置红狐 API Key，请先在「隐私与设置 → 数据服务」里保存');
  const now = options.now?.() ?? new Date();
  const normalized = normalizeHotspotQuery(query, now);
  // 请求体必须是 UTF-8 JSON：Windows 控制台编码发中文关键词时，红狐只回一句「请求异常」。
  const body = JSON.stringify({ keyword: normalized.keyword, pageNum: 1, pageSize: normalized.pageSize, startDate: normalized.startDate, endDate: normalized.endDate, source: 'Sydney' });
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = Math.max(1, options.maxRetries ?? 3);
  let lastError: Error = new Error('红狐请求失败');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return normalizeRedfoxData(await requestOnce(options, body), normalized, now.toISOString());
    } catch (error) {
      if (!(error instanceof RedfoxError) || !error.retryable) throw error;
      lastError = error;
      if (attempt < attempts - 1) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`${lastError.message}（已重试 ${attempts} 次）`);
}
