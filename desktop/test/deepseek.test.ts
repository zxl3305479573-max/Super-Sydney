import test from 'node:test';
import assert from 'node:assert/strict';
import { requestEventDraft, type DeepSeekInput } from '../services/deepseek.ts';

const input: DeepSeekInput = { prompt: '实现登录', response: '已完成登录流程' };
const draft = {
  what_done: '实现登录',
  why: '完成用户认证',
  tools: 'Codex',
  problems: '',
  solution: '增加认证流程',
  result: '登录可用',
  reuse: '沉淀为认证模板',
  category: '工作项目',
  content_candidate: true
};

test('sends only prompt and final response and normalizes the JSON result', async () => {
  let body = '';
  const result = await requestEventDraft(input, { apiKey: 'key', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }), { status: 200 });
  });
  assert.deepEqual(result, draft);
  assert.match(body, /实现登录/);
  assert.match(body, /已完成登录流程/);
  assert.doesNotMatch(body, /session|path|tool_output/i);
});

test('rejects before fetch when API key is missing', async () => {
  let called = false;
  await assert.rejects(
    () => requestEventDraft(input, { apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, async () => {
      called = true;
      return new Response('{}');
    }),
    /API key/
  );
  assert.equal(called, false);
});

test('reports HTTP and response-format failures', async () => {
  const config = { apiKey: 'key', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
  await assert.rejects(() => requestEventDraft(input, config, async () => new Response(JSON.stringify({ error: { message: '余额不足' } }), { status: 401 })), /401.*余额不足/);
  await assert.rejects(() => requestEventDraft(input, config, async () => new Response('{"choices":[{"message":{"content":"not json"}}]}', { status: 200 })), /JSON/);
});
