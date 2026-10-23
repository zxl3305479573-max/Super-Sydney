import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContentTask } from '../shared.ts';
import { assertContentDeliverable, assertContentPublishable, assertContentStage, deliverableArticle, prepareContentEdit } from '../services/content-policy.ts';
import { parseContentResponse, requestContentStage } from '../services/content-workflow.ts';
import { normalizeImageCost, serializeCliConfig, yamlBlock, yamlScalar } from '../services/wewrite-config.ts';
import type { WeWriteConfigDraft } from '../shared.ts';

function task(patch: Partial<ContentTask> = {}): ContentTask {
  return { id: 1, directionId: 1, subdirectionId: 2, directionName: '中老年健康科普', subdirectionName: '饮食营养与蔬果利弊', topic: '蔬果', title: '菠菜的营养', status: 'ready', briefJson: '{"sections":["营养"]}', claimsJson: '', sourcesJson: '', topicsJson: '', draft: '当前正文', finalArticle: '当前正文', reviewJson: '{"decision":"pass"}', coverPath: 'cover.png', theme: '', publishJson: '', exportPath: '', createdAt: '', updatedAt: '', ...patch };
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

test('未配置篇幅时使用公众号默认的 600-1200 字范围', async () => {
  let sent: { messages?: unknown } = {};
  const fetcher = (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '# 短稿' } }] }));
  }) as typeof fetch;
  await requestContentStage(task(), 'draft', { apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'writer' }, fetcher);
  assert.match(JSON.stringify(sent.messages), /600-1200 字范围内/);
});

test('写作提示词用内容方向的约束，换方向就不再带健康红线', async () => {
  const capture = async (config: Parameters<typeof requestContentStage>[2], overrides: Partial<ContentTask> = {}) => {
    let sent: { messages?: unknown } = {};
    const fetcher = (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '# 正文' } }] }));
    }) as typeof fetch;
    await requestContentStage(task(overrides), 'draft', config, fetcher);
    return JSON.stringify(sent.messages);
  };

  const health = await capture({
    apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'writer',
    direction: { name: '中老年健康科普', note: '不宣称根治、抗癌、排毒，不提供剂量疗程。' },
    subdirection: { name: '饮食营养与蔬果利弊', note: '' }
  });
  assert.match(health, /中老年健康科普/);
  assert.match(health, /不宣称根治/);

  const tech = await capture({
    apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'writer',
    direction: { name: '科技与数码', note: '只评测可复现的参数，不吹捧品牌。' },
    subdirection: { name: 'AI 硬件', note: '避免出现品牌 logo 的特写。' }
  }, { directionName: '科技与数码', subdirectionName: 'AI 硬件' });
  assert.match(tech, /科技与数码/);
  assert.match(tech, /AI 硬件/);
  assert.doesNotMatch(tech, /中老年|健康科普|剂量疗程/);
  // 通用底线与联网限制仍然保留
  assert.match(tech, /没有联网核实能力/);
});

test('没有归类时提示词不写死领域', async () => {
  let sent: { messages?: unknown } = {};
  const fetcher = (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '# 正文' } }] }));
  }) as typeof fetch;
  const bare = { ...task(), directionId: null, subdirectionId: null, directionName: '', subdirectionName: '' };
  await requestContentStage(bare, 'draft', { apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'writer' }, fetcher);
  const messages = JSON.stringify(sent.messages);
  assert.doesNotMatch(messages, /类别：/);
  assert.doesNotMatch(messages, /中老年|健康科普/);
  assert.match(messages, /不编造亲身经历/);
});

test('missing key or invalid stage never calls the provider', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  await assert.rejects(() => requestContentStage(task(), 'draft', { apiKey: '', baseUrl: 'x', model: 'x' }, fetcher), /Key/);
  await assert.rejects(() => requestContentStage(task(), 'invalid' as never, { apiKey: 'x', baseUrl: 'x', model: 'x' }, fetcher), /未知/);
  assert.equal(calls, 0);
});

test('公众号选题 prompt 使用红狐公众号参考，并禁止照抄标题或把热度当证据', async () => {
  let sent: { messages?: unknown } = {};
  const fetcher = (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: [{ title: '早餐怎么搭配更稳', angle: '结构', reader_problem: '早餐蛋白质不足', risk_note: '不写具体剂量', keywords: ['早餐'] }] }) } }] }));
  }) as typeof fetch;
  await requestContentStage(task({ topic: '中老年早餐' }), 'topics', { apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'writer' }, fetcher, {
    topicResearch: {
      source: 'redfox', keyword: '中老年早餐', startDate: '2026-10-15', endDate: '2026-10-22', total: 1,
      notes: [{
        id: 'W-1', title: '冬天早餐怎么吃更稳', desc: '蛋白质、主食和蔬菜搭配', cover: '', link: '', createTime: '2026-10-20 08:30:00',
        topics: ['健康养生'], author: { id: 'a1', nickname: '健康早餐研究所', fans: 0 }, interactive: 2930, readCount: 52000,
        liked: 1200, collected: 600, comments: 90, shared: 240, score: null
      }],
      latest: [], relatedSearches: [], hotTopics: [], tips: '', fetchedAt: '2026-10-22T02:00:00Z', cached: false
    }
  });
  const messages = JSON.stringify(sent.messages);
  assert.match(messages, /红狐公众号数据/);
  assert.match(messages, /冬天早餐怎么吃更稳/);
  assert.match(messages, /不得照抄标题/);
  assert.match(messages, /不得把热度当事实依据/);
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

test('证据计划自动推荐来源：去掉链接、标为 AI 推荐，重新生成保留用户录入的来源', async () => {
  const reply = {
    claims: [{ claim: '菠菜含草酸', tier: 'verified' }],
    sources: [
      { publisher: '中国营养学会', title: '《中国居民膳食指南（2022）》', year: '2022', supports: '蔬菜摄入建议', url: 'https://fake.example/deep/link' },
      { publisher: '某机构', title: '', supports: '缺文件名的不收' }
    ]
  };
  const fetcher = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }))) as typeof fetch;
  const existing = JSON.stringify({ sources: [
    { title: '我自己找的资料', url: 'https://example.org/a', excerpt: '原文', status: 'user_provided', featured: true },
    { title: '上一轮推荐', url: '', excerpt: '', status: 'ai_suggested', featured: false }
  ] });
  const result = await requestContentStage(task({ sourcesJson: existing }), 'claims', { apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'writer' }, fetcher);
  assert.deepEqual(JSON.parse(result.claimsJson!), { claims: [{ claim: '菠菜含草酸', tier: 'unverified' }] });
  assert.deepEqual(JSON.parse(result.sourcesJson!).sources, [
    { title: '我自己找的资料', url: 'https://example.org/a', excerpt: '原文', status: 'user_provided', featured: true },
    { title: '中国营养学会《中国居民膳食指南（2022）》（2022）', url: '', excerpt: '蔬菜摄入建议', status: 'ai_suggested', featured: false }
  ]);
});
