import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  appendOpsLog,
  deleteOpsEpisode,
  findOpsEpisodeBySource,
  getOpsPlatformTask,
  hasNotifiedMilestone,
  isOpsStateLocked,
  listEpisodeMetrics,
  listOpsEpisodesWithTasks,
  listOpsFollowers,
  listRecentOpsLogs,
  markMilestoneNotified,
  migrateOpsTables,
  saveOpsFollowers,
  saveOpsMetric,
  setOpsPlatformTask,
  upsertOpsEpisode
} from '../services/ops-store.ts';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateOpsTables(db);
  return db;
}

test('upsertOpsEpisode 按来源幂等复用同一条计划，并初始化四平台任务', () => {
  const db = database();
  const created = upsertOpsEpisode(db, {
    sourceType: 'video',
    sourceId: 42,
    title: '护膝科普第 1 期',
    scheduledAt: '2026-11-20 18:00'
  }, '2026-11-18T10:00:00.000Z');
  assert.equal(created.tasks.length, 4);
  assert.equal(created.tasks.every(task => task.state === 'planned'), true);

  const reused = upsertOpsEpisode(db, {
    sourceType: 'video',
    sourceId: 42,
    title: '护膝科普第 1 期（修订）'
  }, '2026-11-18T11:00:00.000Z');
  assert.equal(reused.id, created.id);
  assert.equal(reused.title, '护膝科普第 1 期（修订）');
  assert.equal(reused.scheduledAt, '2026-11-20 18:00');
  assert.equal(findOpsEpisodeBySource(db, 'video', 42)?.id, created.id);
  assert.equal(listOpsEpisodesWithTasks(db).length, 1);
});

test('平台任务状态转换、防重锁判定与线上链接保留', () => {
  const db = database();
  const ep = upsertOpsEpisode(db, { title: '测试视频' });
  assert.equal(isOpsStateLocked('planned'), false);
  assert.equal(isOpsStateLocked('failed'), false);
  assert.equal(isOpsStateLocked('draft'), true);
  assert.equal(isOpsStateLocked('scheduled'), true);
  assert.equal(isOpsStateLocked('published'), true);

  const changed = setOpsPlatformTask(db, ep.id, 'douyin', 'draft', {
    detail: '草稿已填好',
    filledTitle: '抖音短标题'
  });
  assert.equal(changed, true);

  setOpsPlatformTask(db, ep.id, 'douyin', 'published', {
    postUrl: 'https://www.douyin.com/video/123456'
  });
  const task = getOpsPlatformTask(db, ep.id, 'douyin')!;
  assert.equal(task.state, 'published');
  assert.equal(task.filledTitle, '抖音短标题');
  assert.equal(task.postUrl, 'https://www.douyin.com/video/123456');

  appendOpsLog(db, ep.id, 'douyin', '回抓链接', task.postUrl);
  assert.equal(listRecentOpsLogs(db, 10, ep.id).length, 1);

  assert.equal(hasNotifiedMilestone(db, ep.id, 3), false);
  markMilestoneNotified(db, ep.id, 3);
  assert.equal(hasNotifiedMilestone(db, ep.id, 3), true);

  deleteOpsEpisode(db, ep.id);
  assert.equal(listOpsEpisodesWithTasks(db).length, 0);
});

test('saveOpsFollowers 优先保留实测 live 记录，并支持按每日净增倒推历史总数', () => {
  const db = database();
  saveOpsFollowers(db, 'bilibili', { total: 1000, todayNet: 10 }, '2026-11-16');

  const backfilled = saveOpsFollowers(db, 'bilibili', {
    total: 1050,
    todayNet: 20,
    history: [
      { day: '2026-11-17', net: 30 },
      { day: '2026-11-16', net: 999 } // 已有 live 记录，不应被 backfill 覆盖
    ]
  }, '2026-11-18');

  assert.equal(backfilled, 1);
  const rows = listOpsFollowers(db, 'bilibili', 10);
  const byDay = new Map(rows.map(row => [row.day, row]));
  assert.equal(byDay.get('2026-11-18')?.total, 1050);
  assert.equal(byDay.get('2026-11-17')?.total, 1030);
  assert.equal(byDay.get('2026-11-17')?.source, 'backfill');
  assert.equal(byDay.get('2026-11-16')?.total, 1000);
  assert.equal(byDay.get('2026-11-16')?.source, 'live');
});

test('saveOpsMetric 同时落盘日度聚合与时间戳样本', () => {
  const db = database();
  const ep = upsertOpsEpisode(db, { title: '指标测试' });
  saveOpsMetric(db, ep.id, 'xiaohongshu', {
    views: 3200,
    likes: 180,
    comments: 25,
    favorites: 95,
    shares: 12
  }, '2026-11-18', '2026-11-18T12:00:00.000Z');

  const metrics = listEpisodeMetrics(db, ep.id);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].views, 3200);
  assert.equal(metrics[0].favorites, 95);
});
