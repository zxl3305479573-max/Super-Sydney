import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateArticleStatTables, upsertArticleStats } from '../services/article-stats-store.ts';
import { emptyMetrics } from '../services/article-stats.ts';
import { buildEpisodeReview, buildOpsOverview } from '../services/ops-review.ts';
import { migrateOpsTables, saveOpsFollowers, saveOpsMetric, setOpsPlatformTask, upsertOpsEpisode } from '../services/ops-store.ts';
import { migrateXhsTables } from '../services/xhs-store.ts';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateOpsTables(db);
  migrateArticleStatTables(db);
  migrateXhsTables(db);
  return db;
}

test('buildEpisodeReview 对齐上一期同龄样本，计算播放占比、互动率与同期涨粉', () => {
  const db = database();

  // 第 1 期：2026-11-10 发布，第 3 天（2026-11-12）样本
  const ep1 = upsertOpsEpisode(db, {
    sourceType: 'video',
    sourceId: 1,
    title: '第 1 期：膝盖保暖误区',
    scheduledAt: '2026-11-10 18:00'
  }, '2026-11-10T10:00:00.000Z');
  saveOpsMetric(db, ep1.id, 'douyin', { views: 2000, likes: 100, comments: 20, favorites: 30, shares: 10 }, '2026-11-12');
  saveOpsMetric(db, ep1.id, 'bilibili', { views: 1000, likes: 80, comments: 15, favorites: 40, shares: 5 }, '2026-11-12');
  // 第 7 天的更高数据（不应在算第 3 天同龄对比时误拿）
  saveOpsMetric(db, ep1.id, 'douyin', { views: 9000, likes: 400, comments: 50, favorites: 100, shares: 30 }, '2026-11-16');

  // 第 2 期：2026-11-16 发布，今天 2026-11-18 是第 3 天
  const ep2 = upsertOpsEpisode(db, {
    sourceType: 'video',
    sourceId: 2,
    title: '第 2 期：早晨拉伸三个动作',
    scheduledAt: '2026-11-16 18:00'
  }, '2026-11-16T10:00:00.000Z');
  setOpsPlatformTask(db, ep2.id, 'douyin', 'published', { postUrl: 'https://www.douyin.com/video/2' });
  saveOpsMetric(db, ep2.id, 'douyin', { views: 3000, likes: 180, comments: 30, favorites: 60, shares: 30 }, '2026-11-18');
  saveOpsMetric(db, ep2.id, 'bilibili', { views: 1500, likes: 120, comments: 20, favorites: 60, shares: 25 }, '2026-11-18');

  saveOpsFollowers(db, 'douyin', { total: 5000 }, '2026-11-15');
  saveOpsFollowers(db, 'douyin', { total: 5120, todayNet: 50 }, '2026-11-18');

  const review = buildEpisodeReview(db, ep2.id, 3, '2026-11-18');
  assert.equal(review.ageDays, 3);
  assert.equal(review.milestoneDay, 3);
  assert.equal(review.totalViews, 4500);
  assert.equal(review.prevTotalViews, 3000);
  assert.ok(Math.abs((review.totalViewsDeltaRatio ?? 0) - 0.5) < 1e-6);
  assert.equal(review.periodFollowerGain, 120);
  assert.match(review.comparisonNote, /第 1 期：膝盖保暖误区.*第 3 天/);

  const douyin = review.platforms.find(item => item.platform === 'douyin')!;
  assert.ok(Math.abs((douyin.viewShare ?? 0) - 3000 / 4500) < 1e-6);
  assert.ok(Math.abs((douyin.engageRate ?? 0) - 300 / 3000) < 1e-6);
  assert.ok(Math.abs((douyin.viewsDeltaRatio ?? 0) - 0.5) < 1e-6);
});

test('buildOpsOverview 聚合跨平台粉丝净增以及公众号/小红书已有数据', () => {
  const db = database();
  saveOpsFollowers(db, 'douyin', { total: 2000 }, '2026-11-11');
  saveOpsFollowers(db, 'douyin', { total: 2150, todayNet: 35 }, '2026-11-18');
  saveOpsFollowers(db, 'shipinhao', { total: 800, todayNet: 12 }, '2026-11-18');

  upsertArticleStats(db, [{
    title: '冬季血压管理指南',
    publishDate: '2026-11-15',
    metrics: { ...emptyMetrics(), reads: 1680 }
  }], 'wechat.xlsx');

  const overview = buildOpsOverview(db, '2026-11-18');
  assert.equal(overview.totalFollowers, 2950);
  assert.equal(overview.todayNetFollowers, 47);
  assert.equal(overview.weekNetFollowers, 162);
  assert.equal(overview.externalSummary.wechatArticles, 1);
  assert.equal(overview.externalSummary.wechatTotalReads, 1680);
});
