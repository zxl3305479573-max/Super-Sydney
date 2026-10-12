import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  chosenDefaultSubdirectionName, createContentTask, getContentTask, listContentTasks, migrateContentTables,
  readTaxonomy, saveTaxonomyTree, seedContentTaxonomy, updateContentTask
} from '../services/content-store.ts';
import { DEFAULT_DIRECTION_NAME, DEFAULT_SUBDIRECTIONS } from '../services/content-taxonomy.ts';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateContentTables(db);
  seedContentTaxonomy(db);
  return db;
}

test('首次启动写入默认方向与 4 个具体方向，重复 seed 不会重复插入', () => {
  const db = database();
  seedContentTaxonomy(db);
  const taxonomy = readTaxonomy(db);
  assert.equal(taxonomy.directions.length, 1);
  assert.equal(taxonomy.directions[0].name, DEFAULT_DIRECTION_NAME);
  assert.deepEqual(taxonomy.directions[0].subdirections.map(item => item.name), DEFAULT_SUBDIRECTIONS);
});

test('readTaxonomy 按 style.yaml 的 default_topic 选默认具体方向', () => {
  const db = database();
  const taxonomy = readTaxonomy(db, '身心健康与作息');
  const chosen = taxonomy.directions[0].subdirections.find(item => item.id === taxonomy.defaultSubdirectionId);
  assert.equal(chosen?.name, '身心健康与作息');
});

test('老库：补齐分类列，并把旧 category 迁移到对应的二级方向', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE content_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idea', brief_json TEXT NOT NULL DEFAULT '', claims_json TEXT NOT NULL DEFAULT '',
    topics_json TEXT NOT NULL DEFAULT '', draft TEXT NOT NULL DEFAULT '', final_article TEXT NOT NULL DEFAULT '', review_json TEXT NOT NULL DEFAULT '',
    cover_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.prepare("INSERT INTO content_tasks (category, topic, created_at, updated_at) VALUES ('wellbeing', '午睡', '2026-01-01', '2026-01-01')").run();
  migrateContentTables(db);
  seedContentTaxonomy(db);
  const task = getContentTask(db, 1);
  assert.equal(task.directionName, DEFAULT_DIRECTION_NAME);
  assert.equal(task.subdirectionName, '身心健康与作息');
});

test('新建任务：只传二级方向时自动带出一级方向', () => {
  const db = database();
  const taxonomy = readTaxonomy(db);
  const sub = taxonomy.directions[0].subdirections[1];
  const task = createContentTask(db, taxonomy, null, sub.id, '  早睡  ');
  assert.equal(task.directionId, taxonomy.directions[0].id);
  assert.equal(task.subdirectionId, sub.id);
  assert.equal(task.topic, '早睡');
  assert.equal(task.status, 'idea');
  assert.throws(() => createContentTask(db, taxonomy, null, 999, ''), /具体方向已经不存在/);
});

test('updateContentTask 只写白名单字段并刷新 updated_at', () => {
  const db = database();
  const created = createContentTask(db, readTaxonomy(db), null, null, '');
  const updated = updateContentTask(db, created.id, { title: '标题', id: 42, bogus: 'x' } as never);
  assert.equal(updated.id, created.id);
  assert.equal(updated.title, '标题');
  assert.ok(updated.updatedAt >= created.updatedAt);
  assert.equal(listContentTasks(db).length, 1);
});

test('保存分类树：增改删，有任务引用的方向不允许删除', () => {
  const db = database();
  const taxonomy = readTaxonomy(db);
  const [direction] = taxonomy.directions;
  const keep = direction.subdirections[0];
  createContentTask(db, taxonomy, null, keep.id, '');
  saveTaxonomyTree(db, [{ id: direction.id, name: direction.name, note: '', subdirections: [{ id: keep.id, name: '饮食', note: '' }, { name: '新栏目', note: '' }] }]);
  const saved = readTaxonomy(db);
  assert.deepEqual(saved.directions[0].subdirections.map(item => item.name), ['饮食', '新栏目']);
  assert.throws(() => saveTaxonomyTree(db, [{ name: '科技', note: '', subdirections: [{ name: '数码', note: '' }] }]), /还有 1 篇文章/);
});

test('chosenDefaultSubdirectionName 优先用户指定，无效时兜底', () => {
  const db = database();
  const taxonomy = readTaxonomy(db);
  const second = taxonomy.directions[0].subdirections[1];
  assert.equal(chosenDefaultSubdirectionName(taxonomy, second.id), second.name);
  assert.equal(chosenDefaultSubdirectionName(taxonomy, 999), taxonomy.directions[0].subdirections[0].name);
});
