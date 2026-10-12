import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContentTask } from '../shared.ts';
import { exportContentArticle, parseContentSources } from '../services/content-export.ts';
import { prepareContentEdit } from '../services/content-policy.ts';

function article(overrides: Partial<ContentTask> = {}): ContentTask {
  return { id: 17, category: 'nutrition', topic: '蔬菜', title: '蔬菜怎么吃', status: 'ready', briefJson: '', claimsJson: '', sourcesJson: '', topicsJson: '', draft: '已经审稿的正文', finalArticle: '已经审稿的正文', reviewJson: '{"decision":"pass"}', coverPath: '', theme: '', publishJson: '', exportPath: '', createdAt: '', updatedAt: '', ...overrides };
}

test('source records stay user-provided rather than automatically verified', () => {
  const sources = parseContentSources(JSON.stringify({ sources: [{ title: '膳食指南', url: 'https://example.org/guide', excerpt: '原文摘录', status: 'verified' }] }));
  assert.equal(sources[0].status, 'user_provided');
  assert.equal(sources[0].excerpt, '原文摘录');
  assert.deepEqual(parseContentSources(''), []);
});

test('sources reject malformed records and credential-bearing links', () => {
  assert.throws(() => parseContentSources('not JSON'), /JSON/);
  assert.throws(() => parseContentSources('{"sources":[{}]}'), /文本/);
  assert.throws(() => parseContentSources('{"sources":[{"title":"","url":"","excerpt":""}]}'), /为空/);
  for (const url of ['file:///secret.txt', 'https://user:password@example.org', 'javascript:alert(1)']) {
    assert.throws(() => parseContentSources(JSON.stringify({ sources: [{ title: '资料', url, excerpt: '' }] })), /HTTP|凭证/);
  }
});

test('changing source material invalidates the reviewed article', () => {
  const patch = prepareContentEdit(article(), { sourcesJson: '{"sources":[]}' });
  assert.equal(patch.finalArticle, '');
  assert.equal(patch.reviewJson, '');
  assert.equal(patch.status, 'draft');
});

test('repeated exports create distinct notes and cover copies without overwriting manual content', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-content-export-'));
  try {
    const vault = path.join(directory, 'vault');
    const cover = path.join(directory, 'cover.png');
    fs.writeFileSync(cover, 'simulated image');
    const task = article({ title: '标题/含:特殊字符', coverPath: cover, sourcesJson: JSON.stringify({ sources: [{ title: '营养指南', url: 'https://example.org/guide', excerpt: '需要保留的摘录' }] }) });
    const first = exportContentArticle(vault, task);
    fs.appendFileSync(first, '\n用户手写补充');
    const second = exportContentArticle(vault, task);
    assert.notEqual(first, second);
    assert.equal(path.dirname(first), path.join(vault, '06-公众号'));
    assert.match(fs.readFileSync(first, 'utf8'), /用户手写补充/);
    const output = fs.readFileSync(second, 'utf8');
    assert.match(output, /已经审稿的正文/);
    assert.match(output, /需要保留的摘录/);
    assert.match(output, /未自动联网核实/);
    assert.match(output, /assets\//);
    assert.equal(fs.readdirSync(path.join(vault, '06-公众号', 'assets')).length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('inline images are copied into the vault and linked relatively', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-content-inline-'));
  try {
    const vault = path.join(directory, 'vault');
    const imagePath = path.join(directory, 'inline.png');
    fs.writeFileSync(imagePath, 'image-bytes');
    const body = `正文段落\n\n![配图说明](<${imagePath}>)\n\n结尾段落`;
    const target = exportContentArticle(vault, article({ draft: body, finalArticle: body }));
    const output = fs.readFileSync(target, 'utf8');
    assert.ok(!output.includes(imagePath), '导出笔记里不应再出现本机绝对路径');
    assert.match(output, /!\[配图说明\]\(<assets\/[^>]+>\)/);
    assert.equal(fs.readdirSync(path.join(vault, '06-公众号', 'assets')).length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a missing inline image blocks the export instead of writing a broken note', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-content-missing-'));
  try {
    const vault = path.join(directory, 'vault');
    const body = `正文段落\n\n![配图说明](<${path.join(directory, 'gone.png')}>)`;
    assert.throws(() => exportContentArticle(vault, article({ draft: body, finalArticle: body })), /配图不存在/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('stale review is rejected before writing a note', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-content-stale-'));
  try {
    const vault = path.join(directory, 'vault');
    assert.throws(() => exportContentArticle(vault, article({ draft: '新正文' })), /审稿/);
    assert.equal(fs.existsSync(vault), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('unreviewed export writes the current draft and marks the note as not reviewed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-content-unreviewed-'));
  try {
    const vault = path.join(directory, 'vault');
    const task = article({ draft: '待审的正文', finalArticle: '', reviewJson: '{"decision":"revise","required_changes":["补来源"]}', status: 'review' });
    assert.throws(() => exportContentArticle(vault, task), /审稿/);
    const target = exportContentArticle(vault, task, { allowUnreviewed: true });
    const output = fs.readFileSync(target, 'utf8');
    assert.match(output, /待审的正文/);
    assert.match(output, /reviewed: false/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
