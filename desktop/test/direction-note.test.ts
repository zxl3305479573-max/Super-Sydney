import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectionNotePrompt, normalizeDirectionNoteRequest, parseDirectionNoteSuggestion, requestDirectionNote } from '../services/direction-note.ts';

const config = { apiKey: 'k', baseUrl: 'https://llm.example/v1', model: 'm', style: { targetAudience: '55-75岁读者', tone: '', voice: '', wordCount: '', blacklistWords: [], blacklistTopics: [] } };
const reply = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });

test('请求校验：方向名必填，文本裁剪，类型不对报错', () => {
  assert.throws(() => normalizeDirectionNoteRequest({ directionName: '  ', note: 'x' }), /内容方向名称/);
  assert.throws(() => normalizeDirectionNoteRequest({ directionName: '健康', note: 3 }), /note/);
  assert.throws(() => normalizeDirectionNoteRequest(null), /请求格式/);
  assert.deepEqual(normalizeDirectionNoteRequest({ directionName: ' 健康 ', note: ' 少术语 ' }),
    { directionName: '健康', directionNote: '', subdirectionName: '', note: '少术语', audience: '' });
});

test('一级方向提示词：只带方向与原稿，不带账号级读者定位', () => {
  const prompt = buildDirectionNotePrompt({ directionName: 'AI技术', directionNote: '', subdirectionName: '', note: '不诊疗' });
  assert.match(prompt, /内容方向：AI技术/);
  assert.doesNotMatch(prompt, /读者：|中老年|55-75/);
  assert.match(prompt, /约束原稿：\n不诊疗/);
  assert.match(prompt, /4-8 条/);
  assert.doesNotMatch(prompt, /具体方向：/);
});

test('具体方向提示词：带上一级约束并要求不重复；原稿为空时从零写', () => {
  const prompt = buildDirectionNotePrompt({ directionName: '健康', directionNote: '不诊疗', subdirectionName: '饮食', note: '' });
  assert.match(prompt, /具体方向：饮食/);
  assert.match(prompt, /一级方向已有约束（不要重复）：\n不诊疗/);
  assert.match(prompt, /（空，请从零写）/);
  assert.match(prompt, /1-4 条/);
});

test('解析回复：去掉序号与项目符号，空结果报错', () => {
  const parsed = parseDirectionNoteSuggestion(JSON.stringify({ note: '1. 语气平和\n- 不给剂量\n\n• 配图不出现文字', changes: ['补充配图要求', 3, ' '] }));
  assert.equal(parsed.note, '语气平和\n不给剂量\n配图不出现文字');
  assert.deepEqual(parsed.changes, ['补充配图要求']);
  assert.throws(() => parseDirectionNoteSuggestion('{"note":"  "}'), /没有给出约束/);
  assert.throws(() => parseDirectionNoteSuggestion('not json'), /有效 JSON/);
});

test('requestDirectionNote：缺密钥不请求；正常时发送 JSON 模式请求并解析', async () => {
  let calls = 0;
  const request = { directionName: '健康', directionNote: '', subdirectionName: '', note: '不诊疗' };
  await assert.rejects(() => requestDirectionNote(request, { ...config, apiKey: '' }, (async () => { calls++; return reply({}); }) as typeof fetch), /API Key/);
  assert.equal(calls, 0);
  let body: Record<string, unknown> = {};
  const result = await requestDirectionNote(request, config, (async (_input: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return reply({ note: '不诊断、不开药方\n配图不出现医疗器械', changes: ['补充配图要求'] });
  }) as typeof fetch);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(result.note, '不诊断、不开药方\n配图不出现医疗器械');
  assert.deepEqual(result.changes, ['补充配图要求']);
});

test('提示词带上方向自己的目标读者（填了才带）', () => {
  assert.match(buildDirectionNotePrompt({ directionName: 'AI技术', directionNote: '', subdirectionName: '', note: '', audience: '程序员' }), /这个方向的目标读者：程序员/);
  assert.doesNotMatch(buildDirectionNotePrompt({ directionName: 'AI技术', directionNote: '', subdirectionName: '', note: '' }), /目标读者/);
});
