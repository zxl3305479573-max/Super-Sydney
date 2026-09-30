import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, mergeSettings } from '../services/app-settings.ts';

test('LLM sending is disabled by default and survives settings merge', () => {
  assert.equal(defaultSettings('D:/Vault', 'D:/Project').llmEnabled, false);
  assert.equal(mergeSettings({ llmEnabled: true }, 'D:/Vault', 'D:/Project').llmEnabled, true);
});
