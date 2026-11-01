import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoBgmPath, ensureAutoBgm, synthesizeAutoBgmWav } from '../services/video-bgm.ts';

test('auto BGM is a deterministic 16 second 44.1 kHz stereo PCM WAV', () => {
  const first = synthesizeAutoBgmWav();
  const second = synthesizeAutoBgmWav();
  assert.ok(first.equals(second), '同一模板版本必须生成完全相同的文件');
  assert.equal(first.toString('ascii', 0, 4), 'RIFF');
  assert.equal(first.readUInt32LE(4), first.length - 8);
  assert.equal(first.toString('ascii', 8, 12), 'WAVE');
  assert.equal(first.toString('ascii', 12, 16), 'fmt ');
  assert.equal(first.readUInt16LE(20), 1, 'PCM');
  assert.equal(first.readUInt16LE(22), 2, 'stereo');
  assert.equal(first.readUInt32LE(24), 44_100);
  assert.equal(first.readUInt16LE(34), 16);
  assert.equal(first.toString('ascii', 36, 40), 'data');
  assert.equal(first.readUInt32LE(40), first.length - 44);
  assert.equal(first.length, 44 + 44_100 * 16 * 2 * 2);
});

test('auto BGM is cached under the versioned app data path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-bgm-'));
  try {
    const target = ensureAutoBgm(root);
    assert.equal(target, autoBgmPath(root));
    assert.ok(fs.existsSync(target));
    const firstStat = fs.statSync(target);
    assert.ok(firstStat.size > 44);
    const second = ensureAutoBgm(root);
    assert.equal(second, target);
    assert.equal(fs.statSync(second).mtimeMs, firstStat.mtimeMs, '缓存命中时不重新写文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
