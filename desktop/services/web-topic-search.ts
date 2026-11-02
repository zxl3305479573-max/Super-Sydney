import type { VideoPlatform, XhsHotNote } from '../shared.ts';
import { fingerprint } from './xhs-pipeline.ts';

/** Shared public web search parsing used by independent content workflows. */
export const BING_EXTRACT_SCRIPT = `(() => Array.from(document.querySelectorAll('li.b_algo')).slice(0, 20).map(li => {
  const a = li.querySelector('h2 a');
  const p = li.querySelector('.b_caption p, p');
  return { title: a ? a.textContent.trim() : '', url: a ? a.href : '', snippet: p ? p.textContent.trim() : '' };
}))()`;

export function bingSearchUrls(keyword: string, platform: VideoPlatform = 'xiaohongshu'): string[] {
  const word = keyword.trim();
  const queries = platform === 'douyin'
    ? [`抖音 ${word} 热门视频`, `抖音 ${word}`]
    : platform === 'shipinhao'
      ? [`视频号 ${word} 热门视频`, `微信视频号 ${word}`]
      : platform === 'bilibili'
        ? [`B站 ${word} 热门视频`, `哔哩哔哩 ${word}`]
        : platform === 'general'
          ? [`${word} 短视频 热门`, `${word}`]
          : [`小红书 ${word} 爆款笔记`, `小红书 ${word}`];
  return queries.map(query => `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`);
}

export function normalizeWebResults(rows: unknown, limit = 20): XhsHotNote[] {
  const seen = new Set<string>();
  return (Array.isArray(rows) ? rows : []).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const url = String(row.url ?? '').trim().slice(0, 2000);
    const title = String(row.title ?? '').trim().slice(0, 100);
    if (!title || !/^https?:\/\//.test(url) || seen.has(url)) return [];
    seen.add(url);
    let snippet = String(row.snippet ?? '').trim().slice(0, 400);
    const date = snippet.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s*[·•]\s*/);
    if (date) snippet = snippet.slice(date[0].length);
    return [{
      id: `web-${fingerprint(url)}`, title, desc: snippet, cover: '', link: url,
      createTime: date ? `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}` : '',
      topics: [], author: { id: '', nickname: (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '网页'; } })(), fans: 0 },
      interactive: 0, liked: 0, collected: 0, comments: 0, shared: 0, score: null, unverified: true
    }];
  }).slice(0, limit);
}
