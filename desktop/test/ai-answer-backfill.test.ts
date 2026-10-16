import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backfillAiAnswers, claudeFinalAnswers, codexFinalAnswers } from '../services/ai-answer-backfill.ts';
import { migrateCodexEventColumns, persistAiMessage } from '../services/codex-event-store.ts';

function database(): DatabaseSync {
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

const codexLine = (payload: Record<string, unknown>, type = 'response_item') => JSON.stringify({ type, payload });
const desktopAnswer = (turn: string, id: string, text: string, phase = 'final_answer') => codexLine({
  type: 'message', role: 'assistant', id, phase, content: [{ type: 'output_text', text }],
  internal_chat_message_metadata_passthrough: { turn_id: turn }
});

test('Codex: the final answer of each turn, not its commentary', () => {
  const answers = codexFinalAnswers([
    desktopAnswer('t1', 'm1', '正在看代码…', 'commentary'),
    desktopAnswer('t1', 'm2', '改好了：修复了配对。'),
    codexLine({ type: 'task_complete', turn_id: 't2', last_agent_message: 'CLI 的最终答复' }, 'event_msg')
  ]);
  assert.equal(answers.get('t1'), '改好了：修复了配对。');
  assert.equal(answers.get('t2'), 'CLI 的最终答复');
});

const claudeLine = (record: Record<string, unknown>) => JSON.stringify({ sessionId: 's1', timestamp: '2026-10-14T00:00:00Z', cwd: 'D:/p', ...record });
const prompt = (uuid: string, text: string) => claudeLine({ type: 'user', uuid, message: { role: 'user', content: text } });
const reply = (uuid: string, messageId: string, text: string) => claudeLine({ type: 'assistant', uuid, message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] } });

test('Claude: the last assistant message of each turn', () => {
  const answers = claudeFinalAnswers([
    prompt('p1', '修一下 bug'),
    reply('a1', 'msg-1', '我先看看。'),
    reply('a2', 'msg-2', '修好了。'),
    prompt('p2', '再提交'),
    claudeLine({ type: 'user', uuid: 'i1', message: { role: 'user', content: '[Request interrupted by user]' } })
  ]);
  assert.equal(answers.get('p1'), '修好了。');
  assert.equal(answers.get('p2'), '（本轮被用户中断，未产生最终答复）');
});

test('a prompt recorded before capture stopped gets its final answer on the next start', () => {
  const db = database();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  const day = path.join(root, '2026', '10', '14');
  fs.mkdirSync(day, { recursive: true });
  // Recorded live: the prompt, plus an older turn that already has its answer.
  persistAiMessage(db, 'codex', { id: 'u1', role: 'user', text: '帮我修采集', turnId: 't1', sessionId: 'sess-1', cwd: 'D:/p' });
  persistAiMessage(db, 'codex', { id: 'u0', role: 'user', text: '旧问题', turnId: 't0', sessionId: 'sess-1', cwd: 'D:/p' });
  persistAiMessage(db, 'codex', { id: 'm0', role: 'assistant', text: '旧答复', turnId: 't0', sessionId: 'sess-1', cwd: 'D:/p' });
  // The answers were written while recording was off.
  fs.writeFileSync(path.join(day, 'rollout-2026-10-14T10-00-00-sess-1.jsonl'), [
    desktopAnswer('t0', 'm0b', '日志里的旧答复'),
    desktopAnswer('t1', 'm1', '已修复：回答会被补齐。')
  ].join('\n') + '\n');

  assert.equal(backfillAiAnswers(db, 'codex', [root]), 1);
  const rows = db.prepare("SELECT source_turn_id turn, codex_prompt prompt, codex_response answer FROM events ORDER BY source_turn_id").all() as Array<Record<string, string>>;
  assert.deepEqual(rows.map(row => [row.turn, row.prompt, row.answer]), [
    ['t0', '旧问题', '旧答复'],
    ['t1', '帮我修采集', '已修复：回答会被补齐。']
  ]);
  assert.equal(backfillAiAnswers(db, 'codex', [root]), 0, 'nothing left to fill');
});

test('turns older than the backfill window or without a log are left alone', () => {
  const db = database();
  persistAiMessage(db, 'claude', { id: 'p1', role: 'user', text: '问题', turnId: 'p1', sessionId: 'missing', cwd: '' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  assert.equal(backfillAiAnswers(db, 'claude', [root]), 0);
  assert.equal(backfillAiAnswers(db, 'claude', [root], Date.now() + 365 * 86_400_000), 0);
});
