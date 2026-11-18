import test from 'node:test';
import assert from 'node:assert/strict';
import type { XhsNote, XhsPositioningTurn } from '../shared.ts';
import {
  parseAuditResult, parseCardPlan, parseModelChecks, parsePositioningProfile, parseTitleWorkshop, POSITIONING_MAX_ROUNDS, requestPositioningStep, requestRouteChoice,
  requestXhsBody, requestXhsCardPlan, requestXhsCoverBrief, requestXhsTitles, xhsCoverPrompt, xhsInfoImagePrompt, type XhsApiConfig
} from '../services/xhs-workflow.ts';
import { findAiCliches } from '../services/xhs-pipeline.ts';

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

test('卡片拆页：同时读取原始经验素材与补充重点，先抽 keyFacts 再输出结构化条目，支持 1 张一图流与 4 页紧凑图组', async () => {
  const singlePage = {
    layout: 'metrics',
    kicker: '一页速查',
    heading: '小红书开店【核心门槛】',
    lead: '先核对资质再准备材料，避免白跑流程',
    stats: [{ value: '>6000元', label: '电子资源月流水' }],
    items: [{ title: '基础门槛', detail: '入驻【>180天】、笔记>30篇、粉丝>1000', badge: '企业蓝V' }],
    emphasis: '新办个体户等 14 天工商同步后再交'
  };
  const fake = fakeChat([
    { keyFacts: ['千帆开店需入驻>180天、笔记>30篇、粉丝>1000', '电子资源需单自然月流水>6000元证明'], pages: [singlePage] },
    { keyFacts: ['门槛速览'], pages: [singlePage, singlePage, singlePage, singlePage] }
  ]);
  const sampleNote = note({
    title: '小红书开店指南',
    material: '电子资源定向准入需月流水>6000元证明 + 近90天已售清单；新个体户等14天',
    body: '简短正文',
    coverPath: 'cover.png'
  });
  const plan = await requestXhsCardPlan(config, sampleNote, 1, 'swiss', fake.fetch, '重点保留所有数字门槛');
  assert.match(fake.requests[0].user, /电子资源定向准入需月流水>6000元证明/, '原始素材必须喂给卡片提炼模型');
  assert.match(fake.requests[0].user, /重点保留所有数字门槛/, '用户补充重点传入提示词');
  assert.equal(plan.style, 'swiss');
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.keyFacts?.length, 2);
  assert.equal(plan.pages[0].layout, 'metrics');
  assert.equal(plan.pages[0].items?.[0].badge, '企业蓝V');
  assert.match(plan.pages[0].points[0], /\[企业蓝V\] 基础门槛：入驻【>180天】/, '结构化 items 自动同步到 points 供生图信息图复用');

  const multiPlan = await requestXhsCardPlan(config, sampleNote, 4, 'bento', fake.fetch);
  assert.equal(multiPlan.pages.length, 4);
  assert.match(fake.requests[1].user, /已有独立封面图/, '多页模式且已有封面时提醒第 1 张卡片不要重复做空封面');
});

test('定位档案支持解析变现路径规划与内容支柱角色分工', () => {
  const parsed = parsePositioningProfile({
    ...PROFILE,
    pillars: [{ name: '关节养护', description: '日常科普', role: 'trust' }],
    firstTopics: [{ title: '冬天护膝怎么选', pillar: '关节养护', noteType: 'review', role: 'convert' }],
    monetization: {
      primaryPath: 'pugongying',
      reason: '有专业护理经验但无自有货盘，适合先接合规健康品牌合作',
      starterMove: '千粉前先报众测练手，满 1000 粉开通蒲公英设置图文报价',
      warnings: ['企业直播禁入医疗器械与保健品，严禁疗效承诺与私域导流']
    }
  });
  assert.equal(parsed.pillars[0].role, 'trust');
  assert.equal(parsed.firstTopics[0].role, 'convert');
  assert.equal(parsed.monetization?.primaryPath, 'pugongying');
  assert.equal(parsed.monetization?.warnings.length, 1);
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

test('向导分流：非法链路回退 B，非 C 时清空卡点，支持商业转化链路 D', async () => {
  const fake = fakeChat([{ chain: 'Z', layer: 'click', reason: '' }, { chain: 'C', layer: 'click', reason: '点击低' }, { chain: 'D', layer: 'save', reason: '准备接蒲公英商单' }]);
  assert.deepEqual(await requestRouteChoice(config, '不知道', '', fake.fetch), { chain: 'B', layer: '', reason: '按描述判断' });
  assert.deepEqual(await requestRouteChoice(config, '没人点', '', fake.fetch), { chain: 'C', layer: 'click', reason: '点击低' });
  assert.deepEqual(await requestRouteChoice(config, '怎么变现接单', '', fake.fetch), { chain: 'D', layer: '', reason: '准备接蒲公英商单' });
});

test('商业角色（intent）写入正文提示词，诊断支持商业就绪度字段', async () => {
  const fake = fakeChat([{ body: '买手测评正文', tags: ['护膝'] }]);
  await requestXhsBody(config, note({ intent: 'affiliate', topic: '护膝测评' }), null, 'write', fake.fetch);
  assert.match(fake.requests[0].user, /买手选品种草 \/ 笔记挂车/);

  const metrics = { noteCount: 5, avgInteractions: 80, medianInteractions: 60, interactionRate: 0.08, hitRate: 0.2, postsPerWeek: 3, longestGapDays: 2 };
  const audit = parseAuditResult({
    dimensions: [{ key: 'positioning', score: 8, evidence: '定位清晰' }],
    bottleneck: '粉丝未满千粉',
    actions: [{ priority: 1, action: '置顶高收藏测评当样片', why: '方便品牌选号' }],
    positioningAdvice: '保持垂直',
    monetizationReadiness: '目前适合先开 0 粉买手橱窗，满 1000 粉后开通蒲公英'
  }, metrics);
  assert.match(audit.monetizationReadiness ?? '', /0 粉买手橱窗/);
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

test('IP 身份作为观察视角和判断方式自然融入，不作为固定自我介绍模板', async () => {
  const fake = fakeChat([{ body: '正文', tags: [] }]);
  await requestXhsBody({ ...config, ip: { name: '雪梨的一人公司', tagline: '一个人 + AI = 一个团队' } }, note({ topic: '怎么用 AI 整理资料' }), null, 'write', fake.fetch);
  const systemText = fake.requests[0].system;
  assert.match(systemText, /对外 IP \/ 品牌：雪梨的一人公司/);
  assert.match(systemText, /核心主张或口头禅：一个人 \+ AI = 一个团队/);
  assert.match(systemText, /影响你先提醒什么、怎样做判断、如何举例/);
  assert.match(systemText, /不要为了露出 IP 硬塞品牌名、口号和口头禅/);
  assert.doesNotMatch(systemText, /每篇都必须提到/);
  assert.match(fake.requests[0].user, /不要把账号名、口头禅或“我是……”式自我介绍当固定开头/);
  assert.match(fake.requests[0].user, /默认用 A 或 B/);
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
  assert.match(cover, /1080×1440/);
  assert.match(cover, /中心约 88% 的安全区/);
  assert.match(cover, /补边成 3:4/);
  assert.doesNotMatch(cover, /中老年|老年|长辈/);
  const pages = [{ heading: '总览', points: [], emphasis: '' }, { heading: '要点一', points: ['a', 'b'], emphasis: '记住' }, { heading: '总结', points: [], emphasis: '' }];
  assert.match(xhsInfoImagePrompt(note({ title: 'T' }), pages, 1), /第 2\/3 张[\s\S]*要点一[\s\S]*a；b[\s\S]*记住/);
  assert.match(xhsInfoImagePrompt(note({ title: 'T' }), pages, null), /总览信息图[\s\S]*要点一/);
});

test('内容质量精修：findAiCliches 检出 AI 套话，polish 模式注入去 AI 味规则并解析 coreTakeaway，标题同时读原始素材', async () => {
  const aiDraft = '家人们谁懂啊！今天给大家分享护膝攻略。首先看保暖，其次看弹力，总而言之这套组合拳能全方位赋能关节养护，希望能帮到大家！';
  const hits = findAiCliches(aiDraft);
  assert.ok(hits.length >= 4, `应检出多项 AI 套话，实际检出：${hits.join('、')}`);

  const fake = fakeChat([
    {
      coreTakeaway: '看膝盖保暖层厚度和上下防滑硅胶条两个指标就能避开 80% 勒腿废品',
      opening: ['冬天买护膝最怕两件事：走两步往下掉，或者勒出深红印。', '挑的时候不用看花哨发热概念，只摸内里绒长和防滑条宽度。', '下面这 3 条对照标准可以直接拿着去比。'],
      outline: ['看防滑条宽度 ≥1cm', '蹲下 90 度测腘窝不卡肉'],
      body: '冬天买护膝最怕两件事：走两步往下掉，或者勒出深红印。\n\n1. 防滑硅胶条宽度 ≥1cm\n蹲下 90 度膝弯不堆褶才合格。\n\n你平时戴护膝更怕下滑还是闷汗？',
      interaction: '你平时戴护膝更怕下滑还是闷汗？',
      tags: ['护膝怎么选', '中老年护膝']
    },
    {
      candidates: [{ title: '冬天护膝别乱买！记住这 2 个防滑指标', method: 'avoid', scores: { search: 5, audience: 4, save: 5, hook: 4.5 }, role: 'primary' }]
    }
  ]);

  const polished = await requestXhsBody(config, note({ body: aiDraft, topic: '冬天护膝怎么选' }), null, 'polish', fake.fetch);
  assert.match(fake.requests[0].user, /去 AI 味 \+ 提纯信息密度/);
  assert.match(fake.requests[0].user, /本地扫描发现的套话痕迹（必须清理）/);
  assert.equal(polished.meta.coreTakeaway, '看膝盖保暖层厚度和上下防滑硅胶条两个指标就能避开 80% 勒腿废品');
  assert.equal(findAiCliches(polished.body).length, 0, '精修后正文不再包含 AI 套话');

  await requestXhsTitles(config, note({ material: '实测 5 款护膝：硅胶条宽度 ≥1cm 才不掉筒', body: '简短正文' }), null, fake.fetch);
  assert.match(fake.requests[1].user, /硅胶条宽度 ≥1cm/, '标题工坊同时读取原始素材里的硬核细节');
});

test('结构化生图提示词：支持封面与信息图风格预设切换、6 模块分层规范及 AI 具象视觉分镜提炼', async () => {
  const studioCover = xhsCoverPrompt(
    note({ topic: '桌面效率改造', title: '3 件百元桌面神器', body: '每天在工位坐 8 小时，先把显示器垫高 12cm。' }),
    null,
    '胡桃木增高架与暖光屏幕挂灯',
    'studio_3d'
  );
  assert.match(studioCover, /【1\. 画布与构图规格 \| Canvas & Safe Zone】/);
  assert.match(studioCover, /【2\. 视觉媒介与审美画风 \| Style & Medium】[\s\S]*高品质现代工业风 3D 轻拟物静物渲染/);
  assert.match(studioCover, /【3\. 核心主体与场景叙事 \| Subject & Scene】[\s\S]*胡桃木增高架与暖光屏幕挂灯/);
  assert.match(studioCover, /【4\. 版式分区与文字渲染 \| Typography Spec】[\s\S]*严禁自行生成多余的伪汉字/);
  assert.match(studioCover, /【5\. 色彩体系与光影 \| Palette & Lighting】/);
  assert.match(studioCover, /【6\. 负面禁忌 \| Negative Constraints】/);

  const infoPrompt = xhsInfoImagePrompt(
    note({ title: '小红书开店门槛速查' }),
    [{
      layout: 'metrics',
      kicker: '核心资质',
      heading: '虚拟类目准入门槛',
      lead: '满足以下硬指标再提交审核',
      stats: [{ value: '>6000元', label: '月流水证明' }],
      points: ['入驻满 180 天且粉丝 >1000', '近 90 天已售清单佐证'],
      emphasis: '新办个体户等 14 天工商同步'
    }],
    0,
    'swiss_chart'
  );
  assert.match(infoPrompt, /苏黎世杂志网格/);
  assert.match(infoPrompt, /核心指标块：>6000元（月流水证明）/);
  assert.match(infoPrompt, /顶部章节角标：「核心资质」/);
  assert.match(infoPrompt, /副标导语：「满足以下硬指标再提交审核」/);

  const fake = fakeChat([{
    subject: '浅胡桃木桌面上放着银色显示器增高架、机械键盘和一杯热美式',
    composition: '45度俯拍中近景，主体居下65%，上方35%干净奶油白墙留给大标题',
    paletteLighting: '奶油白底+胡桃木棕+琥珀暖光侧逆光',
    titleHierarchy: '主标题「3件百元桌面神器」双行大黑体，副标胶囊「打工人护颈实测」'
  }]);
  const plan = await requestXhsCoverBrief(
    config,
    note({ topic: '桌面效率改造', title: '3 件百元桌面神器', body: '工位护颈改造实测' }),
    null,
    'editorial_photo',
    '偏暖木色调',
    fake.fetch
  );
  assert.match(fake.requests[0].user, /质感生活实拍/);
  assert.match(fake.requests[0].user, /偏暖木色调/);
  assert.match(plan.brief, /主体与道具：浅胡桃木桌面/);
  assert.match(plan.prompt, /质感生活实拍/);
  assert.match(plan.prompt, /主标题「3件百元桌面神器」/);
});
