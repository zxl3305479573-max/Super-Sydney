import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContentTask, ContentTaxonomy } from '../shared.ts';
import { buildContentApiConfig, coverImagePrompt, imageApiConfig, imagePromptScope } from '../services/content-api-config.ts';
import { RequestLock } from '../services/request-lock.ts';
import { ImageJobs, clampImageCount } from '../services/image-generation.ts';

const taxonomy: ContentTaxonomy = {
  directions: [{ id: 1, name: '健康科普', note: '不诊疗', subdirections: [{ id: 11, name: '饮食', note: '少术语' }] }],
  defaultSubdirectionId: 11
};
const style = 'target_audience: "55-75岁读者"\ntone: "平和"\n';

test('内容 API：config.yaml 的 writer 段优先于环境变量，并注入内容方向', () => {
  const config = buildContentApiConfig({
    files: { styleText: style, configText: 'writer:\n  enabled: true\n  base_url: "https://llm.example/v1"\n  model: "m1"\n' },
    llmEnabled: false, apiKey: 'sk-test', taxonomy, subdirectionId: 11, env: { SYDNEY_LLM_MODEL: 'env-model' }
  });
  assert.equal(config.baseUrl, 'https://llm.example/v1');
  assert.equal(config.model, 'm1');
  assert.equal(config.style?.targetAudience, '55-75岁读者');
  assert.deepEqual(config.direction, { name: '健康科普', note: '不诊疗' });
  assert.deepEqual(config.subdirection, { name: '饮食', note: '少术语' });
});

test('内容 API：writer.enabled 缺省时跟随应用开关；视频不传方向', () => {
  const files = { styleText: null, configText: null };
  assert.throws(() => buildContentApiConfig({ files, llmEnabled: false, apiKey: '', taxonomy, env: {} }), /允许内容 API 调用/);
  const config = buildContentApiConfig({ files, llmEnabled: true, apiKey: '', taxonomy, env: {} });
  assert.equal(config.model, 'deepseek-chat');
  assert.equal(config.direction, undefined);
});

test('内容 API：writer.enabled=false 时即使应用开关打开也拒绝', () => {
  const files = { styleText: null, configText: 'writer:\n  enabled: false\n' };
  assert.throws(() => buildContentApiConfig({ files, llmEnabled: true, apiKey: '', taxonomy, env: {} }), /允许内容 API 调用/);
});

test('图片 API：缺密钥直接报错，地址去掉末尾斜杠', () => {
  assert.throws(() => imageApiConfig(null), /图片 API Key/);
  assert.deepEqual(imageApiConfig('image:\n  api_key: "k"\n  base_url: "https://img.example/v1/"\n'), { apiKey: 'k', baseUrl: 'https://img.example/v1', model: 'gpt-image-2' });
});

test('封面提示词带上方向约束与读者定位', () => {
  const task = { id: 1, subdirectionId: 11, title: '晚饭吃多少', topic: '' } as ContentTask;
  const prompt = coverImagePrompt(task, imagePromptScope(taxonomy, task, style));
  assert.match(prompt, /内容方向：健康科普 \/ 饮食（不诊疗 少术语）/);
  assert.match(prompt, /面向55-75岁读者/);
  assert.match(prompt, /主题：晚饭吃多少/);
});

test('RequestLock 同一任务不并发，结束后释放', async () => {
  const lock = new RequestLock('忙');
  let release!: () => void;
  const first = lock.run(1, () => new Promise<void>(resolve => { release = resolve; }));
  assert.equal(lock.has(1), true);
  await assert.rejects(lock.run(1, async () => undefined), /忙/);
  release();
  await first;
  assert.equal(lock.has(1), false);
});

test('ImageJobs 取消只对进行中的任务生效；配图张数夹在 1..5', () => {
  const jobs = new ImageJobs();
  assert.equal(jobs.cancel(1), false);
  const signal = jobs.begin(1);
  assert.equal(jobs.cancel(1), true);
  assert.equal(signal.aborted, true);
  jobs.end(1);
  assert.equal(jobs.cancel(1), false);
  assert.deepEqual([clampImageCount(0), clampImageCount(9), clampImageCount('2'), clampImageCount('x')], [3, 5, 2, 3]);
});
