import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeepSeekInput } from '../services/ai-draft-input.ts';
import type { WorkEvent } from '../shared.ts';

test('Codex input contains only the prompt and displayed final response', () => {
  const event = {
    source: 'codex',
    codex_prompt: '实现登录',
    codex_response: '已完成登录流程',
    source_session_id: 'private-session',
    app_name: 'Codex',
    window_title: 'private-window',
    note: '实现登录',
    summary: '已完成登录流程'
  } as WorkEvent;
  const input = buildDeepSeekInput(event);
  assert.deepEqual(input, { prompt: '实现登录', response: '已完成登录流程' });
  assert.doesNotMatch(JSON.stringify(input), /private-session|private-window|path|tool_output/i);
});

test('manual event input uses its local note and summary only', () => {
  const event = { source: 'desktop', note: '整理文章', summary: '完成提纲', app_name: 'Word', window_title: 'draft.docx' } as WorkEvent;
  assert.deepEqual(buildDeepSeekInput(event), { prompt: '整理文章', response: '完成提纲' });
});
