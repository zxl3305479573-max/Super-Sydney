import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContentTask, ContentTaxonomy } from '../shared.ts';
import { buildContentApiConfig, coverImagePrompt, imageApiConfig, imagePromptScope } from '../services/content-api-config.ts';
import { RequestLock } from '../services/request-lock.ts';
import { DEFAULT_IMAGE_STYLE, renderImageStyle, resolveImageStyle } from '../services/image-style.ts';
import { ImageJobs, clampCandidateCount, clampImageCount } from '../services/image-generation.ts';
const PROFILE = { accountName: '', industry: '', author: '', persona: '', theme: '', wordCount: '', contentStyle: '', blacklistWords: [] as string[], blacklistTopics: [] as string[] };

const taxonomy: ContentTaxonomy = {
  directions: [{ id: 1, name: '健康科普', note: '不诊疗', imagePrompt: '', ...PROFILE, audience: '60岁以上读者', tone: '温和', voice: '第二人称', subdirections: [{ id: 11, name: '饮食', note: '少术语', imagePrompt: '' }] }],
  defaultSubdirectionId: 11
};
const style = 'target_audience: "55-75岁读者"\ntone: "平和"\n';

test('内容 API：config.yaml 的 writer 段优先于环境变量，并注入内容方向', () => {
  const config = buildContentApiConfig({
    files: { styleText: style, configText: 'writer:\n  enabled: true\n  base_url: "https://llm.example/v1"\n  model: "m1"\n' },
    llmEnabled: true, apiKey: 'sk-test', taxonomy, subdirectionId: 11, env: { SYDNEY_LLM_MODEL: 'env-model' }
  });
  assert.equal(config.baseUrl, 'https://llm.example/v1');
  assert.equal(config.model, 'm1');
  // 归类文章用所属方向的读者定位，不用 style.yaml 的账号级值
  assert.equal(config.style?.targetAudience, '60岁以上读者');
  assert.equal(config.style?.tone, '温和');
  assert.equal(config.style?.voice, '第二人称');
  assert.deepEqual(config.direction, { name: '健康科普', note: '不诊疗' });
  assert.deepEqual(config.subdirection, { name: '饮食', note: '少术语' });
});

test('内容 API：新方向没填读者定位时为空，不回退到最初方向的账号设定', () => {
  const files = { styleText: style, configText: 'writer:\n  enabled: true\n' };
  const fresh: ContentTaxonomy = {
    directions: [{ id: 2, name: 'AI技术', note: '', imagePrompt: '', ...PROFILE, audience: '', tone: '', voice: '', subdirections: [{ id: 21, name: '大模型', note: '', imagePrompt: '' }] }],
    defaultSubdirectionId: 21
  };
  const config = buildContentApiConfig({ files, llmEnabled: true, apiKey: '', taxonomy: fresh, subdirectionId: 21, env: {} });
  assert.equal(config.style?.targetAudience, '');
  assert.equal(config.style?.tone, '');
});

/**
 * 回归：未归类文章以前会静默回退到 style.yaml（也就是最初那份账号资料）。
 * 未归类任务在每个资料下都会显示，于是「切了资料、改了读者定位，选题还是老领域」。
 */
test('内容 API：未归类或方向已被删除的文章不再悄悄用账号级 style.yaml', () => {
  const files = { styleText: style, configText: 'writer:\n  enabled: true\n' };
  const fresh: ContentTaxonomy = {
    directions: [{ id: 2, name: 'AI技术', note: '', imagePrompt: '', ...PROFILE, audience: '', tone: '', voice: '', subdirections: [{ id: 21, name: '大模型', note: '', imagePrompt: '' }] }],
    defaultSubdirectionId: 21
  };
  assert.throws(() => buildContentApiConfig({ files, llmEnabled: true, apiKey: '', taxonomy: fresh, subdirectionId: null, env: {} }), /还没有归到内容方向/);
  assert.throws(() => buildContentApiConfig({ files, llmEnabled: true, apiKey: '', taxonomy: fresh, subdirectionId: 999, env: {} }), /已经不存在/);
  // 视频流水线不传这个字段，仍旧读账号级 style.yaml
  assert.equal(buildContentApiConfig({ files, llmEnabled: true, apiKey: '', taxonomy: fresh, env: {} }).style?.targetAudience, '55-75岁读者');
});

test('内容 API：只认应用的统一开关；视频不传方向', () => {
  const files = { styleText: null, configText: null };
  assert.throws(() => buildContentApiConfig({ files, llmEnabled: false, apiKey: '', taxonomy, env: {} }), /允许调用内容模型/);
  const config = buildContentApiConfig({ files, llmEnabled: true, apiKey: '', taxonomy, env: {} });
  assert.equal(config.model, 'deepseek-chat');
  assert.equal(config.direction, undefined);
});

test('内容 API：config.yaml 里旧的 writer.enabled 不再参与判断', () => {
  const files = { styleText: null, configText: 'writer:\n  enabled: false\n' };
  assert.equal(buildContentApiConfig({ files, llmEnabled: true, apiKey: '', taxonomy, env: {} }).model, 'deepseek-chat');
  assert.throws(() => buildContentApiConfig({ files: { styleText: null, configText: 'writer:\n  enabled: true\n' }, llmEnabled: false, apiKey: '', taxonomy, env: {} }), /允许调用内容模型/);
});

test('图片 API：缺密钥直接报错，地址去掉末尾斜杠', () => {
  assert.throws(() => imageApiConfig(null), /图片模型的 API Key/);
  assert.deepEqual(imageApiConfig('image:\n  api_key: "k"\n  base_url: "https://img.example/v1/"\n'), { apiKey: 'k', baseUrl: 'https://img.example/v1', model: 'gpt-image-2' });
});

test('封面提示词带上方向约束、读者定位，以及正文提要', () => {
  const task = { id: 1, subdirectionId: 11, title: '晚饭吃多少', topic: '', draft: '# 晚饭吃多少\n\n晚饭吃到七分饱，主食留一份粗粮，饭后散步二十分钟。' } as ContentTask;
  const prompt = coverImagePrompt(task, imagePromptScope(taxonomy, task, style));
  assert.match(prompt, /内容方向：健康科普 \/ 饮食（不诊疗 少术语）/);
  assert.match(prompt, /面向60岁以上读者/);
  assert.match(prompt, /主题：晚饭吃多少/);
  // 封面不是只看标题：正文提要进提示词，且没有把 Markdown 标记带进去
  assert.match(prompt, /封面要贴住正文内容：晚饭吃到七分饱/);
  assert.doesNotMatch(prompt, /# /);
});

test('封面提示词：正文为空时省掉提要这一行，不留空壳', () => {
  const task = { id: 1, subdirectionId: 11, title: '晚饭吃多少', topic: '' } as ContentTask;
  const prompt = coverImagePrompt(task, imagePromptScope(taxonomy, task, style));
  assert.doesNotMatch(prompt, /封面要贴住正文内容/);
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

test('ImageJobs 同一篇封面与配图并行：取消一起中断，结束一个不影响另一个', () => {
  const jobs = new ImageJobs();
  const cover = jobs.begin(1);
  const inline = jobs.begin(1);
  jobs.end(1, cover);
  assert.equal(jobs.cancel(1), true);
  assert.equal(inline.aborted, true);
  assert.equal(cover.aborted, false);
  jobs.end(1, inline);
  assert.equal(jobs.cancel(1), false);
});

test('候选张数夹在 1..3，默认 1 张＝沿用生成即插入', () => {
  assert.deepEqual([clampCandidateCount(undefined), clampCandidateCount(0), clampCandidateCount(9), clampCandidateCount('2'), clampCandidateCount('x')], [1, 1, 3, 2, 1]);
});

test('配图风格模板：具体方向优先，留空沿用方向，再留空用默认', () => {
  const custom: ContentTaxonomy = {
    directions: [{ id: 1, name: '科技', note: '', imagePrompt: '扁平插画，冷色调，给{读者}看。', ...PROFILE, audience: '程序员', tone: '', voice: '', subdirections: [
      { id: 11, name: 'AI 硬件', note: '', imagePrompt: '' },
      { id: 12, name: '手机', note: '', imagePrompt: '产品特写，不要品牌 logo。' }
    ] }],
    defaultSubdirectionId: 11
  };
  const inherit = { id: 1, subdirectionId: 11, title: '显卡怎么选', topic: '' } as ContentTask;
  const own = { id: 2, subdirectionId: 12, title: '手机怎么选', topic: '' } as ContentTask;
  const inheritPrompt = coverImagePrompt(inherit, imagePromptScope(custom, inherit, style));
  assert.match(inheritPrompt, /扁平插画，冷色调，给程序员看。/);
  assert.doesNotMatch(inheritPrompt, /温暖写实|医疗符号/);
  assert.match(coverImagePrompt(own, imagePromptScope(custom, own, style)), /产品特写，不要品牌 logo。/);
  const fallback = imagePromptScope(taxonomy, { id: 3, subdirectionId: 11 } as ContentTask, style).style;
  assert.match(fallback, /^面向60岁以上读者：写实/);
  assert.doesNotMatch(fallback, /医疗符号/, "通用默认模板不能带某个领域的禁忌");
});

test('配图风格模板：没有读者定位时去掉"面向{读者}："，不残留花括号', () => {
  assert.equal(renderImageStyle('面向{读者}：写实。\n给{读者}看。', ''), '写实。\n给读者看。');
  assert.equal(renderImageStyle(DEFAULT_IMAGE_STYLE, '中老年').startsWith('面向中老年：'), true);
  assert.equal(resolveImageStyle({ imagePrompt: '  ' }, { imagePrompt: '' }), DEFAULT_IMAGE_STYLE);
});
