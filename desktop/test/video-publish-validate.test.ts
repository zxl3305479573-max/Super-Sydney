import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectMp4Faststart,
  parseMp4FaststartFromBuffer
} from '../services/mp4-faststart.ts';
import {
  composePlatformBody,
  validatePlatformCopy,
  validateVideoPublishPack
} from '../services/video-publish-validate.ts';

function box(type: string, payloadSize: number): Buffer {
  const total = 8 + payloadSize;
  const buf = Buffer.alloc(total);
  buf.writeUInt32BE(total, 0);
  buf.write(type, 4, 4, 'latin1');
  return buf;
}

test('MP4 faststart 解析器正确区分 moov 在前与 mdat 在前（含大于 64KB 偏移文件）', () => {
  const fastBuf = Buffer.concat([box('ftyp', 16), box('moov', 32), box('mdat', 128)]);
  const slowBuf = Buffer.concat([box('ftyp', 16), box('mdat', 128), box('moov', 32)]);
  assert.equal(parseMp4FaststartFromBuffer(fastBuf), true);
  assert.equal(parseMp4FaststartFromBuffer(slowBuf), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-mp4-'));
  try {
    const bigHeaderFast = path.join(dir, 'fast.mp4');
    // 前面放一个 80KB 的 free box，验证跳跃式文件读取不受 64KB 限制
    fs.writeFileSync(bigHeaderFast, Buffer.concat([box('ftyp', 16), box('free', 80_000), box('moov', 64), box('mdat', 256)]));
    assert.equal(inspectMp4Faststart(bigHeaderFast), true);

    const slowFile = path.join(dir, 'slow.mp4');
    fs.writeFileSync(slowFile, slowBuf);
    assert.equal(inspectMp4Faststart(slowFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validatePlatformCopy 拦截视频号短标题过短、国内平台引流词与外链，并放行 B 站外链', () => {
  const shortShipinhao = validatePlatformCopy('shipinhao', {
    title: '太短了',
    body: '正常描述',
    tags: ['养生'],
    coverRatio: '4:3',
    skip: false
  });
  assert.equal(shortShipinhao.some(item => item.code === 'title-too-short' && item.level === 'error'), true);

  const xhsDiversion = validatePlatformCopy('xiaohongshu', {
    title: '冬季护膝实测经验',
    body: '需要资料的姐妹私信我领，或者看 ChatGPT 整理的清单 https://example.com',
    tags: ['护膝'],
    coverRatio: '3:4',
    skip: false
  });
  assert.equal(xhsDiversion.some(item => item.code === 'diversion-risk' && item.level === 'error'), true);
  assert.equal(xhsDiversion.some(item => item.code === 'external-url' && item.level === 'error'), true);
  assert.equal(xhsDiversion.some(item => item.code === 'overseas-brand' && item.level === 'warn'), true);

  const biliWithLink = validatePlatformCopy('bilibili', {
    title: '完整版护膝动作讲解',
    body: '参考指南：https://example.com/guide',
    tags: ['健康', '科普'],
    coverRatio: '16:9',
    skip: false
  });
  assert.equal(biliWithLink.length, 0);
});

test('composePlatformBody 去重拼接话题标签，validateVideoPublishPack 汇总 faststart 门禁', () => {
  const body = composePlatformBody({ body: '正文已经带了 #健康', tags: ['健康', '中老年科普'] });
  assert.equal(body, '正文已经带了 #健康\n\n#中老年科普');

  const res = validateVideoPublishPack({
    copies: {
      douyin: { title: '合格标题', body: '正常正文', tags: ['a', 'b', 'c', 'd', 'e', 'f'], coverRatio: '3:4', skip: false },
      shipinhao: { title: '视频号六字以上短标题', body: '正常正文', tags: [], coverRatio: '4:3', skip: false },
      xiaohongshu: { title: '小红书正常标题', body: '正常正文', tags: [], coverRatio: '3:4', skip: false },
      bilibili: { title: 'B站正常标题', body: '正常简介', tags: [], coverRatio: '16:9', skip: false }
    }
  }, { faststart: false });

  assert.equal(res.ok, false);
  assert.equal(res.issues.some(i => i.code === 'mp4-not-faststart'), true);
  assert.equal(res.issues.some(i => i.code === 'too-many-tags' && i.level === 'warn'), true);
});
