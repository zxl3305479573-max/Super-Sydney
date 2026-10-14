import test from 'node:test';
import assert from 'node:assert/strict';
import type { XhsNote, XhsPositioningTurn } from '../shared.ts';
import {
  parseAuditResult, parseCardPlan, parseModelChecks, parseTitleWorkshop, POSITIONING_MAX_ROUNDS, requestPositioningStep, requestRouteChoice,
  requestXhsBody, requestXhsTitles, xhsCoverPrompt, xhsInfoImagePrompt, type XhsApiConfig
} from '../services/xhs-workflow.ts';

const config: XhsApiConfig = { apiKey: 'k', baseUrl: 'https://llm.test/v1', model: 'm' };

function note(patch: Partial<XhsNote> = {}): XhsNote {
  return {
    id: 1, accountId: 1, topic: '冬天护膝怎么选', noteType: 'tutorial', material: '', title: '', body: '', tagsJson: '', sourceJson: '', status: 'idea',
    writerJson: '', titleCandidatesJson: '', checksJson: '', cardsJson: '', coverPath: '', imagesJson: '', candidatesJson: '', basisJson: '', exportPath: '',
    createdAt: '', updatedAt: '', ...patch
  };
}

/** 假的 chat/completions：记下请求，按顺序回放内容。 */
function fakeChat(replies: unknown[]): { fetch: typeof fetch; requests: Array<{ system: string; user: string }> } {
  const requests: Array<{ system: string; user: string }> = [];
  return {
    requests,
    fetch: (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      requests.push({ system: body.messages[0].content, user: body.messages[1].content });
      const reply = replies.shift();
      return new Response(JSON.stringify({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch
  };
}

const PROFILE = {
  track: { name: '中老年居家健康', reason: '热爱且能长期输出', alternatives: ['家常菜'] },
  statement: '退休护士，教长辈在家把小毛病照顾好',
  persona: { name: '王护士聊健康', bio: '30 年护理经验', visual: '暖橙色、真人出镜' },
  pillars: [{ name: '关节养护', description: '' }, { name: '睡眠', description: '' }],
  firstTopics: Array.from({ length: 22 }, (_, index) => ({ title: `选题${index + 1}`, pillar: '关节养护', noteType: index % 2 ? 'list' : 'bogus' })),
  coldStart: [{ phase: '第 1 周', actions: ['发 3 篇'] }]
};

test('定位咨询：信息不够时继续提问，够了直接出档案', async () => {
  const fake = fakeChat([{ done: false, coach: '了解', questions: ['你最擅长什么？', '想给谁看？'] }, { done: true, coach: '好了', profile: PROFILE }]);
  const first = await requestPositioningStep(config, [], false, fake.fetch);
  assert.equal(first.done, false);
  assert.equal(first.questions.length, 2);
  assert.match(fake.requests[0].system, /小红书账号定位教练/);
  const second = await requestPositioningStep(config, [{ role: 'coach', text: '了解', questions: first.questions }, { role: 'user', text: '护理，给长辈' }], false, fake.fetch);
  assert.equal(second.done, true);
  assert.equal(second.profile?.firstTopics.length, 20, '前 20 篇截断到 20');
  assert.equal(second.profile?.firstTopics[0].noteType, 'tutorial', '未知类型回退为干货教程');
  assert.match(fake.requests[1].user, /护理，给长辈/);
});

test('定位咨询：达到轮数上限或点「直接生成」时强制出档案', async () => {
  const transcript: XhsPositioningTurn[] = Array.from({ length: POSITIONING_MAX_ROUNDS }, () => [{ role: 'coach' as const, text: '问', questions: ['?'] }, { role: 'user' as const, text: '答' }]).flat();
  const fake = fakeChat([{ done: false, questions: ['还想问'] }]);
  await assert.rejects(requestPositioningStep(config, transcript, false, fake.fetch), /缺少赛道/);
  assert.match(fake.requests[0].user, /直接产出完整定位档案/);
});

test('定位档案缺关键字段时报错', async () => {
  const fake = fakeChat([{ done: true, profile: { ...PROFILE, pillars: [] } }]);
  await assert.rejects(requestPositioningStep(config, [], true, fake.fetch), /内容支柱/);
});

test('正文写作：带上笔记类型结构、素材规则与参考热门；回改需要有未通过项', async () => {
  const fake = fakeChat([{ body: '前三行\n正文', opening: ['a', 'b', 'c', 'd'], outline: ['x'], interaction: '你呢？', tags: ['#护膝', '护膝', '冬季'] }]);
  const result = await requestXhsBody(config, note({ sourceJson: JSON.stringify({ title: '热门：护膝避坑', desc: '摘要' }) }), null, 'write', fake.fetch);
  assert.equal(result.body, '前三行\n正文');
  assert.deepEqual(result.tags, ['护膝', '冬季']);
  assert.equal(result.meta.opening.length, 3);
  assert.match(fake.requests[0].user, /干货教程/);
  assert.match(fake.requests[0].user, /没有提供亲身经历素材/);
  assert.match(fake.requests[0].user, /热门：护膝避坑/);
  await assert.rejects(requestXhsBody(config, note({ body: 'x', checksJson: JSON.stringify({ items: [], checkedAt: '', modelError: '' }) }), null, 'revise', fake.fetch), /没有未通过/);
});

test('标题工坊：补本地风险、超长提示，主推只留一个且不超长', () => {
  const workshop = parseTitleWorkshop({
    keywords: ['护膝'],
    candidates: [
      { title: '最好用的护膝推荐给长辈们一定要看看这一篇哦', method: 'number', scores: { search: 5, audience: 5, save: 5, hook: 5 }, role: 'primary' },
      { title: '护膝怎么选？3 个要点', method: 'question', scores: { search: 4, audience: 3, save: 4, hook: 3.5 }, role: 'primary', risks: [] },
      { title: '护膝怎么选？3 个要点', method: 'number' },
      { title: '', method: 'x' }
    ],
    ab: [{ a: 'A 标题', b: 'B 标题', variable: '数字', how: '同时段' }, { a: 'only a' }]
  });
  assert.equal(workshop.candidates.length, 2, '去重、丢空标题');
  const long = workshop.candidates.find(item => item.title.startsWith('最好用'))!;
  assert.ok(long.risks.some(risk => /超过 20 字/.test(risk)));
  assert.ok(long.risks.some(risk => /「最」/.test(risk)));
  assert.equal(long.role, 'backup');
  assert.equal(workshop.candidates.filter(item => item.role === 'primary').length, 1);
  assert.equal(workshop.candidates.find(item => item.role === 'primary')!.title, '护膝怎么选？3 个要点');
  assert.equal(workshop.ab.length, 1);
  assert.throws(() => parseTitleWorkshop({ candidates: [] }), /没有给出有效候选/);
});

test('标题工坊请求里列出 15 种方法并基于正文', async () => {
  const fake = fakeChat([{ candidates: [{ title: '护膝 3 个要点', method: 'number', scores: {}, role: 'primary' }] }]);
  await requestXhsTitles(config, note({ body: '正文内容' }), null, fake.fetch);
  assert.match(fake.requests[0].user, /15 种方法/);
  assert.match(fake.requests[0].user, /collection=收藏合集/);
  assert.match(fake.requests[0].user, /正文内容/);
});

test('模型检测只收 5 个已知项，合规项为 error 级', () => {
  const items = parseModelChecks({ checks: [{ id: 'hook', ok: true, detail: '好' }, { id: 'compliance', ok: false, detail: '出现剂量' }, { id: 'title_length', ok: false }, { id: 'payoff', ok: 'maybe' }] });
  assert.deepEqual(items.map(item => item.id), ['hook', 'compliance', 'payoff']);
  assert.equal(items.find(item => item.id === 'compliance')!.level, 'error');
  assert.equal(items.find(item => item.id === 'payoff')!.ok, null);
});

test('卡片分页至少 6 页，最多 9 页，截断过长文字', () => {
  const pages = Array.from({ length: 11 }, (_, index) => ({ heading: `第${index}页的标题非常非常非常非常长长长长`, points: ['要点'], emphasis: '' }));
  const plan = parseCardPlan({ pages }, 'fresh', 8);
  assert.equal(plan.pages.length, 9);
  assert.equal(plan.style, 'fresh');
  assert.ok(plan.pages[0].heading.length <= 30);
  assert.throws(() => parseCardPlan({ pages: pages.slice(0, 4) }, 'warm', 6), /至少需要 6 页/);
});

test('诊断结果：8 个维度齐全，缺数据为 null，总分只算有分的维度', () => {
  const metrics = { noteCount: 2, avgInteractions: 10, medianInteractions: 10, interactionRate: 0.1, hitRate: 0, postsPerWeek: 2, longestGapDays: 3 };
  const result = parseAuditResult({ dimensions: [{ key: 'positioning', score: 8, evidence: 'e' }, { key: 'cover', score: null }, { key: 'hook', score: 12 }], bottleneck: '定位不清', actions: [{ priority: 2, action: 'b' }, { priority: 1, action: 'a' }] }, metrics);
  assert.equal(result.dimensions.length, 8);
  assert.equal(result.dimensions.find(item => item.key === 'cover')!.score, null);
  assert.equal(result.dimensions.find(item => item.key === 'hook')!.score, 10);
  assert.equal(result.total, 9);
  assert.deepEqual(result.actions.map(item => item.action), ['a', 'b']);
  assert.throws(() => parseAuditResult({ dimensions: [] }, metrics), /没有任何维度/);
});

test('向导分流：非法链路回退 B，非 C 时清空卡点', async () => {
  const fake = fakeChat([{ chain: 'Z', layer: 'click', reason: '' }, { chain: 'C', layer: 'click', reason: '点击低' }]);
  assert.deepEqual(await requestRouteChoice(config, '不知道', '', fake.fetch), { chain: 'B', layer: '', reason: '按描述判断' });
  assert.deepEqual(await requestRouteChoice(config, '没人点', '', fake.fetch), { chain: 'C', layer: 'click', reason: '点击低' });
});

test('缺内容 API Key 时不发请求', async () => {
  const fake = fakeChat([]);
  await assert.rejects(requestXhsTitles({ ...config, apiKey: '' }, note(), null, fake.fetch), /内容生成 API Key/);
  assert.equal(fake.requests.length, 0);
});

test('与公众号隔离：系统提示只有小红书定位，不带公众号的方向、读者与语气', async () => {
  const fake = fakeChat([{ body: '正文', tags: [] }]);
  const positioning = { ...PROFILE, firstTopics: [], generatedAt: '' } as never;
  await requestXhsBody({ ...config, style: { targetAudience: '中老年读者' }, direction: { name: '中老年健康科普', note: '' } } as never, note(), positioning, 'write', fake.fetch);
  assert.doesNotMatch(fake.requests[0].system, /中老年健康科普|中老年读者|账号表达配置|内容方向/);
  assert.match(fake.requests[0].system, /退休护士，教长辈在家把小毛病照顾好/, '读者与人设来自小红书自己的定位档案');
});

test('封面提示词按这篇笔记的选题与正文来画，读者来自定位档案', () => {
  const body = '租房党的收纳难题 🙂 #收纳\n第一步先清空桌面，把东西按使用频率分三类。';
  const cover = xhsCoverPrompt(note({ topic: '小户型收纳', title: '租房收纳 3 步', body }), { statement: '给刚租房的年轻人讲收纳' } as never, '桌面收纳盒');
  // 画面会补边成 3:4 而不是裁切；提示词里要求内容完整、离边留白，避免文字被画面边缘截断。
  assert.match(cover, /完整地放在画面内/);
  assert.match(cover, /笔记选题：小户型收纳/);
  assert.match(cover, /正文内容：租房党的收纳难题 第一步先清空桌面/, '摘要去掉 emoji 和话题标签');
  assert.match(cover, /「租房收纳 3 步」/);
  assert.match(cover, /桌面收纳盒/);
  assert.match(cover, /给刚租房的年轻人讲收纳/);
  assert.doesNotMatch(cover, /中老年|老年|长辈/);
  const pages = [{ heading: '总览', points: [], emphasis: '' }, { heading: '要点一', points: ['a', 'b'], emphasis: '记住' }, { heading: '总结', points: [], emphasis: '' }];
  assert.match(xhsInfoImagePrompt(note({ title: 'T' }), pages, 1), /第 2\/3 张[\s\S]*要点一[\s\S]*a；b[\s\S]*记住/);
  assert.match(xhsInfoImagePrompt(note({ title: 'T' }), pages, null), /总览信息图[\s\S]*要点一/);
});
