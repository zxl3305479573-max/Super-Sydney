import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSessionAdapter, type CodexCapturedMessage } from '../services/codex-session-adapter.ts';
import { extractCodexCliEvent, extractCodexToolCall } from '../services/codex-session.ts';
import { JsonlTreeLister } from '../services/jsonl-tail.ts';

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-10-12T08:00:00.000Z', type, payload });
const cliMeta = line('session_meta', { originator: 'codex_cli_rs', id: 'cli-1', cwd: 'D:/w' });

test('reads CLI prompts and task_complete answers, skipping injected context', () => {
  assert.deepEqual(extractCodexCliEvent(line('event_msg', { type: 'user_message', message: '跑测试' })), { kind: 'user', text: '跑测试' });
  assert.equal(extractCodexCliEvent(line('event_msg', { type: 'user_message', message: '<environment_context>cwd</environment_context>' })), null);
  assert.deepEqual(extractCodexCliEvent(line('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: '完成' })), { kind: 'final', text: '完成', turnId: 't1' });
  assert.equal(extractCodexCliEvent(line('event_msg', { type: 'agent_reasoning', text: 'x' })), null);
});

test('tool calls keep names and patched paths only', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-secret\n+value\n*** Add File: src/b.ts\n*** End Patch';
  assert.deepEqual(extractCodexToolCall(line('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: patch })), { name: 'apply_patch', files: ['src/a.ts', 'src/b.ts'], reads: [] });
  assert.deepEqual(extractCodexToolCall(line('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["rm"]}' })), { name: 'shell', files: [], reads: [] });
  const shellRead = JSON.stringify({ command: ['bash', '-lc', 'sed -n 1,80p "D:\\Vault\\04-工作流\\SOP.md" && cat notes/a.md | grep token=abc'] });
  const reads = extractCodexToolCall(line('response_item', { type: 'function_call', name: 'shell', arguments: shellRead }))?.reads;
  assert.deepEqual(reads, ['D:\\Vault\\04-工作流\\SOP.md', 'notes/a.md']);
});

test('CLI originator is opt-in and pairs prompt/answer through turn ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-codex-cli-'));
  const file = path.join(root, '2026', '10', '12', 'rollout.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out: CodexCapturedMessage[] = [];
  const body = [
    line('event_msg', { type: 'task_started', turn_id: 't1' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑测试' }] }),
    line('event_msg', { type: 'user_message', message: '跑测试' }),
    line('response_item', { type: 'function_call', name: 'shell', arguments: '{}' }),
    line('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: '测试通过' })
  ].join('\n') + '\n';
  const defaultAdapter = new CodexSessionAdapter(root, m => out.push(m), undefined, 60_000);
  const cliAdapter = new CodexSessionAdapter(root, m => out.push(m), undefined, 60_000, ['codex_cli_rs']);
  try {
    defaultAdapter.start();
    cliAdapter.start();
    fs.writeFileSync(file, `${cliMeta}\n${body}`, 'utf8');
    defaultAdapter.scanOnce();
    assert.equal(out.length, 0, 'desktop-only default ignores the CLI');
    cliAdapter.scanOnce();
    assert.deepEqual(out.map(m => [m.role, m.text, m.turnId]), [['user', '跑测试', 't1'], ['assistant', '测试通过', 't1']]);
    assert.deepEqual(out[1].trace?.tools, { shell: 1 });
    assert.equal(out[1].sessionId, 'cli-1');
  } finally {
    defaultAdapter.stop(); cliAdapter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('baselined sessions keep their header so later appends are attributed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-codex-cli-'));
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, `${cliMeta}\n`, 'utf8');
  const out: CodexCapturedMessage[] = [];
  const adapter = new CodexSessionAdapter(root, m => out.push(m), undefined, 60_000, ['codex_cli_rs']);
  try {
    adapter.start();
    fs.appendFileSync(file, `${line('event_msg', { type: 'user_message', message: '继续' })}\n`, 'utf8');
    adapter.scanOnce();
    assert.deepEqual(out.map(m => [m.text, m.cwd]), [['继续', 'D:/w']]);
  } finally {
    adapter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('truncated files are re-read from the start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-codex-cli-'));
  const file = path.join(root, 'rollout.jsonl');
  const out: CodexCapturedMessage[] = [];
  const adapter = new CodexSessionAdapter(root, m => out.push(m), undefined, 60_000, ['codex_cli_rs']);
  try {
    adapter.start();
    fs.writeFileSync(file, `${cliMeta}\n${line('event_msg', { type: 'user_message', message: '一二三四五六七八九十' })}\n`, 'utf8');
    adapter.scanOnce();
    fs.writeFileSync(file, `${cliMeta}\n`, 'utf8');
    adapter.scanOnce();
    fs.appendFileSync(file, `${line('event_msg', { type: 'user_message', message: '新' })}\n`, 'utf8');
    adapter.scanOnce();
    assert.deepEqual(out.map(m => m.text), ['一二三四五六七八九十', '新']);
  } finally {
    adapter.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tree lister discovers new files and skips configured directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-lister-'));
  try {
    const lister = new JsonlTreeLister(root, name => name === 'skip');
    assert.deepEqual(lister.list(), []);
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'skip'));
    fs.writeFileSync(path.join(root, 'a', 'x.jsonl'), '');
    fs.writeFileSync(path.join(root, 'skip', 'y.jsonl'), '');
    fs.writeFileSync(path.join(root, 'a', 'z.txt'), '');
    assert.deepEqual(lister.list(), [path.join(root, 'a', 'x.jsonl')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
