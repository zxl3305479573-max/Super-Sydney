import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  chosenDefaultSubdirectionName, createContentTask, getContentTask, listContentTasks, migrateContentTables,
  adoptAccountProfile, readTaxonomy, saveTaxonomyTree, seedContentTaxonomy, updateContentTask
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

test('内容方向的配图模板随分类树保存与读取', () => {
  const db = new DatabaseSync(':memory:');
  migrateContentTables(db);
  saveTaxonomyTree(db, [{ name: '科技', note: '', imagePrompt: ' 扁平插画 ', subdirections: [{ name: 'AI 硬件', imagePrompt: '产品特写' }, { name: '手机' }] }]);
  const [direction] = readTaxonomy(db).directions;
  assert.equal(direction.imagePrompt, '扁平插画');
  assert.deepEqual(direction.subdirections.map(sub => sub.imagePrompt), ['产品特写', '']);
});

test('公众号资料字段随分类树保存；升级时专属字段只迁给默认资料，通用字段每份一份', () => {
  const db = new DatabaseSync(':memory:');
  assert.equal(migrateContentTables(db), true, '新库首次建表要报告补了资料列');
  assert.equal(migrateContentTables(db), false, '再次迁移不能重复触发');
  saveTaxonomyTree(db, [
    { name: '健康', subdirections: [{ name: '饮食' }] },
    { name: 'AI技术', subdirections: [{ name: '大模型' }] }
  ]);
  adoptAccountProfile(db, {
    name: '健康号', industry: '健康', author: 'TODO', targetAudience: '中老年', tone: '平和', voice: '邻居',
    persona: 'elder', theme: 'elder-clear', wordCount: '1500', contentStyle: '干货', defaultTopic: '饮食',
    blacklistWords: ['震惊'], blacklistTopics: ['赌博']
  }, '雪梨');
  const [health, ai] = readTaxonomy(db).directions;
  assert.deepEqual([health.accountName, health.audience, health.persona, health.theme], ['健康号', '中老年', 'elder', 'elder-clear']);
  assert.deepEqual([ai.accountName, ai.audience, ai.persona, ai.theme], ['', '', '', '']);
  assert.match(health.imagePrompt, /医疗符号/, '原来那份资料保留旧默认配图模板');
  assert.equal(ai.imagePrompt, '', '新资料用通用默认，不继承医疗禁忌');
  for (const profile of [health, ai]) {
    assert.equal(profile.author, '雪梨', 'config.yaml 的草稿署名优先于 style.yaml 的占位署名');
    assert.deepEqual([profile.wordCount, profile.contentStyle], ['1500', '干货']);
    assert.deepEqual([profile.blacklistWords, profile.blacklistTopics], [['震惊'], ['赌博']]);
  }

  // 之后各改各的：保存时列表去重去空，互不影响
  saveTaxonomyTree(db, [
    { ...health, subdirections: health.subdirections },
    { ...ai, audience: ' 程序员 ', blacklistWords: ['标题党', ' 标题党 ', ''], subdirections: ai.subdirections }
  ]);
  const [healthAfter, aiAfter] = readTaxonomy(db).directions;
  assert.equal(aiAfter.audience, '程序员');
  assert.deepEqual(aiAfter.blacklistWords, ['标题党']);
  assert.deepEqual(healthAfter.blacklistWords, ['震惊']);
});
