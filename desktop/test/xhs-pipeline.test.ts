import test from 'node:test';
import assert from 'node:assert/strict';
import type { XhsNote } from '../shared.ts';
import {
  AUTO_XHS_STAGES, assertXhsExportable, autoXhsPlan, buildXhsPipeline, checksPassed, countChars, currentXhsStepKey, deriveXhsStatus, findRiskWords, fingerprint, localChecks,
  addCandidates, mergeCheckItems, normalizeTags, pickAutoXhsTitle, prepareXhsEdit, readCandidates, readCardPlan, routeByRules, sortXhsNotesByCreation, stampBasis,
  xhsDraftContent, xhsExportChecklist, xhsPackageImagePaths, xhsStale
} from '../services/xhs-pipeline.ts';

function note(patch: Partial<XhsNote> = {}): XhsNote {
  return {
    id: 1, accountId: 1, topic: '', noteType: 'tutorial', material: '', title: '', body: '', tagsJson: '', sourceJson: '', status: 'idea',
    writerJson: '', titleCandidatesJson: '', checksJson: '', cardsJson: '', coverPath: '', imagesJson: '', candidatesJson: '', basisJson: '', exportPath: '',
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', ...patch
  };
}
const stateOf = (item: XhsNote, key: string) => buildXhsPipeline(item).find(step => step.key === key)!;

test('指纹稳定、内容一变就不同', () => {
  assert.equal(fingerprint('护膝'), fingerprint('护膝'));
  assert.notEqual(fingerprint('护膝'), fingerprint('护膝 '));
  assert.match(fingerprint(''), /^[0-9a-f]{8}$/);
});

test('内容创作顺序按创建时间排列，后续更新时间不改变序号', () => {
  const items = [
    note({ id: 8, createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-25T20:00:00.000Z' }),
    note({ id: 5, createdAt: '2026-10-18T08:00:00.000Z', updatedAt: '2026-10-18T09:00:00.000Z' }),
    note({ id: 6, createdAt: '2026-10-18T08:00:00.000Z', updatedAt: '2026-10-24T09:00:00.000Z' }),
    note({ id: 9, createdAt: '', updatedAt: '2026-10-26T09:00:00.000Z' })
  ];
  assert.deepEqual(sortXhsNotesByCreation(items).map(item => item.id), [5, 6, 8, 9]);
});

test('步骤按依赖解锁：选题 → 正文 → 标题 → 视觉 → 检测 → 发布包', () => {
  const empty = note();
  assert.equal(stateOf(empty, 'topic').state, 'current');
  assert.equal(stateOf(empty, 'body').state, 'locked');
  const withTopic = note({ topic: '冬天护膝' });
  assert.equal(stateOf(withTopic, 'body').state, 'current');
  assert.equal(stateOf(withTopic, 'title').state, 'locked');
  assert.match(stateOf(withTopic, 'title').reason, /先写好正文/);
  const full = note({ topic: 't', body: '正文', title: '标题', coverPath: 'c.png' });
  assert.equal(stateOf(full, 'visual').state, 'done');
  assert.equal(stateOf(full, 'checks').state, 'current');
  assert.equal(stateOf(full, 'package').state, 'ready');
  assert.equal(currentXhsStepKey(full), 'checks');
});

test('自动生成按当前状态续跑：正文 → 标题 → 检测，视觉与发布不自动执行', () => {
  assert.deepEqual(AUTO_XHS_STAGES, ['body', 'titles', 'checks']);
  assert.deepEqual(autoXhsPlan(note()), { ok: false, reason: '请先填写选题，再点自动生成' });
  assert.deepEqual(autoXhsPlan(note({ topic: 't' })), { ok: true, stages: ['body', 'titles', 'checks'] });

  let item = note({ topic: 't', body: '已经写好的正文' });
  item = { ...item, basisJson: stampBasis(item, 'body') };
  assert.deepEqual(autoXhsPlan(item), { ok: true, stages: ['titles', 'checks'] });

  item = note({ topic: 't', body: '正文', title: '标题', checksJson: JSON.stringify({ items: [], checkedAt: '', modelError: '' }) });
  item = { ...item, basisJson: stampBasis(item, 'body', 'title', 'checks') };
  assert.deepEqual(autoXhsPlan(item), { ok: true, stages: [] }, '全部最新时不重复花钱');

  const changedType = { ...item, noteType: 'story' as const };
  assert.deepEqual(autoXhsPlan(changedType), { ok: true, stages: ['body', 'titles', 'checks'] });

  const risky = { title: '最有效的护膝', method: 'number', scores: { search: 5, audience: 5, save: 5, hook: 5 }, total: 20, risks: ['绝对化用语'], role: 'primary' as const, reason: '' };
  const safe = { ...risky, title: '护膝怎么选？3 个要点', total: 18, risks: [], role: 'backup' as const };
  assert.equal(pickAutoXhsTitle({ candidates: [risky, safe], ab: [], keywords: [], generatedAt: '' })?.title, safe.title, '自动采用时优先避开合规风险');
});

test('失效规则：改正文 → 标题与卡片需复核；改标题 → 封面需复核；换类型 → 正文需重写', () => {
  let item = note({ topic: 't', body: '旧正文', title: '标题', coverPath: 'c.png', imagesJson: JSON.stringify([{ path: 'card.png', source: 'card', caption: '' }]) });
  item = { ...item, basisJson: stampBasis(item, 'body', 'title', 'cover', 'cards') };
  assert.equal(stateOf(item, 'title').state, 'done');
  const bodyChanged = { ...item, body: '新正文' };
  assert.equal(xhsStale(bodyChanged, 'title'), true);
  assert.equal(stateOf(bodyChanged, 'title').state, 'attention');
  assert.match(stateOf(bodyChanged, 'visual').reason, /图文卡片/);
  const titleChanged = { ...item, title: '新标题' };
  assert.equal(stateOf(titleChanged, 'visual').state, 'attention');
  assert.match(stateOf(titleChanged, 'visual').reason, /封面/);
  const typeChanged = { ...item, noteType: 'story' as const };
  assert.equal(stateOf(typeChanged, 'body').state, 'attention');
  // 没有记录过指纹的产物不算过时（例如手写的正文）。
  assert.equal(xhsStale(note({ body: 'x' }), 'body'), false);
});

test('导出后再改内容，发布包需要重新导出；状态按内容推导', () => {
  let item = note({ topic: 't', body: '正文', title: '标题', coverPath: 'c.png', exportPath: 'D:/vault/x' });
  item = { ...item, basisJson: stampBasis(item, 'package') };
  assert.equal(deriveXhsStatus(item), 'packaged');
  assert.equal(stateOf(item, 'package').state, 'done');
  const edited = { ...item, body: '改过' };
  assert.equal(deriveXhsStatus(edited), 'visual');
  assert.equal(stateOf(edited, 'package').state, 'attention');
  assert.equal(deriveXhsStatus(note({ body: 'x' })), 'body');
  assert.equal(deriveXhsStatus(note({ body: 'x', title: 't' })), 'title');
});

test('编辑补丁：白名单、标签归一化、选标题时盖上当前正文指纹', () => {
  const base = note({ topic: 't', body: '正文' });
  const patch = prepareXhsEdit(base, { title: '新标题', tagsJson: JSON.stringify(['#护膝', '护膝', ' 冬天 养生 ']), exportPath: 'hack', coverPath: 'hack' } as Partial<XhsNote>);
  assert.equal(patch.title, '新标题');
  assert.deepEqual(JSON.parse(patch.tagsJson!), ['护膝', '冬天养生']);
  assert.equal(patch.exportPath, undefined);
  assert.equal(patch.coverPath, undefined);
  assert.equal(JSON.parse(patch.basisJson!).title, fingerprint('正文'));
  assert.equal(patch.status, 'title');
  assert.throws(() => prepareXhsEdit(base, { noteType: 'vlog' as never }), /未知的笔记类型/);
  assert.throws(() => prepareXhsEdit(base, { cardsJson: '{"pages":"x"}' }), /格式不正确/);
});

test('标签归一化：去 #、去空格、去重、截断', () => {
  assert.deepEqual(normalizeTags('#护膝 #冬天,护膝，养生'), ['护膝', '冬天', '养生']);
  assert.equal(normalizeTags(Array.from({ length: 30 }, (_, index) => `t${index}`)).length, 15);
});

test('本地 9 项检测', () => {
  const bad = localChecks({
    title: '这是一个特别特别特别特别特别特别长的标题超过二十字',
    body: `最好的护膝，100%根治关节痛！加我微信 vx: abc12345 或打 13812345678 http://x.cn ${'很长的一段'.repeat(30)}`,
    tagsJson: JSON.stringify(['护膝', '冬 天'])
  });
  const byId = Object.fromEntries(bad.map(item => [item.id, item]));
  assert.equal(byId.title_length.ok, false);
  assert.match(byId.title_length.detail, /超出/);
  assert.equal(byId.risk_words.ok, false);
  assert.match(byId.risk_words.detail, /最.*100%.*根治/);
  assert.equal(byId.contact.ok, false);
  assert.match(byId.contact.detail, /外部链接.*微信号.*手机号/);
  assert.equal(byId.tag_format.ok, false);
  assert.equal(byId.tag_count.ok, false);
  assert.equal(byId.paragraph.ok, false);
  const good = localChecks({ title: '冬天护膝怎么选', body: `最近天冷了。${'护膝要选合适的尺寸。\n'.repeat(20)}`, tagsJson: JSON.stringify(['护膝', '冬季养生', '中老年']) });
  assert.ok(good.every(item => item.ok), JSON.stringify(good.filter(item => !item.ok)));
});

test('风险词排除「最近」这类误伤；emoji 密度与字数按字符计', () => {
  assert.deepEqual(findRiskWords('最近最后再说'), []);
  assert.equal(findRiskWords('最好用').length, 1);
  assert.equal(countChars('护膝 🙂\n'), 3);
  const dense = localChecks({ title: 't', body: '🙂'.repeat(10) + '字'.repeat(90), tagsJson: '[]' });
  assert.equal(dense.find(item => item.id === 'emoji_density')!.ok, false);
});

test('检测报告总是完整 14 项；有 error 级未通过就算没通过', () => {
  const merged = mergeCheckItems(localChecks({ title: '标题', body: '正文', tagsJson: '[]' }), []);
  assert.equal(merged.length, 14);
  assert.equal(merged.filter(item => item.source === 'model' && item.ok === null).length, 5);
  const failing = note({ checksJson: JSON.stringify({ items: [{ id: 'risk_words', label: '', ok: false, level: 'error', detail: '', source: 'local' }], checkedAt: '', modelError: '' }) });
  assert.equal(checksPassed(failing), false);
  const warnOnly = note({ checksJson: JSON.stringify({ items: [{ id: 'tag_count', label: '', ok: false, level: 'warn', detail: '', source: 'local' }], checkedAt: '', modelError: '' }) });
  assert.equal(checksPassed(warnOnly), true);
  assert.equal(checksPassed(note()), null);
});

test('导出门槛：正文、标题必须有；独立封面可选，图组首图可自动作封面', () => {
  assert.throws(() => assertXhsExportable(note({ title: 't', coverPath: 'c' })), /正文/);
  assert.throws(() => assertXhsExportable(note({ body: 'b', coverPath: 'c' })), /标题/);
  assert.throws(() => assertXhsExportable(note({ body: 'b', title: 't' })), /至少添加一张图片/);
  const cards = JSON.stringify([{ path: 'card-1.png', source: 'card', caption: '第 1 页' }, { path: 'card-2.png', source: 'card', caption: '第 2 页' }]);
  assert.doesNotThrow(() => assertXhsExportable(note({ body: 'b', title: 't', imagesJson: cards })));
  const list = xhsExportChecklist(note({ body: 'b', title: 't', imagesJson: cards }));
  assert.ok(list.filter(item => !item.optional).every(item => item.ok));
  assert.match(list.find(item => item.label === '封面')?.detail ?? '', /图组第 1 张/);
});

test('发布图顺序：独立封面优先，回退图组首图，并按路径去重', () => {
  const cards = JSON.stringify([
    { path: 'cover.png', source: 'card', caption: '首图' },
    { path: 'card-2.png', source: 'card', caption: '第 2 页' }
  ]);
  assert.deepEqual(xhsPackageImagePaths(note({ coverPath: '', imagesJson: cards })), ['cover.png', 'card-2.png']);
  assert.deepEqual(xhsPackageImagePaths(note({ coverPath: 'cover.png', imagesJson: cards })), ['cover.png', 'card-2.png']);
});

test('填入发布页：标题和正文带标签，并按平台上限截断', () => {
  const filled = xhsDraftContent(note({ title: '一'.repeat(25), body: '正文内容', tagsJson: JSON.stringify(['护膝', '冬季']) }));
  assert.equal(filled.title, '一'.repeat(20));
  assert.equal(filled.body, '正文内容\n\n#护膝 #冬季');
  assert.equal(xhsDraftContent(note({ title: '标题', body: '长'.repeat(1200) })).body.length, 1000);
  const withTags = xhsDraftContent(note({ title: '标题', body: '长'.repeat(1200), tagsJson: JSON.stringify(['护膝']) }));
  assert.equal(withTags.body.length, 1000);
  assert.ok(withTags.body.endsWith('\n\n#护膝'));
});

test('卡片分页读取时丢掉空页并归一化风格', () => {
  const plan = readCardPlan({ cardsJson: JSON.stringify({ style: 'nope', pages: [{ heading: 'A', points: ['1', ' '] }, { heading: '', points: [] }, null] }) });
  assert.equal(plan?.style, 'warm');
  assert.deepEqual(plan?.pages, [{ heading: 'A', points: ['1'], emphasis: '' }]);
  assert.equal(readCardPlan({ cardsJson: 'bad' }), null);
});

test('向导规则：无定位 → A；复盘有卡点 → C；写了几篇没数据 → C；否则 B', () => {
  assert.equal(routeByRules({ hasPositioning: false, dominantLayer: 'click', noteCount: 0, statCount: 0 }).chain, 'A');
  const c = routeByRules({ hasPositioning: true, dominantLayer: 'click', noteCount: 3, statCount: 5 });
  assert.equal(c.chain, 'C');
  assert.equal(c.layer, 'click');
  assert.ok(c.steps.some(step => step.tab === 'notes'));
  assert.equal(routeByRules({ hasPositioning: true, dominantLayer: '', noteCount: 6, statCount: 0 }).chain, 'C');
  assert.equal(routeByRules({ hasPositioning: true, dominantLayer: '', noteCount: 1, statCount: 0 }).chain, 'B');
});

test('候选图库：新批次在前，正在用的封面与图组也算在库里，按路径去重', () => {
  let item = note({ coverPath: 'old-cover.png', imagesJson: JSON.stringify([{ path: 'card-1.png', source: 'card', caption: '第 1 页' }]) });
  // 老笔记没有候选图库：正在用的图也要出现在库里。
  assert.deepEqual(readCandidates(item).map(entry => entry.path), ['old-cover.png', 'card-1.png']);
  item = { ...item, candidatesJson: addCandidates(item, [{ path: 'card-2.png', source: 'card', caption: '' }, { path: 'card-1.png', source: 'card', caption: '第 1 页' }]) };
  const pool = readCandidates(item);
  assert.deepEqual(pool.map(entry => entry.path), ['card-2.png', 'card-1.png', 'old-cover.png']);
  assert.equal(pool[0].batch, pool[1].batch);
  assert.equal(readCandidates(note({ candidatesJson: 'not json' })).length, 0);
});
