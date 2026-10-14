import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivitySegmenter, isSelfWindow, normalizeWindowTitle } from '../services/activity-segment.ts';

test('strips browser suffix, spinner glyphs and app-name-only titles', () => {
  assert.equal(normalizeWindowTitle('Google Chrome', 'Aileader｜AI 订阅与数字服务商城 - Google Chrome'), 'Aileader｜AI 订阅与数字服务商城');
  assert.equal(normalizeWindowTitle('Windows Terminal Host', '✳ 图片压缩至 1M 以内'), '图片压缩至 1M 以内');
  assert.equal(normalizeWindowTitle('Windows Terminal Host', '◑ 图片压缩至 1M 以内'), '图片压缩至 1M 以内');
  assert.equal(normalizeWindowTitle('QQ', 'QQ'), '');
  assert.equal(normalizeWindowTitle('Code', '(3) main.ts - Code'), '(3) main.ts');
});

test('recognises the app\'s own window', () => {
  assert.ok(isSelfWindow('Sydney · 个人工作 OS'));
  assert.ok(!isSelfWindow('Sydney - Google Chrome'));
});

test('one-off samples are dropped; a sustained window becomes one growing event', () => {
  const segmenter = new ActivitySegmenter();
  const gap = 75_000;
  assert.deepEqual(segmenter.observe('A', 0, gap), { type: 'none' });
  assert.deepEqual(segmenter.observe('B', 30_000, gap), { type: 'none' });
  assert.deepEqual(segmenter.observe('B', 60_000, gap), { type: 'insert', startedAt: 30_000, durationSeconds: 30 });
  segmenter.attach(7);
  assert.deepEqual(segmenter.observe('B', 90_000, gap), { type: 'update', eventId: 7, durationSeconds: 60 });
  assert.deepEqual(segmenter.observe(null, 120_000, gap), { type: 'none' });
  assert.deepEqual(segmenter.observe('B', 150_000, gap), { type: 'none' });
});

test('a long gap or a confirmed event starts a new segment', () => {
  const segmenter = new ActivitySegmenter();
  segmenter.observe('A', 0, 75_000);
  segmenter.observe('A', 30_000, 75_000);
  segmenter.attach(1);
  assert.deepEqual(segmenter.observe('A', 200_000, 75_000), { type: 'none' });
  segmenter.observe('A', 230_000, 75_000);
  segmenter.attach(2);
  segmenter.restart(260_000);
  assert.deepEqual(segmenter.observe('A', 290_000, 75_000), { type: 'insert', startedAt: 260_000, durationSeconds: 30 });
});
