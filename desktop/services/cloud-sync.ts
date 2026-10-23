import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CloudSyncStatus, Settings, WorkEvent } from '../shared.ts';
import type { SettingsFile } from './app-settings.ts';
import type { SecretStore } from './secret-store.ts';

/**
 * 云同步：把本地 events 表里 status 为 approved 的记录按隐私规则批量上传到自建同步 API。
 * - 凭据（Basic Auth 密码）只从主进程的系统安全存储读取，渲染进程拿不到明文。
 * - 上传队列落在 sydney.db 的 cloud_sync_queue 表：失败保留重试，不丢数据。
 * - 待确认（pending）与已拒绝（rejected）的记录永不进队列。
 */

let cloudFetch: typeof fetch = (...args) => fetch(...args);
/** 主进程启动时换成 Electron 的 net.fetch：跟随系统代理，和图片网关同一套网络栈。 */
export function useCloudFetch(impl: typeof fetch): void {
  cloudFetch = impl;
}

const SYNC_INTERVAL_MS = 10 * 60 * 1000;
const BATCH_LIMIT = 500;

type QueueRow = WorkEvent & { local_id: number; retries: number };
type SyncItemResult = { local_id: number; ok: boolean; id?: number; created?: boolean; error?: string };
type SyncResponse = { results?: SyncItemResult[]; accepted?: number; failed?: number };

export function migrateCloudSyncTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_sync_queue (
    local_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    retries INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS cloud_sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`);
}

function stateGet(db: DatabaseSync, key: string): string {
  const row = db.prepare('SELECT value FROM cloud_sync_state WHERE key=?').get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

function stateSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO cloud_sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '同步请求超时';
    if (error.name === 'AbortError') return '同步请求已取消';
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    if (error.message === 'fetch failed') return cause ? `连不上同步服务器（${cause.code || cause.message}）：检查网络或地址` : '连不上同步服务器：检查网络或地址';
    return error.message;
  }
  return String(error);
}

export class CloudSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastError = '';
  private readonly db: DatabaseSync;
  private readonly settings: SettingsFile;
  private readonly keyStore: SecretStore;

  constructor(db: DatabaseSync, settings: SettingsFile, keyStore: SecretStore) {
    this.db = db;
    this.settings = settings;
    this.keyStore = keyStore;
  }

  private enabled(): boolean {
    return this.settings.read().cloudSyncEnabled;
  }

  private endpoint(path: string): string {
    const base = this.settings.read().cloudSyncUrl.trim().replace(/\/+$/, '');
    return `${base}/${path}`;
  }

  /** 首次开启时生成固定 client_id，之后一直复用。 */
  clientId(): string {
    const existing = stateGet(this.db, 'client_id');
    if (existing) return existing;
    const id = randomUUID();
    stateSet(this.db, 'client_id', id);
    return id;
  }

  /** 单个事件被确认时入队；非 approved 或已被删除的事件直接忽略。 */
  enqueue(id: number): void {
    const event = this.db.prepare("SELECT id, status FROM events WHERE id=?").get(id) as { id: number; status: string } | undefined;
    if (!event || event.status !== 'approved') return;
    this.db.prepare('INSERT OR IGNORE INTO cloud_sync_queue (local_id, status) VALUES (?, ?)').run(id, 'pending');
  }

  /** 让队列与已确认事件对齐：删除/被拒绝的摘除，新确认的补进待上传。 */
  reconcile(): void {
    this.db.exec("DELETE FROM cloud_sync_queue WHERE local_id NOT IN (SELECT id FROM events WHERE status='approved')");
    this.db.exec("INSERT OR IGNORE INTO cloud_sync_queue (local_id, status) SELECT id, 'pending' FROM events WHERE status='approved'");
  }

  pendingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_queue WHERE status='pending'").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  status(): CloudSyncStatus {
    return {
      enabled: this.enabled(),
      clientId: this.enabled() ? this.clientId() : '',
      lastSyncAt: stateGet(this.db, 'last_sync_at'),
      pending: this.pendingCount(),
      running: this.running,
      error: this.lastError
    };
  }

  private buildPayload(event: WorkEvent, settings: Settings, clientId: string): Record<string, unknown> {
    // 隐私底线：只上传摘要、分类、时长、时间；窗口标题与文件路径各一个开关；截图路径永不上传。
    const payload: Record<string, unknown> = {
      client_id: clientId,
      local_id: event.id,
      created_at: event.created_at,
      summary: event.summary,
      category: event.category,
      duration_seconds: event.duration_seconds,
      status: 'approved'
    };
    if (settings.cloudSyncIncludeWindowTitle) payload.window_title = event.window_title;
    if (settings.cloudSyncIncludeFilePath) payload.related_path = event.related_path;
    return payload;
  }

  private markDone(localId: number): void {
    this.db.prepare("UPDATE cloud_sync_queue SET status='done', last_error='', updated_at=? WHERE local_id=?").run(new Date().toISOString(), localId);
  }

  private markFailed(localIds: number[], error: string): void {
    const statement = this.db.prepare('UPDATE cloud_sync_queue SET retries=retries+1, last_error=?, updated_at=? WHERE local_id=?');
    for (const id of localIds) statement.run(error.slice(0, 500), new Date().toISOString(), id);
  }

  async syncNow(): Promise<CloudSyncStatus> {
    if (!this.enabled()) return this.status();
    if (this.running) return this.status();
    this.running = true;
    try {
      this.reconcile();
      const rows = this.db.prepare(`SELECT q.local_id AS local_id, q.retries AS retries, e.* FROM cloud_sync_queue q JOIN events e ON e.id=q.local_id WHERE q.status='pending' ORDER BY e.created_at LIMIT ?`).all(BATCH_LIMIT) as QueueRow[];
      if (!rows.length) { this.lastError = ''; return this.status(); }

      const settings = this.settings.read();
      const clientId = this.clientId();
      const body = rows.map(event => this.buildPayload(event, settings, clientId));
      const token = Buffer.from(`${settings.cloudSyncUsername}:${this.keyStore.read()}`, 'utf8').toString('base64');

      let response: Response;
      try {
        response = await cloudFetch(this.endpoint('sync'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Basic ${token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000)
        });
      } catch (error) {
        const message = errorText(error);
        this.markFailed(rows.map(row => row.local_id), message);
        this.lastError = message;
        return this.status();
      }

      if (!response.ok) {
        const message = `同步服务器返回 ${response.status}`;
        this.markFailed(rows.map(row => row.local_id), message);
        this.lastError = message;
        return this.status();
      }

      let result: SyncResponse;
      try {
        result = (await response.json()) as SyncResponse;
      } catch {
        const message = '同步服务器返回了无法解析的响应';
        this.markFailed(rows.map(row => row.local_id), message);
        this.lastError = message;
        return this.status();
      }

      stateSet(this.db, 'last_sync_at', new Date().toISOString());
      const byLocal = new Map<number, SyncItemResult>();
      for (const item of result.results ?? []) byLocal.set(Number(item.local_id), item);
      let failed = 0;
      for (const row of rows) {
        const item = byLocal.get(row.local_id);
        if (item?.ok) this.markDone(row.local_id);
        else { failed += 1; this.markFailed([row.local_id], item?.error || '服务器未确认该条'); }
      }
      this.lastError = failed ? `${failed} 条上传失败，将保留重试` : '';
      return this.status();
    } finally {
      this.running = false;
    }
  }

  /** 启动时对齐队列并立即同步一次（若开启），之后每 10 分钟批量上传。 */
  start(): void {
    this.reconcile();
    if (this.enabled()) void this.syncNow();
    this.timer = setInterval(() => { if (this.enabled()) void this.syncNow(); }, SYNC_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
