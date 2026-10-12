import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { confirmedEvents, getEvent, insertEvent, migrateEventTables, sanitizeEventInput, todayStats, updateEvent } from '../services/event-store.ts';

test('sanitizeEventInput 丢弃未知字段，校验状态、类型与计数', () => {
  assert.deepEqual(sanitizeEventInput({ note: '记一笔', status: 'approved', kind: 'manual', value_score: 2, id: 9, codex_prompt: 'x' }),
    { note: '记一笔', status: 'approved', kind: 'manual', value_score: 2 });
  assert.throws(() => sanitizeEventInput({ status: 'done' }), /状态/);
  assert.throws(() => sanitizeEventInput({ kind: 'email' }), /类型/);
  assert.throws(() => sanitizeEventInput({ note: 3 }), /note/);
  assert.throws(() => sanitizeEventInput({ value_score: 1.5 }), /非负整数/);
  assert.throws(() => sanitizeEventInput('x'), /事件格式/);
});

test('事件读写：插入、按白名单更新、确认后进入已确认列表', () => {
  const db = new DatabaseSync(':memory:');
  migrateEventTables(db);
  const id = insertEvent(db, { note: '写测试', created_at: new Date().toISOString() });
  assert.equal(getEvent(db, id)?.status, 'pending');
  updateEvent(db, id, { status: 'approved', summary: '完成' });
  assert.equal(confirmedEvents(db).length, 1);
  assert.equal(confirmedEvents(db)[0].summary, '完成');
  assert.equal(todayStats(db).total, 1);
});
