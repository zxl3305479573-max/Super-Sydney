import type { DatabaseSync } from 'node:sqlite';
import type { ContentDirection, ContentProfileFields, ContentSubdirection, ContentTask, ContentTaxonomy } from '../shared.ts';
import {
  DEFAULT_DIRECTION_NAME, DEFAULT_DIRECTION_NOTE, DEFAULT_SUBDIRECTIONS, LEGACY_CATEGORY_NAMES,
  findDirection, findSubdirection, normalizeTaxonomyInput, resolveDefaultSubdirection
} from './content-taxonomy.ts';
import { LEGACY_IMAGE_STYLE } from './image-style.ts';

/**
 * 公众号文章任务与两级内容方向的持久化。
 * 只碰 SQLite；style.yaml 同步、广播刷新由调用方负责。
 */

/** 资料字段与数据库列名的对应；列表类字段存 JSON 文本。 */
const PROFILE_COLUMNS: Array<[keyof ContentProfileFields, string]> = [
  ['accountName', 'account_name'], ['industry', 'industry'], ['author', 'author'],
  ['audience', 'audience'], ['tone', 'tone'], ['voice', 'voice'],
  ['persona', 'persona'], ['theme', 'theme'], ['wordCount', 'word_count'], ['contentStyle', 'content_style'],
  ['blacklistWords', 'blacklist_words'], ['blacklistTopics', 'blacklist_topics']
];
const LIST_FIELDS = new Set<keyof ContentProfileFields>(['blacklistWords', 'blacklistTopics']);

function parseList(raw: unknown): string[] {
  try {
    const value = JSON.parse(String(raw ?? '[]')) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function profileFromRow(row: Record<string, unknown>): ContentProfileFields {
  const fields = {} as Record<keyof ContentProfileFields, string | string[]>;
  for (const [key, column] of PROFILE_COLUMNS) fields[key] = LIST_FIELDS.has(key) ? parseList(row[column]) : String(row[column] ?? '');
  return fields as ContentProfileFields;
}

function profileValues(profile: ContentProfileFields): string[] {
  return PROFILE_COLUMNS.map(([key]) => LIST_FIELDS.has(key) ? JSON.stringify(profile[key]) : String(profile[key]));
}

/** 返回 true 表示本次刚给内容方向补上公众号资料列（新库或老库升级），调用方据此做一次性迁移。 */
export function migrateContentTables(db: DatabaseSync): boolean {
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
  for (const table of ['content_directions', 'content_subdirections']) {
    const taxonomyColumns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
    if (!taxonomyColumns.has('image_prompt')) db.exec(`ALTER TABLE ${table} ADD COLUMN image_prompt TEXT NOT NULL DEFAULT ''`);
  }
  const directionColumns = new Set((db.prepare('PRAGMA table_info(content_directions)').all() as Array<{ name: string }>).map(column => column.name));
  const profileAdded = !directionColumns.has('account_name');
  for (const [key, column] of PROFILE_COLUMNS) {
    if (!directionColumns.has(column)) db.exec(`ALTER TABLE content_directions ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${LIST_FIELDS.has(key) ? '[]' : ''}'`);
  }
  const columns = new Set((db.prepare('PRAGMA table_info(content_tasks)').all() as Array<{ name: string }>).map(column => column.name));
  if (!columns.has('publish_json')) db.exec("ALTER TABLE content_tasks ADD COLUMN publish_json TEXT NOT NULL DEFAULT ''");
  if (!columns.has('sources_json')) db.exec("ALTER TABLE content_tasks ADD COLUMN sources_json TEXT NOT NULL DEFAULT ''");
  if (!columns.has('export_path')) db.exec("ALTER TABLE content_tasks ADD COLUMN export_path TEXT NOT NULL DEFAULT ''");
  if (!columns.has('theme')) db.exec("ALTER TABLE content_tasks ADD COLUMN theme TEXT NOT NULL DEFAULT ''");
  if (!columns.has('direction_id')) db.exec('ALTER TABLE content_tasks ADD COLUMN direction_id INTEGER');
  if (!columns.has('subdirection_id')) db.exec('ALTER TABLE content_tasks ADD COLUMN subdirection_id INTEGER');
  return profileAdded;
}

export type AccountStyle = {
  name: string; industry: string; author: string; targetAudience: string; tone: string; voice: string;
  persona: string; theme: string; wordCount: string; contentStyle: string; defaultTopic: string;
  blacklistWords: string[]; blacklistTopics: string[];
};

/**
 * 写作配置从账号级 style.yaml 下放到公众号资料时的一次性迁移（只在刚补列时调用，之后清空不会被再次填回）：
 *   - 公众号名称、行业、读者定位、写作人格、排版主题只属于最初那份资料，
 *     写给"默认具体方向所在的资料"（找不到就第一个），其它资料保持空；
 *   - 署名、篇幅、内容风格、禁忌词与禁忌话题是通用的，每份资料都拷一份，之后各改各的。
 * draftAuthor 是 config.yaml 里的草稿署名，比 style.yaml 的署名更可信（后者常是占位文字）。
 */
export function adoptAccountProfile(db: DatabaseSync, style: AccountStyle, draftAuthor = ''): void {
  const byTopic = style.defaultTopic
    ? db.prepare('SELECT direction_id AS id FROM content_subdirections WHERE name=? ORDER BY id LIMIT 1').get(style.defaultTopic) as { id: number } | undefined
    : undefined;
  const owner = byTopic ?? db.prepare('SELECT id FROM content_directions ORDER BY sort_order, id LIMIT 1').get() as { id: number } | undefined;
  db.prepare('UPDATE content_directions SET author=?, word_count=?, content_style=?, blacklist_words=?, blacklist_topics=?')
    .run(draftAuthor || style.author, style.wordCount, style.contentStyle, JSON.stringify(style.blacklistWords), JSON.stringify(style.blacklistTopics));
  if (!owner) return;
  db.prepare('UPDATE content_directions SET account_name=?, industry=?, audience=?, tone=?, voice=?, persona=?, theme=? WHERE id=?')
    .run(style.name, style.industry, style.targetAudience, style.tone, style.voice, style.persona, style.theme, owner.id);
  // 内置默认配图模板改成了通用版；原来那份资料一直用的是旧默认（含医疗禁忌），没自定义过就把旧默认写给它。
  db.prepare("UPDATE content_directions SET image_prompt=? WHERE id=? AND image_prompt=''").run(LEGACY_IMAGE_STYLE, owner.id);
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

/** 删除文章任务（只删库里这一行；配图文件由调用方清理，已导出到知识库的文件不动）。 */
export function deleteContentTask(db: DatabaseSync, id: number): void {
  getContentTask(db, id);
  db.prepare('DELETE FROM content_tasks WHERE id=?').run(id);
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
    imagePrompt: String(row.image_prompt ?? ''),
    ...profileFromRow(row),
    subdirections: [] as ContentSubdirection[]
  })) as ContentDirection[];
  const byId = new Map(directions.map(item => [item.id, item]));
  for (const row of db.prepare('SELECT * FROM content_subdirections ORDER BY sort_order, id').all() as Array<Record<string, unknown>>) {
    const parent = byId.get(Number(row.direction_id));
    if (parent) parent.subdirections.push({ id: Number(row.id), name: String(row.name ?? ''), note: String(row.note ?? ''), imagePrompt: String(row.image_prompt ?? '') });
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
      ? (db.prepare(`UPDATE content_directions SET name=?, note=?, image_prompt=?, ${PROFILE_COLUMNS.map(([, column]) => `${column}=?`).join(', ')}, sort_order=?, updated_at=? WHERE id=?`)
        .run(direction.name, direction.note, direction.imagePrompt, ...profileValues(direction), index, now, direction.id), direction.id)
      : Number(db.prepare(`INSERT INTO content_directions (name, note, image_prompt, ${PROFILE_COLUMNS.map(([, column]) => column).join(', ')}, sort_order, created_at, updated_at) VALUES (${Array(PROFILE_COLUMNS.length + 6).fill('?').join(', ')})`)
        .run(direction.name, direction.note, direction.imagePrompt, ...profileValues(direction), index, now, now).lastInsertRowid);
    direction.subdirections.forEach((subdirection, subIndex) => {
      if (subdirection.id) {
        db.prepare('UPDATE content_subdirections SET direction_id=?, name=?, note=?, image_prompt=?, sort_order=?, updated_at=? WHERE id=?')
          .run(directionId, subdirection.name, subdirection.note, subdirection.imagePrompt, subIndex, now, subdirection.id);
      } else {
        db.prepare('INSERT INTO content_subdirections (direction_id, name, note, image_prompt, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(directionId, subdirection.name, subdirection.note, subdirection.imagePrompt, subIndex, now, now);
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
