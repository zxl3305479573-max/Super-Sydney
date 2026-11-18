import type { DatabaseSync } from 'node:sqlite';
import type {
  OpsEpisode,
  OpsEpisodePlatformReview,
  OpsEpisodeReview,
  OpsMetricRecord,
  OpsOverviewView,
  OpsPlatform,
  OpsPlatformBoardCard
} from '../shared.ts';
import { listArticleStats } from './article-stats-store.ts';
import {
  OPS_PLATFORMS,
  OPS_PLATFORM_LABELS,
  getOpsEpisodeWithTasks,
  listEpisodeMetrics,
  listOpsEpisodesWithTasks,
  listOpsFollowers,
  listRecentOpsLogs,
  localDayString
} from './ops-store.ts';

/**
 * 跨平台运营大屏聚合与单期「同龄对比」复盘。
 *
 * 借鉴麦田 review.mjs 的核心思想：不拿刚发 1 天的新作品和发了 30 天的老作品比绝对播放，
 * 而是按「发布后第 N 天」对齐上一期的同期样本，计算各平台播放占比、互动率与涨粉贡献。
 */

function parseDayMs(day: string): number {
  const match = day.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function addDays(day: string, delta: number): string {
  const base = parseDayMs(day);
  if (Number.isNaN(base)) return day;
  const target = new Date(base + delta * 86_400_000);
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(target.getUTCDate()).padStart(2, '0')}`;
}

export function diffDays(fromDay: string, toDay: string): number {
  const from = parseDayMs(fromDay);
  const to = parseDayMs(toDay);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

export function anchorDayOfEpisode(episode: Pick<OpsEpisode, 'scheduledAt' | 'createdAt'>): string {
  const raw = (episode.scheduledAt || episode.createdAt || '').trim();
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  return localDayString(raw || Date.now());
}

function pickMilestoneDay(ageDays: number): number {
  if (ageDays >= 7) return 7;
  if (ageDays >= 3) return 3;
  return 1;
}

/** 在一批按日记录里，挑出每个平台最接近 targetDay（容差 maxDriftDays 天内）的一条指标。 */
function pickMetricsAtDay(
  records: OpsMetricRecord[],
  targetDay: string,
  maxDriftDays = 2
): { byPlatform: Map<OpsPlatform, OpsMetricRecord>; matchedDay: string; exact: boolean } {
  const byPlatform = new Map<OpsPlatform, OpsMetricRecord>();
  if (!records.length) return { byPlatform, matchedDay: targetDay, exact: true };

  let bestDay = '';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const record of records) {
    const distance = Math.abs(diffDays(targetDay, record.day));
    if (distance < bestDistance || (distance === bestDistance && record.day > bestDay)) {
      bestDistance = distance;
      bestDay = record.day;
    }
  }
  if (bestDistance > maxDriftDays) {
    return { byPlatform, matchedDay: targetDay, exact: false };
  }

  for (const platform of OPS_PLATFORMS) {
    const candidates = records.filter(item => item.platform === platform);
    if (!candidates.length) continue;
    const sorted = [...candidates].sort((a, b) => {
      const da = Math.abs(diffDays(bestDay, a.day));
      const dbDist = Math.abs(diffDays(bestDay, b.day));
      return da !== dbDist ? da - dbDist : b.day.localeCompare(a.day);
    });
    if (Math.abs(diffDays(targetDay, sorted[0].day)) <= maxDriftDays) {
      byPlatform.set(platform, sorted[0]);
    }
  }
  return { byPlatform, matchedDay: bestDay, exact: bestDistance === 0 };
}

function computePeriodFollowerGain(db: DatabaseSync, startDay: string, endDay: string): number {
  let totalGain = 0;
  for (const platform of OPS_PLATFORMS) {
    const rows = listOpsFollowers(db, platform, 90)
      .filter(item => item.day >= addDays(startDay, -1) && item.day <= endDay)
      .sort((a, b) => a.day.localeCompare(b.day));
    if (rows.length >= 2) {
      totalGain += rows[rows.length - 1].total - rows[0].total;
    } else if (rows.length === 1 && rows[0].day >= startDay && rows[0].net != null) {
      totalGain += rows[0].net;
    }
  }
  return totalGain;
}

export function buildEpisodeReview(
  db: DatabaseSync,
  episodeId: number,
  requestedAgeDays?: number,
  today = localDayString()
): OpsEpisodeReview {
  const episode = getOpsEpisodeWithTasks(db, episodeId);
  const startDay = anchorDayOfEpisode(episode);
  const naturalAge = Math.max(1, diffDays(startDay, today) + (startDay === today ? 1 : 0));
  const ageDays = requestedAgeDays !== undefined && requestedAgeDays > 0 ? Math.round(requestedAgeDays) : naturalAge;
  const reviewTargetDay = requestedAgeDays !== undefined ? addDays(startDay, Math.max(0, ageDays - 1)) : today;

  const currentRecords = listEpisodeMetrics(db, episode.id);
  const latestDay = currentRecords.length ? currentRecords[currentRecords.length - 1].day : reviewTargetDay;
  const effectiveDay = requestedAgeDays !== undefined ? reviewTargetDay : latestDay;
  const currentPick = pickMetricsAtDay(currentRecords, effectiveDay, requestedAgeDays !== undefined ? 2 : 365);

  // 找上一期（早于本期且有采集样本的最近一期），对齐同样的 ageDays 做同龄对比
  const allEpisodes = listOpsEpisodesWithTasks(db);
  const currentAnchorMs = parseDayMs(startDay);
  const prevCandidate = allEpisodes.find(other => {
    if (other.id === episode.id) return false;
    const otherAnchor = parseDayMs(anchorDayOfEpisode(other));
    const earlier = !Number.isNaN(otherAnchor) && !Number.isNaN(currentAnchorMs)
      ? otherAnchor < currentAnchorMs || (otherAnchor === currentAnchorMs && other.id < episode.id)
      : other.id < episode.id;
    return earlier && listEpisodeMetrics(db, other.id).length > 0;
  }) ?? null;

  let prevPick: ReturnType<typeof pickMetricsAtDay> | null = null;
  let comparisonNote = '暂无上一期历史样本，从下一期开始自动生成同龄对比';
  if (prevCandidate) {
    const prevStart = anchorDayOfEpisode(prevCandidate);
    const prevTargetDay = addDays(prevStart, Math.max(0, ageDays - 1));
    const prevRecords = listEpisodeMetrics(db, prevCandidate.id);
    prevPick = pickMetricsAtDay(prevRecords, prevTargetDay, 3);
    if (prevPick.byPlatform.size > 0) {
      const prevActualAge = Math.max(1, diffDays(prevStart, prevPick.matchedDay) + 1);
      comparisonNote = prevPick.exact
        ? `对比上一期「${prevCandidate.title}」发布第 ${ageDays} 天同期数据`
        : `对比上一期「${prevCandidate.title}」第 ${prevActualAge} 天邻近样本`;
    } else {
      comparisonNote = `上一期「${prevCandidate.title}」缺少第 ${ageDays} 天附近的采样记录`;
    }
  }

  const taskMap = new Map(episode.tasks.map(task => [task.platform, task]));
  let totalViews = 0;
  let totalInteractions = 0;
  for (const platform of OPS_PLATFORMS) {
    const m = currentPick.byPlatform.get(platform);
    if (!m) continue;
    totalViews += m.views ?? 0;
    totalInteractions += (m.likes ?? 0) + (m.comments ?? 0) + (m.favorites ?? 0) + (m.shares ?? 0);
  }

  let prevTotalViews: number | null = null;
  if (prevPick && prevPick.byPlatform.size > 0) {
    prevTotalViews = 0;
    for (const m of prevPick.byPlatform.values()) prevTotalViews += m.views ?? 0;
  }

  const platforms: OpsEpisodePlatformReview[] = OPS_PLATFORMS.map(platform => {
    const task = taskMap.get(platform);
    const cur = currentPick.byPlatform.get(platform);
    const prev = prevPick?.byPlatform.get(platform);
    const views = cur?.views ?? null;
    const likes = cur?.likes ?? null;
    const comments = cur?.comments ?? null;
    const favorites = cur?.favorites ?? null;
    const shares = cur?.shares ?? null;
    const interactions = (likes ?? 0) + (comments ?? 0) + (favorites ?? 0) + (shares ?? 0);
    const engageRate = views && views > 0 ? interactions / views : null;
    const viewShare = totalViews > 0 && views != null ? views / totalViews : null;
    const prevSameAgeViews = prev?.views ?? null;
    const viewsDeltaRatio = views != null && prevSameAgeViews != null && prevSameAgeViews > 0
      ? (views - prevSameAgeViews) / prevSameAgeViews
      : null;

    return {
      platform,
      label: OPS_PLATFORM_LABELS[platform],
      state: task?.state ?? 'planned',
      postUrl: task?.postUrl ?? '',
      views,
      likes,
      comments,
      favorites,
      shares,
      engageRate,
      viewShare,
      prevSameAgeViews,
      viewsDeltaRatio
    };
  });

  const overallEngageRate = totalViews > 0 ? totalInteractions / totalViews : null;
  const totalViewsDeltaRatio = prevTotalViews != null && prevTotalViews > 0
    ? (totalViews - prevTotalViews) / prevTotalViews
    : null;

  return {
    episode: {
      id: episode.id,
      sourceType: episode.sourceType,
      sourceId: episode.sourceId,
      title: episode.title,
      scheduledAt: episode.scheduledAt,
      notes: episode.notes,
      createdAt: episode.createdAt,
      updatedAt: episode.updatedAt
    },
    ageDays,
    milestoneDay: pickMilestoneDay(ageDays),
    reviewDay: currentPick.matchedDay || effectiveDay,
    totalViews,
    totalInteractions,
    overallEngageRate,
    periodFollowerGain: computePeriodFollowerGain(db, startDay, currentPick.matchedDay || effectiveDay),
    prevEpisodeTitle: prevCandidate?.title ?? '',
    prevTotalViews,
    totalViewsDeltaRatio,
    comparisonNote,
    platforms
  };
}

function summarizeExternalModules(db: DatabaseSync): OpsOverviewView['externalSummary'] {
  let wechatArticles = 0;
  let wechatTotalReads = 0;
  try {
    const articles = listArticleStats(db);
    wechatArticles = articles.length;
    for (const item of articles) {
      wechatTotalReads += item.metrics.reads ?? item.metrics.readUsers ?? 0;
    }
  } catch { /* 公众号统计表未初始化时按 0 处理 */ }

  let xhsNotes = 0;
  let xhsTotalViews = 0;
  let xhsTotalLikes = 0;
  try {
    const rows = db.prepare('SELECT metrics_json FROM xhs_note_stats').all() as Array<{ metrics_json: string }>;
    xhsNotes = rows.length;
    for (const row of rows) {
      const parsed = JSON.parse(row.metrics_json || '{}') as Record<string, unknown>;
      if (typeof parsed.views === 'number') xhsTotalViews += parsed.views;
      if (typeof parsed.likes === 'number') xhsTotalLikes += parsed.likes;
    }
  } catch { /* 小红书统计表未初始化时按 0 处理 */ }

  return { wechatArticles, wechatTotalReads, xhsNotes, xhsTotalViews, xhsTotalLikes };
}

export function buildOpsOverview(db: DatabaseSync, today = localDayString()): OpsOverviewView {
  const episodes = listOpsEpisodesWithTasks(db);
  const weekAgo = addDays(today, -7);

  const platforms: OpsPlatformBoardCard[] = OPS_PLATFORMS.map(platform => {
    const history = listOpsFollowers(db, platform, 30).sort((a, b) => a.day.localeCompare(b.day));
    const latest = history[history.length - 1] ?? null;
    const prevDay = history.length >= 2 ? history[history.length - 2] : null;
    const todayNet = latest
      ? latest.day === today && latest.net != null
        ? latest.net
        : prevDay && latest.day === today
          ? latest.total - prevDay.total
          : 0
      : null;

    const baselineWeek = history.find(item => item.day >= weekAgo) ?? history[0] ?? null;
    const weekNet = latest && baselineWeek && baselineWeek.day < latest.day
      ? latest.total - baselineWeek.total
      : todayNet;

    let publishedCount = 0;
    let draftCount = 0;
    for (const episode of episodes) {
      const task = episode.tasks.find(item => item.platform === platform);
      if (task?.state === 'published') publishedCount += 1;
      else if (task?.state === 'draft' || task?.state === 'scheduled') draftCount += 1;
    }

    return {
      platform,
      label: OPS_PLATFORM_LABELS[platform],
      totalFollowers: latest?.total ?? null,
      todayNet,
      weekNet,
      recentTrend: history.slice(-14).map(item => ({ day: item.day, total: item.total })),
      lastCollectedAt: latest?.collectedAt ?? '',
      publishedCount,
      draftCount
    };
  });

  const totalFollowers = platforms.reduce((sum, item) => sum + (item.totalFollowers ?? 0), 0);
  const todayNetFollowers = platforms.reduce((sum, item) => sum + (item.todayNet ?? 0), 0);
  const weekNetFollowers = platforms.reduce((sum, item) => sum + (item.weekNet ?? 0), 0);

  const latestWithData = episodes.find(ep =>
    ep.tasks.some(t => t.state === 'published' || t.state === 'draft' || t.state === 'scheduled')
    || listEpisodeMetrics(db, ep.id).length > 0
  ) ?? episodes[0] ?? null;

  return {
    platforms,
    totalFollowers,
    todayNetFollowers,
    weekNetFollowers,
    latestEpisode: latestWithData ? buildEpisodeReview(db, latestWithData.id, undefined, today) : null,
    externalSummary: summarizeExternalModules(db),
    episodes,
    recentLogs: listRecentOpsLogs(db, 30)
  };
}
