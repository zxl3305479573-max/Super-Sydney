import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VideoProject } from '../shared.ts';
import { copyRenderedVideoTo, exportVideoPackage, suggestedMp4Name } from '../services/video-export.ts';
import { renderSignature, serializeVideoShots } from '../services/video-pipeline.ts';
import { VIDEO_RENDER_DEFAULTS, audioKey, emptyRenderAssets } from '../services/video-production.ts';
import { skillInputFingerprint } from '../services/video-skill-inputs.ts';

function project(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 9, platform: 'shipinhao', topic: '控糖早餐', title: '控糖早餐/怎么吃', audience: '中老年读者', durationSeconds: 10, status: 'storyboard',
    topicsJson: '', script: '第一句口播。\n第二句口播。', storyboardJson: serializeVideoShots([
      { index: 1, seconds: 4, visual: '厨房台面，俯拍', narration: '第一句口播。', caption: '早餐先吃蛋' },
      { index: 2, seconds: 6, visual: '特写粥碗', narration: '第二句口播。', caption: '' }
    ]),
    coverPath: '', exportPath: '', createdAt: '', updatedAt: '',
    options: { ...VIDEO_RENDER_DEFAULTS }, assets: emptyRenderAssets(), ...patch
  };
}

test('export writes the production package with script, shot list and subtitles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-video-export-'));
  try {
    const vault = path.join(root, 'vault');
    const cover = path.join(root, 'cover.png');
    fs.writeFileSync(cover, 'simulated image');
    const target = exportVideoPackage(vault, project({ coverPath: cover }));
    assert.ok(fs.existsSync(path.join(target, '制作包.md')));
    assert.ok(fs.existsSync(path.join(target, 'shotlist.csv')));
    assert.ok(fs.existsSync(path.join(target, 'captions.srt')));
    assert.ok(fs.existsSync(path.join(target, 'cover.png')));
    assert.ok(target.startsWith(path.join(vault, '07-视频')));

    const markdown = fs.readFileSync(path.join(target, '制作包.md'), 'utf8');
    assert.match(markdown, /控糖早餐\/怎么吃/);
    assert.match(markdown, /视频号/);
    assert.match(markdown, /分镜时长：0:10/);
    assert.match(markdown, /成片：未包含/);
    assert.match(markdown, /不上传、不发布/);

    const csv = fs.readFileSync(path.join(target, 'shotlist.csv'), 'utf8');
    assert.match(csv, /"镜号","作用","时长\(秒\)","画面","画面大字","口播","配图提示词"/);
    assert.match(csv, /"2","","6","特写粥碗","","第二句口播。",""/);

    // 字幕来自口播（按句切、去掉行尾句号），画面大字不进字幕。
    const srt = fs.readFileSync(path.join(target, 'captions.srt'), 'utf8');
    assert.match(srt, /1\n00:00:00,000 --> 00:00:04,000\n第一句口播\n/);
    assert.match(srt, /2\n00:00:04,000 --> 00:00:10,000\n第二句口播\n/);
    assert.ok(!fs.existsSync(path.join(target, 'video.mp4')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('export copies the rendered video only while it still matches the storyboard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-video-export-'));
  try {
    const vault = path.join(root, 'vault');
    const video = path.join(root, 'video-1.mp4');
    fs.writeFileSync(video, 'simulated mp4');
    const silent = project({ options: { ...VIDEO_RENDER_DEFAULTS, voiceMode: 'silent' } });
    const rendered = { ...silent, assets: { ...silent.assets, video: { path: video, signature: renderSignature(silent), seconds: 10, renderedAt: '' } } };
    const fresh = exportVideoPackage(vault, rendered);
    assert.equal(fs.readFileSync(path.join(fresh, 'video.mp4'), 'utf8'), 'simulated mp4');
    assert.match(fs.readFileSync(path.join(fresh, '制作包.md'), 'utf8'), /成片：video\.mp4/);
    // 分镜改过之后旧成片对不上了，导出时不再带上。
    const edited = { ...rendered, storyboardJson: serializeVideoShots([{ index: 1, seconds: 4, visual: 'v', narration: '改过的口播。', caption: '' }]) };
    assert.ok(!fs.existsSync(path.join(exportVideoPackage(vault, edited), 'video.mp4')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('direct MP4 export copies only a fresh render and suggests a safe filename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-video-mp4-'));
  try {
    const video = path.join(root, 'rendered.mp4');
    fs.writeFileSync(video, 'rendered bytes');
    const silent = project({ options: { ...VIDEO_RENDER_DEFAULTS, voiceMode: 'silent' } });
    const rendered = { ...silent, assets: { ...silent.assets, video: { path: video, signature: renderSignature(silent), seconds: 10, renderedAt: '' } } };
    assert.equal(suggestedMp4Name(rendered, new Date(2026, 9, 18, 9, 5)), '控糖早餐-怎么吃-20261018-0905.mp4');
    const destination = path.join(root, 'exports', '我的视频');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const saved = copyRenderedVideoTo(rendered, destination);
    assert.equal(saved, `${destination}.mp4`);
    assert.equal(fs.readFileSync(saved, 'utf8'), 'rendered bytes');

    const edited = { ...rendered, storyboardJson: serializeVideoShots([{ index: 1, seconds: 4, visual: 'v', narration: '改过。', caption: '' }]) };
    assert.throws(() => copyRenderedVideoTo(edited, path.join(root, 'stale.mp4')), /成片已过期/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external skill exports include the final video, transcript and localized subtitles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-skill-export-'));
  try {
    const source = path.join(root, 'source.mp4');
    const video = path.join(root, 'final.mp4');
    const transcript = path.join(root, 'transcript.json');
    const subtitle = path.join(root, 'translation.en.srt');
    fs.writeFileSync(source, 'source-a');
    fs.writeFileSync(video, 'final bytes');
    fs.writeFileSync(transcript, '{"words":[]}');
    fs.writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
    const signature = skillInputFingerprint(source);
    const external = project({
      options: {
        ...VIDEO_RENDER_DEFAULTS,
        workflow: 'localize',
        sourcePath: source,
        skillInputSignature: signature,
        targetLanguage: 'English',
        targetCode: 'en'
      },
      assets: {
        ...emptyRenderAssets(),
        video: { path: video, signature: '', seconds: 1, renderedAt: '' },
        skill: {
          workflow: 'localize',
          outputPath: video,
          rawOutputPath: '',
          transcriptPath: transcript,
          subtitlePath: subtitle,
          sourceSignature: signature,
          completedAt: ''
        }
      }
    });
    external.assets.video!.signature = renderSignature(external);
    const target = exportVideoPackage(path.join(root, 'vault'), external);
    assert.equal(fs.readFileSync(path.join(target, 'video.mp4'), 'utf8'), 'final bytes');
    assert.equal(fs.readFileSync(path.join(target, 'transcript.json'), 'utf8'), '{"words":[]}');
    assert.match(fs.readFileSync(path.join(target, 'captions.en.srt'), 'utf8'), /Hello/);
    const markdown = fs.readFileSync(path.join(target, '制作包.md'), 'utf8');
    assert.match(markdown, /localize/);
    assert.match(markdown, /translation\.en\.srt/);

    fs.writeFileSync(source, 'source-b');
    assert.throws(() => exportVideoPackage(path.join(root, 'vault'), external), /已变化/);
    assert.throws(() => copyRenderedVideoTo(external, path.join(root, 'copy.mp4')), /已变化/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('voiced exports time the subtitles from the real audio', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-video-export-'));
  try {
    const profile = '{"provider":"system","voice":"","rate":0}';
    const voiced = project({ assets: { ...emptyRenderAssets(), voiceProfile: profile, audio: [
      { key: audioKey(profile, '第一句口播。'), path: 'a.wav', seconds: 1.65 },
      { key: audioKey(profile, '第二句口播。'), path: 'b.wav', seconds: 2 }
    ] } });
    const target = exportVideoPackage(path.join(root, 'vault'), voiced);
    const srt = fs.readFileSync(path.join(target, 'captions.srt'), 'utf8');
    assert.match(srt, /00:00:00,000 --> 00:00:02,000\n第一句口播/);
    assert.match(srt, /00:00:02,000 --> 00:00:04,350\n第二句口播/);
    assert.match(fs.readFileSync(path.join(target, '制作包.md'), 'utf8'), /按真实配音/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repeated exports never overwrite an earlier package', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-video-export-'));
  try {
    const vault = path.join(root, 'vault');
    const first = exportVideoPackage(vault, project());
    fs.appendFileSync(path.join(first, '制作包.md'), '\n用户手写补充');
    const second = exportVideoPackage(vault, project());
    assert.notEqual(first, second);
    assert.match(fs.readFileSync(path.join(first, '制作包.md'), 'utf8'), /用户手写补充/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('export refuses an incomplete project and cleans up after a missing cover', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-video-export-'));
  try {
    const vault = path.join(root, 'vault');
    assert.throws(() => exportVideoPackage(vault, project({ script: '' })), /口播脚本/);
    assert.throws(() => exportVideoPackage(vault, project({ storyboardJson: '' })), /分镜/);
    assert.throws(() => exportVideoPackage(vault, project({ coverPath: path.join(root, 'missing.png') })), /封面文件不存在/);
    // 封面缺失时不能留下半个制作包目录。
    assert.deepEqual(fs.existsSync(path.join(vault, '07-视频')) ? fs.readdirSync(path.join(vault, '07-视频')) : [], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
