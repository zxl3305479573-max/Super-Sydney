import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, readWindowState, restoreWindowState, settleWindowBounds, writeWindowState } from '../services/window-state.ts';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

test('没有保存过窗口状态时用默认尺寸、不指定位置', () => {
  assert.deepEqual(restoreWindowState(null, [primary]), { ...DEFAULT_WINDOW_SIZE, maximized: false });
  assert.deepEqual(restoreWindowState('坏数据', [primary]), { ...DEFAULT_WINDOW_SIZE, maximized: false });
});

test('位置在某块显示器里时原样还原，包括最大化', () => {
  assert.deepEqual(restoreWindowState({ x: 2100, y: 80, width: 1500, height: 900, maximized: true }, [primary, right]),
    { x: 2100, y: 80, width: 1500, height: 900, maximized: true });
});

test('显示器拔掉后丢掉位置，只保留尺寸', () => {
  const state = restoreWindowState({ x: 2100, y: 80, width: 1500, height: 900, maximized: false }, [primary]);
  assert.equal(state.x, undefined);
  assert.equal(state.y, undefined);
  assert.equal(state.width, 1500);
});

test('标题栏被拖到屏幕上方外面时也视为不可见', () => {
  assert.equal(restoreWindowState({ x: 100, y: -400, width: 1200, height: 800 }, [primary]).x, undefined);
});

test('尺寸夹在最小窗口与最大工作区之间', () => {
  const small = restoreWindowState({ width: 200, height: 100 }, [primary]);
  assert.equal(small.width, MIN_WINDOW_SIZE.width);
  assert.equal(small.height, MIN_WINDOW_SIZE.height);
  const huge = restoreWindowState({ width: 9000, height: 9000 }, [primary]);
  assert.equal(huge.width, primary.width);
  assert.equal(huge.height, primary.height);
});

test('高 DPI 下读回的边界多出几像素时沿用请求值，窗口不会每次启动都长大', () => {
  const requested = { x: 13, y: 211, width: 1320, height: 860 };
  const reported = { x: 13, y: 211, width: 1321, height: 862 };
  assert.deepEqual(settleWindowBounds(requested, reported, { x: 13, y: 211, width: 1322, height: 864 }), requested);
});

test('用户拖动或缩放过的那一项记新值，没动的那一项沿用请求值', () => {
  const requested = { x: 13, y: 211, width: 1320, height: 860 };
  const reported = { x: 13, y: 211, width: 1321, height: 862 };
  assert.deepEqual(settleWindowBounds(requested, reported, { x: 400, y: 211, width: 1600, height: 862 }), { x: 400, y: 211, width: 1600, height: 860 });
});

test('首次启动没有请求位置时，位置取当前值', () => {
  const reported = { x: 300, y: 100, width: 1321, height: 862 };
  assert.deepEqual(settleWindowBounds({ width: 1320, height: 860 }, reported, reported), { x: 300, y: 100, width: 1320, height: 860 });
});

test('写下的状态能原样读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-window-'));
  const file = path.join(dir, 'window-state.json');
  try {
    assert.equal(readWindowState(file), null);
    writeWindowState(file, { x: 10, y: 20, width: 1300, height: 820 }, true);
    assert.deepEqual(readWindowState(file), { x: 10, y: 20, width: 1300, height: 820, maximized: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
