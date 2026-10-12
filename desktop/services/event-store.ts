import type { DatabaseSync } from 'node:sqlite';
import type { WorkEvent } from '../shared.ts';

/** 工作事件表的读写。只碰 SQLite；广播刷新与 Obsidian 落盘由调用方负责。 */

export function migrateEventTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT '', window_title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '', duration_seconds INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', value_score INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '个人成长'); CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);`);
}

/** 文件监听与应用适配器写入的元数据列；必须在 codex 等其它迁移之后补齐。 */
export function migrateEventMetadataColumns(db: DatabaseSync): void {
  const columns = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, definition] of [['related_path', "TEXT NOT NULL DEFAULT ''"], ['adapter', "TEXT NOT NULL DEFAULT ''"], ['change_type', "TEXT NOT NULL DEFAULT ''"]] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
  }
}

export function recentEvents(db: DatabaseSync): WorkEvent[] {
  return db.prepare('SELECT * FROM events ORDER BY datetime(created_at) DESC LIMIT 200').all() as WorkEvent[];
}

export function confirmedEvents(db: DatabaseSync, limit = 200): WorkEvent[] {
  return db.prepare("SELECT * FROM events WHERE status='approved' ORDER BY datetime(created_at) DESC LIMIT ?").all(limit) as WorkEvent[];
}

export function getEvent(db: DatabaseSync, id: number): WorkEvent | undefined {
  return db.prepare('SELECT * FROM events WHERE id=?').get(id) as WorkEvent | undefined;
}

export function getApprovedEvent(db: DatabaseSync, id: number): WorkEvent | undefined {
  return db.prepare("SELECT * FROM events WHERE id=? AND status='approved'").get(id) as WorkEvent | undefined;
}

export function aiEventsSince(db: DatabaseSync, from: Date): WorkEvent[] {
  return db.prepare("SELECT * FROM events WHERE source IN ('codex','claude') AND status<>'rejected' AND created_at >= ? ORDER BY created_at").all(from.toISOString()) as WorkEvent[];
}

export function todayStats(db: DatabaseSync, day = new Date().toISOString().slice(0, 10)): { total: number; pending: number; duration: number } {
  return db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, COALESCE(SUM(duration_seconds),0) AS duration FROM events WHERE created_at LIKE ?`).get(`${day}%`) as { total: number; pending: number; duration: number };
}

export function insertEvent(db: DatabaseSync, event: Partial<WorkEvent>): number {
  const result = db.prepare(`INSERT INTO events (created_at, app_name, window_title, kind, note, duration_seconds, status, value_score, summary, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.created_at || new Date().toISOString(), event.app_name || '', event.window_title || '', event.kind || 'manual', event.note || '', event.duration_seconds || 0, event.status || 'pending', event.value_score || 0, event.summary || '', event.category || '个人成长');
  return Number(result.lastInsertRowid);
}

export type MetadataEventInput = {
  kind: 'file_change' | 'adapter'; note: string; summary: string; source: 'file' | 'adapter';
  relatedPath?: string; adapter?: string; changeType?: string; appName?: string; windowTitle?: string; durationSeconds?: number;
};

export function insertMetadataEvent(db: DatabaseSync, input: MetadataEventInput): number {
  const result = db.prepare(`INSERT INTO events
    (created_at, app_name, window_title, kind, note, duration_seconds, status, value_score, summary, category, source, related_path, adapter, change_type)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, '提效方案', ?, ?, ?, ?)`)
    .run(new Date().toISOString(), input.appName || '', input.windowTitle || '', input.kind, input.note, input.durationSeconds || 0, input.summary, input.source, input.relatedPath || '', input.adapter || '', input.changeType || '');
  return Number(result.lastInsertRowid);
}

const EDITABLE_EVENT_FIELDS = ['note', 'status', 'category', 'value_score', 'summary'];

/** 只允许改白名单字段；未知字段直接忽略，不会拼进 SQL。 */
export function updateEvent(db: DatabaseSync, id: number, patch: Partial<WorkEvent>): void {
  const entries = Object.entries(patch).filter(([key]) => EDITABLE_EVENT_FIELDS.includes(key));
  if (entries.length) db.prepare(`UPDATE events SET ${entries.map(([key]) => `${key}=?`).join(', ')} WHERE id=?`).run(...entries.map(([, value]) => value as string | number), id);
}

export function deleteEvent(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM events WHERE id=?').run(id);
}
