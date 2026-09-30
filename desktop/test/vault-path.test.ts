import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveVaultPath } from '../services/vault-path.ts';

const projectPath = path.resolve('D:/Super-Sydney');
const legacyVaultPath = path.resolve('D:/33054/Documents/persornal/Sydney');

test('uses the existing legacy vault as the initial default, outside the project', () => {
  assert.equal(resolveVaultPath(undefined, legacyVaultPath, projectPath), legacyVaultPath);
});

test('preserves an explicitly configured vault path', () => {
  const configuredPath = path.resolve('E:/Notes/MyVault');
  assert.equal(resolveVaultPath(configuredPath, legacyVaultPath, projectPath), configuredPath);
});

test('rejects a vault path inside the application project', () => {
  assert.throws(
    () => resolveVaultPath(projectPath, legacyVaultPath, projectPath),
    /知识库必须与项目目录分离/
  );
});
