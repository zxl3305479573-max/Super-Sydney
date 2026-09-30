import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { EventDraft } from '../shared.ts';
import { applyAiDraft, clearAiDraft, migrateAiDraftColumns, saveAiDraft } from '../services/ai-draft-store.ts';

const draft: EventDraft = {
  what_done: '实现登录',
  why: '完成用户认证',
  tools: 'Codex',
  problems: '',
  solution: '增加认证流程',
  result: '登录可用',
  reuse: '沉淀为认证模板',
  category: '工作项目',
  content_candidate: true
};

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT '',
    window_title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '',
    duration_seconds INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
    value_score INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '个人成长'
  )`);
  migrateAiDraftColumns(db);
  return db;
}

test('migrates AI draft columns and stores, applies, and clears a draft without approving the event', () => {
  const db = database();
  const id = Number(db.prepare("INSERT INTO events (created_at, kind, status) VALUES ('2026-09-30T00:00:00Z', 'codex', 'pending')").run().lastInsertRowid);
  saveAiDraft(db, id, draft, 'deepseek-chat', '2026-09-30T01:00:00Z');
  let row = db.prepare('SELECT * FROM events WHERE id=?').get(id) as Record<string, unknown>;
  assert.equal(JSON.parse(String(row.ai_draft_json)).what_done, '实现登录');
  assert.equal(row.ai_draft_model, 'deepseek-chat');
  assert.equal(row.status, 'pending');
  applyAiDraft(db, id);
  row = db.prepare('SELECT * FROM events WHERE id=?').get(id) as Record<string, unknown>;
  assert.equal(row.summary, '登录可用');
  assert.equal(row.category, '工作项目');
  assert.equal(row.status, 'pending');
  clearAiDraft(db, id);
  row = db.prepare('SELECT * FROM events WHERE id=?').get(id) as Record<string, unknown>;
  assert.equal(row.ai_draft_json, '');
  assert.equal(row.ai_draft_model, '');
  assert.equal(row.ai_drafted_at, '');
  assert.equal(row.status, 'pending');
});

test('applying a missing or invalid draft does not change the event', () => {
  const db = database();
  const id = Number(db.prepare("INSERT INTO events (created_at, kind, status, summary, category) VALUES ('2026-09-30T00:00:00Z', 'codex', 'pending', '原摘要', '个人成长')").run().lastInsertRowid);
  assert.doesNotThrow(() => applyAiDraft(db, id));
  const row = db.prepare('SELECT summary, category, status FROM events WHERE id=?').get(id) as Record<string, unknown>;
  assert.equal(row.summary, '原摘要');
  assert.equal(row.category, '个人成长');
  assert.equal(row.status, 'pending');
});
