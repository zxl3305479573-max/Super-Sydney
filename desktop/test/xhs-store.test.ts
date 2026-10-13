import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { XhsHotNote, XhsHotspotResult, XhsNoteStatus } from '../shared.ts';
import { createXhsNote, deleteXhsNote, getXhsNote, listXhsAccounts, listXhsNotes, migrateXhsTables, readHotspotCache, updateXhsAccount, updateXhsNote, writeHotspotCache } from '../services/xhs-store.ts';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateXhsTables(db);
  return db;
}

const HOT: XhsHotNote = {
  id: 'n1', title: '冬天护膝怎么选', desc: '正文'.repeat(400), cover: 'c', link: 'https://www.xiaohongshu.com/explore/n1', createTime: '2026-10-08 17:50:27', topics: ['护膝'],
  author: { id: 'a1', nickname: '膝盖小课堂', fans: 100 }, interactive: 10, liked: 5, collected: 3, comments: 1, shared: 1, score: null
};

test('迁移可重复执行，且只建一个默认账号', () => {
  const db = database();
  migrateXhsTables(db);
  const accounts = listXhsAccounts(db);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].name, '我的小红书号');
  assert.equal(updateXhsAccount(db, accounts[0].id, { name: ' 银发健康 ' }).name, '银发健康');
  assert.throws(() => updateXhsAccount(db, accounts[0].id, { name: ' ' }), /账号名不能为空/);
  assert.throws(() => updateXhsAccount(db, 999, {}), /账号不存在/);
});

test('从热点笔记建选题：默认用其标题，来源只留选题字段并截断正文', () => {
  const db = database();
  const account = listXhsAccounts(db)[0];
  const note = createXhsNote(db, account.id, '  ', HOT);
  assert.equal(note.topic, '冬天护膝怎么选');
  assert.equal(note.status, 'idea');
  assert.equal(note.noteType, 'tutorial');
  const source = JSON.parse(note.sourceJson);
  assert.equal(source.desc.length, 500);
  assert.equal(source.cover, undefined);
  assert.equal(createXhsNote(db, account.id, '自己的选题').sourceJson, '');
  assert.throws(() => createXhsNote(db, 999, 'x'), /账号不存在/);
  assert.equal(listXhsNotes(db, account.id).length, 2);
});

test('updateXhsNote 只写白名单字段并校验状态与类型', () => {
  const db = database();
  const note = createXhsNote(db, listXhsAccounts(db)[0].id, '选题');
  const updated = updateXhsNote(db, note.id, { body: '正文', status: 'body', noteType: 'story', accountId: 42, bogus: 1 } as never);
  assert.equal(updated.body, '正文');
  assert.equal(updated.status, 'body');
  assert.equal(updated.noteType, 'story');
  assert.equal(updated.accountId, note.accountId);
  assert.throws(() => updateXhsNote(db, note.id, { status: 'published' as XhsNoteStatus }), /未知的笔记状态/);
  deleteXhsNote(db, note.id);
  assert.throws(() => getXhsNote(db, note.id), /笔记不存在/);
});

test('热点缓存 24 小时内命中，过期或损坏视为未命中', () => {
  const db = database();
  const fetchedAt = '2026-10-13T02:00:00.000Z';
  const result = { source: 'redfox', keyword: '护膝', startDate: '2026-10-06', endDate: '', total: 1, notes: [HOT], latest: [], relatedSearches: [], hotTopics: [], tips: '', fetchedAt, cached: false } satisfies XhsHotspotResult;
  writeHotspotCache(db, 'k', result);
  const hit = readHotspotCache(db, 'k', new Date('2026-10-13T20:00:00.000Z'));
  assert.equal(hit?.cached, true);
  assert.equal(hit?.notes[0].id, 'n1');
  assert.equal(readHotspotCache(db, 'k', new Date('2026-10-14T03:00:00.000Z')), null);
  assert.equal(readHotspotCache(db, 'other'), null);
  db.prepare("UPDATE xhs_hotspot_cache SET result_json='{' WHERE cache_key='k'").run();
  assert.equal(readHotspotCache(db, 'k', new Date('2026-10-13T03:00:00.000Z')), null);
});

test('写缓存时清理过期条目', () => {
  const db = database();
  const base: Omit<XhsHotspotResult, 'fetchedAt'> = { source: 'redfox', keyword: '', startDate: '', endDate: '', total: 0, notes: [], latest: [], relatedSearches: [], hotTopics: [], tips: '', cached: false };
  writeHotspotCache(db, 'old', { ...base, fetchedAt: '2026-10-10T00:00:00.000Z' });
  writeHotspotCache(db, 'new', { ...base, fetchedAt: '2026-10-13T00:00:00.000Z' });
  const keys = (db.prepare('SELECT cache_key FROM xhs_hotspot_cache').all() as Array<{ cache_key: string }>).map(row => row.cache_key);
  assert.deepEqual(keys, ['new']);
});
