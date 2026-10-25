import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { XhsNote } from '../shared.ts';
import { exportXhsPackage } from '../services/xhs-export.ts';
import {
  createXhsAccount, createXhsNote, createXhsReport, deleteXhsReport, deleteXhsStat, getXhsAccount, listXhsAccounts, listXhsReports, listXhsStats,
  migrateXhsTables, updateXhsAccount, upsertXhsStats
} from '../services/xhs-store.ts';
import { emptyXhsMetrics } from '../services/xhs-stats.ts';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-xhs-')); }

function note(patch: Partial<XhsNote>): XhsNote {
  return {
    id: 3, accountId: 1, topic: 't', noteType: 'tutorial', material: '', title: '冬天护膝/怎么选', body: '正文第一行\n第二行', tagsJson: JSON.stringify(['护膝', '冬季']), sourceJson: '', status: 'visual',
    writerJson: '', titleCandidatesJson: '', checksJson: JSON.stringify({ items: [{ id: 'title_length', label: '标题不超过 20 字', ok: true, level: 'error', detail: '7 字', source: 'local' }], checkedAt: '', modelError: '' }),
    cardsJson: '', coverPath: '', imagesJson: '', candidatesJson: '', basisJson: '', exportPath: '', createdAt: '', updatedAt: '', ...patch
  };
}

test('发布包：封面 01、图组按顺序编号，笔记.md 含标题正文标签与检测；重复导出不覆盖', () => {
  const dir = tempDir();
  const cover = path.join(dir, 'cover.png');
  const card = path.join(dir, 'card.png');
  const local = path.join(dir, 'photo.JPG');
  for (const file of [cover, card, local]) fs.writeFileSync(file, file);
  const vault = path.join(dir, 'vault');
  const item = note({ coverPath: cover, imagesJson: JSON.stringify([{ path: local, source: 'local', caption: '' }, { path: card, source: 'card', caption: '' }]) });
  const first = exportXhsPackage(vault, item);
  assert.ok(first.includes(`${path.sep}08-小红书${path.sep}`));
  assert.ok(path.basename(first).endsWith('冬天护膝 怎么选'), '标题里的非法字符被替换');
  assert.deepEqual(fs.readdirSync(first).sort(), ['01.png', '02.jpg', '03.png', '笔记.md']);
  assert.equal(fs.readFileSync(path.join(first, '02.jpg'), 'utf8'), local);
  const markdown = fs.readFileSync(path.join(first, '笔记.md'), 'utf8');
  assert.match(markdown, /正文第一行\n第二行/);
  assert.match(markdown, /#护膝 #冬季/);
  assert.match(markdown, /✓ 标题不超过 20 字：7 字/);
  assert.match(markdown, /不代发布/);
  const second = exportXhsPackage(vault, item);
  assert.notEqual(first, second);
});

test('发布包：缺门槛报错；图片丢失时报错且不留半个目录', () => {
  const dir = tempDir();
  const vault = path.join(dir, 'vault');
  assert.throws(() => exportXhsPackage(vault, note({ coverPath: '' })), /至少添加一张图片/);
  assert.throws(() => exportXhsPackage('', note({ coverPath: 'x' })), /知识库/);
  const cover = path.join(dir, 'cover.png');
  fs.writeFileSync(cover, 'x');
  assert.throws(() => exportXhsPackage(vault, note({ coverPath: cover, imagesJson: JSON.stringify([{ path: path.join(dir, 'gone.png'), source: 'card', caption: '' }]) })), /不存在：gone\.png/);
  assert.equal(fs.existsSync(path.join(vault, '08-小红书')), false);
});

test('发布包：没有独立封面时用图组首图，封面与图组同一路径只导出一次', () => {
  const dir = tempDir();
  const first = path.join(dir, 'card-cover.png');
  const second = path.join(dir, 'card-2.png');
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');
  const vault = path.join(dir, 'vault');
  const images = [{ path: first, source: 'card' as const, caption: '第 1 页' }, { path: second, source: 'card' as const, caption: '第 2 页' }];
  const fallback = exportXhsPackage(vault, note({ coverPath: '', imagesJson: JSON.stringify(images) }));
  assert.deepEqual(fs.readdirSync(fallback).sort(), ['01.png', '02.png', '笔记.md']);
  assert.equal(fs.readFileSync(path.join(fallback, '01.png'), 'utf8'), 'first');
  assert.match(fs.readFileSync(path.join(fallback, '笔记.md'), 'utf8'), /1\. 01\.png（封面）/);

  const deduped = exportXhsPackage(vault, note({ coverPath: first, imagesJson: JSON.stringify(images) }));
  assert.deepEqual(fs.readdirSync(deduped).sort(), ['01.png', '02.png', '笔记.md']);
  assert.equal(fs.readFileSync(path.join(deduped, '01.png'), 'utf8'), 'first');
});

test('迁移给早期建的表补列，数据保留', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE xhs_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', positioning_json TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE xhs_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, topic TEXT NOT NULL DEFAULT '', note_type TEXT NOT NULL DEFAULT 'tutorial', title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '', source_json TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idea', title_candidates_json TEXT NOT NULL DEFAULT '', checks_json TEXT NOT NULL DEFAULT '', images_json TEXT NOT NULL DEFAULT '', export_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO xhs_accounts (name, created_at, updated_at) VALUES ('旧账号', 'a', 'a');
    INSERT INTO xhs_notes (account_id, topic, created_at, updated_at) VALUES (1, '旧选题', 'a', 'a');`);
  migrateXhsTables(db);
  migrateXhsTables(db);
  const account = listXhsAccounts(db)[0];
  assert.equal(account.name, '旧账号');
  const row = db.prepare('SELECT * FROM xhs_notes WHERE id=1').get() as Record<string, unknown>;
  assert.equal(row.topic, '旧选题');
  assert.equal(row.cover_path, '');
  assert.equal(row.material, '');
  assert.equal(updateXhsAccount(db, account.id, { positioningChatJson: '[]' }).positioningChatJson, '[]');
});

test('报告与笔记数据：同标题同日期再次导入是更新，可关联笔记与删除', () => {
  const db = new DatabaseSync(':memory:');
  migrateXhsTables(db);
  const account = listXhsAccounts(db)[0];
  const created = createXhsNote(db, account.id, '护膝', null, 'list');
  assert.equal(created.noteType, 'list');
  const metrics = { ...emptyXhsMetrics(), views: 100 };
  assert.deepEqual(upsertXhsStats(db, account.id, [{ title: '冬天护膝', publishDate: '2026-10-08', metrics }], () => created.id), { added: 1, updated: 0 });
  assert.deepEqual(upsertXhsStats(db, account.id, [{ title: '冬天 护膝', publishDate: '2026-10-08', metrics: { ...metrics, views: 200 } }], () => null), { added: 0, updated: 1 });
  const stats = listXhsStats(db, account.id);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].metrics.views, 200);
  const second = createXhsAccount(db, '副号');
  assert.throws(() => deleteXhsStat(db, second.id, stats[0].id), /另一个小红书账号/);
  assert.equal(deleteXhsStat(db, account.id, stats[0].id), account.id);
  assert.throws(() => deleteXhsStat(db, account.id, 999), /不存在/);
  const audit = createXhsReport(db, account.id, 'audit', '自己 · x', { a: 1 }, { total: 7 });
  createXhsReport(db, account.id, 'analytics', '复盘', {}, { summary: 's' });
  assert.throws(() => deleteXhsReport(db, second.id, audit.id), /另一个小红书账号/);
  deleteXhsReport(db, account.id, audit.id);
  assert.equal(listXhsReports(db, account.id, 'audit').length, 0);
  assert.equal(JSON.parse(listXhsReports(db, account.id, 'analytics')[0].resultJson).summary, 's');
  assert.throws(() => getXhsAccount(db, 999), /账号不存在/);
});
