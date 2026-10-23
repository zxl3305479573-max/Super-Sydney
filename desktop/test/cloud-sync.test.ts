import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CloudSync, migrateCloudSyncTables, useCloudFetch } from '../services/cloud-sync.ts';
import { migrateEventMetadataColumns, migrateEventTables, insertEvent, insertMetadataEvent, updateEvent } from '../services/event-store.ts';
import { migrateCodexEventColumns } from '../services/codex-event-store.ts';
import { SettingsFile } from '../services/app-settings.ts';
import { SecretStore, type SafeStorageLike } from '../services/secret-store.ts';

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value, 'utf8'),
  decryptString: value => value.toString('utf8')
};

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateEventTables(db);
  migrateCodexEventColumns(db);
  migrateEventMetadataColumns(db);
  migrateCloudSyncTables(db);
  return db;
}

function fixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sync-'));
  const settings = new SettingsFile(path.join(dir, 'settings.json'), 'D:/Vault', 'D:/Project');
  const keyStore = new SecretStore(dir, fakeSafeStorage);
  return { dir, settings, keyStore };
}

function enabledSettings(settings: SettingsFile, overrides: Record<string, unknown> = {}): void {
  settings.write({
    ...settings.read(),
    cloudSyncEnabled: true,
    cloudSyncUrl: 'http://example.test/sync-api/',
    cloudSyncUsername: 'sydney',
    cloudSyncIncludeWindowTitle: false,
    cloudSyncIncludeFilePath: false,
    ...overrides
  } as never);
}

function approvedMetadataEvent(db: DatabaseSync): number {
  const id = insertMetadataEvent(db, {
    kind: 'file_change', note: '改了同步配置', summary: '调整同步配置', source: 'file',
    relatedPath: 'D:/secret/config.yml', adapter: 'fs', changeType: 'modified',
    appName: 'VS Code', windowTitle: '秘密窗口标题', durationSeconds: 120
  });
  updateEvent(db, id, { status: 'approved' });
  return id;
}

test('队列只收已确认事件，未确认与已拒绝不上传', () => {
  const db = database();
  const { settings, keyStore } = fixtures();
  const service = new CloudSync(db, settings, keyStore);
  const pending = insertEvent(db, { note: '待确认' });
  const approved = insertEvent(db, { note: '已确认', status: 'approved' });
  service.enqueue(pending);
  service.enqueue(approved);
  assert.equal(service.pendingCount(), 1);

  updateEvent(db, pending, { status: 'approved' });
  service.reconcile();
  assert.equal(service.pendingCount(), 2);

  updateEvent(db, approved, { status: 'rejected' });
  service.reconcile();
  assert.equal(service.pendingCount(), 1);
});

test('默认只上传摘要、分类、时长、时间，不带窗口标题、文件路径与截图路径', async () => {
  const db = database();
  const { settings, keyStore } = fixtures();
  enabledSettings(settings);
  keyStore.save('secret');
  approvedMetadataEvent(db);

  let captured: { url: string; headers: Record<string, string>; body: Array<Record<string, unknown>> } | undefined;
  useCloudFetch(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
    captured = { url: String(input), headers: init?.headers as Record<string, string>, body };
    return new Response(JSON.stringify({ results: body.map(item => ({ local_id: item.local_id, ok: true })), accepted: body.length, failed: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const status = await new CloudSync(db, settings, keyStore).syncNow();
  assert.equal(status.pending, 0);
  assert.ok(captured);
  assert.equal(captured.url, 'http://example.test/sync-api/sync');
  assert.equal(captured.headers.Authorization, `Basic ${Buffer.from('sydney:secret', 'utf8').toString('base64')}`);
  assert.equal(captured.body.length, 1);
  const item = captured.body[0];
  assert.equal(item.summary, '调整同步配置');
  assert.equal(item.category, '提效方案');
  assert.equal(item.duration_seconds, 120);
  assert.equal(item.status, 'approved');
  assert.ok(item.created_at);
  assert.ok(!('window_title' in item));
  assert.ok(!('related_path' in item));
  assert.ok(!('file_path' in item));
  assert.ok(!('screenshot_path' in item));
});

test('开启开关后才上传窗口标题与文件路径', async () => {
  const db = database();
  const { settings, keyStore } = fixtures();
  enabledSettings(settings, { cloudSyncIncludeWindowTitle: true, cloudSyncIncludeFilePath: true });
  approvedMetadataEvent(db);

  let body: Array<Record<string, unknown>> = [];
  useCloudFetch(async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
    return new Response(JSON.stringify({ results: body.map(item => ({ local_id: item.local_id, ok: true })), accepted: body.length, failed: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  await new CloudSync(db, settings, keyStore).syncNow();
  assert.equal(body.length, 1);
  assert.equal(body[0].window_title, '秘密窗口标题');
  assert.equal(body[0].related_path, 'D:/secret/config.yml');
});

test('失败保留重试：网络错误不丢数据，部分成功只清除成功的', async () => {
  const db = database();
  const { settings, keyStore } = fixtures();
  enabledSettings(settings);
  const first = insertEvent(db, { note: '第一条', status: 'approved', summary: '一', category: '提效方案' });
  const second = insertEvent(db, { note: '第二条', status: 'approved', summary: '二', category: '提效方案' });

  // 第一次：整个请求失败，两条都保留。
  useCloudFetch(async () => { throw new Error('fetch failed'); });
  const afterNetwork = await new CloudSync(db, settings, keyStore).syncNow();
  assert.equal(afterNetwork.pending, 2);
  assert.match(afterNetwork.error, /连不上同步服务器/);
  const retries = db.prepare('SELECT retries FROM cloud_sync_queue ORDER BY local_id').all() as Array<{ retries: number }>;
  assert.deepEqual(retries.map(row => row.retries), [1, 1]);

  // 第二次：一条成功、一条失败，只保留失败的那条。
  useCloudFetch(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
    return new Response(JSON.stringify({
      results: body.map(item => ({ local_id: item.local_id, ok: item.local_id === first, error: item.local_id === first ? undefined : '被服务端拒绝' })),
      accepted: body.filter(item => item.local_id === first).length,
      failed: body.filter(item => item.local_id !== first).length
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const afterPartial = await new CloudSync(db, settings, keyStore).syncNow();
  assert.equal(afterPartial.pending, 1);
  const left = db.prepare("SELECT local_id FROM cloud_sync_queue WHERE status='pending'").all() as Array<{ local_id: number }>;
  assert.deepEqual(left.map(row => row.local_id), [second]);
});

test('client_id 首次生成后持久复用', () => {
  const db = database();
  const { settings, keyStore } = fixtures();
  const service = new CloudSync(db, settings, keyStore);
  const first = service.clientId();
  const second = new CloudSync(db, settings, keyStore).clientId();
  assert.ok(first);
  assert.equal(second, first);
});

test('未开启时不发请求，立即同步也是空操作', async () => {
  const db = database();
  const { settings, keyStore } = fixtures();
  settings.write({ ...settings.read(), cloudSyncEnabled: false } as never);
  insertEvent(db, { note: '已确认', status: 'approved' });
  let called = false;
  useCloudFetch(async () => { called = true; return new Response('{}', { status: 200 }); });
  const status = await new CloudSync(db, settings, keyStore).syncNow();
  assert.equal(status.enabled, false);
  assert.equal(called, false);
});
