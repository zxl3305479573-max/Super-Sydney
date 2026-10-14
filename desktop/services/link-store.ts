import type { DatabaseSync } from 'node:sqlite';
import type { LinkEntry, LinkInput } from '../shared.ts';

/**
 * 成长 · 链接收藏：随手存下来的文章、工具、教程地址。
 * 只碰 SQLite；广播刷新由调用方负责。链接本身只存地址和用户写的备注，不去抓网页内容。
 */

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 20;

export function migrateLinkTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, opened_at TEXT NOT NULL DEFAULT ''
  );`);
}

function linkFromRow(row: Record<string, unknown>): LinkEntry {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(String(row.tags_json ?? '[]')) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    tags = [];
  }
  return {
    id: Number(row.id), url: String(row.url ?? ''), title: String(row.title ?? ''), note: String(row.note ?? ''), tags,
    createdAt: String(row.created_at ?? ''), updatedAt: String(row.updated_at ?? ''), openedAt: String(row.opened_at ?? '')
  };
}

export function listLinks(db: DatabaseSync): LinkEntry[] {
  return (db.prepare('SELECT * FROM links ORDER BY created_at DESC, id DESC').all() as Array<Record<string, unknown>>).map(linkFromRow);
}

export function getLink(db: DatabaseSync, id: number): LinkEntry {
  const row = db.prepare('SELECT * FROM links WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('这条链接不存在，可能已经删除');
  return linkFromRow(row);
}

export function createLink(db: DatabaseSync, input: unknown): LinkEntry {
  const link = sanitizeLinkInput(input);
  assertUnique(db, link.url, null);
  const now = new Date().toISOString();
  const result = db.prepare('INSERT INTO links (url, title, note, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(link.url, link.title, link.note, JSON.stringify(link.tags), now, now);
  return getLink(db, Number(result.lastInsertRowid));
}

export function updateLink(db: DatabaseSync, id: number, input: unknown): LinkEntry {
  getLink(db, id);
  const link = sanitizeLinkInput(input);
  assertUnique(db, link.url, id);
  db.prepare('UPDATE links SET url=?, title=?, note=?, tags_json=?, updated_at=? WHERE id=?')
    .run(link.url, link.title, link.note, JSON.stringify(link.tags), new Date().toISOString(), id);
  return getLink(db, id);
}

export function deleteLink(db: DatabaseSync, id: number): void {
  getLink(db, id);
  db.prepare('DELETE FROM links WHERE id=?').run(id);
}

/** 记下最近一次打开的时间，列表里能看出哪些收藏一直没回头看。 */
export function markLinkOpened(db: DatabaseSync, id: number): LinkEntry {
  getLink(db, id);
  db.prepare('UPDATE links SET opened_at=? WHERE id=?').run(new Date().toISOString(), id);
  return getLink(db, id);
}

function assertUnique(db: DatabaseSync, url: string, selfId: number | null): void {
  const row = db.prepare('SELECT id, title FROM links WHERE url=?').get(url) as { id: number; title: string } | undefined;
  if (row && Number(row.id) !== selfId) throw new Error(`无法重复收藏，这个链接已经存过了：${row.title || url}`);
}

/** 界面提交的内容：地址是硬校验，标题留空用域名兜底，标签去重、限长。 */
export function sanitizeLinkInput(input: unknown): Required<LinkInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('链接格式不正确');
  const { url, title, note, tags } = input as Partial<LinkInput>;
  const address = normalizeLinkUrl(url);
  const cleanTags = [...new Set((Array.isArray(tags) ? tags : [])
    .map(tag => String(tag ?? '').trim().replace(/^#/, '').slice(0, MAX_TAG_LENGTH))
    .filter(Boolean))];
  if (cleanTags.length > MAX_TAGS) throw new Error(`标签最多 ${MAX_TAGS} 个`);
  return {
    url: address,
    title: String(title ?? '').trim().slice(0, 120) || new URL(address).host,
    note: String(note ?? '').trim().slice(0, 2000),
    tags: cleanTags
  };
}

/**
 * 链接只接受 http/https，没写协议时补 https。
 * 打开时会交给系统浏览器，不能让 file:、javascript: 这类协议混进来。
 * 冒号后面跟数字的（localhost:3000）是主机加端口，不算协议头。
 */
export function normalizeLinkUrl(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('请先填写链接地址');
  const scheme = /^([a-z][a-z0-9+.-]*):(?![0-9])/i.exec(text);
  if (scheme && !/^https?$/i.test(scheme[1])) throw new Error(`链接只支持 http 与 https，不认 ${scheme[1]}: 协议`);
  let parsed: URL;
  try {
    parsed = new URL(scheme ? text : `https://${text}`);
  } catch {
    throw new Error('链接格式不正确，请填写完整网址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('链接只支持 http 与 https');
  if (!parsed.hostname) throw new Error('链接缺少域名');
  return parsed.toString();
}
