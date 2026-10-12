import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, mergeSettings } from '../services/app-settings.ts';

test('LLM sending is disabled by default and survives settings merge', () => {
  assert.equal(defaultSettings('D:/Vault', 'D:/Project').llmEnabled, false);
  assert.equal(mergeSettings({ llmEnabled: true }, 'D:/Vault', 'D:/Project').llmEnabled, true);
});

test('Codex capture remains opt-in while Codex is an allowed application', () => {
  const settings = defaultSettings('D:/Vault', 'D:/Project');
  assert.equal(settings.codexCaptureEnabled, false);
  assert.ok(settings.allowedApps.includes('Codex'));
});

test('migrates the previous default allow-list to include Codex without changing custom lists', () => {
  const legacy = ['Code', 'Visual Studio Code', 'Obsidian', 'Google Chrome', 'Microsoft Edge', 'Terminal', 'PowerShell'];
  assert.ok(mergeSettings({ allowedApps: legacy }, 'D:/Vault', 'D:/Project').allowedApps.includes('Codex'));
  assert.deepEqual(mergeSettings({ allowedApps: ['Only Me'] }, 'D:/Vault', 'D:/Project').allowedApps, ['Only Me']);
});
