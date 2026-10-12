import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countRuns, maskSecret, normalizeWeWriteDraft, parseChecks, parseDiagnoseFiles, parseDiagnoseFlags, parseImageConfig,
  parseRecommendations, parseStyleSummary, parseSummary, parseWechatAuthor, serializeCliConfig, serializeStyleConfig,
  stripScalar, yamlBlock, yamlList, yamlScalar
} from '../services/wewrite-config.ts';
import type { WeWriteConfigDraft } from '../shared.ts';

const STYLE = [
  '# 风格配置',
  'name: "中老年健康科普"          # TODO: 改成你的公众号名',
  'industry: "健康科普/中老年生活"',
  'target_audience: "55-75岁关注自身健康的中老年读者"',
  'topics:',
  '  - 饮食营养与蔬果利弊',
  '  - 身心健康与作息',
  '  - 长辈晚辈关系处理',
  'tone: "平和、尊重、不吓唬人"',
  'voice: "第一人称"',
  'word_count: "1200-1800"',
  'content_style: "干货"',
  'writing_persona: "elder-health-guide"',
  'blacklist:',
  '  words:',
  '    - "震惊"',
  '    - "排毒"',
  '    - "酸碱体质"',
  '  topics:',
  '    - "政治敏感"',
  '    - "具体用药剂量与疗程"',
  'theme: "elder-clear"',
  'author: "TODO: 改成你的署名"',
  ''
].join('\n');

const CONFIG = [
  'wechat:',
  '  appid: ""',
  '  secret: ""',
  'image:',
  '  provider: "openai"',
  '  api_key: "sk-fake-image-key-1234567890abcdef"',
  '  base_url: "https://api.example.com/v1"',
  '  model: "gpt-image-2"',
  '  estimated_cost_per_image: 0.04',
  'theme: "elder-clear"',
  ''
].join('\n');

test('stripScalar removes an inline comment before stripping quotes', () => {
  // 顺序错误的经典症状：先剥引号会因行尾残留注释/空格而留下尾引号。
  assert.equal(stripScalar('"中老年健康科普"          # TODO: 改名'), '中老年健康科普');
  assert.equal(stripScalar('"elder-clear"'), 'elder-clear');
  assert.equal(stripScalar("'single'  # note"), 'single');
  assert.equal(stripScalar('plain'), 'plain');
  assert.equal(stripScalar('""'), '');
});

test('yamlScalar reads simple keys and ignores commented examples', () => {
  assert.equal(yamlScalar(STYLE, 'theme'), 'elder-clear');
  assert.equal(yamlScalar(STYLE, 'writing_persona'), 'elder-health-guide');
  assert.equal(yamlScalar(STYLE, 'name'), '中老年健康科普');
  assert.equal(yamlScalar(STYLE, 'missing_key'), '');
  assert.equal(yamlScalar(null, 'theme'), '');
  // 注释行的 #   api_key: "..." 不应被当成真实键
  const commented = ['#   api_key: "sk-fake"', 'provider: "openai"', ''].join('\n');
  assert.equal(yamlScalar(commented, 'api_key'), '');
  assert.equal(yamlScalar(commented, 'provider'), 'openai');
});

test('yamlBlock extracts only the nested block', () => {
  const block = yamlBlock(STYLE, 'blacklist');
  assert.match(block, /words:/);
  assert.match(block, /政治敏感/);
  assert.doesNotMatch(block, /elder-clear/);
  assert.equal(yamlBlock(STYLE, 'nope'), '');
});

test('yamlList reads top-level and nested lists, and disambiguates duplicate keys', () => {
  assert.deepEqual(yamlList(STYLE, 'topics'), ['饮食营养与蔬果利弊', '身心健康与作息', '长辈晚辈关系处理']);
  assert.deepEqual(yamlList(STYLE, 'words'), ['震惊', '排毒', '酸碱体质']);
  // blacklist 下的 topics 与内容方向的 topics 同名，必须能分别取到
  assert.deepEqual(yamlList(yamlBlock(STYLE, 'blacklist'), 'topics'), ['政治敏感', '具体用药剂量与疗程']);
  assert.deepEqual(yamlList(STYLE, 'not_a_list'), []);
});

test('parseStyleSummary keeps content topics and blacklist topics separate', () => {
  const style = parseStyleSummary(STYLE);
  assert.equal(style.name, '中老年健康科普');
  assert.equal(style.theme, 'elder-clear');
  assert.equal(style.persona, 'elder-health-guide');
  assert.equal(style.author, 'TODO: 改成你的署名');
  assert.equal(style.contentStyle, '干货');
  assert.deepEqual(style.topics, ['饮食营养与蔬果利弊', '身心健康与作息', '长辈晚辈关系处理']);
  assert.deepEqual(style.blacklistWords, ['震惊', '排毒', '酸碱体质']);
  assert.deepEqual(style.blacklistTopics, ['政治敏感', '具体用药剂量与疗程']);
});

test('parseImageConfig masks the api key and never returns it in full', () => {
  const image = parseImageConfig(CONFIG);
  assert.equal(image.provider, 'openai');
  assert.equal(image.model, 'gpt-image-2');
  assert.equal(image.baseUrl, 'https://api.example.com/v1');
  assert.equal(image.estimatedCost, '0.04');
  assert.match(image.apiKeyMasked, /^sk-fa••••/);
  assert.ok(image.apiKeyMasked.endsWith('cdef'));
  assert.doesNotMatch(JSON.stringify(image), /1234567890abcdef/);
});

test('maskSecret never leaks short or empty values', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('   '), '');
  assert.equal(maskSecret('short'), '••••••••');
  assert.equal(maskSecret('12345678'), '••••••••');
  assert.equal(maskSecret('123456789'), '12345••••6789');
});

const DIAGNOSE = {
  checks: [
    { group: 'Config', name: 'Config File', status: 'pass', detail: 'found' },
    { group: 'Config', name: 'Wechat Credentials', status: 'warn', detail: 'missing appid/secret' },
    { group: 'Config', name: 'Image Api Key', status: 'pass', detail: '' },
    { group: 'Style', name: 'Writing Persona', status: 'pass', detail: '' }
  ],
  summary: { passed: 6, warnings: 4, failures: 0, skipped: 1, anti_ai_score: 8, anti_ai_max: 12, anti_ai_level: 'MODERATE', style_setup_score: 8, style_setup_max: 12, style_setup_level: 'MODERATE' },
  recommendations: ['Edit a generated article'],
  files: { home: 'C:\\Users\\33054\\.wewrite', config_yaml: true, style_yaml: true, playbook_md: false, history_yaml: false, persona: 'elder-health-guide', exemplars: [] },
  flags: { skip_publish: true, skip_image_gen: false, use_writer_model: false, needs_onboard: false }
};

test('parses the diagnose JSON payload into panel types', () => {
  const checks = parseChecks(DIAGNOSE.checks);
  assert.equal(checks.length, 4);
  assert.equal(checks[1].status, 'WARN');
  assert.equal(checks[1].group, 'Config');
  assert.equal(parseSummary(DIAGNOSE.summary).styleSetupScore, 8);
  assert.equal(parseSummary(DIAGNOSE.summary).antiAiLevel, 'MODERATE');
  assert.deepEqual(parseRecommendations(DIAGNOSE.recommendations), ['Edit a generated article']);
  assert.deepEqual(parseDiagnoseFiles(DIAGNOSE.files), {
    configYaml: true, styleYaml: true, playbookMd: false, historyYaml: false, persona: 'elder-health-guide', exemplarCount: 0
  });
  assert.deepEqual(parseDiagnoseFlags(DIAGNOSE.flags), {
    skipPublish: true, skipImageGen: false, useWriterModel: false, needsOnboard: false
  });
});

test('parsers tolerate missing or malformed diagnose fields', () => {
  assert.deepEqual(parseChecks(undefined), []);
  assert.deepEqual(parseChecks([{ name: '' }]), []);
  assert.equal(parseSummary({}).warnings, 0);
  assert.equal(parseSummary(null).antiAiScore, 0);
  assert.deepEqual(parseRecommendations('not-a-list'), []);
  assert.equal(parseDiagnoseFiles(undefined).configYaml, false);
  assert.equal(parseDiagnoseFlags(undefined).skipPublish, false);
});

test('countRuns groups runs by status', () => {
  assert.deepEqual(countRuns([{ status: 'active' }, { status: 'completed' }, { status: 'failed' }, { status: 'weird' }]), {
    total: 4, active: 2, completed: 1, failed: 1
  });
  assert.deepEqual(countRuns([]), { total: 0, active: 0, completed: 0, failed: 0 });
});

function draft(): WeWriteConfigDraft {
  return {
    style: {
      name: '中老年健康科普', industry: '健康科普/中老年生活', targetAudience: '55-75岁中老年读者',
      tone: '平和、尊重', voice: '第一人称', wordCount: '1200-1800', contentStyle: '干货',
      persona: 'elder-health-guide', theme: 'elder-clear', author: '李医生',
      topics: ['身心健康与作息', '长辈晚辈关系处理'], defaultTopic: '饮食营养与蔬果利弊',
      blacklistWords: ['震惊', '排毒'], blacklistTopics: ['政治敏感']
    },
    wechat: { appid: 'wx123', secret: 'secret-value', author: '李医生' },
    image: { provider: 'openai', model: 'gpt-image-2', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', estimatedCost: '0.04' }
  };
}

test('serialized style.yaml round-trips through the parser', () => {
  const source = serializeStyleConfig(draft().style);
  const parsed = parseStyleSummary(source);
  const expected = draft().style;
  assert.equal(parsed.name, expected.name);
  assert.equal(parsed.industry, expected.industry);
  assert.equal(parsed.targetAudience, expected.targetAudience);
  assert.equal(parsed.persona, expected.persona);
  assert.equal(parsed.theme, expected.theme);
  assert.equal(parsed.author, expected.author);
  assert.equal(parsed.defaultTopic, expected.defaultTopic);
  assert.deepEqual(parsed.blacklistWords, expected.blacklistWords);
  assert.deepEqual(parsed.blacklistTopics, expected.blacklistTopics);
  // defaultTopic 会被排到 topics 第一位，其余保持原顺序
  assert.equal(parsed.topics[0], expected.defaultTopic);
  assert.deepEqual(parsed.topics.slice(1), expected.topics);
});

test('serialized cli config round-trips and keeps values verbatim', () => {
  const config = draft();
  const source = serializeCliConfig(config);
  assert.equal(yamlScalar(source, 'appid'), 'wx123');
  assert.equal(yamlScalar(source, 'secret'), 'secret-value');
  assert.equal(yamlScalar(source, 'provider'), 'openai');
  assert.equal(yamlScalar(source, 'api_key'), 'sk-test');
  assert.equal(yamlScalar(source, 'base_url'), 'https://api.example.com/v1');
  assert.equal(yamlScalar(source, 'model'), 'gpt-image-2');
  assert.equal(yamlScalar(source, 'estimated_cost_per_image'), '0.04');
  assert.equal(yamlScalar(source, 'theme'), 'elder-clear');
  assert.equal(parseImageConfig(source).apiKeyMasked, maskSecret('sk-test'));
});

test('serializer escapes values that would otherwise break YAML', () => {
  const config = draft();
  config.style.name = '标题带"引号" 和 # 井号';
  config.style.tone = '第一行';
  config.image.apiKey = 'key#with#hash';
  const style = serializeStyleConfig(config.style);
  const cli = serializeCliConfig(config);
  // 井号与引号必须原样往返，不能被当成注释或提前结束字符串
  assert.equal(parseStyleSummary(style).name, '标题带"引号" 和 # 井号');
  assert.equal(yamlScalar(cli, 'api_key'), 'key#with#hash');
});

test('serializer keeps an empty secret readable as unconfigured', () => {
  const config = draft();
  config.wechat = { appid: '', secret: '', author: '' };
  config.image.apiKey = '';
  const source = serializeCliConfig(config);
  assert.equal(yamlScalar(source, 'appid'), '');
  assert.equal(yamlScalar(source, 'secret'), '');
  assert.equal(yamlScalar(source, 'api_key'), '');
  assert.equal(Boolean(yamlScalar(source, 'appid') && yamlScalar(source, 'secret')), false);
});

test('parseWechatAuthor 只读 wechat 块里的 author', () => {
  const config = [
    'wechat:',
    '  appid: "wx-keep"',
    '  secret: "secret-keep"',
    '  author: "雪梨"',
    'image:',
    '  provider: "openai"',
    ''
  ].join('\n');
  assert.equal(parseWechatAuthor(config), '雪梨');
  assert.equal(parseWechatAuthor(null), '');
  assert.equal(parseWechatAuthor('image:\n  model: "gpt-image-2"\n'), '');
});

test('normalizeWeWriteDraft 用磁盘旧值补回留空的密钥', () => {
  const existing = [
    'wechat:',
    '  appid: "wx-keep"',
    '  secret: "secret-keep"',
    '  author: "雪梨"',
    'image:',
    '  provider: "openai"',
    '  api_key: "sk-keep"',
    '  estimated_cost_per_image: 0.04',
    ''
  ].join('\n');
  const config = draft();
  config.wechat = { appid: '', secret: '', author: '雪梨' };
  config.image.apiKey = '';
  const normalized = normalizeWeWriteDraft(config, { styleText: null, configText: existing });
  assert.equal(normalized.wechat.appid, 'wx-keep');
  assert.equal(normalized.wechat.secret, 'secret-keep');
  assert.equal(normalized.image.apiKey, 'sk-keep');
  // 也允许用户主动清空：非密钥字段不做兜底填充
  config.wechat.author = '';
  assert.equal(normalizeWeWriteDraft(config, { styleText: null, configText: existing }).wechat.author, '');
});

test('normalizeWeWriteDraft 不把「未指定」的默认类别补成第一个内容方向', () => {
  const config = draft();
  config.style.defaultTopic = '';
  config.style.topics = ['饮食营养与蔬果利弊', '身心健康与作息'];
  const normalized = normalizeWeWriteDraft(config, { styleText: null, configText: null });
  assert.equal(normalized.style.defaultTopic, '');
  assert.equal(parseStyleSummary(serializeStyleConfig(normalized.style)).defaultTopic, '');
  // 内容方向本身不能因为默认类别为空格而被清掉
  assert.deepEqual(parseStyleSummary(serializeStyleConfig(normalized.style)).topics, ['饮食营养与蔬果利弊', '身心健康与作息']);
});
