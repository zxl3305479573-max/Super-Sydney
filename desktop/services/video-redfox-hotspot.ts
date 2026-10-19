import type { VideoPlatform, XhsHotNote, XhsHotspotQuery, XhsHotspotResult } from '../shared.ts';
import { normalizeHotspotQuery, parseCount, type FetchLike } from './xhs-hotspot.ts';

/**
 * 红狐视频平台选题接口。
 *
 * 红狐为抖音、视频号和 B 站分别提供关键词搜索接口，字段结构互不相同。
 * 这里把三者归一化成视频选题页使用的统一结果；官方接口上线状态与权限以红狐控制台为准。
 */
export type VideoRedfoxPlatform = Exclude<VideoPlatform, 'xiaohongshu' | 'general'>;

export const VIDEO_REDFOX_ENDPOINTS: Record<VideoRedfoxPlatform, string> = {
  douyin: 'https://redfox.hk/story/api/dy/data/searchWork',
  shipinhao: 'https://redfox.hk/story/api/sphAllData/searchWork',
  bilibili: 'https://redfox.hk/story/api/bili/data/workSearch'
};

export function isVideoRedfoxPlatform(value: VideoPlatform): value is VideoRedfoxPlatform {
  return value === 'douyin' || value === 'shipinhao' || value === 'bilibili';
}

export type VideoRedfoxOptions = {
  apiKey: string;
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
  now?: () => Date;
};

class VideoRedfoxError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function titleFromText(value: unknown): string {
  const clean = text(value).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '无标题';
  const first = clean.split(/[。！？!?]/)[0]?.trim() || clean;
  return first.slice(0, 52);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (item && typeof item === 'object') {
        const name = text((item as Record<string, unknown>).tagName ?? (item as Record<string, unknown>).name);
        return name ? [name] : [];
      }
      const name = text(item);
      return name ? [name] : [];
    });
  }
  const raw = text(value);
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map(text).filter(Boolean);
    } catch {
      // 不是合法 JSON 时继续按逗号 / # 分隔。
    }
  }
  return raw.split(/[,，#\s]+/).map(item => item.trim()).filter(Boolean);
}

function hashtagsFromContent(value: string): string[] {
  return [...value.matchAll(/#([^#\s，。！？!?]+)/g)].map(match => match[1]).filter(Boolean);
}

function uniqueTopics(...values: string[][]): string[] {
  const seen = new Set<string>();
  return values.flat().flatMap(item => {
    const value = item.trim();
    if (!value || seen.has(value)) return [];
    seen.add(value);
    return [value];
  }).slice(0, 8);
}

function note(platform: VideoRedfoxPlatform, row: Record<string, unknown>): XhsHotNote | null {
  if (platform === 'douyin') {
    const content = text(row.content);
    const id = text(row.videoId);
    if (!id) return null;
    const liked = parseCount(row.likeCount);
    const collected = parseCount(row.collectCount);
    const comments = parseCount(row.commentCount);
    const shared = parseCount(row.shareCount);
    return {
      id: `douyin-${id}`,
      title: titleFromText(content),
      desc: content.slice(0, 600),
      cover: text(row.coverUrl),
      link: text(row.opusUrl),
      createTime: text(row.publishTime),
      topics: uniqueTopics(stringList(row.tagList), hashtagsFromContent(content)),
      author: {
        id: text(row.authorUid ?? row.authorSecUid),
        nickname: text(row.authorName) || '未知作者',
        fans: 0
      },
      interactive: liked + collected + comments + shared,
      liked,
      collected,
      comments,
      shared,
      score: null
    };
  }

  if (platform === 'shipinhao') {
    const description = text(row.description);
    const id = text(row.videoId);
    if (!id) return null;
    const liked = parseCount(row.likeCount);
    const collected = parseCount(row.favCount);
    const comments = parseCount(row.commentCount);
    const shared = parseCount(row.forwardCount);
    return {
      id: `shipinhao-${id}`,
      title: titleFromText(description),
      desc: description.slice(0, 600),
      cover: text(row.coverUrl ?? row.thumbUrl),
      link: text(row.videoUrl),
      createTime: text(row.publishTime),
      topics: uniqueTopics(stringList(row.topic), hashtagsFromContent(description)),
      author: { id: '', nickname: text(row.nickname) || '未知作者', fans: 0 },
      interactive: liked + collected + comments + shared,
      liked,
      collected,
      comments,
      shared,
      score: null
    };
  }

  const id = text(row.bvId);
  if (!id) return null;
  const liked = parseCount(row.likeCount);
  const collected = parseCount(row.favoriteCount);
  const comments = parseCount(row.commentCount);
  const shared = parseCount(row.shareCount);
  return {
    id: `bilibili-${id}`,
    title: titleFromText(row.title),
    desc: text(row.description).slice(0, 600),
    cover: text(row.picUrl),
    link: `https://www.bilibili.com/video/${id}`,
    createTime: text(row.created),
    topics: uniqueTopics(stringList(row.tagNames)),
    author: { id: text(row.authorId), nickname: text(row.author) || '未知作者', fans: 0 },
    interactive: parseCount(row.interactionQuantity) || liked + collected + comments + shared,
    liked,
    collected,
    comments,
    shared,
    score: null
  };
}

export function buildVideoRedfoxBody(
  platform: VideoRedfoxPlatform,
  query: ReturnType<typeof normalizeHotspotQuery>
): Record<string, unknown> {
  if (!query.keyword) throw new Error(`${platform === 'douyin' ? '抖音' : platform === 'shipinhao' ? '视频号' : 'B 站'}红狐选题需要关键词`);
  if (platform === 'douyin') {
    return {
      keyword: query.keyword,
      exactMatch: false,
      startDate: query.startDate,
      endDate: query.endDate,
      pageNum: 1,
      pageSize: query.pageSize
    };
  }
  if (platform === 'shipinhao') {
    return {
      keyword: query.keyword,
      sort: '最多点赞',
      page: 1,
      size: query.pageSize,
      exactMatch: false
    };
  }
  return {
    keyword: query.keyword,
    exactMatch: false,
    page: '1',
    pageSize: query.pageSize,
    order: 'play'
  };
}

export function normalizeVideoRedfoxData(
  platform: VideoRedfoxPlatform,
  data: unknown,
  query: ReturnType<typeof normalizeHotspotQuery>,
  fetchedAt: string
): XhsHotspotResult {
  const record = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const rows = Array.isArray(platform === 'bilibili' ? record.workList : record.list)
    ? (platform === 'bilibili' ? record.workList : record.list) as unknown[]
    : [];
  const notes = rows.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const normalized = note(platform, item as Record<string, unknown>);
    return normalized ? [normalized] : [];
  }).slice(0, query.pageSize);
  return {
    source: 'redfox',
    keyword: query.keyword,
    startDate: query.startDate,
    endDate: query.endDate,
    total: parseCount(record.total) || notes.length,
    notes,
    latest: [],
    relatedSearches: [],
    hotTopics: [],
    tips: '红狐结果来自平台公开内容，互动数与更新时间以接口返回为准；选题方向仍需结合账号定位人工判断。',
    fetchedAt,
    cached: false
  };
}

async function requestOnce(platform: VideoRedfoxPlatform, options: VideoRedfoxOptions, body: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let status: number;
  let raw: string;
  try {
    const response = await options.fetch(VIDEO_REDFOX_ENDPOINTS[platform], {
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
    throw new VideoRedfoxError(aborted ? '红狐请求超时' : `红狐请求失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    clearTimeout(timer);
  }
  if (status === 401) throw new VideoRedfoxError('红狐 API Key 无效或已过期', false);
  if (status === 403) throw new VideoRedfoxError('当前红狐 Key 没有该平台选题接口权限', false);
  if (status === 404 || status === 405 || status === 501) {
    throw new VideoRedfoxError('红狐该平台选题接口尚未开放；官方当前标记为「即将上线」，可先用联网搜索', false);
  }
  if (status >= 500) throw new VideoRedfoxError(`红狐服务暂时不可用（HTTP ${status}）`, true);
  if (status < 200 || status >= 300) throw new VideoRedfoxError(`红狐请求失败（HTTP ${status}）：${raw.slice(0, 120)}`, false);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new VideoRedfoxError('红狐返回的不是有效 JSON', true);
  }
  if (Number(payload.code) !== 2000) {
    throw new VideoRedfoxError(`红狐返回错误：${text(payload.msg ?? payload.message) || '未知错误'}`, false);
  }
  return payload.data;
}

/** 搜索单一平台的抖音 / 视频号 / B 站内容；网络与 5xx 指数退避重试。 */
export async function searchVideoRedfox(
  platform: VideoRedfoxPlatform,
  query: XhsHotspotQuery,
  options: VideoRedfoxOptions
): Promise<XhsHotspotResult> {
  if (!options.apiKey.trim()) throw new Error('还没有配置红狐 API Key，请先在「隐私与设置 → 数据服务」里保存');
  const now = options.now?.() ?? new Date();
  const normalized = normalizeHotspotQuery(query, now);
  const body = JSON.stringify(buildVideoRedfoxBody(platform, normalized));
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = Math.max(1, options.maxRetries ?? 3);
  let lastError: Error = new Error('红狐请求失败');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return normalizeVideoRedfoxData(platform, await requestOnce(platform, options, body), normalized, now.toISOString());
    } catch (error) {
      if (!(error instanceof VideoRedfoxError) || !error.retryable) throw error;
      lastError = error;
      if (attempt < attempts - 1) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`${lastError.message}（已重试 ${attempts} 次）`);
}
