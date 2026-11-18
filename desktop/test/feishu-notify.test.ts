import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDailyReportCard,
  buildDraftReadyCard,
  buildInteractivePayload,
  computeFeishuSign,
  saveFeishuConfig,
  sendFeishuCard,
  validateFeishuWebhookUrl
} from '../services/feishu-notify.ts';
import { SecretStore, type SafeStorageLike } from '../services/secret-store.ts';

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`enc:${value}`, 'utf8'),
  decryptString: buf => buf.toString('utf8').replace(/^enc:/, '')
};

test('validateFeishuWebhookUrl 只允许官方 https 机器人地址', () => {
  const valid = 'https://open.feishu.cn/open-apis/bot/v2/hook/12345678-abcd';
  assert.equal(validateFeishuWebhookUrl(`  ${valid} `), valid);
  assert.throws(() => validateFeishuWebhookUrl('http://open.feishu.cn/open-apis/bot/v2/hook/1'), /https/);
  assert.throws(() => validateFeishuWebhookUrl('https://evil.example.com/open-apis/bot/v2/hook/1'), /官方自定义机器人/);
});

test('computeFeishuSign 按飞书规范生成签名并写入交互式卡片', () => {
  const ts = 1700000000;
  const secret = 'my-bot-secret';
  const expected = crypto.createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
  assert.equal(computeFeishuSign(ts, secret), expected);

  const card = buildDraftReadyCard('护膝第 2 期', [{
    jobId: 'j1',
    projectId: 1,
    platform: 'douyin',
    status: 'draft',
    message: '已填草稿',
    title: '护膝第 2 期',
    bodyChars: 88,
    videoPath: 'D:/v.mp4',
    url: 'https://creator.douyin.com',
    coverUploaded: true,
    at: '2026-11-18T10:00:00.000Z'
  }]);
  const payload = buildInteractivePayload(card, secret, ts * 1000);
  assert.equal(payload.msg_type, 'interactive');
  assert.equal(payload.timestamp, String(ts));
  assert.equal(payload.sign, expected);
});

test('saveFeishuConfig 与 sendFeishuCard 端到端校验及错误处理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-feishu-'));
  try {
    const webhookStore = new SecretStore(dir, fakeSafeStorage, 'feishu-webhook.bin');
    const secretStore = new SecretStore(dir, fakeSafeStorage, 'feishu-secret.bin');
    const saved = saveFeishuConfig(dir, webhookStore, secretStore, {
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcd-9999',
      signingSecret: 'sec-1234',
      settings: { notifyDailyReport: true }
    });
    assert.equal(saved.webhook.configured, true);
    assert.match(saved.webhook.masked, /9999$/);
    assert.equal(saved.settings.notifyDailyReport, true);

    let sentBody = '';
    await sendFeishuCard(
      webhookStore.read(),
      buildDailyReportCard({
        platforms: [],
        totalFollowers: 3600,
        todayNetFollowers: 42,
        weekNetFollowers: 210,
        latestEpisode: null,
        externalSummary: { wechatArticles: 2, wechatTotalReads: 3000, xhsNotes: 5, xhsTotalViews: 8000, xhsTotalLikes: 500 },
        episodes: [],
        recentLogs: []
      }),
      {
        secret: secretStore.read(),
        fetchImpl: async (_url, init) => {
          sentBody = String(init?.body ?? '');
          return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
        }
      }
    );
    assert.match(sentBody, /3,600/);

    await assert.rejects(
      () => sendFeishuCard(webhookStore.read(), { title: 't', color: 'blue', sections: ['hi'] }, {
        fetchImpl: async () => new Response(JSON.stringify({ code: 19021, msg: 'sign match fail' }), { status: 200 })
      }),
      /19021.*sign match fail/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
