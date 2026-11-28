import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VideoProject } from '../shared.ts';
import {
  buildCompatTranscodeArgs,
  buildFaststartRemuxArgs,
  cleanVideoTitleFromFilename,
  prepareDirectUploadVideo,
  readNeutralCopyFile,
  validateLocalCoverPath,
  validateLocalVideoPath
} from '../services/video-direct-upload.ts';
import { isRenderFresh, renderSignature } from '../services/video-pipeline.ts';
import { VIDEO_RENDER_DEFAULTS, emptyRenderAssets } from '../services/video-production.ts';

function box(type: string, payloadSize: number): Buffer {
  const total = 8 + payloadSize;
  const buf = Buffer.alloc(total);
  buf.writeUInt32BE(total, 0);
  buf.write(type, 4, 4, 'latin1');
  return buf;
}

function faststartMp4Buffer(): Buffer {
  return Buffer.concat([box('ftyp', 16), box('moov', 64), box('mdat', 1200)]);
}

function slowMp4Buffer(): Buffer {
  return Buffer.concat([box('ftyp', 16), box('mdat', 1200), box('moov', 64)]);
}

test('cleanVideoTitleFromFilename 与本地视频/封面/中性文案文件校验', () => {
  assert.equal(cleanVideoTitleFromFilename('D:/clips/2026_demo_clip_v2.mp4'), '2026 demo clip v2');
  assert.equal(cleanVideoTitleFromFilename('  ___.mov'), '本地上传视频');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-direct-upload-'));
  try {
    const mp4 = path.join(dir, 'sample.mp4');
    const cover = path.join(dir, 'cover.jpg');
    const copyMd = path.join(dir, 'copy.md');
    const emptyTxt = path.join(dir, 'empty.txt');
    const badFile = path.join(dir, 'archive.zip');
    fs.writeFileSync(mp4, faststartMp4Buffer());
    fs.writeFileSync(cover, Buffer.from('fake-jpg'));
    fs.writeFileSync(copyMd, '\uFEFF第一行卖点\r\n第二行受众说明  ', 'utf8');
    fs.writeFileSync(emptyTxt, '   \r\n  ', 'utf8');
    fs.writeFileSync(badFile, 'zip');

    assert.equal(validateLocalVideoPath(mp4), path.resolve(mp4));
    assert.equal(validateLocalCoverPath(cover), path.resolve(cover));
    assert.deepEqual(readNeutralCopyFile(copyMd), {
      path: path.resolve(copyMd),
      text: '第一行卖点\n第二行受众说明'
    });

    assert.throws(() => validateLocalVideoPath(badFile), /不支持的视频格式/);
    assert.throws(() => validateLocalCoverPath(badFile), /不支持的封面格式/);
    assert.throws(() => readNeutralCopyFile(emptyTxt), /文案文件为空/);
    assert.throws(() => readNeutralCopyFile(badFile), /不支持的文案文件格式/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareDirectUploadVideo：faststart MP4 零拷贝直连，非 faststart MP4 自动无损快封装，不兼容容器降级转码', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-direct-prep-'));
  try {
    const outDir = path.join(dir, 'assets');

    // 1. 已是 faststart 的 MP4：不调 ffmpeg，直接返回原文件
    const fastFile = path.join(dir, 'ready.mp4');
    fs.writeFileSync(fastFile, faststartMp4Buffer());
    let ffmpegCalled = 0;
    const fastRes = await prepareDirectUploadVideo(fastFile, outDir, {
      resolveTools: async () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
      probe: async () => ({ seconds: 42.5, width: 1080, height: 1920, hasAudio: true }),
      runFfmpeg: async () => { ffmpegCalled += 1; }
    });
    assert.equal(ffmpegCalled, 0);
    assert.equal(fastRes.remuxed, false);
    assert.equal(fastRes.faststart, true);
    assert.equal(fastRes.videoPath, path.resolve(fastFile));
    assert.equal(fastRes.seconds, 42.5);

    // 2. 非 faststart 的 MP4：自动无损重封装为 +faststart
    const slowFile = path.join(dir, 'slow.mp4');
    fs.writeFileSync(slowFile, slowMp4Buffer());
    const calls: string[][] = [];
    const slowRes = await prepareDirectUploadVideo(slowFile, outDir, {
      resolveTools: async () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
      probe: async () => ({ seconds: 18, width: 1920, height: 1080, hasAudio: true }),
      runFfmpeg: async (_tools, args) => {
        calls.push(args);
        fs.writeFileSync(args[args.length - 1], faststartMp4Buffer());
      },
      now: () => 1001
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], buildFaststartRemuxArgs(path.resolve(slowFile), path.join(outDir, 'upload-faststart-1001.mp4')));
    assert.equal(slowRes.remuxed, true);
    assert.equal(slowRes.faststart, true);
    assert.match(slowRes.notice, /faststart/);

    // 3. WebM 无损流拷贝失败时自动降级转码为 H.264/AAC + faststart
    const webmFile = path.join(dir, 'clip.webm');
    fs.writeFileSync(webmFile, Buffer.alloc(2048));
    const webmCalls: string[][] = [];
    const webmRes = await prepareDirectUploadVideo(webmFile, outDir, {
      resolveTools: async () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
      probe: async () => ({ seconds: 25, width: 1280, height: 720, hasAudio: true }),
      runFfmpeg: async (_tools, args) => {
        webmCalls.push(args);
        if (webmCalls.length === 1) throw new Error('codec not supported in mp4 container');
        fs.writeFileSync(args[args.length - 1], faststartMp4Buffer());
      },
      now: () => 2002
    });
    assert.equal(webmCalls.length, 2);
    assert.deepEqual(webmCalls[1], buildCompatTranscodeArgs(path.resolve(webmFile), path.join(outDir, 'upload-faststart-2002.mp4')));
    assert.equal(webmRes.remuxed, true);
    assert.equal(webmRes.faststart, true);

    // 4. 无 ffmpeg 时优雅降级并给出提示
    const noFfmpegRes = await prepareDirectUploadVideo(slowFile, outDir, {
      resolveTools: async () => { throw new Error('ffmpeg not found'); }
    });
    assert.equal(noFfmpegRes.remuxed, false);
    assert.equal(noFfmpegRes.faststart, false);
    assert.match(noFfmpegRes.notice, /缺少 faststart/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('direct-upload 工作流的 renderSignature 仅绑定上传源文件，修改标题/平台/封面不会让成片过期', () => {
  const base: VideoProject = {
    id: 99,
    platform: 'douyin',
    topic: '',
    title: '初始标题',
    audience: '',
    durationSeconds: 30,
    status: 'storyboard',
    topicsJson: '',
    script: '',
    storyboardJson: '',
    coverPath: '',
    exportPath: '',
    options: {
      ...VIDEO_RENDER_DEFAULTS,
      workflow: 'direct-upload',
      sourcePath: 'D:/videos/demo.mp4',
      skillInputSignature: 'sig-v1'
    },
    assets: emptyRenderAssets(),
    createdAt: '2026-11-28T00:00:00.000Z',
    updatedAt: '2026-11-28T00:00:00.000Z'
  };
  base.assets.video = {
    path: 'D:/videos/demo.mp4',
    signature: renderSignature(base),
    seconds: 30,
    renderedAt: '2026-11-28T00:00:00.000Z'
  };

  assert.equal(isRenderFresh(base), true);

  const editedMeta: VideoProject = {
    ...base,
    title: '改过的营销标题',
    platform: 'bilibili',
    coverPath: 'D:/covers/new.png'
  };
  assert.equal(isRenderFresh(editedMeta), true);

  const replacedSource: VideoProject = {
    ...base,
    options: { ...base.options, skillInputSignature: 'sig-v2' }
  };
  assert.equal(isRenderFresh(replacedSource), false);
});
