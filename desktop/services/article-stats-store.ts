import type { DatabaseSync } from 'node:sqlite';
import type { ArticleMetrics } from '../shared.ts';
import { emptyMetrics, METRIC_KEYS, normalizeTitle, type ArticleStatInput, type StoredStat } from './article-stats.ts';

/**
 * 文章数据的持久化。一篇文章一行，以（归一化标题, 发表日期）为键：
 * 重复导入同一篇时用新值覆盖——后台导出是累计数，越晚导出越完整。
 * 与创作任务的关联不落库，每次读取时重新按标题匹配，任务改标题后自动跟上。
 */

export function migrateArticleStatTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS article_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, title_key TEXT NOT NULL, publish_date TEXT NOT NULL,
    metrics_json TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT '', imported_at TEXT NOT NULL,
    UNIQUE(title_key, publish_date)
  );`);
}

function parseMetrics(raw: unknown): ArticleMetrics {
  const metrics = emptyMetrics();
  try {
    const parsed = JSON.parse(String(raw ?? '{}')) as Record<string, unknown>;
    for (const key of METRIC_KEYS) if (typeof parsed[key] === 'number') metrics[key] = parsed[key] as number;
  } catch {
    // 损坏的行按"没有数据"展示，不让一行坏数据拖垮整个列表。
  }
  return metrics;
}

export function listArticleStats(db: DatabaseSync): StoredStat[] {
  return (db.prepare('SELECT * FROM article_stats ORDER BY publish_date DESC, id DESC').all() as Array<Record<string, unknown>>).map(row => ({
    id: Number(row.id),
    title: String(row.title ?? ''),
    publishDate: String(row.publish_date ?? ''),
    metrics: parseMetrics(row.metrics_json),
    source: String(row.source ?? ''),
    importedAt: String(row.imported_at ?? '')
  }));
}

/**
 * 写入一批记录。合并而不是整行替换：新文件里没有的列（null）保留旧值，
 * 这样先导"阅读"表、再导"分享"表也能拼成完整的一行。
 */
export function upsertArticleStats(db: DatabaseSync, inputs: ArticleStatInput[], source: string, now = new Date().toISOString()): { added: number; updated: number } {
  const find = db.prepare('SELECT id, metrics_json FROM article_stats WHERE title_key=? AND publish_date=?');
  const insert = db.prepare('INSERT INTO article_stats (title, title_key, publish_date, metrics_json, source, imported_at) VALUES (?, ?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE article_stats SET title=?, metrics_json=?, source=?, imported_at=? WHERE id=?');
  let added = 0;
  let updated = 0;
  db.exec('BEGIN');
  try {
    for (const input of inputs) {
      const titleKey = normalizeTitle(input.title);
      const existing = find.get(titleKey, input.publishDate) as { id: number; metrics_json: string } | undefined;
      if (!existing) {
        insert.run(input.title, titleKey, input.publishDate, JSON.stringify(input.metrics), source, now);
        added += 1;
        continue;
      }
      const merged = parseMetrics(existing.metrics_json);
      for (const key of METRIC_KEYS) if (input.metrics[key] !== null) merged[key] = input.metrics[key];
      update.run(input.title, JSON.stringify(merged), source, now, existing.id);
      updated += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { added, updated };
}

export function deleteArticleStat(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM article_stats WHERE id=?').run(id);
}
