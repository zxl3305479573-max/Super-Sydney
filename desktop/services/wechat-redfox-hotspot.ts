import type { XhsHotNote, XhsHotspotQuery, XhsHotspotResult } from '../shared.ts';
import { normalizeHotspotQuery, parseCount, type FetchLike } from './xhs-hotspot.ts';

/**
 * 红狐公众号作品搜索。
 *
 * 公众号平台在红狐里的代码是 gongzhonghao：
 * - 优质库：/story/api/gzhData/searchArticle
 * - 广域库：/story/api/gzh/data/searchArticle
 * 先用优质库；没有权限、接口不可用或结果为空时再试广域库。
 */
export const WECHAT_REDFOX_ENDPOINTS = [
  { kind: 'premium', url: 'https://redfox.hk/story/api/gzhData/searchArticle', sortType: '_4' },
  { kind: 'broad', url: 'https://redfox.hk/story/api/gzh/data/searchArticle', sortType: '4' }
] as const;

/** 自动选题没有手填方向时，用具体方向 / 一级方向作为红狐检索词。 */
export function wechatTopicKeyword(task: { topic: string; subdirectionName: string; directionName: string }): string {
  return [task.topic, task.subdirectionName, task.directionName].map(value => String(value ?? '').trim()).find(Boolean) ?? '';
}

export type WechatRedfoxOptions = {
  apiKey: string;
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
  now?: () => Date;
};

class WechatRedfoxError extends Error {
  readonly retryable: boolean;
  readonly status: number;
  constructor(message: string, retryable: boolean, status = 0) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function strArray(...values: unknown[]): string[] {
  const seen = new Set<string>();
  return values.flatMap(value => {
    const clean = text(value);
    return clean ? clean.split(/[,，#\s]+/).map(item => item.trim()) : [];
  }).filter(item => item && !seen.has(item) && Boolean(seen.add(item))).slice(0, 8);
}

export function normalizeWechatRedfoxNote(raw: unknown): XhsHotNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const link = text(row.workUrl ?? row.oriUrl ?? row.sourceUrl);
  const id = text(row.workUuid ?? row.photoId) || link;
  const title = text(row.title).replace(/\s+/g, ' ');
  if (!id || !title) return null;
  const readCount = parseCount(row.readCount ?? row.clicksCount);
  const liked = parseCount(row.likeCount);
  const watched = parseCount(row.watchCount);
  const collected = parseCount(row.collectCount);
  const comments = parseCount(row.commentCount);
  const shared = parseCount(row.shareCount);
  const interactive = parseCount(row.interactiveCount) || watched + liked + collected + comments + shared;
  const summary = text(row.summary) || text(row.content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600);
  const type = text(row.type ?? row.accountType);
  return {
    id,
    title: title.slice(0, 120),
    desc: summary.slice(0, 600),
    cover: text(row.coverUrl),
    link,
    createTime: text(row.publishTime ?? row.publicTime ?? row.syncTime),
    topics: strArray(type, row.memo),
    author: {
      id: text(row.accountId),
      nickname: text(row.userName ?? row.originalAuthor ?? row.author) || '未知公众号',
      fans: parseCount(row.fans)
    },
    interactive,
    readCount,
    liked,
    collected,
    comments,
    shared,
    // 公众号接口目前不返回与小红书同构的 15 分评分，不伪造一个分数。
    score: null
  };
}

export function normalizeWechatRedfoxData(
  data: unknown,
  query: ReturnType<typeof normalizeHotspotQuery>,
  fetchedAt: string,
  endpoint: typeof WECHAT_REDFOX_ENDPOINTS[number]['kind'],
  notice = ''
): XhsHotspotResult {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(record.list)
      ? record.list
      : Array.isArray(record.articles)
        ? record.articles
        : [];
  const all = rows.map(normalizeWechatRedfoxNote).filter((item): item is XhsHotNote => Boolean(item));
  const inRange = all.filter(note => {
    const day = note.createTime.slice(0, 10);
    return !day || (!query.startDate || day >= query.startDate) && (!query.endDate || day <= query.endDate);
  });
  const notes = (inRange.length ? inRange : all).slice(0, query.pageSize);
  const rangeNotice = inRange.length ? '' : `近 ${Math.max(1, Math.round((Date.parse(query.endDate || fetchedAt) - Date.parse(query.startDate)) / 86_400_000))} 天没有结果，已显示红狐较新的热门文章`;
  return {
    source: 'redfox',
    keyword: query.keyword,
    startDate: query.startDate,
    endDate: query.endDate,
    total: parseCount(record.total) || all.length,
    notes,
    latest: [],
    relatedSearches: [],
    hotTopics: [],
    tips: `红狐公众号${endpoint === 'premium' ? '优质库' : '广域库'} T+1 数据，按阅读数排序；选题仍需结合账号定位人工判断。`,
    fetchedAt,
    cached: false,
    notice: [notice, rangeNotice].filter(Boolean).join('；')
  };
}

async function requestOnce(endpoint: typeof WECHAT_REDFOX_ENDPOINTS[number], options: WechatRedfoxOptions, body: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let status = 0;
  let raw = '';
  try {
    const response = await options.fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-API-KEY': options.apiKey,
        REDFOX_API_KEY: options.apiKey
      },
      body,
      signal: controller.signal
    });
    status = response.status;
    raw = await response.text();
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new WechatRedfoxError(aborted ? '红狐请求超时' : `红狐请求失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    clearTimeout(timer);
  }
  if (status === 401 || status === 403) throw new WechatRedfoxError('红狐 API Key 无效、已过期或没有公众号接口权限', false, status);
  if (status === 404 || status === 405 || status === 501) throw new WechatRedfoxError('红狐公众号搜索接口暂不可用', false, status);
  if (status >= 500) throw new WechatRedfoxError(`红狐服务暂时不可用（HTTP ${status}）`, true, status);
  if (status < 200 || status >= 300) throw new WechatRedfoxError(`红狐请求失败（HTTP ${status}）：${raw.slice(0, 120)}`, false, status);
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw) as Record<string, unknown>; }
  catch { throw new WechatRedfoxError('红狐返回的不是有效 JSON', true, status); }
  if (Number(payload.code) !== 2000) {
    throw new WechatRedfoxError(`红狐返回错误：${text(payload.msg ?? payload.message) || '未知错误'}`, false, status);
  }
  return payload.data;
}

/** 搜索公众号文章。网络 / 超时 / 5xx 退避重试；优质库不可用时自动换广域库。 */
export async function searchWechatRedfox(query: XhsHotspotQuery, options: WechatRedfoxOptions): Promise<XhsHotspotResult> {
  if (!options.apiKey.trim()) throw new Error('还没有配置红狐 API Key，请先在「隐私与设置 → 数据服务」里保存');
  const now = options.now?.() ?? new Date();
  const normalized = normalizeHotspotQuery(query, now);
  if (!normalized.keyword) throw new Error('公众号红狐选题需要填写关键词或内容方向');
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = Math.max(1, options.maxRetries ?? 3);
  const endpointNotices: string[] = [];
  let lastEmpty: XhsHotspotResult | null = null;

  for (const endpoint of WECHAT_REDFOX_ENDPOINTS) {
    const body = JSON.stringify({
      keyword: normalized.keyword,
      offset: 0,
      sortType: endpoint.sortType,
      exactMatch: false
    });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = normalizeWechatRedfoxData(
          await requestOnce(endpoint, options, body),
          normalized,
          now.toISOString(),
          endpoint.kind,
          endpointNotices.join('；')
        );
        if (result.notes.length) return result;
        lastEmpty = result;
        endpointNotices.push(`红狐公众号${endpoint.kind === 'premium' ? '优质库' : '广域库'}没有搜到文章`);
        break;
      } catch (error) {
        const issue = error instanceof WechatRedfoxError ? error : new WechatRedfoxError(String(error), false);
        if (issue.retryable && attempt < attempts - 1) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (endpoint.kind === 'premium') {
          endpointNotices.push(`${issue.message}，已改用广域库`);
          break;
        }
        throw issue.status ? issue : new Error(issue.message);
      }
    }
  }
  if (lastEmpty) return lastEmpty;
  throw new Error(endpointNotices.at(-1) || '红狐公众号搜索没有返回结果');
}
