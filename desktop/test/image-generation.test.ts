import assert from 'node:assert/strict';
import test from 'node:test';
import { imageErrorText, imageSizeFor, requestGeneratedImage, useImageFetch } from '../services/image-generation.ts';

const config = { apiKey: 'k', baseUrl: 'https://img.example/v1', model: 'gpt-image-2' };

test('gpt-image 只用它支持的尺寸，按横竖方向换算；其它模型原样传', () => {
  assert.equal(imageSizeFor('gpt-image-2', '1792x1024'), '1536x1024');
  assert.equal(imageSizeFor('gpt-image-2.5-flare', '1024x1792'), '1024x1536');
  assert.equal(imageSizeFor('gpt-image-2', '1024x1536'), '1024x1536');
  assert.equal(imageSizeFor('gpt-image-2', '1024x1024'), '1024x1024');
  assert.equal(imageSizeFor('dall-e-3', '1792x1024'), '1792x1024');
});

test('请求走可替换的 fetch；不传 response_format，网关报错带上原因', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  useImageFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ error: { message: 'Model not found' } }), { status: 404 });
  });
  try {
    await assert.rejects(requestGeneratedImage(config, '一杯茶', '1792x1024'), /HTTP 404）：Model not found/);
    assert.equal(bodies[0].size, '1536x1024');
    assert.equal('response_format' in bodies[0], false);
  } finally {
    useImageFetch((...args) => fetch(...args));
  }
});

test('b64_json 直接解码返回', async () => {
  useImageFetch(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] })));
  try {
    assert.equal((await requestGeneratedImage(config, '一杯茶')).toString(), 'png');
  } finally {
    useImageFetch((...args) => fetch(...args));
  }
});

test('fetch failed 换成说得清原因的提示', () => {
  const error = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  assert.equal(imageErrorText(error), '连不上图片接口（UND_ERR_CONNECT_TIMEOUT）：检查网络或代理');
});
