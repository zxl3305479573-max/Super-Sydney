import type { XhsHotspotQuery } from '../shared.ts';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export const HOTSPOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const REDFOX_MAX_PAGE_SIZE = 50;
export const DEFAULT_HOTSPOT_DAYS = 7;
export const DEFAULT_HOTSPOT_PAGE_SIZE = 20;
export type NormalizedHotspotQuery = { keyword: string; startDate: string; endDate: string; pageSize: number };

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function normalizeHotspotQuery(query: XhsHotspotQuery, now: Date = new Date()): NormalizedHotspotQuery {
  const keyword = String(query.keyword ?? '').replace(/\s+/g, ' ').trim();
  const startDate = String(query.startDate ?? '').trim();
  const endDate = String(query.endDate ?? '').trim();
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('开始日期格式应为 yyyy-MM-dd');
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error('结束日期格式应为 yyyy-MM-dd');
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

export function parseHotspotCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const raw = String(value ?? '').replace(/[+,\s]/g, '').toLowerCase();
  if (!raw) return 0;
  const wan = raw.endsWith('w') || raw.endsWith('万');
  const amount = Number(wan ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(wan ? amount * 10_000 : amount);
}

export function hotspotCacheKey(query: NormalizedHotspotQuery, source: 'redfox' | 'web' = 'redfox'): string {
  return [source, query.keyword, source === 'web' ? '' : query.startDate, source === 'web' ? '' : query.endDate, query.pageSize].join('|');
}
