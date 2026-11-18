import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  checkScheduleDrift,
  detectAccessBarrier,
  parseFollowerDom,
  parseMetricNumber,
  syncOpsPlatforms,
  type DomInspector
} from '../services/ops-collector.ts';
import {
  getOpsPlatformTask,
  listEpisodeMetrics,
  listOpsFollowers,
  migrateOpsTables,
  upsertOpsEpisode
} from '../services/ops-store.ts';

test('parseMetricNumber 与 detectAccessBarrier 识别万/w计数及登录墙/验证拦截', () => {
  assert.equal(parseMetricNumber('1.25万'), 12500);
  assert.equal(parseMetricNumber('3.4w'), 34000);
  assert.equal(parseMetricNumber('1,280'), 1280);
  assert.equal(parseMetricNumber('--'), null);

  assert.match(detectAccessBarrier('https://creator.douyin.com/passport/login'), /未登录/);
  assert.match(detectAccessBarrier('https://creator.xiaohongshu.com/new/note-manager', '', '请完成下方验证 滑动验证'), /人机验证/);
  assert.equal(detectAccessBarrier('https://member.bilibili.com/platform/home', '', '粉丝 3,420 播放 8.9万'), '');
});

test('parseFollowerDom 解析视频号 Shadow DOM 关注者总数与 7 日历史回填行', () => {
  const shadow = '数据概览 | 关注者总数 | 2,350 | 趋势明细 | 2026/11/17 | 15 | 18 | 3 | 2,335 | 2026/11/16 | 10 | 12 | 2 | 2,320';
  const res = parseFollowerDom('shipinhao', 'https://channels.weixin.qq.com/platform/statistic/follower', { bodyText: shadow });
  assert.equal(res.loginOk, true);
  assert.equal(res.total, 2350);
  assert.equal(res.history?.length, 2);
  assert.equal(res.history?.[0].day, '2026-11-17');
  assert.equal(res.history?.[0].total, 2335);
});

test('checkScheduleDrift 发现超过 15 分钟的定时偏移时给出告警', () => {
  assert.equal(checkScheduleDrift('2026-11-20 18:00', '2026-11-20 18:05'), '');
  assert.match(checkScheduleDrift('2026-11-20 18:00', '2026-11-20 20:00'), /相差 120 分钟/);
});

test('syncOpsPlatforms 完成只读 DOM 粉丝采集、作品链接回填、指标入库与未登录中断', async () => {
  const db = new DatabaseSync(':memory:');
  migrateOpsTables(db);
  const ep = upsertOpsEpisode(db, {
    sourceType: 'video',
    sourceId: 9,
    title: '冬季护膝黄金三步法',
    scheduledAt: '2026-11-20 18:00'
  });

  const inspector: DomInspector = async (platform, url) => {
    if (platform === 'douyin') {
      return { finalUrl: 'https://creator.douyin.com/login', data: { bodyText: '扫码登录' } as never };
    }
    if (url.includes('platform/home')) {
      return { finalUrl: url, data: { bodyText: '创作首页 粉丝数 4,580' } as never };
    }
    return {
      finalUrl: url,
      data: {
        bodyText: '稿件管理',
        items: [{
          title: '冬季护膝黄金三步法',
          url: 'https://www.bilibili.com/video/BV1xx411c7mD',
          isScheduled: false,
          views: '1.6万',
          likes: '820',
          comments: '64',
          favorites: '310',
          shares: '45'
        }]
      } as never
    };
  };

  const results = await syncOpsPlatforms(db, inspector, ['douyin', 'bilibili'], '2026-11-18');
  assert.equal(results.length, 2);

  const douyin = results.find(item => item.platform === 'douyin')!;
  assert.equal(douyin.loginOk, false);
  assert.match(douyin.error, /未登录/);

  const bili = results.find(item => item.platform === 'bilibili')!;
  assert.equal(bili.loginOk, true);
  assert.equal(bili.followers, 4580);
  assert.equal(bili.matchedPosts, 1);
  assert.equal(bili.linkedUrls, 1);

  assert.equal(listOpsFollowers(db, 'bilibili', 5)[0]?.total, 4580);
  assert.equal(getOpsPlatformTask(db, ep.id, 'bilibili')?.postUrl, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(getOpsPlatformTask(db, ep.id, 'bilibili')?.state, 'published');
  assert.equal(listEpisodeMetrics(db, ep.id)[0]?.views, 16000);
});
