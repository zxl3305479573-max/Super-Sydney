import assert from 'node:assert/strict';
import test from 'node:test';
import { IP_IMAGE_INSTRUCTION, imageErrorText, imageSizeFor, multipartBody, requestGeneratedImage, useImageFetch, withIpInstruction } from '../services/image-generation.ts';

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

test('选了 IP：改走 /images/edits，表单里带原提示词 + 融入角色的说明和参考图', async () => {
  const calls: Array<{ url: string; type: string; body: string }> = [];
  useImageFetch(async (input, init) => {
    calls.push({ url: String(input), type: String((init?.headers as Record<string, string>)['Content-Type']), body: Buffer.from(init?.body as Uint8Array).toString('latin1') });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('PNG').toString('base64') }] }), { status: 200 });
  });
  try {
    const reference = { bytes: Buffer.from('JPEGDATA'), filename: 'ip-reference.jpg', contentType: 'image/jpeg' };
    const bytes = await requestGeneratedImage(config, withIpInstruction('一杯茶'), '1024x1536', undefined, [reference]);
    assert.equal(bytes.toString(), 'PNG');
    assert.equal(calls[0].url, 'https://img.example/v1/images/edits');
    assert.match(calls[0].type, /^multipart\/form-data; boundary=/);
    assert.ok(calls[0].body.includes('name="size"\r\n\r\n1024x1536'));
    assert.ok(calls[0].body.includes('name="image"; filename="ip-reference.jpg"\r\nContent-Type: image/jpeg\r\n\r\nJPEGDATA'));
    // 不传参考图时仍走原来的 generations
    await requestGeneratedImage(config, '一杯茶', '1024x1536');
    assert.equal(calls[1].url, 'https://img.example/v1/images/generations');
  } finally {
    useImageFetch((...args) => fetch(...args));
  }
});

test('接口不支持参考图时给出能看懂的提示', async () => {
  useImageFetch(async () => new Response('not found', { status: 404 }));
  try {
    const reference = { bytes: Buffer.from('x'), filename: 'a.jpg', contentType: 'image/jpeg' };
    await assert.rejects(requestGeneratedImage(config, 'p', '1024x1024', undefined, [reference]), /不支持参考图/);
  } finally {
    useImageFetch((...args) => fetch(...args));
  }
});

test('IP 说明只追加在原提示词后面，不要求写品牌名或加头像', () => {
  const prompt = withIpInstruction('  封面：一杯热茶  ');
  assert.ok(prompt.startsWith('封面：一杯热茶\n\n'));
  assert.ok(prompt.endsWith(IP_IMAGE_INSTRUCTION));
  assert.match(IP_IMAGE_INSTRUCTION, /不要在画面里写任何品牌名/);
  assert.match(IP_IMAGE_INSTRUCTION, /不要加头像框、角标或水印/);
});

test('multipart 表单：字段与文件按规范分段，多张图用 image[]', () => {
  const file = { bytes: Buffer.from([0, 255]), filename: 'a"b.png', contentType: 'image/png' };
  const { body, contentType } = multipartBody({ model: 'm' }, [{ field: 'image[]', file }, { field: 'image[]', file }], 'B');
  assert.equal(contentType, 'multipart/form-data; boundary=B');
  const text = body.toString('latin1');
  assert.ok(text.startsWith('--B\r\nContent-Disposition: form-data; name="model"\r\n\r\nm\r\n'));
  assert.equal(text.split('name="image[]"; filename="ab.png"').length, 3);
  assert.ok(text.endsWith('--B--\r\n'));
});
