import test from 'node:test';
import assert from 'node:assert/strict';
import { videoSafeArea, videoSafeAreaFractions } from '../services/video-safe-area.ts';
import { LANDSCAPE_FRAME, VERTICAL_FRAME } from '../services/video-frame-spec.ts';

test('竖屏平台按各自界面覆盖范围预留安全区', () => {
  assert.deepEqual(videoSafeAreaFractions('douyin'), { top: 0.10, bottom: 0.22, left: 0.05, right: 0.14 });
  assert.deepEqual(videoSafeArea('douyin', VERTICAL_FRAME), {
    top: 192, bottom: 422, left: 54, right: 151, label: '10%/22%/5%/14%'
  });
  assert.deepEqual(videoSafeArea('xiaohongshu', VERTICAL_FRAME), {
    top: 115, bottom: 346, left: 54, right: 130, label: '6%/18%/5%/12%'
  });
});

test('横屏平台使用百分之五标题安全区', () => {
  assert.deepEqual(videoSafeArea('bilibili', LANDSCAPE_FRAME), {
    top: 54, bottom: 54, left: 96, right: 96, label: '5%/5%/5%/5%'
  });
});
