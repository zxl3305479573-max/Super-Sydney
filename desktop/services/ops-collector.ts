import type { DatabaseSync } from 'node:sqlite';
import type {
  OpsMetricSnapshot,
  OpsPlatform,
  OpsSyncPlatformResult
} from '../shared.ts';
import { normalizeTitle } from './article-stats.ts';
import {
  OPS_PLATFORMS,
  OPS_PLATFORM_LABELS,
  OPS_PLATFORM_SET,
  appendOpsLog,
  listOpsEpisodesWithTasks,
  localDayString,
  saveOpsFollowers,
  saveOpsMetric,
  setOpsPlatformTask,
  type FollowerHistoryItem
} from './ops-store.ts';

/**
 * 创作者后台只读 DOM 采集器（严守 AGENTS.md 安全边界）：
 * - 仅在用户点击「同步后台数据 / 回抓链接」按钮时执行。
 * - 只读 WebContentsView 当前已渲染出来的 DOM（视频号含 wujie-app Shadow DOM），
 *   绝不在页面里调用 fetch 逆向私有接口、绝不自动滚动翻页。
 * - 遇到登录墙、扫码页或人机验证页立即中断，不尝试绕过。
 *
 * 本模块不直接 import electron，通过 DomInspector 接口抽象浏览器执行器，便于纯 Node 单元测试。
 */

export type DomInspector = <T>(
  platform: OpsPlatform,
  url: string,
  readyScript: string,
  extractScript: string,
  timeoutMs?: number
) => Promise<{ finalUrl: string; data: T }>;

export type RawFollowerDom = {
  barrier?: string;
  bodyText?: string;
  totalText?: string;
  todayNetText?: string;
  historyRows?: Array<{ day: string; total?: string; net?: string; gain?: string; loss?: string }>;
};

export type RawPostDomItem = {
  title: string;
  url?: string;
  scheduledText?: string;
  isScheduled?: boolean;
  views?: string;
  likes?: string;
  comments?: string;
  favorites?: string;
  shares?: string;
  recommend?: string;
};

export type RawPostsDom = {
  barrier?: string;
  bodyText?: string;
  items?: RawPostDomItem[];
};

/** 解析中文/英文计数："1.2万" / "3.5w" / "12,345" / "8.2k" -> 整数。 */
export function parseMetricNumber(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  const cleaned = String(raw ?? '').replace(/[,，\s+]/g, '').trim();
  if (!cleaned || /^[-—]+$/.test(cleaned)) return null;
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*(万|亿|w|k|m)?$/i);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  const unit = (match[2] ?? '').toLowerCase();
  const mult = unit === '万' || unit === 'w' ? 10_000 : unit === '亿' ? 100_000_000 : unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
  return Math.round(num * mult);
}

/** 识别登录重定向、扫码墙或验证码拦截页。 */
export function detectAccessBarrier(finalUrl: string, barrierHint = '', bodySample = ''): string {
  const url = (finalUrl || '').toLowerCase();
  if (/\/(login|passport|signin|sso|auth)(?:[/?#]|$)/i.test(url)) {
    return '创作者后台未登录，请先在发布窗口扫码登录';
  }
  if (/captcha|verify|sec_verify|security|waf/i.test(url)) {
    return '遇到平台安全验证页，已按安全策略停止读取，请在窗口内手动处理';
  }
  if (barrierHint) return barrierHint;
  const sample = (bodySample || '').slice(0, 600);
  if (/(扫码登录|请先登录|微信扫码登录|验证码登录|手机号登录)/.test(sample) && sample.length < 320) {
    return '创作者后台处于登录页，请先完成扫码登录';
  }
  if (/(滑动验证|安全验证|请完成下方验证|点选验证)/.test(sample)) {
    return '检测到人机验证弹窗，已停止自动读取';
  }
  return '';
}

/** 解析创作者后台已渲染粉丝 DOM 结构。 */
export function parseFollowerDom(platform: OpsPlatform, finalUrl: string, raw: RawFollowerDom | null | undefined): {
  error?: string;
  loginOk: boolean;
  total?: number;
  todayNet?: number | null;
  history?: FollowerHistoryItem[];
} {
  const barrier = detectAccessBarrier(finalUrl, raw?.barrier, raw?.bodyText);
  if (barrier) {
    return { loginOk: !/登录/.test(barrier), error: barrier };
  }
  const text = raw?.bodyText ?? '';
  let total = parseMetricNumber(raw?.totalText);

  if (total == null && text) {
    const patterns: Record<OpsPlatform, RegExp[]> = {
      douyin: [/粉丝\s*[：:|]?\s*([\d,.]+\s*[万亿wk]?)/i, /([\d,.]+\s*[万亿wk]?)\s*粉丝/i],
      shipinhao: [/关注者总数\s*\|\s*([\d,.]+\s*[万亿wk]?)/, /关注者\s*[：:|]?\s*([\d,.]+\s*[万亿wk]?)/],
      xiaohongshu: [/(?:总粉丝数?|当前粉丝数?|粉丝数)\s*[：:|]?\s*([\d,.]+\s*[万亿wk]?)/i, /粉丝\s*([\d,.]+\s*[万亿wk]?)/i],
      bilibili: [/粉丝(?:数|总数)?\s*[：:|]?\s*([\d,.]+\s*[万亿wk]?)/i]
    };
    for (const re of patterns[platform]) {
      const m = text.match(re);
      if (m) {
        total = parseMetricNumber(m[1]);
        if (total != null) break;
      }
    }
  }

  if (total == null) {
    return { loginOk: true, error: `${OPS_PLATFORM_LABELS[platform]}后台页面尚未渲染出粉丝数字，请确认已登录后重试` };
  }

  const todayNet = parseMetricNumber(raw?.todayNetText);
  const history: FollowerHistoryItem[] = [];

  for (const row of raw?.historyRows ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day)) continue;
    history.push({
      day: row.day,
      total: parseMetricNumber(row.total),
      net: parseMetricNumber(row.net),
      gain: parseMetricNumber(row.gain),
      loss: parseMetricNumber(row.loss)
    });
  }

  // 视频号关注者统计表常以 "2026/11/17 | 12 | 15 | 3 | 1,280" 形式渲染在 Shadow DOM 文本里
  if (platform === 'shipinhao' && !history.length && text) {
    for (const m of text.matchAll(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*\|\s*(-?[\d,]+)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)/g)) {
      history.push({
        day: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`,
        net: parseMetricNumber(m[4]),
        gain: parseMetricNumber(m[5]),
        loss: parseMetricNumber(m[6]),
        total: parseMetricNumber(m[7])
      });
    }
  }

  return { loginOk: true, total, todayNet, history };
}

function parseLooseTimestamp(text: string): number {
  const cleaned = (text || '').trim();
  if (!cleaned) return Number.NaN;
  const full = cleaned.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日\sT]+(\d{1,2}):(\d{2})/);
  if (full) {
    return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5])).getTime();
  }
  const parsed = Date.parse(cleaned);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** 比对计划发布时间与平台实际记录的定时时间（如视频号偶发自动偏移 +2 小时），超过 15 分钟报警。 */
export function checkScheduleDrift(plannedAt: string, platformRecordedAt: string): string {
  const plannedMs = parseLooseTimestamp(plannedAt);
  const actualMs = parseLooseTimestamp(platformRecordedAt);
  if (Number.isNaN(plannedMs) || Number.isNaN(actualMs)) return '';
  const diffMinutes = Math.round(Math.abs(actualMs - plannedMs) / 60_000);
  if (diffMinutes <= 15) return '';
  return `平台记录定时（${platformRecordedAt}）与计划（${plannedAt}）相差 ${diffMinutes} 分钟`;
}

function titleMatchesEpisode(renderedTitle: string, candidates: string[]): boolean {
  const normRendered = normalizeTitle(renderedTitle);
  if (!normRendered) return false;
  return candidates.some(candidate => {
    const normCand = normalizeTitle(candidate);
    if (!normCand) return false;
    if (normRendered === normCand) return true;
    const prefix = normCand.slice(0, Math.min(12, normCand.length));
    return prefix.length >= 5 && (normRendered.startsWith(prefix) || normCand.startsWith(normRendered.slice(0, Math.min(12, normRendered.length))));
  });
}

/* ── 各平台只读 DOM 脚本定义（无 fetch、无滚屏） ──────────────── */

const BARRIER_SNIPPET = `
  const pageText = (document.body?.innerText || '').trim();
  if (/(滑动验证|安全验证|请完成下方验证|点选验证)/.test(pageText)) {
    return { barrier: '检测到人机验证弹窗，已停止自动读取', bodyText: pageText.slice(0, 300) };
  }
`;

const WUJIE_SHADOW_WALKER = `
  const shadowText = () => {
    const root = document.querySelector('wujie-app')?.shadowRoot;
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (parent && /STYLE|SCRIPT|NOSCRIPT/.test(parent.tagName)) continue;
      const val = (node.textContent || '').trim().replace(/\\s+/g, ' ');
      if (val) parts.push(val);
    }
    return parts.join(' | ');
  };
`;

const PLATFORM_DOM_SPECS: Record<OpsPlatform, {
  followerUrl: string;
  followerReady: string;
  followerExtract: string;
  postsUrl: string;
  postsReady: string;
  postsExtract: string;
}> = {
  bilibili: {
    followerUrl: 'https://member.bilibili.com/platform/home',
    followerReady: `Boolean((document.body?.innerText || '').match(/粉丝|扫码登录|密码登录/))`,
    followerExtract: `(() => {
      ${BARRIER_SNIPPET}
      return { bodyText: pageText.slice(0, 3000) };
    })()`,
    postsUrl: 'https://member.bilibili.com/platform/upload-manager/article',
    postsReady: `Boolean(document.querySelectorAll('.article-card, .video-card, [class*="arc-card"], a[href*="bilibili.com/video/BV"]').length || (document.body?.innerText || '').match(/暂无稿件|登录/))`,
    postsExtract: `(() => {
      ${BARRIER_SNIPPET}
      const cards = Array.from(document.querySelectorAll('.article-card, [class*="article-card"], [class*="video-item"], .cc-article-wrp > div'));
      const items = cards.slice(0, 30).map(card => {
        const text = (card.innerText || '').trim();
        const linkEl = card.querySelector('a[href*="bilibili.com/video/BV"], a[href*="/video/BV"]');
        const title = (linkEl?.innerText || card.querySelector('[class*="title"]')?.innerText || text.split('\\n')[0] || '').trim();
        const href = linkEl?.href || '';
        const getNum = re => ((text.match(re) || [])[1] || '');
        const sched = (text.match(/(?:定时发布|将于)\\s*([\\d-: /]+)/) || [])[1] || '';
        return {
          title,
          url: href.startsWith('http') ? href.split('?')[0] : '',
          isScheduled: /定时/.test(text),
          scheduledText: sched,
          views: getNum(/(?:播放|观看)\\s*([\\d,.万w]+)/i) || ((card.querySelector('[title*="播放"]')?.innerText || '').trim()),
          likes: getNum(/(?:点赞|赞)\\s*([\\d,.万w]+)/i) || ((card.querySelector('[title*="点赞"]')?.innerText || '').trim()),
          comments: getNum(/(?:评论)\\s*([\\d,.万w]+)/i) || ((card.querySelector('[title*="评论"]')?.innerText || '').trim()),
          favorites: getNum(/(?:收藏)\\s*([\\d,.万w]+)/i) || ((card.querySelector('[title*="收藏"]')?.innerText || '').trim()),
          shares: getNum(/(?:分享)\\s*([\\d,.万w]+)/i) || ((card.querySelector('[title*="分享"]')?.innerText || '').trim())
        };
      }).filter(item => item.title);
      return { bodyText: pageText.slice(0, 1200), items };
    })()`
  },
  douyin: {
    followerUrl: 'https://creator.douyin.com/creator-micro/home',
    followerReady: `Boolean((document.body?.innerText || '').match(/粉丝|扫码登录|验证码登录/))`,
    followerExtract: `(() => {
      ${BARRIER_SNIPPET}
      return { bodyText: pageText.slice(0, 3000) };
    })()`,
    postsUrl: 'https://creator.douyin.com/creator-micro/content/manage',
    postsReady: `Boolean(document.querySelectorAll('[class*="video-card"], [class*="content-item"]').length || (document.body?.innerText || '').match(/暂无作品|扫码登录/))`,
    postsExtract: `(() => {
      ${BARRIER_SNIPPET}
      const cards = Array.from(document.querySelectorAll('[class*="video-card-info"], [class*="video-card"]'));
      const items = cards.slice(0, 30).map(card => {
        const text = (card.innerText || '').trim();
        const title = (card.querySelector('[class*="info-title"], [class*="title"]')?.innerText || text.split('\\n')[0] || '').trim();
        const linkEl = card.querySelector('a[href*="douyin.com/video/"]');
        const nums = Array.from(card.querySelectorAll('[class*="metric"], [class*="stat"], [class*="number"]')).map(el => (el.innerText || '').trim()).filter(Boolean);
        const sched = (text.match(/定时发布[：:\\s]*([\\d-: /]+)/) || [])[1] || '';
        return {
          title,
          url: linkEl ? linkEl.href.split('?')[0] : '',
          isScheduled: /定时发布/.test(text),
          scheduledText: sched,
          views: ((text.match(/(?:播放|观看)[量数]?\\s*([\\d,.万w]+)/) || [])[1]) || nums[0] || '',
          likes: ((text.match(/点赞\\s*([\\d,.万w]+)/) || [])[1]) || nums[1] || '',
          comments: ((text.match(/评论\\s*([\\d,.万w]+)/) || [])[1]) || nums[2] || '',
          favorites: ((text.match(/收藏\\s*([\\d,.万w]+)/) || [])[1]) || nums[3] || '',
          shares: ((text.match(/分享\\s*([\\d,.万w]+)/) || [])[1]) || nums[4] || ''
        };
      }).filter(item => item.title);
      return { bodyText: pageText.slice(0, 1200), items };
    })()`
  },
  xiaohongshu: {
    followerUrl: 'https://creator.xiaohongshu.com/statistics/fans-data',
    followerReady: `Boolean((document.body?.innerText || '').match(/粉丝|登录|验证/))`,
    followerExtract: `(() => {
      ${BARRIER_SNIPPET}
      return { bodyText: pageText.slice(0, 3000) };
    })()`,
    postsUrl: 'https://creator.xiaohongshu.com/new/note-manager',
    postsReady: `Boolean(document.querySelectorAll('.note-card, [class*="note-item"]').length || (document.body?.innerText || '').match(/暂无笔记|登录|验证/))`,
    postsExtract: `(() => {
      ${BARRIER_SNIPPET}
      const cards = Array.from(document.querySelectorAll('.note-card'));
      const items = cards.slice(0, 30).map(card => {
        const title = (card.querySelector('.note-card__title, [class*="title"]')?.innerText || '').trim();
        let noteId = '';
        try { noteId = JSON.parse(card.getAttribute('data-impression') || '{}')?.noteTarget?.value?.noteId || ''; } catch {}
        const stats = Array.from(card.querySelectorAll('.note-card__stat')).map(el => (el.innerText || '').trim());
        const text = (card.innerText || '').trim();
        return {
          title,
          url: noteId ? 'https://www.xiaohongshu.com/explore/' + noteId : '',
          isScheduled: /定时发布/.test(text),
          scheduledText: ((text.match(/定时发布\\s*([\\d-: /]+)/) || [])[1] || ''),
          views: stats[0] || '',
          comments: stats[1] || '',
          likes: stats[2] || '',
          favorites: stats[3] || '',
          shares: stats[4] || ''
        };
      }).filter(item => item.title);
      return { bodyText: pageText.slice(0, 1200), items };
    })()`
  },
  shipinhao: {
    followerUrl: 'https://channels.weixin.qq.com/platform/statistic/follower',
    followerReady: `(() => {
      const root = document.querySelector('wujie-app')?.shadowRoot;
      const text = root ? (root.innerHTML || '') : (document.body?.innerText || '');
      return /关注者总数|扫码登录|微信扫码/.test(text);
    })()`,
    followerExtract: `(() => {
      ${BARRIER_SNIPPET}
      ${WUJIE_SHADOW_WALKER}
      const st = shadowText();
      return { bodyText: (st || pageText).slice(0, 4000) };
    })()`,
    postsUrl: 'https://channels.weixin.qq.com/platform/post/list',
    postsReady: `(() => {
      const root = document.querySelector('wujie-app')?.shadowRoot;
      if (root && root.querySelectorAll('.post-feed-item').length > 0) return true;
      return /扫码登录|暂无动态/.test(document.body?.innerText || '');
    })()`,
    postsExtract: `(() => {
      ${BARRIER_SNIPPET}
      const root = document.querySelector('wujie-app')?.shadowRoot;
      if (!root) return { bodyText: pageText.slice(0, 1200), items: [] };
      const cards = Array.from(root.querySelectorAll('.post-feed-item'));
      const items = cards.slice(0, 30).map(card => {
        const text = (card.innerText || '').trim();
        const title = text.split('\\n')[0]?.trim() || '';
        const metrics = {};
        for (const item of Array.from(card.querySelectorAll('.data-item'))) {
          const html = item.innerHTML || '';
          const val = (item.innerText || '').trim();
          if (/eyes/.test(html)) metrics.views = val;
          else if (/outlined-like/.test(html)) metrics.likes = val;
          else if (/comment/.test(html)) metrics.comments = val;
          else if (/icon-share/.test(html)) metrics.shares = val;
          else if (/thumb/.test(html)) metrics.recommend = val;
        }
        const sched = (text.match(/定时发表[：:\\s]*([\\d-: /年日月]+)/) || [])[1] || '';
        return {
          title,
          url: '',
          isScheduled: /定时发表|将于/.test(text),
          scheduledText: sched,
          views: metrics.views || '',
          likes: metrics.likes || '',
          comments: metrics.comments || '',
          shares: metrics.shares || '',
          recommend: metrics.recommend || ''
        };
      }).filter(item => item.title);
      return { bodyText: (root.innerText || pageText).slice(0, 1200), items };
    })()`
  }
};

export function matchAndSaveRenderedPosts(
  db: DatabaseSync,
  platform: OpsPlatform,
  rawPosts: RawPostDomItem[],
  today = localDayString(),
  now = new Date().toISOString()
): { matchedPosts: number; linkedUrls: number; scheduleWarnings: string[] } {
  const episodes = listOpsEpisodesWithTasks(db);
  let matchedPosts = 0;
  let linkedUrls = 0;
  const scheduleWarnings: string[] = [];

  for (const episode of episodes) {
    const task = episode.tasks.find(item => item.platform === platform);
    if (task?.state === 'skipped') continue;
    const candidates = [task?.filledTitle ?? '', episode.title].filter(Boolean);
    const matched = rawPosts.find(post => titleMatchesEpisode(post.title, candidates));
    if (!matched) continue;

    matchedPosts += 1;
    const nextState = matched.isScheduled ? 'scheduled' : 'published';
    let warning = '';
    if (matched.scheduledText && episode.scheduledAt) {
      warning = checkScheduleDrift(episode.scheduledAt, matched.scheduledText);
      if (warning) scheduleWarnings.push(`${OPS_PLATFORM_LABELS[platform]}《${episode.title}》：${warning}`);
    }

    const hadUrl = Boolean(task?.postUrl);
    if (matched.url && !hadUrl) linkedUrls += 1;

    setOpsPlatformTask(db, episode.id, platform, nextState, {
      postUrl: matched.url || undefined,
      platformSchedule: matched.scheduledText || undefined,
      detail: warning || (matched.isScheduled ? `已定时：${matched.scheduledText}` : '已在创作者后台核对上线')
    }, now);

    const snapshot: OpsMetricSnapshot = {
      views: parseMetricNumber(matched.views),
      likes: parseMetricNumber(matched.likes),
      comments: parseMetricNumber(matched.comments),
      favorites: parseMetricNumber(matched.favorites),
      shares: parseMetricNumber(matched.shares),
      extra: matched.recommend ? { 推荐: parseMetricNumber(matched.recommend) } : undefined
    };
    if (Object.values(snapshot).some(val => typeof val === 'number')) {
      saveOpsMetric(db, episode.id, platform, snapshot, today, now);
    }
  }

  return { matchedPosts, linkedUrls, scheduleWarnings };
}

export async function syncOpsPlatforms(
  db: DatabaseSync,
  inspector: DomInspector,
  requestedPlatforms?: OpsPlatform[] | null,
  today = localDayString()
): Promise<OpsSyncPlatformResult[]> {
  const targets = (requestedPlatforms?.length ? requestedPlatforms : OPS_PLATFORMS)
    .filter(item => OPS_PLATFORM_SET.has(item));

  const results: OpsSyncPlatformResult[] = [];
  for (const platform of targets) {
    const spec = PLATFORM_DOM_SPECS[platform];
    try {
      const followerPage = await inspector<RawFollowerDom>(
        platform,
        spec.followerUrl,
        spec.followerReady,
        spec.followerExtract
      );
      const parsedFollower = parseFollowerDom(platform, followerPage.finalUrl, followerPage.data);
      if (!parsedFollower.loginOk || parsedFollower.error) {
        const errMsg = parsedFollower.error || '未能读取粉丝数据';
        appendOpsLog(db, null, platform, '同步后台数据', errMsg);
        results.push({
          platform,
          loginOk: parsedFollower.loginOk,
          followers: null,
          backfilledDays: 0,
          matchedPosts: 0,
          linkedUrls: 0,
          scheduleWarnings: [],
          error: errMsg
        });
        continue;
      }

      const backfilledDays = saveOpsFollowers(db, platform, {
        total: parsedFollower.total!,
        todayNet: parsedFollower.todayNet,
        history: parsedFollower.history
      }, today);

      const postsPage = await inspector<RawPostsDom>(
        platform,
        spec.postsUrl,
        spec.postsReady,
        spec.postsExtract
      );
      const postsBarrier = detectAccessBarrier(postsPage.finalUrl, postsPage.data?.barrier, postsPage.data?.bodyText);
      let matchedPosts = 0;
      let linkedUrls = 0;
      let scheduleWarnings: string[] = [];
      if (!postsBarrier && Array.isArray(postsPage.data?.items)) {
        const postSummary = matchAndSaveRenderedPosts(db, platform, postsPage.data.items, today);
        matchedPosts = postSummary.matchedPosts;
        linkedUrls = postSummary.linkedUrls;
        scheduleWarnings = postSummary.scheduleWarnings;
      }

      appendOpsLog(
        db,
        null,
        platform,
        '同步后台数据',
        `粉丝 ${parsedFollower.total}（补历史 ${backfilledDays} 天），匹配作品 ${matchedPosts} 条，回填链接 ${linkedUrls} 条`
      );
      results.push({
        platform,
        loginOk: true,
        followers: parsedFollower.total!,
        backfilledDays,
        matchedPosts,
        linkedUrls,
        scheduleWarnings,
        error: postsBarrier || ''
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOpsLog(db, null, platform, '同步后台异常', message);
      results.push({
        platform,
        loginOk: !/登录/.test(message),
        followers: null,
        backfilledDays: 0,
        matchedPosts: 0,
        linkedUrls: 0,
        scheduleWarnings: [],
        error: message
      });
    }
  }
  return results;
}
