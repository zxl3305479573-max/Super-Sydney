import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoBgmPath, ensureAutoBgm, synthesizeAutoBgmWav } from '../services/video-bgm.ts';

test('every auto BGM style is a deterministic, distinct 16 second 44.1 kHz stereo PCM WAV', () => {
  const styles = ['tech', 'uplifting', 'calm', 'cinematic'] as const;
  const files = styles.map(style => synthesizeAutoBgmWav(style));
  for (const [index, wav] of files.entries()) {
    assert.ok(wav.equals(synthesizeAutoBgmWav(styles[index])), '同一曲风和模板版本必须生成完全相同的文件');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
    assert.equal(wav.readUInt16LE(20), 1, 'PCM');
    assert.equal(wav.readUInt16LE(22), 2, 'stereo');
    assert.equal(wav.readUInt32LE(24), 44_100);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.toString('ascii', 36, 40), 'data');
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.equal(wav.length, 44 + 44_100 * 16 * 2 * 2);
  }
  for (let index = 1; index < files.length; index += 1) {
    assert.equal(files[index].equals(files[0]), false, `${styles[index]} 应有独立编曲`);
  }
});

test('auto BGM is cached under a style and version specific app data path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-bgm-'));
  try {
    const target = ensureAutoBgm(root, 'tech');
    const calm = ensureAutoBgm(root, 'calm');
    assert.equal(target, autoBgmPath(root, 'tech'));
    assert.equal(calm, autoBgmPath(root, 'calm'));
    assert.notEqual(target, calm);
    assert.ok(fs.existsSync(target));
    assert.ok(fs.existsSync(calm));
    const firstStat = fs.statSync(target);
    assert.ok(firstStat.size > 44);
    const second = ensureAutoBgm(root, 'tech');
    assert.equal(second, target);
    assert.equal(fs.statSync(second).mtimeMs, firstStat.mtimeMs, '缓存命中时不重新写文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
