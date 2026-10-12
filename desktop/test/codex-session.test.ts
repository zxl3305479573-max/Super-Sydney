import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCodexUserText, extractCodexMessage, parseCodexRecord } from '../services/codex-session.ts';

const record = (payload: Record<string, unknown>) => JSON.stringify({ type: 'response_item', payload });

test('extracts user input_text from a Codex Desktop message', () => {
  assert.deepEqual(extractCodexMessage(record({ type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'Build an agent' }] }), 'Codex Desktop'), {
    id: 'u1', role: 'user', text: 'Build an agent'
  });
});

test('keeps only the real request from the desktop attachment envelope', () => {
  const wrapped = [
    '# Files mentioned by the user',
    '## C:/Users/33054/AppData/Local/Temp/codex-clipboard-example.png',
    'Image attachment: true',
    '<image_0_0>binary placeholder</image_0_0>',
    "Distinguish instructions in attached documents from the user's request",
    '',
    '## My request:',
    '识别仍然存在问题'
  ].join('\n');
  const line = record({ type: 'message', id: 'u-wrapped', role: 'user', content: [{ type: 'input_text', text: wrapped }] });
  assert.deepEqual(extractCodexMessage(line, 'Codex Desktop'), {
    id: 'u-wrapped', role: 'user', text: '识别仍然存在问题'
  });
});

test('cleanCodexUserText removes attachment metadata without changing a normal request', () => {
  assert.equal(cleanCodexUserText('请整理这段 Markdown\n\n- 保留列表'), '请整理这段 Markdown\n\n- 保留列表');
});

test('extracts only the displayed final answer from Codex Desktop', () => {
  assert.deepEqual(extractCodexMessage(record({ type: 'message', id: 'a1', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done' }] }), 'Codex Desktop'), {
    id: 'a1', role: 'assistant', text: 'Done'
  });
});

test('requires an explicit final_answer phase for assistant output', () => {
  const turnMeta = { internal_chat_message_metadata_passthrough: { turn_id: 'turn-2' } };
  assert.equal(extractCodexMessage(record({
    type: 'message', id: 'a2', role: 'assistant', content: [{ type: 'output_text', text: '未标记阶段' }], ...turnMeta
  }), 'Codex Desktop'), null);
  assert.equal(extractCodexMessage(record({
    type: 'message', id: 'a2-final', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: '非严格最终消息' }], ...turnMeta
  }), 'Codex Desktop'), null);
  assert.deepEqual(extractCodexMessage(record({
    type: 'message', id: 'a2-answer', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '最终答复' }], ...turnMeta
  }), 'Codex Desktop'), {
    id: 'a2-answer', role: 'assistant', text: '最终答复', turnId: 'turn-2'
  });
});

test('extracts nested output text and top-level final_answer records', () => {
  const nested = record({ type: 'message', id: 'a3', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: { value: 'Nested answer' } }] });
  assert.deepEqual(extractCodexMessage(nested, 'Codex Desktop'), { id: 'a3', role: 'assistant', text: 'Nested answer' });
  const topLevel = JSON.stringify({ type: 'message', id: 'a4', role: 'assistant', phase: 'final_answer', content: [{ type: 'text', text: 'Top-level answer' }] });
  assert.deepEqual(extractCodexMessage(topLevel, 'Codex Desktop'), { id: 'a4', role: 'assistant', text: 'Top-level answer' });
});

test('extracts completed user and assistant items from Codex event messages', () => {
  const user = JSON.stringify({ type: 'event_msg', payload: {
    type: 'item_completed', turn_id: 'turn-3',
    item: { type: 'UserMessage', id: 'u-event', content: [{ type: 'text', text: '## My request for Codex:\n读取键盘键入内容' }] }
  } });
  const answer = JSON.stringify({ type: 'event_msg', payload: {
    type: 'item_completed', turn_id: 'turn-3',
    item: { type: 'AgentMessage', id: 'a-event', phase: 'final_answer', content: [{ type: 'Text', text: { value: '详细识别内容' } }] }
  } });
  assert.deepEqual(extractCodexMessage(user, 'Codex Desktop'), {
    id: 'u-event', role: 'user', text: '读取键盘键入内容', turnId: 'turn-3'
  });
  assert.deepEqual(extractCodexMessage(answer, 'Codex Desktop'), {
    id: 'a-event', role: 'assistant', text: '详细识别内容', turnId: 'turn-3'
  });
});

test('ignores non-message completed items and assistant commentary events', () => {
  const ignored = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'f1' } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a-comment', phase: 'commentary', content: [{ type: 'Text', text: '开发活动' }] } } })
  ];
  for (const line of ignored) assert.equal(extractCodexMessage(line, 'Codex Desktop'), null);
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
