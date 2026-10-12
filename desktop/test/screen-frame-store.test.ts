import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScreenFrameStore } from '../services/screen-frame-store.ts';

type FakeSafeStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
};

function fakeSafeStorage(): FakeSafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^encrypted:/, '')
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-screen-'));
}

test('encrypts saved screen frames and cleans only expired frame files', () => {
  const root = tempDir();
  const store = new ScreenFrameStore(root, fakeSafeStorage());
  const capturedAt = new Date('2026-10-06T10:00:00.000Z');
  const target = store.save(Buffer.from('png bytes'), capturedAt);
  const bytes = fs.readFileSync(target);
  assert.equal(bytes.subarray(0, 7).toString('utf8'), 'SYDNEY1');
  assert.doesNotMatch(bytes.toString('utf8'), /png bytes/);
  assert.equal(fs.existsSync(path.join(root, 'screen-key.bin')), true);

  const oldTarget = path.join(root, 'old.sframe');
  fs.writeFileSync(oldTarget, Buffer.from('old'));
  fs.utimesSync(oldTarget, new Date('2026-10-01T10:00:00.000Z'), new Date('2026-10-01T10:00:00.000Z'));
  const removed = store.cleanup(24, new Date('2026-10-06T12:00:00.000Z').getTime());
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(oldTarget), false);
  assert.equal(fs.existsSync(target), true);
});
