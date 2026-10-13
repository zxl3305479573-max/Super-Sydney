/**
 * 来源记录的纯解析与校验。
 *
 * 单独成文件是因为渲染进程也要用它（正文末尾的「来源与证据」预览），
 * 而 content-export 里带着 node:fs / node:path，不能进浏览器包。
 */

/**
 * status：user_provided 是用户录入的资料；ai_suggested 是生成证据计划时模型推荐的权威公开资料（不带链接、未联网核实）。
 * featured：用户勾选「列入正文末尾」。读者在文末只看到精选的几条，其余来源只留在工作台与知识库笔记里。
 */
export type ContentSourceStatus = 'user_provided' | 'ai_suggested';
export type ContentSourceRecord = { title: string; url: string; excerpt: string; status: ContentSourceStatus; featured: boolean };

/** 正文末尾展示给读者的来源条数。 */
export const FEATURED_SOURCE_LIMIT = 3;

/**
 * 选出正文末尾要列的来源：先取用户勾选的（按录入顺序，最多3条）；
 * 勾选不足3条时用其余来源补齐——优先有链接的，其次有摘录的，同等条件保持录入顺序。
 */
export function pickFeaturedSources<T extends { url: string; excerpt: string; featured?: boolean }>(sources: T[], limit = FEATURED_SOURCE_LIMIT): T[] {
  const marked = sources.filter(source => source.featured).slice(0, limit);
  if (marked.length >= limit) return marked;
  const score = (source: T) => (source.url.trim() ? 2 : 0) + (source.excerpt.trim() ? 1 : 0);
  const rest = sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => !marked.includes(source))
    .sort((a, b) => score(b.source) - score(a.source) || a.index - b.index)
    .slice(0, limit - marked.length)
    .map(({ source }) => source);
  // 输出按录入顺序排，读者看到的编号与工作台里的顺序一致。
  const chosen = new Set([...marked, ...rest]);
  return sources.filter(source => chosen.has(source));
}

/** 记录来源不等于已联网验证：状态只可能是「用户提供」或「AI 推荐」，不接受外部声称的 verified。 */
export function parseContentSources(value: string): ContentSourceRecord[] {
  if (!value.trim()) return [];
  let data: unknown;
  try { data = JSON.parse(value); } catch { throw new Error('来源记录不是有效 JSON'); }
  if (!data || typeof data !== 'object' || !('sources' in data) || !Array.isArray(data.sources)) throw new Error('来源记录必须包含 sources 数组');
  if (data.sources.length > 50) throw new Error('每篇文章最多记录50份来源');
  return data.sources.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('来源格式不正确');
    const record = item as Record<string, unknown>;
    for (const key of ['title', 'url', 'excerpt']) if (typeof record[key] !== 'string') throw new Error('来源的标题、链接、摘录必须是文本');
    const title = (record.title as string).trim();
    const url = (record.url as string).trim();
    const excerpt = (record.excerpt as string).trim();
    if (url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('来源链接格式不正确'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('来源链接只允许不含凭证的 HTTP/HTTPS 地址');
    }
    if (!title && !url && !excerpt) throw new Error('来源不能全部为空');
    if (title.length > 500 || url.length > 4000 || excerpt.length > 20000) throw new Error('来源内容过长，请缩短摘录');
    return { title, url, excerpt, status: record.status === 'ai_suggested' ? 'ai_suggested' as const : 'user_provided' as const, featured: record.featured === true };
  });
}

/**
 * 把模型推荐的来源并入已有来源：用户录入的原样保留在前，上一轮的 AI 推荐整体替换。
 * 旧数据解析失败时只保留新推荐，不让一条脏数据挡住生成。
 */
export function mergeSuggestedSources(existingJson: string, suggested: ContentSourceRecord[]): string {
  let existing: ContentSourceRecord[] = [];
  try { existing = parseContentSources(existingJson); } catch { existing = []; }
  const kept = existing.filter(source => source.status === 'user_provided');
  const titles = new Set(kept.map(source => source.title));
  const fresh = suggested.filter(source => !titles.has(source.title));
  return JSON.stringify({ sources: [...kept, ...fresh].slice(0, 50) });
}
