import type { XhsHotNote, XhsPageRead, XhsProfileRead } from '../shared.ts';
import { fingerprint } from './xhs-pipeline.ts';
import { parseCount } from './xhs-hotspot.ts';

/**
 * 页面读取的纯逻辑：在页面里执行的抽取脚本（只读已渲染的 DOM），以及抽取结果的归一化。
 *
 * 红线（与设计草案一致）：只读页面上已经显示出来的内容，不调内部接口、不逆向签名、不自动滚动翻页；
 * 遇到登录墙或验证页就停，交给用户在窗口里处理。抽取结果按「不可信数据」处理，逐字段校验与截断。
 */

/**
 * 在小红书页面里执行的抽取脚本。返回纯数据（JSON 可序列化）。
 * 选择器按 2026-10 的网页版结构：笔记卡片 section.note-item，主页 .user-name / .user-desc / .user-interactions。
 * 读不到时尽量退化而不是报错，最终由 normalizePageRead 判断是不是「什么都没读到」。
 */
export const XHS_PAGE_EXTRACT_SCRIPT = `(() => {
  const text = el => (el && el.textContent || '').replace(/\\s+/g, ' ').trim();
  const cards = Array.from(document.querySelectorAll('section.note-item')).slice(0, 60).map(card => {
    const link = card.querySelector('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]');
    const cover = card.querySelector('a.cover img, img');
    return {
      href: link ? link.href : '',
      title: text(card.querySelector('.title span, .title, .footer .title')),
      author: text(card.querySelector('.author .name, .name')),
      authorHref: (card.querySelector('a.author, .author-wrapper a') || {}).href || '',
      likes: text(card.querySelector('.like-wrapper .count, .count')),
      cover: cover ? cover.src || '' : '',
      video: Boolean(card.querySelector('.play-icon'))
    };
  });
  const interactions = Array.from(document.querySelectorAll('.user-interactions > div')).map(text);
  return {
    url: location.href,
    title: document.title,
    loginWall: Boolean(document.querySelector('.login-modal, .login-container')),
    captcha: /captcha|verify|security/i.test(location.pathname) || Boolean(document.querySelector('.captcha-container, #captcha, .red-captcha')),
    cards,
    profile: document.querySelector('.user-name') ? {
      name: text(document.querySelector('.user-name')),
      redId: text(document.querySelector('.user-redId')),
      bio: text(document.querySelector('.user-desc')),
      interactions
    } : null
  };
})()`;

export type RawPageExtract = {
  url?: unknown; title?: unknown; loginWall?: unknown; captcha?: unknown;
  cards?: unknown;
  profile?: { name?: unknown; redId?: unknown; bio?: unknown; interactions?: unknown } | null;
};

const str = (value: unknown, max = 300) => (typeof value === 'string' ? value.trim() : '').slice(0, max);

export function isXhsHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)xiaohongshu\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

function noteIdFrom(href: string): string {
  const match = href.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-f]{16,32})/i) ?? href.match(/\/user\/profile\/[0-9a-f]+\/([0-9a-f]{24})/i);
  return match ? match[1] : '';
}

/** 「10+ 粉丝」「1万+ 获赞与收藏」→ 数字（取下限）。 */
function interactionCount(lines: string[], label: RegExp): number {
  const line = lines.find(item => label.test(item)) ?? '';
  const match = line.match(/(\d+(?:\.\d+)?\s*[万wW]?)/);
  return match ? parseCount(match[1].replace(/\s/g, '')) : 0;
}

/** 抽取结果 → 统一形状；登录墙 / 验证页且没有任何内容时抛出，提示用户去窗口里处理。 */
export function normalizePageRead(raw: RawPageExtract): XhsPageRead {
  const url = str(raw.url, 2000);
  const cards = Array.isArray(raw.cards) ? raw.cards : [];
  const seen = new Set<string>();
  const notes: XhsHotNote[] = cards.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const card = item as Record<string, unknown>;
    const href = str(card.href, 2000);
    const title = str(card.title, 100);
    // 未登录时主页卡片不给笔记 id（链接只是 /explore/）：用标题生成 id、链接指回当前页，诊断只需要标题与点赞。
    if (href && !isXhsHost(href)) return [];
    const realId = noteIdFrom(href);
    const id = realId || (title && isXhsHost(url) ? `page-${fingerprint(title)}` : '');
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const liked = parseCount(str(card.likes, 20));
    const authorHref = str(card.authorHref, 2000);
    return [{
      id, title: title || '无标题', desc: '', cover: str(card.cover, 2000), link: realId ? href : url, createTime: '', topics: card.video === true ? ['视频'] : [],
      author: { id: (authorHref.match(/\/user\/profile\/([0-9a-f]+)/i) ?? [])[1] ?? '', nickname: str(card.author, 40) || '未知', fans: 0 },
      interactive: liked, liked, collected: 0, comments: 0, shared: 0, score: null
    }];
  });
  let profile: XhsProfileRead | null = null;
  if (raw.profile && typeof raw.profile === 'object' && str(raw.profile.name)) {
    const lines = Array.isArray(raw.profile.interactions) ? raw.profile.interactions.map(line => str(line, 60)) : [];
    profile = {
      name: str(raw.profile.name, 60),
      redId: str(raw.profile.redId, 60).replace(/^小红书号[:：]\s*/, ''),
      bio: str(raw.profile.bio, 300),
      fans: interactionCount(lines, /粉丝/),
      follows: interactionCount(lines, /关注/),
      likesAndCollects: interactionCount(lines, /获赞|收藏/)
    };
  }
  const blocked = raw.captcha === true || (raw.loginWall === true && !notes.length && !profile);
  if (blocked) throw new Error(raw.captcha === true ? '小红书要求完成安全验证：请在窗口里自己完成验证后再点读取' : '这个页面需要登录才能看到内容：请在窗口里自己登录后再点读取');
  if (!notes.length && !profile) throw new Error('当前页面没有读到笔记或主页信息：打开搜索结果页、发现页或博主主页后再读取（页面结构变化时也会这样）');
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  const kind: XhsPageRead['kind'] = profile ? 'profile' : path.startsWith('/search_result') ? 'search' : path.startsWith('/explore') ? 'feed' : 'other';
  return { url, kind, notes, profile };
}

/* ── 联网搜索（必应结果页）兜底 ─────────────────────────────── */

/** 在必应结果页里执行的抽取脚本。 */
export const BING_EXTRACT_SCRIPT = `(() => Array.from(document.querySelectorAll('li.b_algo')).slice(0, 20).map(li => {
  const a = li.querySelector('h2 a');
  const p = li.querySelector('.b_caption p, p');
  return { title: a ? a.textContent.trim() : '', url: a ? a.href : '', snippet: p ? p.textContent.trim() : '' };
}))()`;

export function bingSearchUrls(keyword: string): string[] {
  const word = keyword.trim();
  return [`小红书 ${word} 爆款笔记`, `小红书 ${word}`].map(query => `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`);
}

/**
 * 必应结果 → 热点条目：没有互动数据，统一标 unverified；
 * 摘要开头「2026年2月21日 ·」这类日期提出来当发布时间，必应跳转链接保留原样。
 */
export function normalizeWebResults(rows: unknown, limit = 20): XhsHotNote[] {
  const seen = new Set<string>();
  return (Array.isArray(rows) ? rows : []).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const url = str(row.url, 2000);
    const title = str(row.title, 100);
    if (!title || !/^https?:\/\//.test(url) || seen.has(url)) return [];
    seen.add(url);
    let snippet = str(row.snippet, 400);
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
