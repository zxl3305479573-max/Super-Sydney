import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLink, deleteLink, listLinks, markLinkOpened, migrateLinkTables, normalizeLinkUrl, sanitizeLinkInput, updateLink } from '../services/link-store.ts';

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateLinkTables(db);
  migrateLinkTables(db);
  return db;
}

test('链接没写协议时补 https，主机:端口不当成协议头', () => {
  assert.equal(normalizeLinkUrl(' example.com/post?id=1 '), 'https://example.com/post?id=1');
  assert.equal(normalizeLinkUrl('localhost:3000'), 'https://localhost:3000/');
  assert.equal(normalizeLinkUrl('HTTP://Example.COM'), 'http://example.com/');
});

test('非 http/https 链接一律拒绝', () => {
  assert.throws(() => normalizeLinkUrl('javascript:alert(1)'), /只支持 http 与 https/);
  assert.throws(() => normalizeLinkUrl('file:///C:/Windows/win.ini'), /只支持 http 与 https/);
  assert.throws(() => normalizeLinkUrl(''), /请先填写链接地址/);
});

test('标题留空用域名兜底，标签去掉井号、去重', () => {
  const link = sanitizeLinkInput({ url: 'https://docs.example.com/a', title: '  ', tags: ['#AI 工具', 'AI 工具', ' 教程 ', ''] });
  assert.equal(link.title, 'docs.example.com');
  assert.deepEqual(link.tags, ['AI 工具', '教程']);
  assert.throws(() => sanitizeLinkInput({ url: 'a.com', tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }), /标签最多/);
});

test('增删改查：新收藏排在前面，同一地址不能收藏两次', () => {
  const db = openDb();
  const first = createLink(db, { url: 'example.com/one', title: '第一篇', note: '回头细看', tags: ['教程'] });
  const second = createLink(db, { url: 'example.com/two' });
  assert.deepEqual(listLinks(db).map(link => link.id), [second.id, first.id]);
  assert.equal(first.openedAt, '');
  assert.throws(() => createLink(db, { url: 'https://example.com/one' }), /已经存过了：第一篇/);

  const updated = updateLink(db, first.id, { url: 'example.com/one', title: '改过的标题', tags: ['教程', 'AI'] });
  assert.equal(updated.title, '改过的标题');
  assert.deepEqual(updated.tags, ['教程', 'AI']);
  assert.equal(updated.note, '');
  assert.throws(() => updateLink(db, first.id, { url: 'example.com/two' }), /已经存过了/);

  assert.notEqual(markLinkOpened(db, first.id).openedAt, '');
  deleteLink(db, second.id);
  assert.deepEqual(listLinks(db).map(link => link.id), [first.id]);
  assert.throws(() => deleteLink(db, second.id), /不存在/);
});
