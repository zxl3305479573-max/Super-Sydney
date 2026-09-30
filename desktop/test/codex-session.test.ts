import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodexMessage, parseCodexRecord } from '../services/codex-session.ts';

const record = (payload: Record<string, unknown>) => JSON.stringify({ type: 'response_item', payload });

test('extracts user input_text from a Codex Desktop message', () => {
  assert.deepEqual(extractCodexMessage(record({ type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'Build an agent' }] }), 'Codex Desktop'), {
    id: 'u1', role: 'user', text: 'Build an agent'
  });
});

test('extracts only the displayed final answer from Codex Desktop', () => {
  assert.deepEqual(extractCodexMessage(record({ type: 'message', id: 'a1', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done' }] }), 'Codex Desktop'), {
    id: 'a1', role: 'assistant', text: 'Done'
  });
});

test('ignores analysis, commentary, tool events, metadata, and malformed lines', () => {
  const ignored = [
    record({ type: 'message', id: 'a2', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: 'hidden' }] }),
    record({ type: 'message', id: 'a3', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'status' }] }),
    record({ type: 'function_call', id: 't1', name: 'exec_command', arguments: '{}' }),
    record({ type: 'function_call_output', id: 't2', output: 'terminal result' }),
    JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex Desktop' } }),
    '{broken json'
  ];
  for (const line of ignored) assert.equal(extractCodexMessage(line, 'Codex Desktop'), null);
});

test('rejects non-desktop sessions even when their message shape matches', () => {
  const user = record({ type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'CLI input' }] });
  assert.equal(extractCodexMessage(user, 'Codex CLI'), null);
});

test('parseCodexRecord returns null for malformed JSON', () => {
  assert.equal(parseCodexRecord('{broken'), null);
});
