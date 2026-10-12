import type { DatabaseSync } from 'node:sqlite';
import type { VideoPlatform, VideoProject } from '../shared.ts';
import { VIDEO_PLATFORMS } from './video-pipeline.ts';

/** 视频任务的持久化。只碰 SQLite；广播刷新由调用方负责。 */

export const videoPlatformSet = new Set<VideoPlatform>(VIDEO_PLATFORMS.map(item => item.value));

export function migrateVideoTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS video_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'general', topic TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT '', duration_seconds INTEGER NOT NULL DEFAULT 60, status TEXT NOT NULL DEFAULT 'idea',
    topics_json TEXT NOT NULL DEFAULT '', script TEXT NOT NULL DEFAULT '', storyboard_json TEXT NOT NULL DEFAULT '',
    cover_path TEXT NOT NULL DEFAULT '', export_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
}

export function videoProjectFromRow(row: Record<string, unknown>): VideoProject {
  const platform = String(row.platform ?? 'general') as VideoPlatform;
  const seconds = Math.round(Number(row.duration_seconds));
  return {
    id: Number(row.id),
    platform: videoPlatformSet.has(platform) ? platform : 'general',
    topic: String(row.topic ?? ''), title: String(row.title ?? ''), audience: String(row.audience ?? ''),
    durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 60,
    status: String(row.status ?? 'idea') as VideoProject['status'],
    topicsJson: String(row.topics_json ?? ''), script: String(row.script ?? ''), storyboardJson: String(row.storyboard_json ?? ''),
    coverPath: String(row.cover_path ?? ''), exportPath: String(row.export_path ?? ''),
    createdAt: String(row.created_at ?? ''), updatedAt: String(row.updated_at ?? '')
  };
}

export function listVideoProjects(db: DatabaseSync): VideoProject[] {
  return (db.prepare('SELECT * FROM video_projects ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>).map(videoProjectFromRow);
}

export function getVideoProject(db: DatabaseSync, id: number): VideoProject {
  const row = db.prepare('SELECT * FROM video_projects WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('视频任务不存在');
  return videoProjectFromRow(row);
}

export function createVideoProject(db: DatabaseSync, platform: VideoPlatform, topic: unknown): VideoProject {
  if (!videoPlatformSet.has(platform)) throw new Error('未知的视频平台');
  const now = new Date().toISOString();
  const result = db.prepare("INSERT INTO video_projects (platform, topic, status, created_at, updated_at) VALUES (?, ?, 'idea', ?, ?)").run(platform, String(topic ?? '').trim(), now, now);
  return getVideoProject(db, Number(result.lastInsertRowid));
}

const VIDEO_COLUMNS: Record<string, string> = {
  platform: 'platform', topic: 'topic', title: 'title', audience: 'audience', durationSeconds: 'duration_seconds',
  status: 'status', topicsJson: 'topics_json', script: 'script', storyboardJson: 'storyboard_json',
  coverPath: 'cover_path', exportPath: 'export_path'
};

/** 只写白名单字段；未知字段直接忽略，不会拼进 SQL。 */
export function updateVideoProject(db: DatabaseSync, id: number, patch: Partial<VideoProject>): VideoProject {
  const entries = Object.entries(patch).filter(([key]) => VIDEO_COLUMNS[key]);
  if (entries.length) {
    const sets = entries.map(([key]) => `${VIDEO_COLUMNS[key]}=?`);
    const values = entries.map(([, value]) => value as string | number);
    sets.push('updated_at=?'); values.push(new Date().toISOString()); values.push(id);
    db.prepare(`UPDATE video_projects SET ${sets.join(', ')} WHERE id=?`).run(...values);
  }
  return getVideoProject(db, id);
}
