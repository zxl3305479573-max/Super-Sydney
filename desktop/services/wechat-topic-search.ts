import type { DatabaseSync } from 'node:sqlite';
import type { XhsHotspotQuery, XhsHotspotResult } from '../shared.ts';
import { readHotspotCache, writeHotspotCache } from './xhs-store.ts';
import { normalizeHotspotQuery, type FetchLike } from './xhs-hotspot.ts';
import { searchBing } from './xhs-render.ts';
import { searchWechatRedfox } from './wechat-redfox-hotspot.ts';

/** 公众号选题数据源：红狐公众号搜索 → 联网搜索。 */
export async function searchWechatTopicHotspots(
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
    if (!normalized.keyword) throw new Error('公众号红狐选题需要关键词；AI 生成时会自动使用具体方向或选题方向');
    const key = ['content', 'wechat', 'redfox', normalized.keyword, normalized.startDate, normalized.endDate, normalized.pageSize].join('|');
    const cached = input.refresh ? null : readHotspotCache(db, key);
    if (cached) return cached;
    try {
      const result = await searchWechatRedfox(input, { apiKey, fetch: fetchImpl as unknown as FetchLike });
      writeHotspotCache(db, key, result);
      return result;
    } catch (error) {
      if (source === 'redfox') throw error;
      notice = `红狐公众号接口不可用（${error instanceof Error ? error.message : String(error)}），已改用联网搜索`;
    }
  } else if (source === 'auto') {
    notice = '还没有配置红狐 API Key，已改用联网搜索';
  }

  if (!normalized.keyword) throw new Error(`${notice ? `${notice}；` : ''}联网搜索需要关键词或内容方向`);
  const key = ['content', 'wechat', 'web', normalized.keyword, normalized.pageSize].join('|');
  const cached = input.refresh ? null : readHotspotCache(db, key);
  if (cached) return { ...cached, notice: notice || cached.notice };
  const notes = await searchBing(normalized.keyword, 'general');
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
    tips: '联网搜索结果没有公众号阅读与互动数据，只能看标题、摘要与内容方向；不能据此判断真实热度。'
  };
  writeHotspotCache(db, key, result);
  return result;
}
