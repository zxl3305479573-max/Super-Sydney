import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XHS_API_DEFAULTS, normalizeXhsApiSettings, readXhsApiSettings, writeXhsApiSettings, xhsImageConfig, xhsLlmConfig } from '../services/xhs-api-config.ts';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-xhs-api-')); }

test('默认关闭内容模型调用；文件缺失或损坏时用默认值', () => {
  const dir = tempDir();
  assert.deepEqual(readXhsApiSettings(dir), XHS_API_DEFAULTS);
  fs.writeFileSync(path.join(dir, 'xhs-api.json'), '{bad');
  assert.equal(readXhsApiSettings(dir).llmEnabled, false);
});

test('保存补丁：合并旧值、去掉末尾斜杠、空值回默认、拒绝非 http 地址', () => {
  const dir = tempDir();
  writeXhsApiSettings(dir, { llmEnabled: true, llmBaseUrl: 'https://llm.example/v1/', llmModel: ' deepseek-flash ' });
  const next = writeXhsApiSettings(dir, { imageModel: '' });
  assert.deepEqual(next, { ...XHS_API_DEFAULTS, llmEnabled: true, llmBaseUrl: 'https://llm.example/v1', llmModel: 'deepseek-flash', imageModel: 'gpt-image-2' });
  assert.deepEqual(readXhsApiSettings(dir), next);
  assert.throws(() => normalizeXhsApiSettings({ imageBaseUrl: 'ftp://x' }), /不是有效的 http/);
  assert.equal(normalizeXhsApiSettings({ llmEnabled: 'yes' as never }).llmEnabled, false);
});

test('调用前的门槛：开关、key 缺失时给出指向小红书设置的提示', () => {
  const on = { ...XHS_API_DEFAULTS, llmEnabled: true };
  assert.throws(() => xhsLlmConfig(XHS_API_DEFAULTS, 'k'), /还没开启.*请先在「隐私与设置 → 小红书模型」/);
  assert.throws(() => xhsLlmConfig(on, ' '), /内容模型 API Key/);
  assert.deepEqual(xhsLlmConfig(on, 'k'), { apiKey: 'k', baseUrl: on.llmBaseUrl, model: on.llmModel });
  assert.throws(() => xhsImageConfig(on, ''), /图片模型 API Key/);
  assert.equal(xhsImageConfig(on, 'img').model, 'gpt-image-2');
});
