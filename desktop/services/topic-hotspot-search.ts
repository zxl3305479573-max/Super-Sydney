import type { DatabaseSync } from 'node:sqlite';
import type { XhsHotspotQuery, XhsHotspotResult } from '../shared';
import { hotspotCacheKey, normalizeHotspotQuery, searchRedfox, type FetchLike } from './xhs-hotspot';
import { searchBing } from './xhs-render';
import { readHotspotCache, writeHotspotCache } from './xhs-store';

/**
 * 内容模块共用的热点选题检索。
 *
 * 数据源按优先级降级：红狐（有 key 时）→ 联网搜索（必应）。
 * 同样的查询 24 小时内走缓存：红狐每天只更新一次，重查没有新数据还费额度。
 * 红狐提供的是小红书近 30 天数据；视频模块也把它当作公开内容热度参考。
 */
export async function searchTopicHotspots(
  db: DatabaseSync,
  query: XhsHotspotQuery | null | undefined,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<XhsHotspotResult> {
  const input = query ?? { keyword: '' };
  const source = input.source ?? 'auto';
  const normalized = normalizeHotspotQuery(input);
  let notice = '';

  if (source === 'redfox' || (source === 'auto' && apiKey)) {
    const key = hotspotCacheKey(normalized, 'redfox');
    const cached = input.refresh ? null : readHotspotCache(db, key);
    if (cached) return cached;
    try {
      const result = await searchRedfox(input, {
        apiKey,
        fetch: fetchImpl as unknown as FetchLike
      });
      writeHotspotCache(db, key, result);
      return result;
    } catch (error) {
      if (source === 'redfox') throw error;
      notice = `红狐不可用（${error instanceof Error ? error.message : String(error)}），已改用联网搜索`;
    }
  } else if (source === 'auto') {
    notice = '还没有配置红狐 API Key，已改用联网搜索';
  }

  if (!normalized.keyword) throw new Error(`${notice ? `${notice}；` : ''}联网搜索需要关键词，全站热门只有红狐支持`);
  const key = hotspotCacheKey(normalized, 'web');
  const cached = input.refresh ? null : readHotspotCache(db, key);
  if (cached) return { ...cached, notice: notice || cached.notice };

  const notes = await searchBing(normalized.keyword);
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
    tips: '联网搜索结果来自公开网页，没有互动数据：只能看标题钩子、内容形态和方向有没有人写，互动量级、账号量级与热度趋势都需要配置数据源，结论未经互动数据验证。'
  };
  writeHotspotCache(db, key, result);
  return result;
}
