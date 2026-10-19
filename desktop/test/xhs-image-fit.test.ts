import assert from 'node:assert/strict';
import test from 'node:test';
import { padToThreeFour, threeFourSize, XHS_COVER_SIZE } from '../services/xhs-image-fit.ts';

function solid(width: number, height: number, color: [number, number, number, number]) {
  const data = Buffer.alloc(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set(color, at);
  return { data, width, height };
}

test('2:3 竖图补左右边到 3:4，不丢任何一行', () => {
  assert.deepEqual(XHS_COVER_SIZE, { width: 1080, height: 1440 });
  assert.deepEqual(threeFourSize(1024, 1536), { width: 1152, height: 1536 });
  const source = solid(16, 24, [10, 20, 30, 255]);
  // 第一行与最后一行打上记号：补边后它们必须还在（以前居中裁切会把它们切掉）。
  source.data.set([200, 0, 0, 255], 0);
  source.data.set([0, 200, 0, 255], (23 * 16 + 15) * 4);
  const padded = padToThreeFour(source);
  assert.equal(padded.width, 18);
  assert.equal(padded.height, 24);
  const at = (x: number, y: number) => [...padded.data.subarray((y * 18 + x) * 4, (y * 18 + x) * 4 + 4)];
  // 左右各补 1 列，原图整体右移 1 列。
  assert.deepEqual(at(1, 0), [200, 0, 0, 255]);
  assert.deepEqual(at(16, 23), [0, 200, 0, 255]);
  // 补出来的列用的是贴边平均色，纯色图里就是原色。
  assert.deepEqual(at(17, 5), [10, 20, 30, 255]);
});

test('偏宽的图补上下边；已经是 3:4 的原样返回', () => {
  const wide = padToThreeFour(solid(12, 12, [1, 2, 3, 255]));
  assert.equal(wide.width, 12);
  assert.equal(wide.height, 16);
  assert.deepEqual([...wide.data.subarray(0, 4)], [1, 2, 3, 255]);
  const exact = solid(6, 8, [0, 0, 0, 255]);
  assert.equal(padToThreeFour(exact), exact);
});
