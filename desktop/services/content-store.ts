import type { DatabaseSync } from 'node:sqlite';
import type { ContentDirection, ContentSubdirection, ContentTask, ContentTaxonomy } from '../shared.ts';
import {
  DEFAULT_DIRECTION_NAME, DEFAULT_DIRECTION_NOTE, DEFAULT_SUBDIRECTIONS, LEGACY_CATEGORY_NAMES,
  findDirection, findSubdirection, normalizeTaxonomyInput, resolveDefaultSubdirection
} from './content-taxonomy.ts';

/**
 * 公众号文章任务与两级内容方向的持久化。
 * 只碰 SQLite；style.yaml 同步、广播刷新由调用方负责。
 */

export function migrateContentTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS content_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL DEFAULT '', direction_id INTEGER, subdirection_id INTEGER,
    topic TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idea', brief_json TEXT NOT NULL DEFAULT '', claims_json TEXT NOT NULL DEFAULT '', sources_json TEXT NOT NULL DEFAULT '', topics_json TEXT NOT NULL DEFAULT '',
    draft TEXT NOT NULL DEFAULT '', final_article TEXT NOT NULL DEFAULT '', review_json TEXT NOT NULL DEFAULT '', cover_path TEXT NOT NULL DEFAULT '',
    theme TEXT NOT NULL DEFAULT '', publish_json TEXT NOT NULL DEFAULT '', export_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  // 内容方向是用户自维护的两级分类；旧版写死的 4 个类目在 seedContentTaxonomy 里迁移成默认方向的二级方向。
  db.exec(`CREATE TABLE IF NOT EXISTS content_directions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS content_subdirections (
    id INTEGER PRIMARY KEY AUTOINCREMENT, direction_id INTEGER NOT NULL, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_content_subdirections_direction ON content_subdirections(direction_id);');
  const columns = new Set((db.prepare('PRAGMA table_info(content_tasks)').all() as Array<{ name: string }>).map(column => column.name));
  if (!columns.has('publish_json')) db.exec("ALTER TABLE content_tasks ADD COLUMN publish_json TEXT NOT NULL DEFAULT ''");
  if (!columns.has('sources_json')) db.exec("ALTER TABLE content_tasks ADD COLUMN sources_json TEXT NOT NULL DEFAULT ''");
  if (!columns.has('export_path')) db.exec("ALTER TABLE content_tasks ADD COLUMN export_path TEXT NOT NULL DEFAULT ''");
  if (!columns.has('theme')) db.exec("ALTER TABLE content_tasks ADD COLUMN theme TEXT NOT NULL DEFAULT ''");
  if (!columns.has('direction_id')) db.exec('ALTER TABLE content_tasks ADD COLUMN direction_id INTEGER');
  if (!columns.has('subdirection_id')) db.exec('ALTER TABLE content_tasks ADD COLUMN subdirection_id INTEGER');
}

/** 任务查询统一带出分类名，界面不必再自己去查分类表。 */
const CONTENT_TASK_SELECT = `SELECT t.*, d.name AS direction_name, s.name AS subdirection_name
  FROM content_tasks t
  LEFT JOIN content_directions d ON d.id = t.direction_id
  LEFT JOIN content_subdirections s ON s.id = t.subdirection_id`;

export function optionalId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function contentTaskFromRow(row: Record<string, unknown>): ContentTask {
  return {
    id: Number(row.id),
    directionId: optionalId(row.direction_id),
    subdirectionId: optionalId(row.subdirection_id),
    directionName: String(row.direction_name ?? ''),
    subdirectionName: String(row.subdirection_name ?? ''),
    topic: String(row.topic ?? ''), title: String(row.title ?? ''), status: String(row.status ?? 'idea') as ContentTask['status'],
    briefJson: String(row.brief_json ?? ''), claimsJson: String(row.claims_json ?? ''), sourcesJson: String(row.sources_json ?? ''), topicsJson: String(row.topics_json ?? ''),
    draft: String(row.draft ?? ''), finalArticle: String(row.final_article ?? ''), reviewJson: String(row.review_json ?? ''),
    coverPath: String(row.cover_path ?? ''), theme: String(row.theme ?? ''), publishJson: String(row.publish_json ?? ''), exportPath: String(row.export_path ?? ''), createdAt: String(row.created_at ?? ''), updatedAt: String(row.updated_at ?? '')
  };
}

export function listContentTasks(db: DatabaseSync): ContentTask[] {
  return (db.prepare(`${CONTENT_TASK_SELECT} ORDER BY t.updated_at DESC`).all() as Array<Record<string, unknown>>).map(contentTaskFromRow);
}

export function getContentTask(db: DatabaseSync, id: number): ContentTask {
  const row = db.prepare(`${CONTENT_TASK_SELECT} WHERE t.id=?`).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('文章任务不存在');
  return contentTaskFromRow(row);
}

/**
 * 新建任务：只传二级方向时自动带出一级方向；两者都空也允许，任务会以"未归类"存在。
 */
export function createContentTask(db: DatabaseSync, taxonomy: ContentTaxonomy, directionId: unknown, subdirectionId: unknown, topic: string): ContentTask {
  const subdirection = findSubdirection(taxonomy.directions, optionalId(subdirectionId));
  if (subdirectionId && !subdirection) throw new Error('选择的具体方向已经不存在，请刷新后重试');
  const direction = subdirection?.direction ?? findDirection(taxonomy.directions, optionalId(directionId));
  if (directionId && !direction) throw new Error('选择的内容方向已经不存在，请刷新后重试');
  const now = new Date().toISOString();
  // category 是旧版本的列（NOT NULL 且老库没有默认值），这里显式写空串，保证老库升级后也能插入。
  const result = db.prepare('INSERT INTO content_tasks (category, direction_id, subdirection_id, topic, status, created_at, updated_at) VALUES (\'\', ?, ?, ?, \'idea\', ?, ?)')
    .run(direction?.id ?? null, subdirection?.subdirection.id ?? null, topic.trim(), now, now);
  return getContentTask(db, Number(result.lastInsertRowid));
}

const CONTENT_COLUMNS: Record<string, string> = {
  directionId: 'direction_id', subdirectionId: 'subdirection_id',
  topic: 'topic', title: 'title', status: 'status', briefJson: 'brief_json', claimsJson: 'claims_json', sourcesJson: 'sources_json',
  topicsJson: 'topics_json', draft: 'draft', finalArticle: 'final_article', reviewJson: 'review_json', coverPath: 'cover_path',
  theme: 'theme', publishJson: 'publish_json', exportPath: 'export_path'
};

/** 只写白名单字段；未知字段直接忽略，不会拼进 SQL。 */
export function updateContentTask(db: DatabaseSync, id: number, patch: Partial<ContentTask>): ContentTask {
  const entries = Object.entries(patch).filter(([key]) => CONTENT_COLUMNS[key]);
  if (entries.length) {
    const sets = entries.map(([key]) => `${CONTENT_COLUMNS[key]}=?`);
    const values = entries.map(([, value]) => value as string | number | null);
    sets.push('updated_at=?'); values.push(new Date().toISOString()); values.push(id);
    db.prepare(`UPDATE content_tasks SET ${sets.join(', ')} WHERE id=?`).run(...values);
  }
  return getContentTask(db, id);
}

/* ── 内容方向（两级，用户自维护） ─────────────────────────────── */

/** preferredDefaultTopic 来自 style.yaml 的 default_topic，用于选出默认具体方向。 */
export function readTaxonomy(db: DatabaseSync, preferredDefaultTopic = ''): ContentTaxonomy {
  const directions = (db.prepare('SELECT * FROM content_directions ORDER BY sort_order, id').all() as Array<Record<string, unknown>>).map(row => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    note: String(row.note ?? ''),
    subdirections: [] as ContentSubdirection[]
  })) as ContentDirection[];
  const byId = new Map(directions.map(item => [item.id, item]));
  for (const row of db.prepare('SELECT * FROM content_subdirections ORDER BY sort_order, id').all() as Array<Record<string, unknown>>) {
    const parent = byId.get(Number(row.direction_id));
    if (parent) parent.subdirections.push({ id: Number(row.id), name: String(row.name ?? ''), note: String(row.note ?? '') });
  }
  const fallback = resolveDefaultSubdirection({ directions, defaultSubdirectionId: null }, preferredDefaultTopic);
  return { directions, defaultSubdirectionId: fallback.subdirectionId };
}

/** 首次启动写入默认方向，并把旧的 category 值映射到对应的二级方向。 */
export function seedContentTaxonomy(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const count = Number((db.prepare('SELECT COUNT(*) AS count FROM content_directions').get() as { count: number }).count);
  if (!count) {
    const direction = db.prepare('INSERT INTO content_directions (name, note, sort_order, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run(DEFAULT_DIRECTION_NAME, DEFAULT_DIRECTION_NOTE, now, now);
    DEFAULT_SUBDIRECTIONS.forEach((name, index) => {
      db.prepare('INSERT INTO content_subdirections (direction_id, name, note, sort_order, created_at, updated_at) VALUES (?, ?, \'\', ?, ?, ?)')
        .run(Number(direction.lastInsertRowid), name, index, now, now);
    });
  }
  const subdirections = db.prepare('SELECT id, name FROM content_subdirections').all() as Array<{ id: number; name: string }>;
  for (const [legacy, name] of Object.entries(LEGACY_CATEGORY_NAMES)) {
    const target = subdirections.find(item => item.name === name);
    if (!target) continue;
    const parent = db.prepare('SELECT direction_id FROM content_subdirections WHERE id=?').get(target.id) as { direction_id: number } | undefined;
    if (!parent) continue;
    db.prepare('UPDATE content_tasks SET direction_id=?, subdirection_id=? WHERE subdirection_id IS NULL AND category=?')
      .run(Number(parent.direction_id), target.id, legacy);
  }
}

/**
 * 保存分类树：按 id 增改删。
 * 有任务引用的方向不允许删除——否则历史文章会突然没有归属，界面上也解释不清。
 */
export function saveTaxonomyTree(db: DatabaseSync, input: unknown): void {
  const normalized = normalizeTaxonomyInput(input);
  const now = new Date().toISOString();
  const keepDirectionIds = new Set(normalized.map(item => item.id).filter((id): id is number => Boolean(id)));
  const keepSubIds = new Set(normalized.flatMap(item => item.subdirections.map(sub => sub.id)).filter((id): id is number => Boolean(id)));

  for (const direction of db.prepare('SELECT id, name FROM content_directions').all() as Array<{ id: number; name: string }>) {
    if (keepDirectionIds.has(direction.id)) continue;
    const used = Number((db.prepare('SELECT COUNT(*) AS count FROM content_tasks WHERE direction_id=?').get(direction.id) as { count: number }).count);
    if (used) throw new Error(`「${direction.name}」下还有 ${used} 篇文章，先改掉它们的分类再删除这个方向`);
    db.prepare('DELETE FROM content_subdirections WHERE direction_id=?').run(direction.id);
    db.prepare('DELETE FROM content_directions WHERE id=?').run(direction.id);
  }
  for (const subdirection of db.prepare('SELECT id, name FROM content_subdirections').all() as Array<{ id: number; name: string }>) {
    if (keepSubIds.has(subdirection.id)) continue;
    const used = Number((db.prepare('SELECT COUNT(*) AS count FROM content_tasks WHERE subdirection_id=?').get(subdirection.id) as { count: number }).count);
    if (used) throw new Error(`「${subdirection.name}」下还有 ${used} 篇文章，先把它们改成别的具体方向再删除`);
    db.prepare('DELETE FROM content_subdirections WHERE id=?').run(subdirection.id);
  }

  normalized.forEach((direction, index) => {
    const directionId = direction.id
      ? (db.prepare('UPDATE content_directions SET name=?, note=?, sort_order=?, updated_at=? WHERE id=?').run(direction.name, direction.note, index, now, direction.id), direction.id)
      : Number(db.prepare('INSERT INTO content_directions (name, note, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(direction.name, direction.note, index, now, now).lastInsertRowid);
    direction.subdirections.forEach((subdirection, subIndex) => {
      if (subdirection.id) {
        db.prepare('UPDATE content_subdirections SET direction_id=?, name=?, note=?, sort_order=?, updated_at=? WHERE id=?')
          .run(directionId, subdirection.name, subdirection.note, subIndex, now, subdirection.id);
      } else {
        db.prepare('INSERT INTO content_subdirections (direction_id, name, note, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(directionId, subdirection.name, subdirection.note, subIndex, now, now);
      }
    });
  });
}

/** 保存后用于回写 style.yaml 的默认具体方向：优先用户指定的，其次按规则兜底。 */
export function chosenDefaultSubdirectionName(taxonomy: ContentTaxonomy, wantedId: number | null | undefined): string {
  const wanted = findSubdirection(taxonomy.directions, wantedId ?? null);
  if (wanted) return wanted.subdirection.name;
  const fallback = resolveDefaultSubdirection({ directions: taxonomy.directions, defaultSubdirectionId: null });
  return fallback.subdirectionId ? findSubdirection(taxonomy.directions, fallback.subdirectionId)?.subdirection.name ?? '' : '';
}
