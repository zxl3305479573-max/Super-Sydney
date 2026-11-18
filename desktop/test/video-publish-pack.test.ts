import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { VideoProject } from '../shared.ts';
import { migrateOpsTables } from '../services/ops-store.ts';
import { serializeVideoShots } from '../services/video-pipeline.ts';
import { VIDEO_RENDER_DEFAULTS, emptyRenderAssets } from '../services/video-production.ts';
import {
  buildBilibiliChapters,
  getVideoPublishPack,
  normalizeShipinhaoTitle,
  parseGeneratedPublishPackJson,
  saveVideoPublishPack
} from '../services/video-publish-pack.ts';

function sampleProject(): VideoProject {
  return {
    id: 7,
    platform: 'douyin',
    topic: '晨起护膝',
    title: '晨起三分钟护膝法',
    audience: '中老年朋友',
    durationSeconds: 45,
    status: 'storyboard',
    topicsJson: '',
    script: '早上起床别急着下地，先活动膝关节。',
    storyboardJson: serializeVideoShots([
      { index: 1, seconds: 15, visual: '坐床边', narration: '第一步坐稳', caption: '坐床边慢抬腿' },
      { index: 2, seconds: 30, visual: '缓慢屈伸', narration: '第二步屈伸十次', caption: '勾脚尖激活股四头肌' }
    ]),
    coverPath: '',
    exportPath: '',
    options: { ...VIDEO_RENDER_DEFAULTS },
    assets: emptyRenderAssets(),
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z'
  };
}

test('buildBilibiliChapters 自动生成分镜时间轴，视频号短标题自动补足 6–16 字', () => {
  const project = sampleProject();
  const chapters = buildBilibiliChapters(project);
  assert.match(chapters, /00:00 坐床边慢抬腿/);
  assert.match(chapters, /00:15 勾脚尖激活股四头肌/);

  assert.ok(Array.from(normalizeShipinhaoTitle('护膝')).length >= 6);
  assert.ok(Array.from(normalizeShipinhaoTitle('这是一个超过十六个字限制的超长视频号标题测试')).length <= 16);
});

test('parseGeneratedPublishPackJson 解析模型 JSON 并拼入 B 站章节，saveVideoPublishPack 持久化读写', () => {
  const db = new DatabaseSync(':memory:');
  migrateOpsTables(db);
  const project = sampleProject();

  const parsed = parseGeneratedPublishPackJson(JSON.stringify({
    douyin: { title: '早起别急着下床！', body: '膝盖发僵先做这两步', tags: ['#护膝', '中老年健康'] },
    shipinhao: { title: '早起三分钟温和护膝操', body: '转给家里长辈看一看', tags: ['关节养护'] },
    xiaohongshu: { title: '陪爸妈练了一周的晨起护膝动作', body: '最近降温膝盖容易发紧，分享两个床边动作', tags: ['长辈健康'] },
    bilibili: { title: '中老年晨起膝盖发僵？床边 2 个温和动作讲解', body: '本期详细拆解起床前如何唤醒膝关节。', tags: ['健康科普'] }
  }), project);

  assert.deepEqual(parsed.douyin.tags, ['护膝', '中老年健康']);
  assert.match(parsed.bilibili.body, /【章节时间轴】/);

  const saved = saveVideoPublishPack(db, project, {
    scheduledAt: '2026-11-20 19:30',
    copies: parsed,
    variants: { '3:4': 'D:/covers/3x4.jpg', '16:9': 'D:/covers/16x9.jpg' }
  });
  assert.equal(saved.scheduledAt, '2026-11-20 19:30');
  assert.equal(saved.copies.douyin.title, '早起别急着下床！');
  assert.equal(saved.variants['16:9'], 'D:/covers/16x9.jpg');
  assert.equal(getVideoPublishPack(db, project).copies.xiaohongshu.coverRatio, '3:4');
});
