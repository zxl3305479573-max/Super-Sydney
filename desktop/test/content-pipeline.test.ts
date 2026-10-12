import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContentTask } from '../shared.ts';
import { AUTO_GENERATE_STAGES, PIPELINE_STEPS, autoGeneratePlan, buildPipeline, currentStepKey, publishChecklist, reviewOutstanding } from '../services/content-pipeline.ts';

function task(patch: Partial<ContentTask> = {}): ContentTask {
  return { id: 1, category: 'nutrition', topic: '', title: '', status: 'idea', briefJson: '', claimsJson: '', sourcesJson: '', topicsJson: '', draft: '', finalArticle: '', reviewJson: '', coverPath: '', theme: '', publishJson: '', exportPath: '', createdAt: '', updatedAt: '', ...patch };
}
const env = { wechatConfigured: true };
const states = (t: ContentTask) => Object.fromEntries(buildPipeline(t, env).map(step => [step.key, step.state]));

test('new task starts at topic and locks later steps', () => {
  const s = states(task());
  assert.equal(s.topic, 'current');
  assert.equal(s.brief, 'locked');
  assert.equal(s.draft, 'locked');
  assert.equal(s.review, 'locked');
  assert.equal(s.publish, 'locked');
  assert.equal(currentStepKey(task(), env), 'topic');
});

test('progress moves forward with brief and draft', () => {
  assert.equal(currentStepKey(task({ title: '菠菜' }), env), 'brief');
  assert.equal(currentStepKey(task({ title: '菠菜', briefJson: '{}' }), env), 'evidence');
  assert.equal(currentStepKey(task({ title: '菠菜', briefJson: '{}', claimsJson: '{}', draft: '正文', status: 'draft' }), env), 'review');
});

test('revise decision surfaces attention on review step', () => {
  const t = task({ title: '菠菜', briefJson: '{}', claimsJson: '{}', draft: '正文', status: 'review', reviewJson: '{"decision":"revise"}' });
  assert.equal(states(t).review, 'attention');
  assert.equal(currentStepKey(t, env), 'review');
});

test('passed review with cover unlocks publish; edits after review flag it instead of locking', () => {
  const passed = task({ title: '菠菜', briefJson: '{}', claimsJson: '{}', draft: '正文', finalArticle: '正文', status: 'ready', reviewJson: '{"decision":"pass"}', coverPath: 'c.png' });
  assert.equal(states(passed).publish, 'current');
  assert.ok(publishChecklist(passed, env).every(item => item.ok));
  const edited = { ...passed, draft: '改过的正文' };
  // 未通过审稿不再锁死发布，只提示待处理；正文缺封面时仍会列出缺口。
  assert.equal(states(edited).publish, 'attention');
  assert.match(buildPipeline(edited, env).find(step => step.key === 'publish')!.reason, /审稿/);
  assert.equal(states({ ...passed, draft: '', finalArticle: '' }).publish, 'locked');
  assert.equal(publishChecklist(passed, { wechatConfigured: false }).find(item => item.label.includes('凭证'))?.ok, false);
  assert.equal(states({ ...passed, publishJson: '{"media_id":"x"}', status: 'published' }).publish, 'done');
});

test('outstanding review items summarise what is still open before an unreviewed delivery', () => {
  assert.deepEqual(reviewOutstanding(task()), ['还没有执行 AI 审稿']);
  const revise = task({ draft: '正文', reviewJson: '{"decision":"revise","required_changes":["补来源","改标题"],"health_risks":["夸大"],"unsupported_claims":[]}' });
  assert.deepEqual(reviewOutstanding(revise), ['审稿结论：需修改', '必须修改 2 条', '健康风险 1 条']);
  const stale = task({ draft: '新正文', finalArticle: '旧成稿', reviewJson: '{"decision":"pass"}' });
  assert.deepEqual(reviewOutstanding(stale), ['正文在审稿之后又被修改过']);
  assert.deepEqual(reviewOutstanding(task({ reviewJson: '{broken' })), ['审稿结论无法解析，建议重新审稿']);
});

test('auto generation requires a title and then runs brief through review in order', () => {
  const blocked = autoGeneratePlan(task());
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? '' : blocked.reason, /标题/);
  const plan = autoGeneratePlan(task({ title: '菠菜和豆腐能一起吃吗' }));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok ? plan.stages : [], ['brief', 'claims', 'draft', 'review']);
  assert.deepEqual(AUTO_GENERATE_STAGES, ['brief', 'claims', 'draft', 'review']);
});

test('auto generation stops before cover, export and publish', () => {
  assert.equal(AUTO_GENERATE_STAGES.includes('topics'), false);
  const autoSteps = PIPELINE_STEPS.filter(step => step.stage && AUTO_GENERATE_STAGES.includes(step.stage)).map(step => step.key);
  assert.deepEqual(autoSteps, ['brief', 'evidence', 'draft', 'review']);
});
