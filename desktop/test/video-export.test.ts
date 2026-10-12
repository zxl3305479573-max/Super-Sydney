import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VideoProject } from '../shared.ts';
import { exportVideoPackage } from '../services/video-export.ts';
import { serializeVideoShots } from '../services/video-pipeline.ts';

function project(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 9, platform: 'shipinhao', topic: '控糖早餐', title: '控糖早餐/怎么吃', audience: '中老年读者', durationSeconds: 10, status: 'storyboard',
    topicsJson: '', script: '第一句口播。\n第二句口播。', storyboardJson: serializeVideoShots([
      { index: 1, seconds: 4, visual: '厨房台面，俯拍', narration: '第一句口播。', caption: '早餐先吃蛋' },
      { index: 2, seconds: 6, visual: '特写粥碗', narration: '第二句口播。', caption: '' }
    ]),
    coverPath: '', exportPath: '', createdAt: '', updatedAt: '', ...patch
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
    assert.match(markdown, /不上传、不发布/);

    const csv = fs.readFileSync(path.join(target, 'shotlist.csv'), 'utf8');
    assert.match(csv, /"镜号","时长\(秒\)","画面","口播","字幕"/);
    assert.match(csv, /"2","6","特写粥碗","第二句口播。","第二句口播。"/);

    const srt = fs.readFileSync(path.join(target, 'captions.srt'), 'utf8');
    assert.match(srt, /1\n00:00:00,000 --> 00:00:04,000\n早餐先吃蛋/);
    assert.match(srt, /2\n00:00:04,000 --> 00:00:10,000\n第二句口播。/);
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
