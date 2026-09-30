const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

test('event store supports pending review and confirmation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, note TEXT, status TEXT DEFAULT \'pending\')');
  db.prepare('INSERT INTO events (note) VALUES (?)').run('拆解 Agent 调试问题');
  assert.equal(db.prepare('SELECT status FROM events WHERE id = 1').get().status, 'pending');
  db.prepare('UPDATE events SET status = ? WHERE id = 1').run('approved');
  assert.equal(db.prepare('SELECT status FROM events WHERE id = 1').get().status, 'approved');
});

test('weekly summary window can be calculated from ISO timestamps', () => {
  const now = new Date('2026-09-30T10:00:00.000Z');
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  assert.equal(sevenDaysAgo.toISOString().slice(0, 10), '2026-09-23');
});
