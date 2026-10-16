import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VIDEO_TTS_DEFAULTS, normalizeVideoTtsSettings, readVideoTtsSettings, requestSpeech, writeVideoTtsSettings } from '../services/video-tts.ts';

const profile = { provider: 'openai' as const, baseUrl: 'https://tts.example.com/v1', model: 'tts-model', voice: 'anna', speed: 1.1 };

test('tts settings default to the free system voice and validate patches', () => {
  assert.equal(VIDEO_TTS_DEFAULTS.provider, 'system');
  const next = normalizeVideoTtsSettings({ provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1/', speed: 9, systemRate: -12 });
  assert.equal(next.baseUrl, 'https://api.siliconflow.cn/v1');
  assert.equal(next.speed, 2);
  assert.equal(next.systemRate, -5);
  assert.throws(() => normalizeVideoTtsSettings({ provider: 'edge' as never }), /配音来源/);
  assert.throws(() => normalizeVideoTtsSettings({ baseUrl: 'ftp://x' }), /http/);
});

test('tts settings persist to userData and fall back to defaults when the file is broken', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-video-tts-'));
  try {
    assert.deepEqual(readVideoTtsSettings(directory), VIDEO_TTS_DEFAULTS);
    writeVideoTtsSettings(directory, { provider: 'openai', voice: 'anna' });
    assert.equal(readVideoTtsSettings(directory).voice, 'anna');
    // 只改一个字段时，其它字段沿用文件里已有的值。
    writeVideoTtsSettings(directory, { speed: 0.8 });
    assert.equal(readVideoTtsSettings(directory).provider, 'openai');
    fs.writeFileSync(path.join(directory, 'video-tts.json'), '{oops');
    assert.deepEqual(readVideoTtsSettings(directory), VIDEO_TTS_DEFAULTS);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('speech requests use the OpenAI-compatible shape and return the audio bytes', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  let auth = '';
  const bytes = await requestSpeech(profile, 'key-1', '早上先喝一杯温水', async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    auth = new Headers(init?.headers).get('Authorization') ?? '';
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  });
  assert.equal(url, 'https://tts.example.com/v1/audio/speech');
  assert.deepEqual(body, { model: 'tts-model', input: '早上先喝一杯温水', voice: 'anna', response_format: 'mp3', speed: 1.1 });
  assert.equal(auth, 'Bearer key-1');
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test('speech requests fail loudly instead of saving an error page as audio', async () => {
  let called = false;
  await assert.rejects(() => requestSpeech(profile, '', '文本', async () => { called = true; return new Response(''); }), /API Key/);
  assert.equal(called, false);
  await assert.rejects(() => requestSpeech(profile, 'k', '文本', async () => new Response('{"error":"bad voice"}', { status: 400 })), /HTTP 400.*bad voice/);
  await assert.rejects(() => requestSpeech(profile, 'k', '文本', async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })), /不是音频/);
  await assert.rejects(() => requestSpeech(profile, 'k', '文本', async () => new Response(new Uint8Array(), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })), /没有返回音频/);
});
