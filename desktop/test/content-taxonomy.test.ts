import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContentTaxonomy } from '../shared.ts';
import { DEFAULT_DIRECTION_NAME, DEFAULT_SUBDIRECTIONS, LEGACY_CATEGORY_NAMES, findSubdirection, normalizeTaxonomyInput, resolveDefaultSubdirection, subdirectionNames } from '../services/content-taxonomy.ts';

test('分类树归一化：去空格、保留 id、按输入顺序', () => {
  const normalized = normalizeTaxonomyInput([
    { id: 3, name: '  中老年健康科普  ', note: ' 不诊疗 ', subdirections: [{ id: 7, name: ' 饮食营养 ', note: '' }] },
    { name: '科技与数码', subdirections: [{ name: 'AI 硬件' }] }
  ]);
  assert.deepEqual(normalized[0], { id: 3, name: '中老年健康科普', note: '不诊疗', subdirections: [{ id: 7, name: '饮食营养', note: '' }] });
  assert.equal(normalized[1].id, undefined);
  assert.equal(normalized[1].subdirections[0].name, 'AI 硬件');
});

test('分类树归一化拒绝空名称、重名与空树', () => {
  assert.throws(() => normalizeTaxonomyInput([]), /至少保留一个内容方向/);
  assert.throws(() => normalizeTaxonomyInput([{ name: '  ', subdirections: [] }]), /还没有名称/);
  assert.throws(() => normalizeTaxonomyInput([{ name: 'A', subdirections: [{ name: 'x' }, { name: ' x ' }] }]), /重复/);
  assert.throws(() => normalizeTaxonomyInput([{ name: 'A', subdirections: [] }, { name: 'A', subdirections: [{ name: 'x' }] }]), /重复/);
  assert.throws(() => normalizeTaxonomyInput([{ name: 'A', subdirections: [] }]), /至少给一个内容方向加一个具体方向/);
  assert.throws(() => normalizeTaxonomyInput('nope'), /数组/);
});

const TAXONOMY: ContentTaxonomy = {
  directions: [
    { id: 1, name: '中老年健康科普', note: '', subdirections: [{ id: 11, name: '饮食营养与蔬果利弊', note: '' }, { id: 12, name: '身心健康与作息', note: '' }] },
    { id: 2, name: '科技与数码', note: '', subdirections: [{ id: 21, name: 'AI 硬件', note: '' }] }
  ],
  defaultSubdirectionId: 12
};

test('按 id 找到具体方向及其所属的一级方向', () => {
  const found = findSubdirection(TAXONOMY.directions, 21);
  assert.equal(found?.direction.name, '科技与数码');
  assert.equal(found?.subdirection.name, 'AI 硬件');
  assert.equal(findSubdirection(TAXONOMY.directions, 999), null);
  assert.equal(findSubdirection(TAXONOMY.directions, null), null);
});

test('默认具体方向：先按 id，再按 style.yaml 里的名字，最后取第一个', () => {
  assert.deepEqual(resolveDefaultSubdirection(TAXONOMY), { directionId: 1, subdirectionId: 12, name: '身心健康与作息' });
  assert.deepEqual(resolveDefaultSubdirection({ ...TAXONOMY, defaultSubdirectionId: null }, 'AI 硬件'), { directionId: 2, subdirectionId: 21, name: 'AI 硬件' });
  assert.deepEqual(resolveDefaultSubdirection({ ...TAXONOMY, defaultSubdirectionId: null }, '不存在的方向'), { directionId: 1, subdirectionId: 11, name: '饮食营养与蔬果利弊' });
  assert.deepEqual(resolveDefaultSubdirection({ directions: [{ id: 3, name: '空方向', note: '', subdirections: [] }], defaultSubdirectionId: null }), { directionId: null, subdirectionId: null, name: '' });
});

test('写回 style.yaml 的 topics 是所有具体方向名（去重）', () => {
  const directions = [
    ...TAXONOMY.directions,
    { id: 4, name: '育儿', note: '', subdirections: [{ id: 41, name: 'AI 硬件', note: '' }] }
  ];
  assert.deepEqual(subdirectionNames(directions), ['饮食营养与蔬果利弊', '身心健康与作息', 'AI 硬件']);
});

test('旧版 4 个固定类目都映射到默认方向的二级方向', () => {
  assert.equal(DEFAULT_DIRECTION_NAME, '中老年健康科普');
  assert.deepEqual(Object.keys(LEGACY_CATEGORY_NAMES), ['nutrition', 'wellbeing', 'family', 'general']);
  for (const name of Object.values(LEGACY_CATEGORY_NAMES)) assert.ok(DEFAULT_SUBDIRECTIONS.includes(name));
});
