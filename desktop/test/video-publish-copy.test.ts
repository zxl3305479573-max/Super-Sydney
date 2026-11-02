import test from 'node:test';
import assert from 'node:assert/strict';
import { clipPublishText, videoPublishCopy, VIDEO_PUBLISH_LIMITS } from '../services/video-publish-copy.ts';

test('发布文案按各平台上限截断，并保留标题回退', () => {
  const project = {
    title: '这是一个很长的视频标题，用来验证小红书标题会被截断',
    topic: '备用选题',
    script: '第一段描述。\n第二段描述。'
  };
  const xhs = videoPublishCopy(project, 'xiaohongshu');
  assert.equal(Array.from(xhs.title).length, VIDEO_PUBLISH_LIMITS.xiaohongshu.title);
  assert.equal(xhs.body, project.script);

  const fallback = videoPublishCopy({ title: '', topic: '备用选题', script: '' }, 'douyin');
  assert.equal(fallback.title, '备用选题');
  assert.equal(fallback.body, '备用选题');
});

test('clipPublishText 不切断 emoji 代理对', () => {
  assert.equal(clipPublishText('健康😀科普', 3), '健康😀');
  assert.equal(Array.from(clipPublishText('健康😀科普', 3)).length, 3);
});
