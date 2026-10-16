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

/* ── 流式 ─────────────────────────────────────────────────── */

/** 按给定间隔逐段吐出 SSE 文本；收到中断信号就以 AbortError 结束读取。 */
function sse(pieces: string[], gapMs = 0, signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const piece of pieces) {
        if (gapMs) await new Promise(resolve => setTimeout(resolve, gapMs));
        if (signal?.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return; }
        controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

test('流式：拼起各段 delta，数据行被切在半中间也能接上，[DONE] 结束', async () => {
  let body: Record<string, unknown> = {};
  const whole = `: keep-alive\n\n${delta('{"claims"')}${delta(':[]}')}data: [DONE]\n\n`;
  const content = await requestChatContent(config, 's', 'u', {
    stream: true,
    fetchImpl: (async (_input: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return sse([whole.slice(0, 30), whole.slice(30, 61), whole.slice(61)]); }) as typeof fetch
  });
  assert.equal(content, '{"claims":[]}');
  assert.equal(body.stream, true);
});

test('流式：一直在出字就不受总时长以外的限制，慢也能拿到完整结果', async () => {
  const content = await requestChatContent(config, 's', 'u', {
    stream: true, idleMs: 60, timeoutMs: 5_000,
    fetchImpl: (async (_input: string, init: RequestInit) => sse([delta('一'), delta('二'), delta('三'), 'data: [DONE]\n\n'], 30, init.signal)) as typeof fetch
  });
  assert.equal(content, '一二三');
});

test('流式：连续 idleMs 没有任何数据判定为卡住', async () => {
  await assert.rejects(() => requestChatContent(config, 's', 'u', {
    label: '内容 API', stream: true, idleMs: 30, timeoutMs: 5_000,
    fetchImpl: (async (_input: string, init: RequestInit) => sse([delta('一'), delta('二')], 80, init.signal)) as typeof fetch
  }), /内容 API 连续 0 秒没有生成任何内容/);
});

test('流式：网关不支持流式、直接回普通 JSON 时照常解析；流里带 error 按报错处理', async () => {
  assert.equal(await requestChatContent(config, 's', 'u', { stream: true, fetchImpl: (async () => reply('整段')) as typeof fetch }), '整段');
  await assert.rejects(() => requestChatContent(config, 's', 'u', {
    label: '内容 API', stream: true, fetchImpl: (async () => sse([`data: ${JSON.stringify({ error: { message: '服务繁忙' } })}\n\n`])) as typeof fetch
  }), /内容 API 请求失败：服务繁忙/);
});

test('流式：只有保活注释、模型一个字都没出，按卡住处理，不会一直干等', async () => {
  await assert.rejects(() => requestChatContent(config, 's', 'u', {
    label: '内容 API', stream: true, idleMs: 50, timeoutMs: 5_000,
    fetchImpl: (async (_input: string, init: RequestInit) => sse(Array.from({ length: 10 }, () => ': keep-alive\n\n'), 20, init.signal)) as typeof fetch
  }), /内容 API 连续 0 秒没有生成任何内容/);
});

test('服务繁忙（503）自动重试，恢复后拿到结果', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls < 3 ? new Response(JSON.stringify({ error: { message: 'Service is too busy.' } }), { status: 503 }) : reply('好了');
  }) as typeof fetch;
  assert.equal(await requestChatContent(config, 's', 'u', { retryDelaysMs: [0, 0], fetchImpl }), '好了');
  assert.equal(calls, 3);
});

test('重试用完仍繁忙时说明是服务繁忙；其他错误（如 402）不重试', async () => {
  let calls = 0;
  const busy = (async () => { calls += 1; return new Response(JSON.stringify({ error: { message: 'Service is too busy.' } }), { status: 503 }); }) as typeof fetch;
  await assert.rejects(() => requestChatContent(config, 's', 'u', { label: '内容 API', retryDelaysMs: [0, 0], fetchImpl: busy }), /内容 API 服务繁忙，已自动重试 2 次仍不可用.*HTTP 503/);
  assert.equal(calls, 3);
  calls = 0;
  const broke = (async () => { calls += 1; return new Response('{}', { status: 402 }); }) as typeof fetch;
  await assert.rejects(() => requestChatContent(config, 's', 'u', { retryDelaysMs: [0, 0], fetchImpl: broke }), /HTTP 402/);
  assert.equal(calls, 1);
});

test('要了流式但网关回整段 JSON：等整段生成不受卡住判定影响', async () => {
  const slowJson = (async () => {
    const body = new ReadableStream<Uint8Array>({ async start(controller) {
      await new Promise(resolve => setTimeout(resolve, 80));
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '整段' } }] })));
      controller.close();
    } });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  assert.equal(await requestChatContent(config, 's', 'u', { stream: true, idleMs: 30, timeoutMs: 5_000, fetchImpl: slowJson }), '整段');
});
