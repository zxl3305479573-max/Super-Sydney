import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeModelConfigDraft } from '../services/model-config.ts';

const base = {
  writer: { baseUrl: 'https://api.example.com/v1/', model: '  writer-model  ', apiKey: '  writer-key  ' },
  image: { provider: ' openai ', model: ' image-model ', baseUrl: 'https://image.example.com/v1/', apiKey: ' image-key ', estimatedCost: ' 0.04 ' }
};

test('模型配置保存前会去掉地址尾斜杠和敏感字段空白', () => {
  assert.deepEqual(normalizeModelConfigDraft(base), {
    writer: { baseUrl: 'https://api.example.com/v1', model: 'writer-model', apiKey: 'writer-key' },
    image: { provider: 'openai', model: 'image-model', baseUrl: 'https://image.example.com/v1', apiKey: 'image-key', estimatedCost: '0.04' }
  });
});

test('内容模型缺地址或模型名时在写文件前报清晰错误', () => {
  assert.throws(() => normalizeModelConfigDraft({ ...base, writer: { ...base.writer, baseUrl: '' } }), /内容模型接口地址/);
  assert.throws(() => normalizeModelConfigDraft({ ...base, writer: { ...base.writer, model: ' ' } }), /内容模型名/);
  assert.throws(() => normalizeModelConfigDraft({ ...base, writer: { ...base.writer, baseUrl: 'ftp://example.com' } }), /http\(s\)/);
});

test('图片模型地址可以留空，费用格式仍然校验', () => {
  const result = normalizeModelConfigDraft({ ...base, image: { ...base.image, baseUrl: '', estimatedCost: '' } });
  assert.equal(result.image.baseUrl, '');
  assert.equal(result.image.estimatedCost, '0');
  assert.throws(() => normalizeModelConfigDraft({ ...base, image: { ...base.image, estimatedCost: '￥0.04' } }), /预估单价/);
});
