import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGeneratedImages, buildImagePrompt, collectTaskAssets, countInlineImages, insertImages, listInlineImages, matchImageLine, planCoverAndInlineImages, planImageSlots } from '../services/content-images.ts';

const article = [
  '# 柚子怎么吃更稳妥',
  '',
  '很多人把柚子当成降糖水果，其实它和某些常用药一起吃会出问题。这篇把常见疑问讲清楚。',
  '',
  '## 柚子会影响哪些药',
  '',
  '柚子会抑制肠道里的一种代谢酶，让部分药物在体内浓度升高，常见于降压药、他汀类降脂药等，具体请咨询医生或药师。',
  '',
  '- 降压药',
  '- 他汀类降脂药',
  '',
  '## 一天吃多少合适',
  '',
  '血糖控制稳定的人，把柚子当成一份水果即可，大约两三瓣，分次吃比一次吃完更稳妥，同时注意监测血糖变化。',
  '',
  '## 常见误区',
  '',
  '有人相信柚子能抗癌、排毒，这些说法没有可靠依据，不要用它替代药物和正规治疗。',
  ''
].join('\n');

test('image lines are parsed with or without angle brackets', () => {
  assert.deepEqual(matchImageLine('![导语](<C:/a b/c.png>)'), { caption: '导语', source: 'C:/a b/c.png' });
  assert.deepEqual(matchImageLine('![](/tmp/x.jpg)'), { caption: '', source: '/tmp/x.jpg' });
  assert.equal(matchImageLine('![说明]( )'), null);
  assert.equal(matchImageLine('普通段落'), null);
  assert.equal(matchImageLine('<img src=x>'), null);
  assert.deepEqual(listInlineImages('![a](<1.png>)\n正文\n![b](<2.png>)'), [{ caption: 'a', source: '1.png' }, { caption: 'b', source: '2.png' }]);
  assert.equal(countInlineImages('没有图片'), 0);
});

test('slots cover the lead paragraph and each section', () => {
  const slots = planImageSlots(article, 5);
  assert.deepEqual(slots.map(slot => slot.heading), ['导语', '柚子会影响哪些药', '一天吃多少合适', '常见误区']);
  for (const slot of slots) assert.ok(article.split('\n')[slot.afterLine].trim().length > 0);
});

test('too many sections are thinned out to the requested count and stay ordered', () => {
  const slots = planImageSlots(article, 2);
  assert.equal(slots.length, 2);
  assert.deepEqual([...slots].sort((a, b) => a.afterLine - b.afterLine), slots);
  const lines = article.split('\n');
  assert.ok(lines[slots[0].afterLine].trim().length > 0);
  assert.ok(lines[slots[1].afterLine].trim().length > 0);
});

test('inserting images keeps paragraph order and normalises captions', () => {
  const lines = article.split('\n');
  const firstParagraphEnd = 2;
  const secondSectionEnd = lines.findIndex(line => line.startsWith('有人相信柚子'));
  const updated = insertImages(article, [
    { afterLine: firstParagraphEnd, caption: '导语[配图]', path: 'C:/a b/one.png' },
    { afterLine: secondSectionEnd, caption: '常见误区', path: 'C:/two.png' }
  ]);
  const result = updated.split('\n');
  assert.deepEqual(result.slice(firstParagraphEnd + 1, firstParagraphEnd + 4), ['', '![导语配图](<C:/a b/one.png>)', '']);
  const images = listInlineImages(updated);
  assert.deepEqual(images.map(image => image.source), ['C:/a b/one.png', 'C:/two.png']);
  // 正文内容没有被破坏
  assert.match(updated, /## 常见误区/);
  assert.match(updated, /不要用它替代药物和正规治疗/);
});

test('prompt keeps the health-compliance guards', () => {
  const prompt = buildImagePrompt({ articleTitle: '柚子怎么吃', heading: '常见误区', excerpt: '柚子不能抗癌' });
  assert.match(prompt, /柚子怎么吃/);
  assert.match(prompt, /常见误区/);
  assert.match(prompt, /不要出现任何文字/);
  assert.match(prompt, /不要夸大疗效/);
});

test('task assets expose the cover plus every inline image for the UI', () => {
  const withImages = insertImages(article, [{ afterLine: 2, caption: '导语', path: 'C:/one.png' }]);
  assert.deepEqual(collectTaskAssets({ coverPath: 'C:/cover.png', draft: withImages }), {
    cover: 'C:/cover.png',
    images: [{ caption: '导语', source: 'C:/one.png' }]
  });
  assert.deepEqual(collectTaskAssets({ coverPath: '  ', draft: '没有图的正文' }), { cover: '', images: [] });
});

test('封面 + 配图一次生成时，正文为空或太短就只出封面并说明原因', () => {
  const empty = planCoverAndInlineImages('  \n ', 3);
  assert.equal(empty.withInline, false);
  assert.deepEqual(empty.slots, []);
  assert.match(empty.note, /只生成了封面/);

  const tooShort = planCoverAndInlineImages('## 小标题\n\n太短了。\n', 3);
  assert.equal(tooShort.withInline, false);
  assert.match(tooShort.note, /只生成了封面/);

  const normal = planCoverAndInlineImages(article, 3);
  assert.equal(normal.withInline, true);
  assert.equal(normal.note, '');
  assert.ok(normal.slots.length > 0);
});

test('并发生成里失败的配图被跳过，成功的那几张照常插进正文', () => {
  const slots = planImageSlots(article, 3);
  assert.ok(slots.length >= 2);
  const paths = slots.map((_slot, index) => index === 1 ? null : `C:/img-${index}.png`);
  const merged = applyGeneratedImages(article, slots, paths);
  assert.equal(merged.inserted, slots.length - 1);
  assert.equal(merged.failed, 1);
  const inserted = listInlineImages(merged.draft);
  assert.equal(inserted.length, slots.length - 1);
  assert.ok(inserted.every(image => !image.source.includes('img-1.png')));
  // 正文内容没有被破坏
  assert.match(merged.draft, /## 常见误区/);
});
