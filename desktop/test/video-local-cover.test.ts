import test from 'node:test';
import assert from 'node:assert/strict';
import type { IpRenderKit } from '../shared.ts';
import { buildPlatformFitFfmpegArgs } from '../services/video-compose.ts';
import { LANDSCAPE_FRAME, VERTICAL_FRAME } from '../services/video-frame-spec.ts';
import { storyboardFromSrt } from '../services/video-pipeline.ts';
import {
  emptyVideoLocalCoverInput,
  normalizeVideoLocalCoverInput,
  pickVideoCoverPose,
  renderVideoLocalCoverHtml
} from '../services/video-local-cover.ts';

const KIT: IpRenderKit = {
  id: 'sydney',
  name: '雪梨工作室',
  tagline: '一人公司实操',
  colors: { primary: '#22304D', accent: '#F4E15B', secondary: '#8DBF5A' },
  avatar: 'data:image/png;base64,AVATAR',
  poses: [
    { id: 'p1', label: '打字', src: 'data:image/png;base64,TYPING' },
    { id: 'p2', label: '指向重点', src: 'data:image/png;base64,POINTING' }
  ]
};

test('本地视频封面模板支持无 IP 杂志大字风与有 IP 角色联动，并适配横竖屏画布', () => {
  const verticalPlain = renderVideoLocalCoverHtml({
    ...emptyVideoLocalCoverInput('起床记住|【三个半分钟】', false),
    style: 'warm',
    tag: '健康科普',
    sub: '每天多等半分钟，减少晨起头晕'
  }, 'douyin', null);
  assert.match(verticalPlain, /width:1080px;height:1920px/);
  assert.match(verticalPlain, /<mark>三个半分钟<\/mark>/);
  assert.match(verticalPlain, /class="tag">健康科普<\/div>/);
  assert.doesNotMatch(verticalPlain, /class="hero"/);

  const landscapeIp = renderVideoLocalCoverHtml({
    ...emptyVideoLocalCoverInput('一个人如何用【AI工具】|跑通多平台内容', true),
    style: 'ip-dark',
    tag: '实操复盘'
  }, 'bilibili', KIT);
  assert.match(landscapeIp, /width:1920px;height:1080px/);
  assert.match(landscapeIp, /#22304D/i);
  assert.match(landscapeIp, /base64,POINTING/, '自动优先选择指向类动作');
  // 不展示头像与品牌名文字，避免画面杂乱。
  assert.ok(!landscapeIp.includes('雪梨工作室') && !landscapeIp.includes('base64,AVATAR'));

  // 退回无 IP 时，ip-dark 自动回落到深色纯文字模板，不留坏状态。
  assert.equal(normalizeVideoLocalCoverInput({ style: 'ip-dark', title: '测试' }, false).style, 'night');
  assert.equal(pickVideoCoverPose({ pose: 'p1' }, KIT)?.id, 'p1');
});

test('原生 FFmpeg 平台画布适配按比例自动切换直缩或高斯模糊补边并保持 +faststart', () => {
  const crossRatio = buildPlatformFitFfmpegArgs({
    source: 'raw-16x9.mp4',
    output: 'douyin-9x16.mp4',
    frame: VERTICAL_FRAME,
    sourceWidth: 1920,
    sourceHeight: 1080,
    hasAudio: true,
    maxSeconds: 45
  });
  const filter = crossRatio[crossRatio.indexOf('-filter_complex') + 1];
  assert.match(filter, /boxblur=32:2/);
  assert.match(filter, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
  assert.equal(crossRatio[crossRatio.indexOf('-t') + 1], '45.000');
  assert.ok(crossRatio.includes('+faststart'));

  const sameRatio = buildPlatformFitFfmpegArgs({
    source: 'raw-16x9.mp4',
    output: 'bili-16x9.mp4',
    frame: LANDSCAPE_FRAME,
    sourceWidth: 1280,
    sourceHeight: 720,
    hasAudio: false
  });
  const directFilter = sameRatio[sameRatio.indexOf('-filter_complex') + 1];
  assert.doesNotMatch(directFilter, /boxblur/);
  assert.match(directFilter, /scale=1920:1080:flags=lanczos/);
  assert.ok(sameRatio.includes('-an'));
});

test('SRT 字幕自动聚合为结构化多镜分镜，为下游 B 站章节时间轴供给真实段落', () => {
  const srt = [
    '1\n00:00:00,000 --> 00:00:05,000\n先看第一个常见误区，很多人一上来就盲目堆工具。',
    '2\n00:00:05,200 --> 00:00:11,000\n其实真正卡住产出的往往是选题和脚本结构。',
    '3\n00:00:11,500 --> 00:00:22,000\n第二步是把口播稿拆成清晰镜头，每镜只讲一件事。',
    '4\n00:00:22,500 --> 00:00:34,000\n最后一步做好质量验收和多平台差异化标题。'
  ].join('\n\n');
  const shots = storyboardFromSrt(srt, '已有素材剪辑', 35);
  assert.ok(shots.length >= 2 && shots.length <= 4);
  assert.equal(shots[0].role, 'hook');
  assert.equal(shots.at(-1)!.role, 'takeaway');
  assert.ok(shots.every(shot => Array.from(shot.caption).length <= 12 && shot.caption.length > 0));
});
