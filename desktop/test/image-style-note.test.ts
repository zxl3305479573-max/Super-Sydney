import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IMAGE_STYLE } from '../services/image-style.ts';
import { buildImageStylePrompt, normalizeImageStyleRequest, parseImageStyleSuggestion, requestImageStyle } from '../services/image-style-note.ts';

const config = { apiKey: 'k', baseUrl: 'https://llm.example/v1', model: 'm', style: { targetAudience: '55-75岁读者', tone: '', voice: '', wordCount: '', blacklistWords: [], blacklistTopics: [] } };
const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const base = { directionName: 'AI技术', directionNote: '', subdirectionName: '', subdirectionNote: '', parentTemplate: '', template: '', audience: '' };

test('配图模板请求校验：方向名必填，缺省字段补空，类型不对报错', () => {
  assert.throws(() => normalizeImageStyleRequest({ directionName: ' ' }), /内容方向名称/);
  assert.throws(() => normalizeImageStyleRequest({ directionName: 'AI', template: 1 }), /template/);
  assert.throws(() => normalizeImageStyleRequest([]), /请求格式/);
  assert.deepEqual(normalizeImageStyleRequest({ directionName: ' AI技术 ', template: ' 扁平插画 ' }), { ...base, template: '扁平插画' });
});

test('一级方向提示词：带方向名与写作约束，原稿为空时给默认模板做参考，不带账号读者定位', () => {
  const prompt = buildImageStylePrompt({ ...base, directionNote: '读者是程序员\n配图用科技感插画' });
  assert.match(prompt, /内容方向：AI技术/);
  assert.match(prompt, /写作约束：\n读者是程序员\n配图用科技感插画/);
  assert.ok(prompt.includes(DEFAULT_IMAGE_STYLE));
  assert.match(prompt, /完整配图模板/);
  assert.doesNotMatch(prompt, /具体方向：|55-75/);
});

test('具体方向提示词：带上级生效模板，并要求输出能整段替换上级的完整模板', () => {
  const prompt = buildImageStylePrompt({ ...base, subdirectionName: 'AI 硬件', subdirectionNote: '多讲显卡', parentTemplate: '扁平插画，冷色调', template: '' });
  assert.match(prompt, /具体方向：AI 硬件/);
  assert.match(prompt, /具体方向的额外要求：\n多讲显卡/);
  assert.match(prompt, /上级方向当前生效的配图模板：\n扁平插画，冷色调/);
  assert.match(prompt, /整段替换上级模板/);
  // 上级也没写模板时，按默认模板作为上级
  assert.ok(buildImageStylePrompt({ ...base, subdirectionName: 'AI 硬件' }).includes(`上级方向当前生效的配图模板：\n${DEFAULT_IMAGE_STYLE}`));
});

test('解析配图模板建议：去序号，兼容 note 字段，空结果报错', () => {
  const parsed = parseImageStyleSuggestion(JSON.stringify({ template: '1. 扁平插画\n- 不要 logo', changes: ['新增禁忌'] }));
  assert.equal(parsed.note, '扁平插画\n不要 logo');
  assert.deepEqual(parsed.changes, ['新增禁忌']);
  assert.equal(parseImageStyleSuggestion('{"note":"写实"}').note, '写实');
  assert.throws(() => parseImageStyleSuggestion('{"template":" "}'), /没有给出配图模板/);
});

test('requestImageStyle：缺密钥不请求；正常时走 JSON 模式并解析', async () => {
  let calls = 0;
  await assert.rejects(() => requestImageStyle(base, { ...config, apiKey: '' }, (async () => { calls++; return reply({}); }) as typeof fetch), /API Key/);
  assert.equal(calls, 0);
  let body: Record<string, unknown> = {};
  const result = await requestImageStyle(base, config, (async (_input: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return reply({ template: '面向{读者}：扁平科技插画\n画面里可以出现与内容相关的文字与数字，要写对写清楚', changes: ['从零起草'] });
  }) as typeof fetch);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  // 系统提示词已经改成「允许出现文字，但要求写对写清楚」，不能再要求 AI 加禁字一条
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.match(messages.find(message => message.role === 'system')!.content, /可以出现与内容相关的文字、字母、数字和图表数值/);
  assert.doesNotMatch(messages.find(message => message.role === 'system')!.content, /不要出现任何文字/);
  assert.equal(result.note, '面向{读者}：扁平科技插画\n画面里可以出现与内容相关的文字与数字，要写对写清楚');
});
