import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonObject, requestChatContent, requestLlmJson } from '../services/llm-json.ts';

const config = { apiKey: 'key', baseUrl: 'https://llm.example/v1/', model: 'm' };
const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

test('requestChatContent 拼接地址、带上温度；纯文本模式不发 response_format', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const content = await requestChatContent(config, 'sys', 'user', {
    json: false, temperature: 0.5,
    fetchImpl: (async (input: string, init: RequestInit) => { url = input; body = JSON.parse(String(init.body)); return reply('正文'); }) as typeof fetch
  });
  assert.equal(content, '正文');
  assert.equal(url, 'https://llm.example/v1/chat/completions');
  assert.equal(body.temperature, 0.5);
  assert.equal(body.response_format, undefined);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user' }]);
});

test('requestChatContent 报错带服务名与网关给出的原因', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: '余额不足' } }), { status: 402 })) as typeof fetch;
  await assert.rejects(() => requestChatContent(config, 's', 'u', { label: '内容 API', fetchImpl }), /^Error: 内容 API 请求失败（HTTP 402）：余额不足$/);
  await assert.rejects(() => requestChatContent(config, 's', 'u', { label: '内容 API', fetchImpl: (async () => reply('  ')) as typeof fetch }), /内容 API 返回内容为空/);
});

test('requestChatContent 超时给出秒数', async () => {
  const hang = ((_input: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;
  await assert.rejects(() => requestChatContent(config, 's', 'u', { label: '视频 API', timeoutMs: 20, fetchImpl: hang }), /视频 API 请求超时（0 秒）/);
});

test('requestLlmJson 先校验配置再请求，并把负载序列化成 JSON', async () => {
  let called = false;
  await assert.rejects(() => requestLlmJson('s', {}, { ...config, apiKey: ' ' }, { fetchImpl: (async () => { called = true; return reply('{}'); }) as typeof fetch }), /API key/);
  assert.equal(called, false);
  let user = '';
  const result = await requestLlmJson('s', { a: 1 }, config, {
    fetchImpl: (async (_input: string, init: RequestInit) => { user = JSON.parse(String(init.body)).messages[1].content; return reply('```json\n{"ok":true}\n```'); }) as typeof fetch
  });
  assert.equal(user, '{"a":1}');
  assert.deepEqual(result, { ok: true });
});

test('parseJsonObject 区分无效 JSON 与非对象', () => {
  assert.throws(() => parseJsonObject('nope', '视频 API'), /视频 API 返回的内容不是有效 JSON/);
  assert.throws(() => parseJsonObject('[1]', '内容 API'), /内容 API 必须返回 JSON 对象/);
});
