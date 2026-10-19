import type { DatabaseSync } from 'node:sqlite';
import type { VideoPlatform, VideoTopicSearchQuery, VideoTopicSearchResult, XhsHotspotResult } from '../shared';
import { readHotspotCache, writeHotspotCache } from './xhs-store';
import { normalizeHotspotQuery, type FetchLike } from './xhs-hotspot';
import { searchTopicHotspots } from './topic-hotspot-search';
import { isVideoRedfoxPlatform, searchVideoRedfox } from './video-redfox-hotspot';
import { searchBing } from './xhs-render';

const platformName: Record<VideoPlatform, string> = {
  douyin: '抖音',
  shipinhao: '视频号',
  xiaohongshu: '小红书',
  bilibili: 'B 站',
  general: '通用平台'
};
const platforms = new Set<VideoPlatform>(['douyin', 'shipinhao', 'xiaohongshu', 'bilibili', 'general']);

function cacheKey(
  platform: VideoPlatform,
  source: 'redfox' | 'web',
  query: ReturnType<typeof normalizeHotspotQuery>
): string {
  return [
    'video', source, platform, query.keyword,
    source === 'web' ? '' : query.startDate,
    source === 'web' ? '' : query.endDate,
    query.pageSize
  ].join('|');
}

/**
 * 视频选题的平台路由器。
 *
 * 小红书沿用现有红狐接口；抖音、视频号、B 站分别走官方对应接口。
 * 自动模式优先红狐，接口未开放、无权限或网络失败时回落到对应平台的联网搜索。
 */
export async function searchVideoTopicHotspots(
  db: DatabaseSync,
  input: VideoTopicSearchQuery | null | undefined,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<VideoTopicSearchResult> {
  const raw = input ?? { keyword: '', platform: 'general' as const };
  const platform: VideoPlatform = platforms.has(raw.platform) ? raw.platform : 'general';
  const query = { ...raw, platform };
  const source = query.source ?? 'auto';
  const normalized = normalizeHotspotQuery(query);
  const decorate = (result: XhsHotspotResult): VideoTopicSearchResult => ({ ...result, platform });

  if (platform === 'xiaohongshu') {
    return decorate(await searchTopicHotspots(db, query, apiKey, fetchImpl));
  }

  let notice = '';
  if (source === 'redfox' || (source === 'auto' && apiKey)) {
    if (!isVideoRedfoxPlatform(platform)) {
      if (source === 'redfox') throw new Error(`${platformName[platform]}没有专属红狐选题数据，请改用联网搜索`);
      notice = `${platformName[platform]}没有专属红狐选题数据，已改用联网搜索`;
    } else {
      const key = cacheKey(platform, 'redfox', normalized);
      const cached = query.refresh ? null : readHotspotCache(db, key);
      if (cached) return decorate(cached);
      try {
        const result = await searchVideoRedfox(platform, query, {
          apiKey,
          fetch: fetchImpl as unknown as FetchLike
        });
        writeHotspotCache(db, key, result);
        return decorate(result);
      } catch (error) {
        if (source === 'redfox') throw error;
        notice = `${platformName[platform]}红狐接口不可用（${error instanceof Error ? error.message : String(error)}），已改用联网搜索`;
      }
    }
  } else if (source === 'auto') {
    notice = '还没有配置红狐 API Key，已改用联网搜索';
  }

  if (!normalized.keyword) throw new Error(`${notice ? `${notice}；` : ''}联网搜索需要关键词`);
  const key = cacheKey(platform, 'web', normalized);
  const cached = query.refresh ? null : readHotspotCache(db, key);
  if (cached) return decorate({ ...cached, notice: notice || cached.notice });

  const notes = await searchBing(normalized.keyword, platform);
  const result: XhsHotspotResult = {
    source: 'web',
    keyword: normalized.keyword,
    startDate: '',
    endDate: '',
    total: notes.length,
    notes: notes.slice(0, normalized.pageSize),
    latest: [],
    relatedSearches: [],
    hotTopics: [],
    fetchedAt: new Date().toISOString(),
    cached: false,
    notice,
    tips: `${platformName[platform]}联网搜索结果来自公开网页，没有平台互动数据：只能看标题钩子、内容形态与方向有没有人写，热度和互动结论未经数据验证。`
  };
  writeHotspotCache(db, key, result);
  return decorate(result);
}
