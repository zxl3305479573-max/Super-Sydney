import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { defaultSettings } from '../services/app-settings.ts';
import { migrateCodexEventColumns, persistCodexMessage } from '../services/codex-event-store.ts';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT '',
    window_title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '',
    duration_seconds INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
    value_score INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '个人成长'
  )`);
  migrateCodexEventColumns(db);
  return db;
}

test('Codex capture is disabled by default', () => {
  assert.equal(defaultSettings('D:/Vault', 'D:/Project').codexCaptureEnabled, false);
});

test('a prompt creates one local pending Codex event with source metadata', () => {
  const db = database();
  persistCodexMessage(db, { id: 'user-1', role: 'user', text: '实现登录', sessionId: 'session-1', cwd: 'D:/work', sessionFile: 'rollout.jsonl' });
  const event = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
  assert.equal(event.status, 'pending');
  assert.equal(event.kind, 'codex');
  assert.equal(event.source, 'codex');
  assert.equal(event.source_session_id, 'session-1');
  assert.equal(event.source_turn_id, '');
  assert.equal(event.source_message_id, 'user-1');
  assert.equal(event.codex_prompt, '实现登录');
  assert.equal(event.codex_response, '');
});

test('the next final answer updates the newest unanswered prompt in the same session', () => {
  const db = database();
  persistCodexMessage(db, { id: 'user-1', role: 'user', text: '第一个问题', sessionId: 'session-1', cwd: 'D:/work', sessionFile: 'rollout.jsonl' });
  persistCodexMessage(db, { id: 'assistant-1', role: 'assistant', text: '第一个回答', sessionId: 'session-1', cwd: 'D:/work', sessionFile: 'rollout.jsonl' });
  const event = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
  assert.equal(event.codex_response, '第一个回答');
  assert.equal(event.summary, '第一个回答');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count, 1);
});

test('answers update the matching turn instead of the newest unanswered prompt', () => {
  const db = database();
  persistCodexMessage(db, { id: 'user-1', role: 'user', text: 'first', turnId: 'turn-1', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' });
  persistCodexMessage(db, { id: 'user-2', role: 'user', text: 'second', turnId: 'turn-2', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' });
  persistCodexMessage(db, { id: 'assistant-1', role: 'assistant', text: 'answer one', turnId: 'turn-1', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' });
  persistCodexMessage(db, { id: 'assistant-2', role: 'assistant', text: 'answer two', turnId: 'turn-2', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' });
  const events = db.prepare('SELECT codex_prompt, codex_response, source_turn_id FROM events ORDER BY id').all().map(row => ({ ...row })) as Array<Record<string, string>>;
  assert.deepEqual(events, [
    { codex_prompt: 'first', codex_response: 'answer one', source_turn_id: 'turn-1' },
    { codex_prompt: 'second', codex_response: 'answer two', source_turn_id: 'turn-2' }
  ]);
});

test('a repeated answer does not overwrite or duplicate the paired event', () => {
  const db = database();
  persistCodexMessage(db, { id: 'user-1', role: 'user', text: 'question', turnId: 'turn-1', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' });
  assert.equal(persistCodexMessage(db, { id: 'assistant-1', role: 'assistant', text: 'answer', turnId: 'turn-1', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' }), 1);
  assert.equal(persistCodexMessage(db, { id: 'assistant-1', role: 'assistant', text: 'answer changed', turnId: 'turn-1', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' }), null);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT codex_response FROM events').get() as { codex_response: string }).codex_response, 'answer');
});

test('a response without a pending prompt is retained and duplicate messages are ignored', () => {
  const db = database();
  persistCodexMessage(db, { id: 'assistant-1', role: 'assistant', text: '孤立回答', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' });
  persistCodexMessage(db, { id: 'user-1', role: 'user', text: '问题', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' });
  persistCodexMessage(db, { id: 'user-1', role: 'user', text: '问题', sessionId: 'session-1', cwd: '', sessionFile: 'rollout.jsonl' });
  const events = db.prepare('SELECT codex_prompt, codex_response FROM events ORDER BY id').all().map(row => ({ ...(row as { codex_prompt: string; codex_response: string }) })) as Array<{ codex_prompt: string; codex_response: string }>;
  assert.deepEqual(events, [
    { codex_prompt: '', codex_response: '孤立回答' },
    { codex_prompt: '问题', codex_response: '' }
  ]);
});
