import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContentTask, ContentTaxonomy } from '../shared.ts';
import { DEFAULT_IMAGE_STYLE, IMAGE_STYLE_PRESETS, renderImageStyle } from '../services/image-style.ts';
import { coverImagePrompt, imagePromptScope } from '../services/content-api-config.ts';
import { buildImagePrompt } from '../services/content-images.ts';

const whiteboard = IMAGE_STYLE_PRESETS.find(item => item.key === 'whiteboard')!.template;
const PROFILE = { accountName: '', industry: '', author: '', persona: '', theme: '', wordCount: '', contentStyle: '', blacklistWords: [] as string[], blacklistTopics: [] as string[], tone: '', voice: '' };

test('预设都允许画面出现文字与数字（但要求写对写清楚），不再禁字；键名不重复；通用写实就是内置默认', () => {
  for (const preset of IMAGE_STYLE_PRESETS) {
    assert.match(preset.template, /可以出现与(?:内容|这段内容)(?:相关|对应)/, preset.label);
    assert.match(preset.template, /写对、写清楚/, preset.label);
    assert.doesNotMatch(preset.template, /不要出现任何文字|不要出现文字/, preset.label);
  }
  assert.equal(new Set(IMAGE_STYLE_PRESETS.map(item => item.key)).size, IMAGE_STYLE_PRESETS.length);
  assert.equal(IMAGE_STYLE_PRESETS.find(item => item.key === 'default')?.template, DEFAULT_IMAGE_STYLE);
});

test('手绘白板预设：覆盖适老化规范的各项硬约束', () => {
  for (const pattern of [/whiteboard hand-drawn/, /#FFFDF9/, /不超过 2 种/, /#E67E22/, /#27AE60/, /#E74C3C/, /35%/, /字号大、对比强/, /具体现实人物/]) {
    assert.match(whiteboard, pattern);
  }
});

test('手绘白板预设的 {读者}：有读者定位时代入，没有时整段去掉不留花括号', () => {
  assert.match(renderImageStyle(whiteboard, '55-75岁读者'), /^面向55-75岁读者：手绘白板图解/);
  const bare = renderImageStyle(whiteboard, '');
  assert.match(bare, /^手绘白板图解/);
  assert.doesNotMatch(bare, /\{|\}/);
});

test('套用到资料后，封面与正文配图提示词都按白板风出图，方向约束仍在', () => {
  const taxonomy: ContentTaxonomy = {
    directions: [{ id: 1, name: '中老年健康科普', note: '不诊疗', imagePrompt: whiteboard, ...PROFILE, audience: '55-75岁读者', subdirections: [{ id: 11, name: '饮食', note: '', imagePrompt: '' }] }],
    defaultSubdirectionId: 11
  };
  const task = { id: 1, subdirectionId: 11, title: '降压药能不能停', topic: '' } as ContentTask;
  const scope = imagePromptScope(taxonomy, task, null);
  const cover = coverImagePrompt(task, scope);
  const inline = buildImagePrompt({ articleTitle: task.title, heading: '别擅自停药', excerpt: '夏天血压偏低', direction: scope.direction, style: scope.style });
  for (const prompt of [cover, inline]) {
    assert.match(prompt, /面向55-75岁读者：手绘白板图解/);
    assert.match(prompt, /不诊疗/);
    assert.doesNotMatch(prompt, /温暖写实|\{读者\}/);
  }
});
