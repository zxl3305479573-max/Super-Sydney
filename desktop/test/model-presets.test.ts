import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelPresetStore, matchActivePreset, normalizePresetInput, type PresetKeyVault } from '../services/model-presets.ts';

function memoryVault(): PresetKeyVault & { value: string } {
  return { value: '', read() { return this.value; }, save(value: string) { this.value = value; }, remove() { this.value = ''; } };
}

function store() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-'));
  const vault = memoryVault();
  return { presets: new ModelPresetStore(directory, vault), vault, directory };
}

test('存预设：key 留空沿用当前 key，同类型同名覆盖而不是新建', () => {
  const { presets } = store();
  const first = presets.save({ kind: 'image', name: '主力', baseUrl: 'https://a.example.com/v1/', model: 'gpt-image-2', provider: 'openai', estimatedCost: '0.04' }, 'sk-current');
  assert.equal(first.baseUrl, 'https://a.example.com/v1');
  assert.equal(presets.apiKey(first.id), 'sk-current');
  const second = presets.save({ kind: 'image', name: '主力', baseUrl: 'https://b.example.com/v1', model: 'flux', apiKey: 'sk-new' }, 'sk-current');
  assert.equal(second.id, first.id);
  assert.equal(presets.list().length, 1);
  assert.equal(presets.apiKey(first.id), 'sk-new');
  // 内容模型可以和图片模型同名，互不覆盖。
  presets.save({ kind: 'writer', name: '主力', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, 'sk-writer');
  assert.equal(presets.list().length, 2);
});

test('没有 key、地址不合法、缺模型名都直接报错', () => {
  const { presets } = store();
  assert.throws(() => presets.save({ kind: 'writer', name: '', baseUrl: 'https://x.com/v1', model: 'm' }, ''), /API Key/);
  assert.throws(() => normalizePresetInput({ kind: 'writer', name: '', baseUrl: 'ftp://x', model: 'm' }), /http/);
  assert.throws(() => normalizePresetInput({ kind: 'image', name: '', baseUrl: 'https://x.com', model: ' ' }), /模型名/);
  assert.equal(normalizePresetInput({ kind: 'writer', name: ' ', baseUrl: 'https://x.com', model: 'deepseek-chat' }).name, 'deepseek-chat');
});

test('删除预设同时删掉它的 key；最后一个删完就清空密钥文件', () => {
  const { presets, vault } = store();
  const one = presets.save({ kind: 'writer', name: 'a', baseUrl: 'https://x.com', model: 'm1' }, 'k1');
  const two = presets.save({ kind: 'writer', name: 'b', baseUrl: 'https://x.com', model: 'm2' }, 'k2');
  presets.remove(one.id);
  assert.deepEqual(presets.list().map(item => item.id), [two.id]);
  assert.equal(presets.apiKey(one.id), '');
  presets.remove(two.id);
  assert.equal(vault.value, '');
  assert.throws(() => presets.find(two.id), /不存在/);
});

test('当前配置按地址 + 模型（图片再加 provider）对应预设，对不上就是自定义', () => {
  const { presets } = store();
  const image = presets.save({ kind: 'image', name: 'x', baseUrl: 'https://a.com/v1', model: 'gpt-image-2', provider: 'openai' }, 'k');
  const list = presets.list();
  assert.equal(matchActivePreset(list, 'image', { baseUrl: 'https://a.com/v1/', model: 'gpt-image-2', provider: 'openai' }), image.id);
  assert.equal(matchActivePreset(list, 'image', { baseUrl: 'https://a.com/v1', model: 'gpt-image-2', provider: 'doubao' }), '');
  assert.equal(matchActivePreset(list, 'writer', { baseUrl: 'https://a.com/v1', model: 'gpt-image-2' }), '');
});
