import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { VideoProject } from '../shared.ts';
import { migrateOpsTables } from '../services/ops-store.ts';
import { serializeVideoShots } from '../services/video-pipeline.ts';
import { VIDEO_RENDER_DEFAULTS, emptyRenderAssets } from '../services/video-production.ts';
import {
  buildBilibiliChapters,
  generateAiVideoPublishPack,
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
    neutralCopy: '一段中性基础文案，用于多平台改写。',
    copies: parsed,
    variants: { '3:4': 'D:/covers/3x4.jpg', '16:9': 'D:/covers/16x9.jpg' }
  });
  assert.equal(saved.scheduledAt, '2026-11-20 19:30');
  assert.equal(saved.neutralCopy, '一段中性基础文案，用于多平台改写。');
  assert.equal(saved.copies.douyin.title, '早起别急着下床！');
  assert.equal(saved.variants['16:9'], 'D:/covers/16x9.jpg');
  assert.equal(getVideoPublishPack(db, project).copies.xiaohongshu.coverRatio, '3:4');
});

test('旧库 ops_video_publish_packs 自动迁移 neutral_copy 列，且 AI 可仅凭中性文案生成四平台差异化文案', async () => {
  const db = new DatabaseSync(':memory:');
  // 模拟升级前的旧表结构（无 neutral_copy 列）
  db.exec(`
    CREATE TABLE ops_video_publish_packs (
      project_id INTEGER PRIMARY KEY,
      scheduled_at TEXT NOT NULL DEFAULT '',
      copies_json TEXT NOT NULL DEFAULT '{}',
      variants_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
  `);
  migrateOpsTables(db);

  const directProject: VideoProject = {
    ...sampleProject(),
    id: 19,
    title: '',
    topic: '',
    script: '',
    storyboardJson: '',
    options: { ...VIDEO_RENDER_DEFAULTS, workflow: 'direct-upload' }
  };

  await assert.rejects(
    () => generateAiVideoPublishPack(directProject, { apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm' }),
    /请先输入中性文案/
  );

  let capturedBody = '';
  const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capturedBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '以下是生成结果：\n```json\n' + JSON.stringify({
            douyin: { title: '一个工具把四平台文案全搞定', body: '剪好视频不用手写四遍文案了！', tags: ['#效率工具', '自媒体'] },
            shipinhao: { title: '效率工具', body: '适合平时要做多平台更新的朋友。', tags: ['效率分享'] },
            xiaohongshu: { title: '打工人亲测好用的多平台发文方式', body: '以前每发一条视频都要重写四份标题，现在只写一段中性文案就行。', tags: ['自媒体工具', '效率'] },
            bilibili: { title: '【实战演示】上传本地视频+中性文案一键生成四平台分发草稿', body: '本期演示如何用本地桌面端完成多平台适配。', tags: ['工具推荐'] }
          }) + '\n```'
        }
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const generated = await generateAiVideoPublishPack(
    directProject,
    { apiKey: 'test-key', baseUrl: 'https://api.example.com/v1', model: 'test-model' },
    {
      neutralCopy: '本地桌面效率助手演示：上传剪好的视频、封面和中性文案，自动适配抖音、视频号、小红书和B站。',
      existingCopies: {
        douyin: { title: '', body: '', tags: [], coverRatio: '9:16', skip: false }
      },
      fetchImpl: mockFetch
    }
  );

  assert.match(capturedBody, /中性基础文案/);
  assert.equal(generated.douyin.coverRatio, '9:16');
  assert.deepEqual(generated.douyin.tags, ['效率工具', '自媒体']);
  assert.ok(Array.from(generated.shipinhao.title).length >= 6);
  assert.ok(Array.from(generated.shipinhao.title).length <= 16);
  assert.doesNotMatch(generated.bilibili.body, /【章节时间轴】/);

  const saved = saveVideoPublishPack(db, directProject, {
    neutralCopy: '中性测试文案',
    copies: generated
  });
  assert.equal(saved.neutralCopy, '中性测试文案');
  assert.equal(getVideoPublishPack(db, directProject).neutralCopy, '中性测试文案');
});
