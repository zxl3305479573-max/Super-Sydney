import test from 'node:test';
import assert from 'node:assert/strict';
import type { WeWriteOverview } from '../shared.ts';
import { normalizeWeWriteDraft, parseStyleSummary, parseWechatAuthor, serializeCliConfig, serializeStyleConfig, yamlBlock, yamlScalar } from '../services/wewrite-config.ts';
import { taskScopeLabel } from '../renderer/content-taxonomy.ts';
import { splitLines, weWriteDraftFromOverview } from '../renderer/config-draft.ts';

function overview(): WeWriteOverview {
  return {
    cliAvailable: true,
    cliError: '',
    cliVersion: 'test',
    writer: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyMasked: 'sk-ab••••1234', enabled: true },
    home: 'C:\\Users\\tester\\.wewrite',
    checks: [],
    summary: { passed: 0, warnings: 0, failures: 0, skipped: 0, antiAiLevel: '', antiAiScore: 0, antiAiMax: 0, styleSetupLevel: '', styleSetupScore: 0, styleSetupMax: 0 },
    recommendations: [],
    files: { configYaml: true, styleYaml: true, playbookMd: false, historyYaml: false, persona: 'elder-health-guide', exemplarCount: 0 },
    flags: { skipPublish: false, skipImageGen: false, useWriterModel: true, needsOnboard: false },
    image: { provider: 'openai', model: 'gpt-image-2', baseUrl: 'https://api.example.com/v1', apiKeyMasked: 'sk-12••••abcd', estimatedCost: '0.04' },
    wechat: { author: '雪梨' },
    style: {
      name: '中老年健康科普', industry: '健康科普/中老年生活', targetAudience: '55-75岁中老年读者',
      tone: '平和、尊重', voice: '第一人称', wordCount: '1200-1800', contentStyle: '干货',
      persona: 'elder-health-guide', theme: 'elder-clear', author: '李医生', defaultTopic: '饮食营养与蔬果利弊',
      topics: ['饮食营养与蔬果利弊', '身心健康与作息'], blacklistWords: ['震惊'], blacklistTopics: ['具体用药剂量']
    },
    themes: [{ name: 'elder-clear', description: '中老年友好大字号' }],
    skills: { total: 6, elderHealth: true, complianceReference: true, topicReference: true },
    counts: { total: 1, active: 1, completed: 0, failed: 0 }
  };
}

test('创作设置草稿只带走 style，密钥字段一律留空', () => {
  const draft = weWriteDraftFromOverview(overview());
  assert.equal(draft.style.targetAudience, '55-75岁中老年读者');
  assert.equal(draft.style.theme, 'elder-clear');
  assert.deepEqual(draft.style.topics, ['饮食营养与蔬果利弊', '身心健康与作息']);
  // 留空表示保留原值：密钥明文不进渲染进程，也不该被空值覆盖
  assert.equal(draft.image.apiKey, '');
  assert.equal(draft.image.baseUrl, 'https://api.example.com/v1');
  assert.equal(draft.wechat.appid, '');
  assert.equal(draft.wechat.secret, '');
  // 草稿默认署名读的是 config.yaml 的 wechat.author，不能拿 style.yaml 的 author 顶替
  assert.equal(draft.wechat.author, '雪梨');
  assert.equal(draft.writer?.apiKey, '');
  assert.equal(draft.writer?.enabled, true);
});

test('公众号资料署名与草稿默认署名互不干扰', () => {
  const overviews = overview();
  overviews.style.author = '李医生';
  overviews.wechat.author = '雪梨';
  const draft = weWriteDraftFromOverview(overviews);
  assert.equal(draft.style.author, '李医生');
  assert.equal(draft.wechat.author, '雪梨');
});

/**
 * 回归测试：面板的每个字段都要能原样存下来再读回来。
 * 之前的 bug 是「草稿默认署名」读的是 style.author，用户填了值、保存后界面又变回旧值，
 * 下一次保存还会把它覆盖掉——也就是用户说的“配置保存不下来”。
 */
test('保存后再读回来，面板字段不发生漂移', () => {
  const styleText = serializeStyleConfig({ ...overview().style, author: 'TODO: 改成你的署名' });
  const configText = serializeCliConfig({
    ...weWriteDraftFromOverview(overview()),
    wechat: { appid: 'wx-keep', secret: 'secret-keep', author: '雪梨' },
    image: { provider: 'openai', model: 'gpt-image-2', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-keep', estimatedCost: '0.04' }
  });

  const before = weWriteDraftFromOverview(overview());
  // 模拟界面：用户在「草稿默认署名」里填了一个和 style.author 不同的值
  before.wechat.author = '雪梨';

  const normalized = normalizeWeWriteDraft(before, { styleText, configText });
  const styleAfter = serializeStyleConfig(normalized.style);
  const configAfter = serializeCliConfig(normalized);
  const after = weWriteDraftFromOverview({
    ...overview(),
    style: parseStyleSummary(styleAfter),
    wechat: { author: parseWechatAuthor(configAfter) }
  });

  assert.equal(after.wechat.author, '雪梨');
  assert.equal(after.style.author, before.style.author);
  assert.equal(after.style.defaultTopic, before.style.defaultTopic);
  assert.equal(after.style.theme, before.style.theme);
  assert.deepEqual(after.style.topics, before.style.topics);
  assert.deepEqual(after.style.blacklistWords, before.style.blacklistWords);
  // 留空的密钥字段必须沿用磁盘旧值，不能被空值覆盖
  assert.equal(yamlScalar(yamlBlock(configAfter, 'wechat'), 'appid'), 'wx-keep');
  assert.equal(yamlScalar(yamlBlock(configAfter, 'wechat'), 'secret'), 'secret-keep');
  assert.equal(yamlScalar(yamlBlock(configAfter, 'image'), 'api_key'), 'sk-keep');
});

test('默认类别选「未指定」时保存后仍是未指定', () => {
  const draft = weWriteDraftFromOverview(overview());
  draft.style.defaultTopic = '';
  draft.style.topics = ['饮食营养与蔬果利弊'];
  const normalized = normalizeWeWriteDraft(draft, { styleText: null, configText: null });
  assert.equal(normalized.style.defaultTopic, '');
  assert.equal(parseStyleSummary(serializeStyleConfig(normalized.style)).defaultTopic, '');
});

test('创作设置保存的字段与环境与配置写同一批 style.yaml 键', () => {
  const overviews = overview();
  const draft = weWriteDraftFromOverview(overviews);
  const parsed = parseStyleSummary(serializeStyleConfig({ ...draft.style, topics: splitLines('饮食营养与蔬果利弊\n身心健康与作息') }));
  assert.equal(parsed.name, overviews.style.name);
  assert.equal(parsed.persona, overviews.style.persona);
  assert.equal(parsed.theme, overviews.style.theme);
  assert.equal(parsed.wordCount, overviews.style.wordCount);
  assert.equal(parsed.contentStyle, overviews.style.contentStyle);
  assert.equal(parsed.targetAudience, overviews.style.targetAudience);
  assert.equal(parsed.tone, overviews.style.tone);
  assert.equal(parsed.voice, overviews.style.voice);
  assert.equal(parsed.defaultTopic, overviews.style.defaultTopic);
  assert.equal(parsed.author, overviews.style.author);
});

test('多行文本按行解析，空行与首尾空格被忽略', () => {
  assert.deepEqual(splitLines('  饮食营养  \n\n 身心健康与作息 \n'), ['饮食营养', '身心健康与作息']);
  assert.deepEqual(splitLines('   '), []);
});

test('任务展示的分类名优先用具体方向，其次一级方向，最后是未归类', () => {
  assert.equal(taskScopeLabel({ directionName: '中老年健康科普', subdirectionName: '饮食营养与蔬果利弊' }), '饮食营养与蔬果利弊');
  assert.equal(taskScopeLabel({ directionName: '科技与数码', subdirectionName: '' }), '科技与数码');
  assert.equal(taskScopeLabel({ directionName: '', subdirectionName: '' }), '未归类');
});
