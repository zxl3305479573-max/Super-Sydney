import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyApplication } from '../services/application-adapters.ts';

test('uses the actual window title as the event summary', () => {
  assert.deepEqual(classifyApplication('Electron', 'Agent 工作台'), {
    adapter: 'generic',
    note: 'Electron：Agent 工作台',
    summary: 'Agent 工作台'
  });
});

test('falls back to the application name when a window has no title', () => {
  const result = classifyApplication('PowerToys.MouseWithoutBordersHelper', '');
  assert.equal(result.summary, 'PowerToys.MouseWithoutBordersHelper');
  assert.equal(result.note, 'PowerToys.MouseWithoutBordersHelper');
});
