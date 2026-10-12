import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../services/atomic-file.ts';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-atomic-')); }
function patchRename(replacement: typeof fs.renameSync): () => void {
  const mutable = fs as unknown as { renameSync: typeof fs.renameSync };
  const original = mutable.renameSync;
  mutable.renameSync = replacement;
  return () => { mutable.renameSync = original; };
}
function exdev(): never {
  const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
  error.code = 'EXDEV';
  throw error;
}

test('writes and overwrites through a temp file without leaving residue', () => {
  const dir = tempDir();
  const target = path.join(dir, 'nested', 'value.txt');
  writeFileAtomic(target, 'first');
  assert.equal(fs.readFileSync(target, 'utf8'), 'first');
  writeFileAtomic(target, 'second');
  assert.equal(fs.readFileSync(target, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(path.dirname(target)).filter(name => name.endsWith('.tmp')), []);
});

test('falls back to a direct write when the rename is rejected', () => {
  const dir = tempDir();
  const target = path.join(dir, 'secret.bin');
  const restore = patchRename(exdev);
  try {
    writeFileAtomic(target, Buffer.from('payload'), { mode: 0o600 });
  } finally {
    restore();
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'payload');
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});

test('surfaces a genuine write failure instead of silently succeeding', () => {
  const dir = tempDir();
  const target = path.join(dir, 'blocked');
  fs.mkdirSync(target);
  assert.throws(() => writeFileAtomic(target, 'x'));
});
