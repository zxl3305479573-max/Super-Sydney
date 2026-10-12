import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanClaudePrompt, parseClaudeLine } from '../services/claude-session.ts';
import { ClaudeSessionAdapter, defaultClaudeProjectsRoot, type ClaudeCapturedMessage } from '../services/claude-session-adapter.ts';
import { migrateCodexEventColumns, persistAiMessage } from '../services/codex-event-store.ts';

const base = { sessionId: 's-1', cwd: 'D:/Super-Sydney', gitBranch: 'main', isSidechain: false, timestamp: '2026-10-12T08:00:00.000Z' };
const prompt = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...extra, type: 'user', uuid, message: { role: 'user', content } });
const assistant = (uuid: string, messageId: string, content: unknown[], stop: string | null = null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...base, ...extra, type: 'assistant', uuid, message: { id: messageId, role: 'assistant', model: 'claude-test', content, stop_reason: stop } });

test('parses typed prompts and discards tool results, meta, sidechain and shell output', () => {
  assert.deepEqual(parseClaudeLine(prompt('u1', '修复登录')), { kind: 'prompt', uuid: 'u1', sessionId: 's-1', cwd: 'D:/Super-Sydney', gitBranch: 'main', text: '修复登录', timestamp: base.timestamp });
  assert.equal(parseClaudeLine(prompt('u2', [{ type: 'tool_result', tool_use_id: 't', content: 'secret output' }])), null);
  assert.equal(parseClaudeLine(prompt('u3', 'skill body', { isMeta: true })), null);
  assert.equal(parseClaudeLine(prompt('u4', 'sub task', { isSidechain: true })), null);
  assert.equal(parseClaudeLine(prompt('u5', '<bash-input>ls</bash-input>')), null);
  assert.equal(parseClaudeLine(prompt('u6', '<local-command-stdout>ok</local-command-stdout>')), null);
  assert.equal(parseClaudeLine('not json'), null);
  assert.equal(parseClaudeLine(JSON.stringify({ type: 'summary', summary: 'x' })), null);
  assert.deepEqual(parseClaudeLine(prompt('u7', '[Request interrupted by user]')), { kind: 'interrupt', sessionId: 's-1', timestamp: base.timestamp });
});

test('cleans slash commands and injected envelopes', () => {
  assert.equal(cleanClaudePrompt('<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>PR 12</command-args>'), '/review PR 12');
  assert.equal(cleanClaudePrompt('<command-name>/clear</command-name><command-args></command-args>'), '');
  assert.equal(cleanClaudePrompt('<system-reminder>ctx</system-reminder>\n帮我写测试'), '帮我写测试');
  assert.equal(cleanClaudePrompt('<ide_opened_file>a.ts</ide_opened_file>解释这段代码'), '解释这段代码');
});

test('assistant lines expose visible text and tool metadata only', () => {
  const parsed = parseClaudeLine(assistant('a1', 'm1', [
    { type: 'thinking', thinking: 'hidden' },
    { type: 'text', text: '我来修改' },
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'D:/a.ts', old_string: 'x', new_string: 'y' } },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'rm -rf secret' } }
  ]));
  assert.ok(parsed && parsed.kind === 'assistant');
  assert.equal(parsed.text, '我来修改');
  assert.deepEqual(parsed.tools, [{ name: 'Edit', files: ['D:/a.ts'], reads: [] }, { name: 'Bash', files: [], reads: [] }]);
  assert.ok(!JSON.stringify(parsed).includes('rm -rf'));
  assert.ok(!JSON.stringify(parsed).includes('hidden'));
});

test('honours CLAUDE_CONFIG_DIR', () => {
  assert.equal(defaultClaudeProjectsRoot('/home/u', {}), path.join('/home/u', '.claude', 'projects'));
  assert.equal(defaultClaudeProjectsRoot('/home/u', { CLAUDE_CONFIG_DIR: '/cfg' }), path.join('/cfg', 'projects'));
});

function withRoot(run: (root: string, file: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-claude-'));
  const project = path.join(root, 'D--Super-Sydney');
  fs.mkdirSync(project);
  try { run(root, path.join(project, 's-1.jsonl')); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('emits prompt, then the last assistant text of the turn with a tool trace', () => withRoot((root, file) => {
  const out: ClaudeCapturedMessage[] = [];
  fs.writeFileSync(file, `${prompt('old', '历史问题')}\n`, 'utf8');
  const adapter = new ClaudeSessionAdapter([root], message => out.push(message), undefined, { intervalMs: 60_000 });
  try {
    adapter.start();
    adapter.scanOnce();
    assert.equal(out.length, 0, 'history is not backfilled');
    fs.appendFileSync(file, [
      prompt('p1', '加个测试'),
      assistant('a1', 'm1', [{ type: 'text', text: '先看看代码' }]),
      assistant('a2', 'm1', [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'x' } }]),
      prompt('r1', [{ type: 'tool_result', tool_use_id: 't', content: 'file body' }]),
      assistant('a3', 'm2', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'D:/x.test.ts' } }]),
      assistant('a4', 'm3', [{ type: 'text', text: '已添加测试，全部通过。' }], 'end_turn'),
      assistant('a5', 'm4', [{ type: 'text', text: 'side' }], null, { isSidechain: true })
    ].join('\n') + '\n', 'utf8');
    adapter.scanOnce();
    assert.deepEqual(out.map(m => [m.role, m.text]), [['user', '加个测试'], ['assistant', '已添加测试，全部通过。']]);
    assert.equal(out[1].turnId, 'p1');
    assert.deepEqual(out[1].trace?.tools, { Read: 1, Edit: 1 });
    assert.deepEqual(out[1].trace?.files, ['D:/x.test.ts']);
    assert.equal(out[1].trace?.model, 'claude-test');
    assert.deepEqual(out[1].trace?.reads, ['x']);
  } finally { adapter.stop(); }
}));

test('flushes on idle and re-emits when late text arrives', () => withRoot((root, file) => {
  const out: ClaudeCapturedMessage[] = [];
  fs.writeFileSync(file, '', 'utf8');
  const adapter = new ClaudeSessionAdapter([root], message => out.push(message), undefined, { intervalMs: 60_000, idleMs: 1_000 });
  try {
    adapter.start();
    fs.appendFileSync(file, `${prompt('p1', '问题')}\n${assistant('a1', 'm1', [{ type: 'text', text: '草稿' }])}\n`, 'utf8');
    adapter.scanOnce();
    assert.equal(out.length, 1);
    adapter.scanOnce(Date.now() + 5_000);
    assert.deepEqual(out.map(m => m.text), ['问题', '草稿']);
    adapter.scanOnce(Date.now() + 10_000);
    assert.equal(out.length, 2, 'no repeated flush without new text');
    fs.appendFileSync(file, `${assistant('a2', 'm2', [{ type: 'text', text: '最终版' }], 'end_turn')}\n`, 'utf8');
    adapter.scanOnce();
    assert.deepEqual(out.map(m => m.text), ['问题', '草稿', '最终版']);
    assert.equal(out[1].id, out[2].id);
  } finally { adapter.stop(); }
}));

test('a user interrupt closes the turn and is recorded in the trace', () => withRoot((root, file) => {
  const out: ClaudeCapturedMessage[] = [];
  fs.writeFileSync(file, '', 'utf8');
  const adapter = new ClaudeSessionAdapter([root], message => out.push(message), undefined, { intervalMs: 60_000 });
  try {
    adapter.start();
    fs.appendFileSync(file, `${prompt('p1', '重构')}\n${prompt('i1', [{ type: 'text', text: '[Request interrupted by user]' }])}\n`, 'utf8');
    adapter.scanOnce();
    assert.equal(out.length, 2);
    assert.equal(out[1].trace?.interrupted, true);
  } finally { adapter.stop(); }
}));

test('subagent transcripts in session folders are ignored', () => withRoot((root, file) => {
  const out: ClaudeCapturedMessage[] = [];
  const adapter = new ClaudeSessionAdapter([root], message => out.push(message), undefined, { intervalMs: 60_000 });
  try {
    adapter.start();
    const sub = path.join(path.dirname(file), 's-1', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), `${prompt('x', 'sub prompt')}\n`, 'utf8');
    adapter.scanOnce();
    assert.equal(out.length, 0);
  } finally { adapter.stop(); }
}));

test('store pairs Claude prompt and answer and lets later answers refine it', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT '', window_title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '', duration_seconds INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', value_score INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '个人成长')`);
  migrateCodexEventColumns(db);
  persistAiMessage(db, 'claude', { id: 'p1', role: 'user', text: '问题', turnId: 'p1', sessionId: 's', cwd: 'D:/w' });
  persistAiMessage(db, 'claude', { id: 'p1:final', role: 'assistant', text: '草稿', turnId: 'p1', sessionId: 's', cwd: 'D:/w', trace: { tools: { Edit: 1 }, files: [], durationMs: 0, interrupted: false } });
  persistAiMessage(db, 'claude', { id: 'p1:final', role: 'assistant', text: '最终版', turnId: 'p1', sessionId: 's', cwd: 'D:/w' });
  // Same ids from a different source never collide.
  persistAiMessage(db, 'codex', { id: 'p1', role: 'user', text: 'codex 问题', turnId: 'p1', sessionId: 's', cwd: '' });
  const rows = db.prepare('SELECT app_name, kind, source, codex_prompt, codex_response FROM events ORDER BY id').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    { app_name: 'Claude Code', kind: 'claude', source: 'claude', codex_prompt: '问题', codex_response: '最终版' },
    { app_name: 'Codex', kind: 'codex', source: 'codex', codex_prompt: 'codex 问题', codex_response: '' }
  ]);
});
