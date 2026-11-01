import test from 'node:test';
import assert from 'node:assert/strict';
import type { VideoProject } from '../shared.ts';
import { evaluateVideoQuality, parseDetectionIntervals, type VideoQualityExtras } from '../services/video-quality.ts';
import { VIDEO_RENDER_DEFAULTS, emptyRenderAssets } from '../services/video-production.ts';
import { isQualityFresh, qualityBlockingIssues, qualitySignature, renderSignature, serializeVideoShots } from '../services/video-pipeline.ts';

function project(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 1, platform: 'douyin', topic: '', title: '', audience: '', durationSeconds: 40, status: 'storyboard',
    topicsJson: '', script: '', storyboardJson: serializeVideoShots([{ index: 1, seconds: 40, visual: '画面', narration: '', caption: '' }]),
    coverPath: '', exportPath: '', createdAt: '', updatedAt: '',
    options: { ...VIDEO_RENDER_DEFAULTS, voiceMode: 'silent' },
    assets: emptyRenderAssets(),
    ...patch
  };
}

const probe = (patch: Partial<Parameters<typeof evaluateVideoQuality>[1]> = {}) => ({
  seconds: 40, width: 1080, height: 1920, fps: '30/1', videoCodec: 'h264', hasAudio: true,
  videoStartTime: 0, videoDuration: 40, audioStartTime: 0, audioDuration: 40, ...patch
});

const extras = (patch: Partial<VideoQualityExtras> = {}): VideoQualityExtras => ({
  content: { blackSeconds: 0, blackSegments: 0, silenceSeconds: 0, silenceSegments: 0 },
  ...patch
});

test('抖音竖屏成片通过完整质量检查', () => {
  const report = evaluateVideoQuality(project(), probe(), 'video.mp4', extras());
  assert.equal(report.ok, true);
  assert.equal(report.checks.every(check => check.status === 'ok'), true);
});

test('B 站项目使用横屏画布并通过检查', () => {
  const report = evaluateVideoQuality(project({
    platform: 'bilibili',
    storyboardJson: serializeVideoShots([{ index: 1, seconds: 40, visual: '画面', narration: '', caption: '' }])
  }), probe({ width: 1920, height: 1080 }), 'video.mp4', extras());
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.key === 'dimensions')?.status, 'ok');
});

test('尺寸不符合平台规格时检查失败', () => {
  const report = evaluateVideoQuality(project(), probe({ width: 1920, height: 1080 }), 'video.mp4', extras());
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.key === 'dimensions')?.status, 'error');
  assert.equal(report.checks.find(check => check.key === 'aspect')?.status, 'error');
});

test('需要旁白但没有音频轨道时检查失败', () => {
  const report = evaluateVideoQuality(project({
    options: { ...VIDEO_RENDER_DEFAULTS, voiceMode: 'tts', bgmMode: 'none' },
    storyboardJson: serializeVideoShots([{ index: 1, seconds: 40, visual: '画面', narration: '这一镜需要旁白', caption: '' }])
  }), probe({ hasAudio: false }), 'video.mp4', extras());
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.key === 'audio')?.status, 'error');
});

test('时长偏差超过百分之二十时给出警告', () => {
  const report = evaluateVideoQuality(project(), probe({ seconds: 55, videoDuration: 55, audioDuration: 55 }), 'video.mp4', extras());
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.key === 'duration')?.status, 'warn');
});

test('静音且关闭 BGM 的项目允许没有音频轨道', () => {
  const report = evaluateVideoQuality(project(), probe({ hasAudio: false }), 'video.mp4', extras());
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.key === 'audio')?.status, 'ok');
  assert.equal(report.checks.find(check => check.key === 'timeline')?.status, 'ok');
});

test('黑帧和静音标记能解析成总时长与段数', () => {
  const log = `
    black_start:0 black_end:0.5 black_duration:0.5
    black_start:9.5 black_end:10 black_duration:0.5
    silence_start: 0
    silence_end: 1.25
    silence_start: 9
  `;
  assert.deepEqual(parseDetectionIntervals(log, 'black', 10), { seconds: 1, segments: 2 });
  assert.deepEqual(parseDetectionIntervals(log, 'silence', 10), { seconds: 2.25, segments: 2 });
});

test('大面积黑帧和全静音会成为硬错误', () => {
  const report = evaluateVideoQuality(project(), probe(), 'video.mp4', extras({
    content: { blackSeconds: 39, blackSegments: 1, silenceSeconds: 40, silenceSegments: 1 }
  }));
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.key === 'black')?.status, 'error');
  assert.equal(report.checks.find(check => check.key === 'silence')?.status, 'error');
});

test('音画起止偏差过大时阻止交付', () => {
  const report = evaluateVideoQuality(project(), probe({ audioStartTime: 0.8, audioDuration: 38.5 }), 'video.mp4', extras());
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.key === 'timeline')?.status, 'error');
});

test('封面比例错误会阻止交付，分辨率偏低只给警告', () => {
  const wrong = evaluateVideoQuality(project({ coverPath: 'cover.png' }), probe(), 'video.mp4', extras({ cover: { width: 1920, height: 1080 } }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.checks.find(check => check.key === 'cover')?.status, 'error');
  const small = evaluateVideoQuality(project({ coverPath: 'cover.png' }), probe(), 'video.mp4', extras({ cover: { width: 576, height: 1024 } }));
  assert.equal(small.ok, true);
  assert.equal(small.checks.find(check => check.key === 'cover')?.status, 'warn');
});

test('外部 Skill 成片的安全区只能提示人工抽查', () => {
  const report = evaluateVideoQuality(project({
    options: { ...VIDEO_RENDER_DEFAULTS, workflow: 'footage-edit' }
  }), probe(), 'video.mp4', extras());
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.key === 'safe-area')?.status, 'warn');
});

test('质量报告绑定当前成片、平台和封面', () => {
  const base = project();
  const rendered = {
    ...base,
    assets: {
      ...emptyRenderAssets(),
      video: { path: 'video.mp4', signature: renderSignature(base), seconds: 40, renderedAt: '' }
    }
  };
  const report = evaluateVideoQuality(rendered, probe(), 'video.mp4', extras());
  const checked = { ...rendered, assets: { ...rendered.assets, quality: report } };
  assert.equal(report.signature, qualitySignature(rendered));
  assert.equal(isQualityFresh({ ...checked, assets: { ...checked.assets, video: { ...checked.assets.video!, signature: 'render-b' } } }), false);
  assert.equal(isQualityFresh({ ...checked, coverPath: 'new-cover.png' }), false);
});

test('只有质量错误阻止交付，警告保留给用户判断', () => {
  const base = project();
  const rendered = {
    ...base,
    assets: {
      ...emptyRenderAssets(),
      video: { path: 'video.mp4', signature: renderSignature(base), seconds: 40, renderedAt: '' }
    }
  };
  const warning = evaluateVideoQuality(rendered, probe(), 'video.mp4', extras({
    content: { blackSeconds: 5, blackSegments: 1, silenceSeconds: 0, silenceSegments: 0 }
  }));
  assert.equal(warning.ok, true);
  assert.deepEqual(qualityBlockingIssues({ ...rendered, assets: { ...rendered.assets, quality: warning } }), []);
  const error = evaluateVideoQuality(rendered, probe(), 'video.mp4', extras({
    content: { blackSeconds: 39, blackSegments: 1, silenceSeconds: 0, silenceSegments: 0 }
  }));
  assert.match(qualityBlockingIssues({ ...rendered, assets: { ...rendered.assets, quality: error } }).join(), /黑帧/);
});
