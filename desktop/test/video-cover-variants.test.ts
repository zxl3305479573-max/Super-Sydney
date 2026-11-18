import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCoverVariantFfmpegArgs, generateCoverVariants } from '../services/video-cover-variants.ts';

test('buildCoverVariantFfmpegArgs 使用高斯模糊补边且保留完整前景文字', () => {
  const args = buildCoverVariantFfmpegArgs('D:/in/cover.png', 'D:/out/cover-16x9.jpg', '16:9');
  const filterIdx = args.indexOf('-filter_complex');
  assert.ok(filterIdx >= 0);
  const filter = args[filterIdx + 1];
  assert.match(filter, /scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=36:2/);
  assert.match(filter, /scale=1920:1080:force_original_aspect_ratio=decrease\[fg\]/);
  assert.match(filter, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
});

test('generateCoverVariants 校验源文件并按请求比例依次调用执行器', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-cover-var-'));
  try {
    const src = path.join(dir, 'main-cover.png');
    fs.writeFileSync(src, 'fake-image');
    const calls: string[][] = [];
    const out = await generateCoverVariants(src, path.join(dir, 'variants'), 'ffmpeg', ['3:4', '4:3', '16:9'], async (_bin, args) => {
      calls.push(args);
      fs.writeFileSync(args[args.length - 1], 'jpg-bytes');
    });
    assert.equal(calls.length, 3);
    assert.equal(Boolean(out['3:4'] && fs.existsSync(out['3:4'])), true);
    assert.equal(Boolean(out['4:3'] && fs.existsSync(out['4:3'])), true);
    assert.equal(Boolean(out['16:9'] && fs.existsSync(out['16:9'])), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
