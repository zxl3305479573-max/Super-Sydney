import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContentTask } from '../shared.ts';
import { assertContentDeliverable, assertContentPublishable, assertContentStage, deliverableArticle, prepareContentEdit } from '../services/content-policy.ts';
import { parseContentResponse, requestContentStage } from '../services/content-workflow.ts';
import { normalizeImageCost, serializeCliConfig, yamlBlock, yamlScalar } from '../services/wewrite-config.ts';
import type { WeWriteConfigDraft } from '../shared.ts';

function task(patch: Partial<ContentTask> = {}): ContentTask {
  return { id: 1, category: 'nutrition', topic: '蔬果', title: '菠菜的营养', status: 'ready', briefJson: '{"sections":["营养"]}', claimsJson: '', sourcesJson: '', topicsJson: '', draft: '当前正文', finalArticle: '当前正文', reviewJson: '{"decision":"pass"}', coverPath: 'cover.png', theme: '', publishJson: '', exportPath: '', createdAt: '', updatedAt: '', ...patch };
}

test('changing reviewed content invalidates the final article and review', () => {
  const patch = prepareContentEdit(task(), { draft: '新正文', status: 'ready', finalArticle: '伪造成稿', reviewJson: '{"decision":"pass"}' });
  assert.deepEqual(patch, { draft: '新正文', finalArticle: '', reviewJson: '', status: 'draft' });
  const title = prepareContentEdit(task(), { title: '新标题' });
  assert.equal(title.finalArticle, '');
  assert.equal(title.status, 'draft');
  assert.deepEqual(prepareContentEdit(task(), { draft: '当前正文' }), { draft: '当前正文' });
});

test('changing only the layout theme keeps the passing review', () => {
  assert.deepEqual(prepareContentEdit(task(), { theme: 'classic' }), { theme: 'classic' });
  assert.throws(() => prepareContentEdit(task(), { theme: 7 as never }), /文本/);
});

test('publish gate requires a passing review for the current body', () => {
  assert.doesNotThrow(() => assertContentPublishable(task()));
  assert.throws(() => assertContentPublishable(task({ draft: '已修改' })), /重新审稿/);
  assert.throws(() => assertContentPublishable(task({ reviewJson: '{"decision":"revise"}' })), /审稿/);
  assert.throws(() => assertContentPublishable(task({ status: 'draft' })), /审稿/);
});

test('generation stages reject missing prerequisites', () => {
  assert.throws(() => assertContentStage(task(), 'invalid' as never), /未知/);
  assert.throws(() => assertContentStage(task({ title: '', topic: '' }), 'brief'), /选题/);
  assert.throws(() => assertContentStage(task({ briefJson: '' }), 'draft'), /任务书/);
  assert.throws(() => assertContentStage(task({ draft: '' }), 'review'), /初稿/);
  assert.doesNotThrow(() => assertContentStage(task({ title: '', topic: '' }), 'topics'));
});

test('revise stage needs a draft and a review, and rewrites plain markdown', async () => {
  assert.throws(() => assertContentStage(task({ draft: '' }), 'revise'), /初稿/);
  assert.throws(() => assertContentStage(task({ reviewJson: '' }), 'revise'), /审稿/);
  assert.doesNotThrow(() => assertContentStage(task(), 'revise'));
  let sent: { response_format?: unknown; messages?: unknown } = {};
  const fetcher = (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '```markdown\n# 改好的正文\n```' } }] }));
  }) as typeof fetch;
  const result = await requestContentStage(task(), 'revise', { apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'writer' }, fetcher);
  assert.equal(result.draft, '# 改好的正文');
  assert.equal(sent.response_format, undefined);
  assert.match(JSON.stringify(sent.messages), /审稿意见/);
});

test('unreviewed delivery stays blocked until the caller explicitly opts in', () => {
  const unreviewed = task({ draft: '待审正文', finalArticle: '', reviewJson: '{"decision":"revise"}' });
  assert.throws(() => assertContentDeliverable(unreviewed), /审稿/);
  assert.doesNotThrow(() => assertContentDeliverable(unreviewed, { allowUnreviewed: true }));
  assert.equal(deliverableArticle(unreviewed, true), '待审正文');
  assert.equal(deliverableArticle(task(), true), '当前正文');
  assert.throws(() => assertContentDeliverable(task({ draft: '', finalArticle: '' }), { allowUnreviewed: true }), /正文/);
});

test('model response shape and review contradictions are validated', () => {
  assert.throws(() => parseContentResponse('[]', 'topics'), /对象/);
  assert.throws(() => parseContentResponse('{"topics":[{}]}', 'topics'), /标题/);
  assert.throws(() => parseContentResponse('{"decision":"pass"}', 'review'), /清单/);
  const review = parseContentResponse('{"decision":"pass","unsupported_claims":["缺来源"],"health_risks":[],"required_changes":[]}', 'review');
  assert.equal(review.decision, 'revise');
  const claims = parseContentResponse('{"claims":[{"claim":"主张","tier":"verified"}]}', 'claims');
  assert.equal((claims.claims as Array<{ tier: string }>)[0].tier, 'unverified');
});

test('API call uses account style, a timeout and the persisted task', async () => {
  let sent: Record<string, unknown> = {};
  const fetcher = (async (_url, init) => {
    assert.ok(init?.signal);
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '# 模拟初稿' } }] }));
  }) as typeof fetch;
  const result = await requestContentStage(task(), 'draft', { apiKey: 'dummy', baseUrl: 'https://example.test/v1', model: 'writer', style: { targetAudience: '老人', tone: '平和', voice: '客观', wordCount: '800-1200', blacklistWords: ['震惊'], blacklistTopics: [] } }, fetcher);
  assert.equal(result.draft, '# 模拟初稿');
  assert.equal(sent.model, 'writer');
  assert.match(JSON.stringify(sent.messages), /800-1200/);
  assert.match(JSON.stringify(sent.messages), /没有联网核实能力/);
});

test('missing key or invalid stage never calls the provider', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  await assert.rejects(() => requestContentStage(task(), 'draft', { apiKey: '', baseUrl: 'x', model: 'x' }, fetcher), /Key/);
  await assert.rejects(() => requestContentStage(task(), 'invalid' as never, { apiKey: 'x', baseUrl: 'x', model: 'x' }, fetcher), /未知/);
  assert.equal(calls, 0);
});

test('writer secret is never serialized into configuration', () => {
  const config = {
    style: { theme: 'elder-clear' }, wechat: { appid: '', secret: '', author: '' },
    image: { provider: 'openai', model: 'image', baseUrl: 'https://example.test', apiKey: '', estimatedCost: '0.04' },
    writer: { baseUrl: 'https://writer.test/v1', model: 'writer', apiKey: 'must-not-be-written', enabled: true }
  } as WeWriteConfigDraft;
  const yaml = serializeCliConfig(config);
  assert.doesNotMatch(yaml, /must-not-be-written/);
  const writer = yamlBlock(yaml, 'writer');
  assert.equal(yamlScalar(writer, 'model'), 'writer');
  assert.equal(yamlScalar(writer, 'enabled'), 'true');
  assert.throws(() => normalizeImageCost('0.04\nextra: true'), /非负数/);
});
