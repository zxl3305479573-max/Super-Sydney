import type { DatabaseSync } from 'node:sqlite';
import type { XhsAccount, XhsHotNote, XhsHotspotResult, XhsNote, XhsNoteStat, XhsNoteStatus, XhsNoteType, XhsReport, XhsStatMetrics } from '../shared.ts';
import { HOTSPOT_CACHE_TTL_MS } from './xhs-hotspot.ts';
import { XHS_NOTE_TYPES } from './xhs-catalog.ts';
import type { XhsStatInput } from './xhs-stats.ts';
import { emptyXhsMetrics } from './xhs-stats.ts';
import { normalizeTitle } from './article-stats.ts';

/** 小红书模块的持久化。只碰 SQLite；广播刷新由调用方负责。 */

export const XHS_NOTE_STATUSES: XhsNoteStatus[] = ['idea', 'body', 'title', 'visual', 'packaged'];
const statusSet = new Set<XhsNoteStatus>(XHS_NOTE_STATUSES);
const typeSet = new Set<XhsNoteType>(XHS_NOTE_TYPES.map(item => item.value));
const DEFAULT_ACCOUNT_NAME = '我的小红书号';

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
}

/** 早期版本建的表缺列时补上：只加列、不删列，已有数据原样保留。 */
function addColumns(db: DatabaseSync, table: string, definitions: Record<string, string>): void {
  const existing = columns(db, table);
  for (const [name, definition] of Object.entries(definitions)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export function migrateXhsTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS xhs_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', positioning_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS xhs_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES xhs_accounts(id),
    topic TEXT NOT NULL DEFAULT '', note_type TEXT NOT NULL DEFAULT 'tutorial', title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '', source_json TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'idea',
    title_candidates_json TEXT NOT NULL DEFAULT '', checks_json TEXT NOT NULL DEFAULT '', images_json TEXT NOT NULL DEFAULT '',
    export_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS xhs_notes_account ON xhs_notes(account_id, updated_at);
  CREATE TABLE IF NOT EXISTS xhs_hotspot_cache (
    cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL, fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS xhs_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES xhs_accounts(id), kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '', input_json TEXT NOT NULL DEFAULT '', result_json TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS xhs_reports_account ON xhs_reports(account_id, kind, created_at);
  CREATE TABLE IF NOT EXISTS xhs_note_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL REFERENCES xhs_accounts(id),
    title TEXT NOT NULL, title_key TEXT NOT NULL, publish_date TEXT NOT NULL DEFAULT '', metrics_json TEXT NOT NULL,
    note_id INTEGER, imported_at TEXT NOT NULL,
    UNIQUE(account_id, title_key, publish_date)
  );`);
  addColumns(db, 'xhs_accounts', {
    // 早期版本让小红书账号绑定公众号的内容方向；现在两者隔离，这列保留但不再读写。
    subdirection_id: 'INTEGER',
    positioning_chat_json: "TEXT NOT NULL DEFAULT ''",
    ip_id: "TEXT NOT NULL DEFAULT ''"
  });
  addColumns(db, 'xhs_notes', {
    material: "TEXT NOT NULL DEFAULT ''",
    writer_json: "TEXT NOT NULL DEFAULT ''",
    cards_json: "TEXT NOT NULL DEFAULT ''",
    cover_path: "TEXT NOT NULL DEFAULT ''",
    basis_json: "TEXT NOT NULL DEFAULT ''",
    candidates_json: "TEXT NOT NULL DEFAULT ''"
  });
  // 多账号是待定问题；先保证至少有一个账号，笔记总有归属。
  const count = db.prepare('SELECT COUNT(*) AS n FROM xhs_accounts').get() as { n: number };
  if (!Number(count.n)) {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO xhs_accounts (name, created_at, updated_at) VALUES (?, ?, ?)').run(DEFAULT_ACCOUNT_NAME, now, now);
  }
}

/* ── 账号 ─────────────────────────────────────────────────────── */

function accountFromRow(row: Record<string, unknown>): XhsAccount {
  return {
    id: Number(row.id), name: String(row.name ?? ''),
    positioningJson: String(row.positioning_json ?? ''), positioningChatJson: String(row.positioning_chat_json ?? ''),
    ipId: String(row.ip_id ?? ''),
    createdAt: String(row.created_at ?? ''), updatedAt: String(row.updated_at ?? '')
  };
}

export function listXhsAccounts(db: DatabaseSync): XhsAccount[] {
  return (db.prepare('SELECT * FROM xhs_accounts ORDER BY id').all() as Array<Record<string, unknown>>).map(accountFromRow);
}

export function getXhsAccount(db: DatabaseSync, id: number): XhsAccount {
  const row = db.prepare('SELECT * FROM xhs_accounts WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('小红书账号不存在');
  return accountFromRow(row);
}

export function updateXhsAccount(db: DatabaseSync, id: number, patch: Partial<XhsAccount>): XhsAccount {
  getXhsAccount(db, id);
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new Error('账号名不能为空');
    sets.push('name=?'); values.push(name.slice(0, 40));
  }
  if (patch.positioningJson !== undefined) { sets.push('positioning_json=?'); values.push(String(patch.positioningJson)); }
  if (patch.positioningChatJson !== undefined) { sets.push('positioning_chat_json=?'); values.push(String(patch.positioningChatJson)); }
  if (patch.ipId !== undefined) { sets.push('ip_id=?'); values.push(String(patch.ipId).trim().slice(0, 60)); }
  if (sets.length) db.prepare(`UPDATE xhs_accounts SET ${sets.join(', ')}, updated_at=? WHERE id=?`).run(...values, new Date().toISOString(), id);
  return getXhsAccount(db, id);
}

/** 新建一个账号：名字必填、最长 40 字，不和已有账号重名（切换时靠名字区分）。 */
export function createXhsAccount(db: DatabaseSync, name: unknown): XhsAccount {
  const clean = String(name ?? '').trim().slice(0, 40);
  if (!clean) throw new Error('账号名不能为空');
  if (listXhsAccounts(db).some(account => account.name === clean)) throw new Error('已经有同名账号了，换个名字');
  const now = new Date().toISOString();
  const result = db.prepare('INSERT INTO xhs_accounts (name, created_at, updated_at) VALUES (?, ?, ?)').run(clean, now, now);
  return getXhsAccount(db, Number(result.lastInsertRowid));
}

/**
 * 删除账号只允许删「空账号」（没有笔记、报告、导入的数据），用来清掉误建的账号；
 * 有内容的账号不提供删除，避免一次误点连带删掉笔记和复盘数据。至少保留一个账号。
 */
export function deleteXhsAccount(db: DatabaseSync, id: number): void {
  getXhsAccount(db, id);
  if (listXhsAccounts(db).length <= 1) throw new Error('至少要保留一个账号');
  const used = ['xhs_notes', 'xhs_reports', 'xhs_note_stats'].some(table => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id=?`).get(id) as { n: number }).n) > 0);
  if (used) throw new Error('这个账号下已经有笔记或数据，不能删除');
  db.prepare('DELETE FROM xhs_accounts WHERE id=?').run(id);
}

/* ── 笔记 ─────────────────────────────────────────────────────── */

export function xhsNoteFromRow(row: Record<string, unknown>): XhsNote {
  const status = String(row.status ?? 'idea') as XhsNoteStatus;
  const noteType = String(row.note_type ?? 'tutorial') as XhsNoteType;
  const text = (key: string) => String(row[key] ?? '');
  return {
    id: Number(row.id), accountId: Number(row.account_id),
    topic: text('topic'), noteType: typeSet.has(noteType) ? noteType : 'tutorial', material: text('material'),
    title: text('title'), body: text('body'), tagsJson: text('tags_json'), sourceJson: text('source_json'),
    status: statusSet.has(status) ? status : 'idea',
    writerJson: text('writer_json'), titleCandidatesJson: text('title_candidates_json'), checksJson: text('checks_json'),
    cardsJson: text('cards_json'), coverPath: text('cover_path'), imagesJson: text('images_json'), candidatesJson: text('candidates_json'), basisJson: text('basis_json'),
    exportPath: text('export_path'), createdAt: text('created_at'), updatedAt: text('updated_at')
  };
}

export function listXhsNotes(db: DatabaseSync, accountId: number): XhsNote[] {
  return (db.prepare('SELECT * FROM xhs_notes WHERE account_id=? ORDER BY updated_at DESC, id DESC').all(accountId) as Array<Record<string, unknown>>).map(xhsNoteFromRow);
}

export function getXhsNote(db: DatabaseSync, id: number): XhsNote {
  const row = db.prepare('SELECT * FROM xhs_notes WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('小红书笔记不存在');
  return xhsNoteFromRow(row);
}

/** 从热点笔记转选题时只留选题要用的字段，不存作者主页之外的个人信息。 */
function sourceSnapshot(source: XhsHotNote): string {
  const { id, title, desc, link, createTime, topics, author, interactive, liked, collected, comments, shared, unverified } = source;
  return JSON.stringify({ id, title, desc: String(desc ?? '').slice(0, 500), link, createTime, topics, author: { id: author?.id ?? '', nickname: author?.nickname ?? '', fans: author?.fans ?? 0 }, interactive, liked, collected, comments, shared, unverified: Boolean(unverified) });
}

export function createXhsNote(db: DatabaseSync, accountId: number, topic: unknown, source?: XhsHotNote | null, noteType: XhsNoteType = 'tutorial'): XhsNote {
  getXhsAccount(db, accountId);
  const text = String(topic ?? '').trim() || source?.title?.trim() || '';
  const now = new Date().toISOString();
  const result = db.prepare("INSERT INTO xhs_notes (account_id, topic, note_type, source_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'idea', ?, ?)")
    .run(accountId, text.slice(0, 200), typeSet.has(noteType) ? noteType : 'tutorial', source ? sourceSnapshot(source) : '', now, now);
  return getXhsNote(db, Number(result.lastInsertRowid));
}

const NOTE_COLUMNS: Record<string, string> = {
  topic: 'topic', noteType: 'note_type', material: 'material', title: 'title', body: 'body', tagsJson: 'tags_json', status: 'status',
  writerJson: 'writer_json', titleCandidatesJson: 'title_candidates_json', checksJson: 'checks_json', cardsJson: 'cards_json',
  coverPath: 'cover_path', imagesJson: 'images_json', candidatesJson: 'candidates_json', basisJson: 'basis_json', exportPath: 'export_path'
};

/** 只写白名单字段；未知字段直接忽略，不会拼进 SQL。状态与笔记类型只接受已知取值。 */
export function updateXhsNote(db: DatabaseSync, id: number, patch: Partial<XhsNote>): XhsNote {
  getXhsNote(db, id);
  if (patch.status !== undefined && !statusSet.has(patch.status)) throw new Error('未知的笔记状态');
  if (patch.noteType !== undefined && !typeSet.has(patch.noteType)) throw new Error('未知的笔记类型');
  const entries = Object.entries(patch).filter(([key]) => NOTE_COLUMNS[key]);
  if (entries.length) {
    const sets = entries.map(([key]) => `${NOTE_COLUMNS[key]}=?`);
    const values = entries.map(([, value]) => String(value ?? ''));
    db.prepare(`UPDATE xhs_notes SET ${sets.join(', ')}, updated_at=? WHERE id=?`).run(...values, new Date().toISOString(), id);
  }
  return getXhsNote(db, id);
}

export function deleteXhsNote(db: DatabaseSync, id: number): void {
  getXhsNote(db, id);
  db.prepare('UPDATE xhs_note_stats SET note_id=NULL WHERE note_id=?').run(id);
  db.prepare('DELETE FROM xhs_notes WHERE id=?').run(id);
}

/* ── 诊断 / 复盘报告 ─────────────────────────────────────────── */

function reportFromRow(row: Record<string, unknown>): XhsReport {
  return {
    id: Number(row.id), accountId: Number(row.account_id), kind: String(row.kind) === 'analytics' ? 'analytics' : 'audit',
    title: String(row.title ?? ''), inputJson: String(row.input_json ?? ''), resultJson: String(row.result_json ?? ''), createdAt: String(row.created_at ?? '')
  };
}

export function createXhsReport(db: DatabaseSync, accountId: number, kind: XhsReport['kind'], title: string, input: unknown, result: unknown): XhsReport {
  getXhsAccount(db, accountId);
  const run = db.prepare('INSERT INTO xhs_reports (account_id, kind, title, input_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(accountId, kind, title.slice(0, 80), JSON.stringify(input), JSON.stringify(result), new Date().toISOString());
  return reportFromRow(db.prepare('SELECT * FROM xhs_reports WHERE id=?').get(Number(run.lastInsertRowid)) as Record<string, unknown>);
}

export function listXhsReports(db: DatabaseSync, accountId: number, kind: XhsReport['kind']): XhsReport[] {
  return (db.prepare('SELECT * FROM xhs_reports WHERE account_id=? AND kind=? ORDER BY created_at DESC, id DESC').all(accountId, kind) as Array<Record<string, unknown>>).map(reportFromRow);
}

export function deleteXhsReport(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM xhs_reports WHERE id=?').run(id);
}

/* ── 笔记数据 ─────────────────────────────────────────────────── */

function statFromRow(row: Record<string, unknown>): XhsNoteStat {
  let metrics: XhsStatMetrics = emptyXhsMetrics();
  try { metrics = { ...metrics, ...(JSON.parse(String(row.metrics_json)) as Partial<XhsStatMetrics>) }; } catch { /* 损坏的行按空指标显示 */ }
  const noteId = Number(row.note_id);
  return {
    id: Number(row.id), accountId: Number(row.account_id), title: String(row.title ?? ''), publishDate: String(row.publish_date ?? ''),
    metrics, noteId: Number.isInteger(noteId) && noteId > 0 ? noteId : null, importedAt: String(row.imported_at ?? '')
  };
}

/** 同账号同标题同日期视为同一篇：再次导入时更新数据，不重复插入。 */
export function upsertXhsStats(db: DatabaseSync, accountId: number, inputs: XhsStatInput[], match: (title: string) => number | null): { added: number; updated: number } {
  getXhsAccount(db, accountId);
  let added = 0;
  let updated = 0;
  const now = new Date().toISOString();
  const find = db.prepare('SELECT id FROM xhs_note_stats WHERE account_id=? AND title_key=? AND publish_date=?');
  const insert = db.prepare('INSERT INTO xhs_note_stats (account_id, title, title_key, publish_date, metrics_json, note_id, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE xhs_note_stats SET title=?, metrics_json=?, note_id=?, imported_at=? WHERE id=?');
  for (const input of inputs) {
    const key = normalizeTitle(input.title);
    const existing = find.get(accountId, key, input.publishDate) as { id: number } | undefined;
    const noteId = match(input.title);
    if (existing) { update.run(input.title, JSON.stringify(input.metrics), noteId, now, existing.id); updated += 1; }
    else { insert.run(accountId, input.title, key, input.publishDate, JSON.stringify(input.metrics), noteId, now); added += 1; }
  }
  return { added, updated };
}

export function listXhsStats(db: DatabaseSync, accountId: number): XhsNoteStat[] {
  return (db.prepare('SELECT * FROM xhs_note_stats WHERE account_id=? ORDER BY publish_date DESC, id DESC').all(accountId) as Array<Record<string, unknown>>).map(statFromRow);
}

export function deleteXhsStat(db: DatabaseSync, id: number): number | null {
  const row = db.prepare('SELECT account_id FROM xhs_note_stats WHERE id=?').get(id) as { account_id: number } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM xhs_note_stats WHERE id=?').run(id);
  return Number(row.account_id);
}

/* ── 热点缓存 ─────────────────────────────────────────────────── */

/** 命中且未过期时返回带 cached 标记的结果；过期或损坏的条目当作未命中。 */
export function readHotspotCache(db: DatabaseSync, key: string, now: Date = new Date()): XhsHotspotResult | null {
  const row = db.prepare('SELECT result_json, fetched_at FROM xhs_hotspot_cache WHERE cache_key=?').get(key) as { result_json: string; fetched_at: string } | undefined;
  if (!row) return null;
  const age = now.getTime() - Date.parse(row.fetched_at);
  if (!Number.isFinite(age) || age < 0 || age > HOTSPOT_CACHE_TTL_MS) return null;
  try { return { ...(JSON.parse(row.result_json) as XhsHotspotResult), cached: true }; } catch { return null; }
}

export function writeHotspotCache(db: DatabaseSync, key: string, result: XhsHotspotResult): void {
  db.prepare('INSERT INTO xhs_hotspot_cache (cache_key, result_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json, fetched_at=excluded.fetched_at')
    .run(key, JSON.stringify({ ...result, cached: false }), result.fetchedAt);
  // 顺手清掉过期条目，缓存表不会无限长。
  db.prepare('DELETE FROM xhs_hotspot_cache WHERE fetched_at < ?').run(new Date(Date.parse(result.fetchedAt) - HOTSPOT_CACHE_TTL_MS).toISOString());
}
