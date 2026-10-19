import test from 'node:test';
import assert from 'node:assert/strict';
import type { VideoProject } from '../shared.ts';
import {
  buildVideoCoverImagePrompt, buildVideoShotImagePrompt, VIDEO_IMAGE_PROMPT_DEFAULTS, VIDEO_STORYBOARD_IMAGE_PROMPT_RULE
} from '../services/video-image-prompts.ts';
import { emptyRenderAssets, VIDEO_RENDER_DEFAULTS } from '../services/video-production.ts';

function project(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 1, platform: 'douyin', topic: '控糖早餐', title: '早餐怎么吃', audience: '中老年读者', durationSeconds: 60,
    status: 'storyboard', topicsJson: '', script: '先吃鸡蛋，再搭配主食。', storyboardJson: '', coverPath: '', exportPath: '',
    createdAt: '', updatedAt: '', options: { ...VIDEO_RENDER_DEFAULTS }, assets: emptyRenderAssets(), ...patch
  };
}

test('逐镜配图提示词单独维护，并按 imagePrompt、visual、caption、标题依次回退', () => {
  const shot = { index: 1, seconds: 5, visual: '厨房', narration: '口播', caption: '早餐' };
  const prompt = buildVideoShotImagePrompt({ ...shot, imagePrompt: '清晨的厨房餐桌' }, '早餐怎么吃');
  assert.match(prompt, /主题「早餐怎么吃」/);
  assert.match(prompt, /画面：清晨的厨房餐桌/);
  assert.match(prompt, /中国家庭或社区日常场景/);
  assert.match(buildVideoShotImagePrompt(shot, '早餐怎么吃'), /画面：厨房/);
  assert.match(buildVideoShotImagePrompt({ ...shot, visual: '' }, '早餐怎么吃'), /画面：早餐/);
  const custom = buildVideoShotImagePrompt(shot, '早餐怎么吃', '自定义 {title}：{subject}');
  assert.equal(custom, '自定义 早餐怎么吃：厨房');
  // 替换用户文本时不把 $& 等字符串当作 replace 的特殊语法。
  assert.match(buildVideoShotImagePrompt({ ...shot, imagePrompt: '$& 与 $`' }, 'T'), /\$& 与 \$`/);
});

test('分镜生图规则和竖版封面提示词也在独立模块中', () => {
  assert.match(VIDEO_STORYBOARD_IMAGE_PROMPT_RULE, /主体 \+ 一个明确动作 \+ 环境 \+ 构图 \+ 光线 \+ 情绪/);
  assert.match(VIDEO_STORYBOARD_IMAGE_PROMPT_RULE, /不要出现任何文字、数字、标志/);
  const cover = buildVideoCoverImagePrompt(project({ script: '第一段内容。'.repeat(40) }));
  assert.match(cover, /9:16 竖版短视频封面/);
  assert.match(cover, /主题「早餐怎么吃」/);
  assert.match(cover, /内容线索：第一段内容/);
  assert.match(cover, /底部留出干净的标题安全区/);
  assert.match(buildVideoCoverImagePrompt(project({ title: '$&', script: '' })), /主题「\$&」/);
  assert.equal(buildVideoCoverImagePrompt(project(), '封面 {title}｜{context}'), '封面 早餐怎么吃｜内容线索：先吃鸡蛋，再搭配主食。');
  assert.equal(VIDEO_IMAGE_PROMPT_DEFAULTS.storyboardImagePromptRule, VIDEO_STORYBOARD_IMAGE_PROMPT_RULE);
});
