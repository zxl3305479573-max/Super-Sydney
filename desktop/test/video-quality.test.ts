import test from 'node:test';
import assert from 'node:assert/strict';
import type { VideoProject } from '../shared.ts';
import { evaluateVideoQuality } from '../services/video-quality.ts';
import { VIDEO_RENDER_DEFAULTS, emptyRenderAssets } from '../services/video-production.ts';
import { serializeVideoShots } from '../services/video-pipeline.ts';

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
  seconds: 40, width: 1080, height: 1920, fps: '30/1', videoCodec: 'h264', hasAudio: true, ...patch
});

test('抖音竖屏成片通过基础质量检查', () => {
  const report = evaluateVideoQuality(project(), probe(), 'video.mp4');
  assert.equal(report.ok, true);
  assert.equal(report.checks.every(check => check.status === 'ok'), true);
});

test('B 站项目使用横屏画布并通过检查', () => {
  const report = evaluateVideoQuality(project({
    platform: 'bilibili',
    storyboardJson: serializeVideoShots([{ index: 1, seconds: 40, visual: '画面', narration: '', caption: '' }])
  }), probe({ width: 1920, height: 1080 }), 'video.mp4');
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.key === 'dimensions')?.status, 'ok');
});

test('尺寸不符合平台规格时检查失败', () => {
  const report = evaluateVideoQuality(project(), probe({ width: 1920, height: 1080 }), 'video.mp4');
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.key === 'dimensions')?.status, 'error');
  assert.equal(report.checks.find(check => check.key === 'aspect')?.status, 'error');
});

test('需要旁白但没有音频轨道时检查失败', () => {
  const report = evaluateVideoQuality(project({
    options: { ...VIDEO_RENDER_DEFAULTS, voiceMode: 'tts', bgmMode: 'none' },
    storyboardJson: serializeVideoShots([{ index: 1, seconds: 40, visual: '画面', narration: '这一镜需要旁白', caption: '' }])
  }), probe({ hasAudio: false }), 'video.mp4');
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.key === 'audio')?.status, 'error');
});

test('时长偏差超过百分之二十时给出警告', () => {
  const report = evaluateVideoQuality(project(), probe({ seconds: 55 }), 'video.mp4');
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.key === 'duration')?.status, 'warn');
});

test('静音且关闭 BGM 的项目允许没有音频轨道', () => {
  const report = evaluateVideoQuality(project(), probe({ hasAudio: false }), 'video.mp4');
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.key === 'audio')?.status, 'ok');
});
