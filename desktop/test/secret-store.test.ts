import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore, resolveLlmApiKey, type SafeStorageLike } from '../services/secret-store.ts';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-secret-')); }
function fakeSafeStorage(available = true): SafeStorageLike {
  return { isEncryptionAvailable: () => available, encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'), decryptString: value => { const text = value.toString('utf8'); if (!text.startsWith('encrypted:')) throw new Error('corrupt'); return text.replace(/^encrypted:/, ''); } };
}

test('stores only encrypted bytes and returns a masked status', () => {
  const dir = tempDir();
  const store = new SecretStore(dir, fakeSafeStorage());
  assert.equal(store.getStatus().configured, false);
  store.save('deepseek-secret-value');
  const status = store.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.encryptionAvailable, true);
  assert.match(status.masked, /^••••.{4}$/);
  assert.equal(fs.readFileSync(path.join(dir, 'deepseek-api-key.bin'), 'utf8'), 'encrypted:deepseek-secret-value');
  assert.equal(store.read(), 'deepseek-secret-value');
  assert.doesNotMatch(JSON.stringify(status), /deepseek-secret-value/);
});

test('replaces and removes a stored key', () => {
  const dir = tempDir();
  const store = new SecretStore(dir, fakeSafeStorage());
  store.save('first-key');
  store.save('second-key');
  assert.equal(store.read(), 'second-key');
  store.remove();
  assert.equal(store.read(), '');
  assert.equal(store.getStatus().configured, false);
});

test('never writes when encryption is unavailable and treats corrupt data as unconfigured', () => {
  const dir = tempDir();
  const unavailable = new SecretStore(dir, fakeSafeStorage(false));
  assert.equal(unavailable.getStatus().encryptionAvailable, false);
  assert.throws(() => unavailable.save('key'), /加密不可用/);
  fs.writeFileSync(path.join(dir, 'deepseek-api-key.bin'), 'corrupt');
  const store = new SecretStore(dir, fakeSafeStorage());
  assert.equal(store.getStatus().configured, false);
  assert.equal(store.read(), '');
});

test('saves the key even when the directory rejects renames with EXDEV', () => {
  const dir = tempDir();
  const store = new SecretStore(dir, fakeSafeStorage());
  const mutable = fs as unknown as { renameSync: typeof fs.renameSync };
  const original = mutable.renameSync;
  mutable.renameSync = () => {
    const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
    error.code = 'EXDEV';
    throw error;
  };
  try {
    store.save('key-under-exdev');
  } finally {
    mutable.renameSync = original;
  }
  assert.equal(store.read(), 'key-under-exdev');
});

test('stored key has priority over environment fallback', () => {
  assert.equal(resolveLlmApiKey('stored-key', 'environment-key'), 'stored-key');
  assert.equal(resolveLlmApiKey('', 'environment-key'), 'environment-key');
  assert.equal(resolveLlmApiKey('', ''), '');
});
