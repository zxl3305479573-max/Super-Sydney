import type { DatabaseSync } from 'node:sqlite';
import {
  VIDEO_PUBLISH_PLATFORMS,
  type OpsEpisode,
  type OpsEpisodeWithTasks,
  type OpsFollowerRecord,
  type OpsLogEntry,
  type OpsMetricRecord,
  type OpsMetricSnapshot,
  type OpsPlatform,
  type OpsPlatformTask,
  type OpsSourceType,
  type OpsTaskState
} from '../shared.ts';

/**
 * 运营中控持久化层：分发计划、各平台任务防重状态机、粉丝净增账本、作品指标采样与日志。
 *
 * 设计参考麦田（mdldm-maitian）的 episodes / tasks / followers / metrics / samples，
 * 针对 Super-Sydney 扩展为支持关联视频项目、小红书笔记、公众号文章或手工登记。
 */

export const OPS_PLATFORMS: OpsPlatform[] = VIDEO_PUBLISH_PLATFORMS.map(item => item.value);
export const OPS_PLATFORM_SET = new Set<OpsPlatform>(OPS_PLATFORMS);
export const OPS_PLATFORM_LABELS: Record<OpsPlatform, string> = {
  douyin: '抖音',
  shipinhao: '微信视频号',
  xiaohongshu: '小红书',
  bilibili: 'B 站'
};

export const OPS_TASK_STATES = new Set<OpsTaskState>([
  'planned', 'draft', 'scheduled', 'published', 'failed', 'not_logged_in', 'skipped'
]);

/** 已经到位或已上传过视频的状态（防重锁）：默认拦截二次上传，避免触发平台风控。 */
export const OPS_LOCKED_STATES = new Set<OpsTaskState>(['draft', 'scheduled', 'published']);

export const OPS_STATE_LABELS: Record<OpsTaskState, string> = {
  planned: '计划中',
  draft: '已填草稿·待点发布',
  scheduled: '已定时',
  published: '已发布',
  failed: '异常',
  not_logged_in: '未登录',
  skipped: '跳过'
};

export function isOpsStateLocked(state: OpsTaskState | undefined | null): boolean {
  return Boolean(state && OPS_LOCKED_STATES.has(state));
}

export function localDayString(input: Date | number | string = Date.now()): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    const fallback = new Date();
    return `${fallback.getFullYear()}-${String(fallback.getMonth() + 1).padStart(2, '0')}-${String(fallback.getDate()).padStart(2, '0')}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function migrateOpsTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL DEFAULT 'video',
      source_id INTEGER,
      title TEXT NOT NULL DEFAULT '',
      scheduled_at TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ops_episodes_source ON ops_episodes(source_type, source_id);
    CREATE INDEX IF NOT EXISTS ops_episodes_schedule ON ops_episodes(scheduled_at, created_at);

    CREATE TABLE IF NOT EXISTS ops_platform_tasks (
      episode_id INTEGER NOT NULL REFERENCES ops_episodes(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'planned',
      detail TEXT NOT NULL DEFAULT '',
      post_url TEXT NOT NULL DEFAULT '',
      filled_title TEXT NOT NULL DEFAULT '',
      platform_schedule TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (episode_id, platform)
    );

    CREATE TABLE IF NOT EXISTS ops_video_publish_packs (
      project_id INTEGER PRIMARY KEY,
      scheduled_at TEXT NOT NULL DEFAULT '',
      neutral_copy TEXT NOT NULL DEFAULT '',
      copies_json TEXT NOT NULL DEFAULT '{}',
      variants_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ops_followers (
      day TEXT NOT NULL,
      platform TEXT NOT NULL,
      total INTEGER NOT NULL,
      gain INTEGER,
      loss INTEGER,
      net INTEGER,
      source TEXT NOT NULL DEFAULT 'live',
      collected_at TEXT NOT NULL,
      PRIMARY KEY (day, platform)
    );

    CREATE TABLE IF NOT EXISTS ops_metrics (
      day TEXT NOT NULL,
      episode_id INTEGER NOT NULL REFERENCES ops_episodes(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      views INTEGER,
      likes INTEGER,
      comments INTEGER,
      favorites INTEGER,
      shares INTEGER,
      extra_json TEXT NOT NULL DEFAULT '{}',
      collected_at TEXT NOT NULL,
      PRIMARY KEY (day, episode_id, platform)
    );

    CREATE TABLE IF NOT EXISTS ops_metric_samples (
      ts TEXT NOT NULL,
      episode_id INTEGER NOT NULL REFERENCES ops_episodes(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      views INTEGER,
      likes INTEGER,
      comments INTEGER,
      favorites INTEGER,
      shares INTEGER,
      PRIMARY KEY (ts, episode_id, platform)
    );

    CREATE TABLE IF NOT EXISTS ops_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      episode_id INTEGER,
      platform TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ops_notified_milestones (
      episode_id INTEGER NOT NULL,
      milestone_day INTEGER NOT NULL,
      notified_at TEXT NOT NULL,
      PRIMARY KEY (episode_id, milestone_day)
    );
  `);
  // 2026-11-28 加入：发布包的中性基础文案列，供上传本地视频直发或二次改写四平台文案使用。
  const packColumns = new Set(
    (db.prepare('PRAGMA table_info(ops_video_publish_packs)').all() as Array<{ name: string }>).map(column => column.name)
  );
  if (!packColumns.has('neutral_copy')) {
    db.exec("ALTER TABLE ops_video_publish_packs ADD COLUMN neutral_copy TEXT NOT NULL DEFAULT ''");
  }
}

function episodeFromRow(row: Record<string, unknown>): OpsEpisode {
  const rawType = String(row.source_type ?? 'manual');
  const sourceType: OpsSourceType = rawType === 'video' || rawType === 'xhs' || rawType === 'wechat' ? rawType : 'manual';
  return {
    id: Number(row.id),
    sourceType,
    sourceId: typeof row.source_id === 'number' ? row.source_id : row.source_id != null ? Number(row.source_id) : null,
    title: String(row.title ?? ''),
    scheduledAt: String(row.scheduled_at ?? ''),
    notes: String(row.notes ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? '')
  };
}

function taskFromRow(row: Record<string, unknown>): OpsPlatformTask {
  const rawState = String(row.state ?? 'planned') as OpsTaskState;
  return {
    episodeId: Number(row.episode_id),
    platform: String(row.platform) as OpsPlatform,
    state: OPS_TASK_STATES.has(rawState) ? rawState : 'planned',
    detail: String(row.detail ?? ''),
    postUrl: String(row.post_url ?? ''),
    filledTitle: String(row.filled_title ?? ''),
    platformSchedule: String(row.platform_schedule ?? ''),
    updatedAt: String(row.updated_at ?? '')
  };
}

export function getOpsEpisode(db: DatabaseSync, id: number): OpsEpisode {
  const row = db.prepare('SELECT * FROM ops_episodes WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('分发计划不存在');
  return episodeFromRow(row);
}

export function findOpsEpisodeBySource(db: DatabaseSync, sourceType: OpsSourceType, sourceId: number): OpsEpisode | null {
  const row = db.prepare('SELECT * FROM ops_episodes WHERE source_type=? AND source_id=? ORDER BY id DESC LIMIT 1')
    .get(sourceType, sourceId) as Record<string, unknown> | undefined;
  return row ? episodeFromRow(row) : null;
}

export function getOpsPlatformTasks(db: DatabaseSync, episodeId: number): OpsPlatformTask[] {
  const rows = db.prepare('SELECT * FROM ops_platform_tasks WHERE episode_id=? ORDER BY rowid').all(episodeId) as Array<Record<string, unknown>>;
  return rows.filter(row => OPS_PLATFORM_SET.has(String(row.platform) as OpsPlatform)).map(taskFromRow);
}

export function getOpsPlatformTask(db: DatabaseSync, episodeId: number, platform: OpsPlatform): OpsPlatformTask | null {
  const row = db.prepare('SELECT * FROM ops_platform_tasks WHERE episode_id=? AND platform=?').get(episodeId, platform) as Record<string, unknown> | undefined;
  return row ? taskFromRow(row) : null;
}

export function getOpsEpisodeWithTasks(db: DatabaseSync, id: number): OpsEpisodeWithTasks {
  const episode = getOpsEpisode(db, id);
  return { ...episode, tasks: getOpsPlatformTasks(db, id) };
}

export function listOpsEpisodesWithTasks(db: DatabaseSync): OpsEpisodeWithTasks[] {
  const episodes = (db.prepare('SELECT * FROM ops_episodes ORDER BY COALESCE(NULLIF(scheduled_at, \'\'), created_at) DESC, id DESC').all() as Array<Record<string, unknown>>)
    .map(episodeFromRow);
  if (!episodes.length) return [];
  const allTasks = (db.prepare('SELECT * FROM ops_platform_tasks ORDER BY rowid').all() as Array<Record<string, unknown>>)
    .filter(row => OPS_PLATFORM_SET.has(String(row.platform) as OpsPlatform))
    .map(taskFromRow);
  const grouped = new Map<number, OpsPlatformTask[]>();
  for (const task of allTasks) {
    const list = grouped.get(task.episodeId) ?? [];
    list.push(task);
    grouped.set(task.episodeId, list);
  }
  return episodes.map(episode => ({ ...episode, tasks: grouped.get(episode.id) ?? [] }));
}

export type UpsertOpsEpisodeInput = {
  id?: number;
  sourceType?: OpsSourceType;
  sourceId?: number | null;
  title: string;
  scheduledAt?: string;
  notes?: string;
  platforms?: OpsPlatform[];
};

/**
 * 新建或更新一期分发计划。
 * 若传入了 sourceType + sourceId（如视频任务），自动复用已有记录，不会重复建多条计划。
 */
export function upsertOpsEpisode(db: DatabaseSync, input: UpsertOpsEpisodeInput, now = new Date().toISOString()): OpsEpisodeWithTasks {
  const cleanTitle = String(input.title ?? '').trim() || '未命名内容';
  const sourceType: OpsSourceType = input.sourceType ?? 'manual';
  const sourceId = typeof input.sourceId === 'number' && Number.isFinite(input.sourceId) ? input.sourceId : null;
  const existing = input.id
    ? getOpsEpisode(db, input.id)
    : sourceId !== null && sourceType !== 'manual'
      ? findOpsEpisodeBySource(db, sourceType, sourceId)
      : null;

  let episodeId: number;
  if (existing) {
    const scheduledAt = input.scheduledAt !== undefined ? String(input.scheduledAt).trim() : existing.scheduledAt;
    const notes = input.notes !== undefined ? String(input.notes).trim() : existing.notes;
    db.prepare('UPDATE ops_episodes SET title=?, scheduled_at=?, notes=?, updated_at=? WHERE id=?')
      .run(cleanTitle, scheduledAt, notes, now, existing.id);
    episodeId = existing.id;
  } else {
    const result = db.prepare(
      'INSERT INTO ops_episodes (source_type, source_id, title, scheduled_at, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(sourceType, sourceId, cleanTitle, String(input.scheduledAt ?? '').trim(), String(input.notes ?? '').trim(), now, now);
    episodeId = Number(result.lastInsertRowid);
  }

  const platforms = (input.platforms?.length ? input.platforms : OPS_PLATFORMS).filter(item => OPS_PLATFORM_SET.has(item));
  const ensureTask = db.prepare(`
    INSERT INTO ops_platform_tasks (episode_id, platform, state, detail, post_url, filled_title, platform_schedule, updated_at)
    VALUES (?, ?, 'planned', '', '', '', '', ?)
    ON CONFLICT(episode_id, platform) DO NOTHING
  `);
  for (const platform of platforms) {
    ensureTask.run(episodeId, platform, now);
  }

  return getOpsEpisodeWithTasks(db, episodeId);
}

export function deleteOpsEpisode(db: DatabaseSync, id: number): void {
  getOpsEpisode(db, id);
  db.prepare('DELETE FROM ops_platform_tasks WHERE episode_id=?').run(id);
  db.prepare('DELETE FROM ops_metrics WHERE episode_id=?').run(id);
  db.prepare('DELETE FROM ops_metric_samples WHERE episode_id=?').run(id);
  db.prepare('DELETE FROM ops_episodes WHERE id=?').run(id);
}

export type SetOpsTaskOptions = {
  detail?: string;
  postUrl?: string;
  filledTitle?: string;
  platformSchedule?: string;
};

/** 更新单个平台任务状态；返回状态或备注是否发生变化。保留已有的线上链接与填入标题（除非传入新值）。 */
export function setOpsPlatformTask(
  db: DatabaseSync,
  episodeId: number,
  platform: OpsPlatform,
  state: OpsTaskState,
  options: SetOpsTaskOptions = {},
  now = new Date().toISOString()
): boolean {
  if (!OPS_PLATFORM_SET.has(platform)) throw new Error(`不支持的运营平台：${platform}`);
  if (!OPS_TASK_STATES.has(state)) throw new Error(`未知的任务状态：${state}`);
  const prev = getOpsPlatformTask(db, episodeId, platform);
  const detail = options.detail !== undefined ? options.detail : prev?.detail ?? '';
  const postUrl = options.postUrl !== undefined && options.postUrl.trim() ? options.postUrl.trim() : prev?.postUrl ?? '';
  const filledTitle = options.filledTitle !== undefined && options.filledTitle.trim() ? options.filledTitle.trim() : prev?.filledTitle ?? '';
  const platformSchedule = options.platformSchedule !== undefined && options.platformSchedule.trim() ? options.platformSchedule.trim() : prev?.platformSchedule ?? '';

  db.prepare(`
    INSERT INTO ops_platform_tasks (episode_id, platform, state, detail, post_url, filled_title, platform_schedule, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(episode_id, platform) DO UPDATE SET
      state=excluded.state,
      detail=excluded.detail,
      post_url=excluded.post_url,
      filled_title=excluded.filled_title,
      platform_schedule=excluded.platform_schedule,
      updated_at=excluded.updated_at
  `).run(episodeId, platform, state, detail, postUrl, filledTitle, platformSchedule, now);

  db.prepare('UPDATE ops_episodes SET updated_at=? WHERE id=?').run(now, episodeId);
  return !prev || prev.state !== state || prev.detail !== detail || prev.postUrl !== postUrl;
}

export function appendOpsLog(
  db: DatabaseSync,
  episodeId: number | null,
  platform: OpsPlatform | '' | string,
  action: string,
  result = '',
  now = new Date().toISOString()
): void {
  db.prepare('INSERT INTO ops_logs (ts, episode_id, platform, action, result) VALUES (?, ?, ?, ?, ?)')
    .run(now, episodeId, String(platform ?? ''), action.slice(0, 120), String(result ?? '').slice(0, 2000));
}

export function listRecentOpsLogs(db: DatabaseSync, limit = 40, episodeId?: number): OpsLogEntry[] {
  const rows = (episodeId !== undefined
    ? db.prepare('SELECT * FROM ops_logs WHERE episode_id=? ORDER BY id DESC LIMIT ?').all(episodeId, limit)
    : db.prepare('SELECT * FROM ops_logs ORDER BY id DESC LIMIT ?').all(limit)) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: Number(row.id),
    ts: String(row.ts ?? ''),
    episodeId: row.episode_id != null ? Number(row.episode_id) : null,
    platform: String(row.platform ?? ''),
    action: String(row.action ?? ''),
    result: String(row.result ?? '')
  }));
}

/* ── 粉丝净增账本（实测优先 + 历史回填） ───────────────────────── */

export type FollowerHistoryItem = {
  day: string;
  total?: number | null;
  gain?: number | null;
  loss?: number | null;
  net?: number | null;
};

export type FollowerCollectPayload = {
  total: number;
  todayNet?: number | null;
  todayGain?: number | null;
  todayLoss?: number | null;
  history?: FollowerHistoryItem[];
};

/**
 * 保存当天粉丝实测值，并顺手补齐创作者后台自带的历史趋势：
 * - 当天写为 source='live'；若没有显式 todayNet，且昨天有记录，自动算出当日净增。
 * - 历史日期只补还没有 live 实测值的天；若后台只给了每日净增 net 没给每日总数，从今天总数倒推。
 */
export function saveOpsFollowers(
  db: DatabaseSync,
  platform: OpsPlatform,
  payload: FollowerCollectPayload,
  today = localDayString(),
  now = new Date().toISOString()
): number {
  const upsert = db.prepare(`
    INSERT INTO ops_followers (day, platform, total, gain, loss, net, source, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, platform) DO UPDATE SET
      total=excluded.total,
      gain=COALESCE(excluded.gain, ops_followers.gain),
      loss=COALESCE(excluded.loss, ops_followers.loss),
      net=COALESCE(excluded.net, ops_followers.net),
      source=excluded.source,
      collected_at=excluded.collected_at
  `);
  const existingSource = db.prepare('SELECT source, total FROM ops_followers WHERE day=? AND platform=?');
  const prevRow = db.prepare('SELECT day, total FROM ops_followers WHERE platform=? AND day<? ORDER BY day DESC LIMIT 1')
    .get(platform, today) as { day: string; total: number } | undefined;

  const inferredNet = payload.todayNet ?? (prevRow ? payload.total - Number(prevRow.total) : null);
  upsert.run(today, platform, Math.round(payload.total), payload.todayGain ?? null, payload.todayLoss ?? null, inferredNet, 'live', now);

  const history = [...(payload.history ?? [])]
    .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.day) && item.day < today)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

  if (history.length && history.every(item => item.total == null)) {
    let running = Math.round(payload.total) - (payload.todayNet ?? 0);
    for (const item of history) {
      item.total = running;
      running -= item.net ?? 0;
    }
  }

  let backfilled = 0;
  for (const item of history) {
    if (item.total == null || !Number.isFinite(item.total)) continue;
    const current = existingSource.get(item.day, platform) as { source: string } | undefined;
    if (current?.source === 'live') continue;
    const net = item.net ?? (item.gain != null && item.loss != null ? item.gain - item.loss : null);
    upsert.run(item.day, platform, Math.round(item.total), item.gain ?? null, item.loss ?? null, net, 'backfill', now);
    backfilled += 1;
  }
  return backfilled;
}

export function listOpsFollowers(db: DatabaseSync, platform?: OpsPlatform, limitDays = 30): OpsFollowerRecord[] {
  const rows = (platform
    ? db.prepare('SELECT * FROM ops_followers WHERE platform=? ORDER BY day DESC LIMIT ?').all(platform, limitDays)
    : db.prepare('SELECT * FROM ops_followers ORDER BY day DESC, platform ASC LIMIT ?').all(limitDays * OPS_PLATFORMS.length)) as Array<Record<string, unknown>>;
  return rows
    .filter(row => OPS_PLATFORM_SET.has(String(row.platform) as OpsPlatform))
    .map(row => ({
      day: String(row.day),
      platform: String(row.platform) as OpsPlatform,
      total: Number(row.total ?? 0),
      gain: typeof row.gain === 'number' ? row.gain : null,
      loss: typeof row.loss === 'number' ? row.loss : null,
      net: typeof row.net === 'number' ? row.net : null,
      source: row.source === 'backfill' ? 'backfill' : 'live',
      collectedAt: String(row.collected_at ?? '')
    }));
}

/* ── 作品指标采集与历史样本 ─────────────────────────────────── */

export function saveOpsMetric(
  db: DatabaseSync,
  episodeId: number,
  platform: OpsPlatform,
  metric: OpsMetricSnapshot,
  day = localDayString(),
  now = new Date().toISOString()
): void {
  const sampleTs = now.slice(0, 16);
  db.prepare(`
    INSERT OR REPLACE INTO ops_metric_samples (ts, episode_id, platform, views, likes, comments, favorites, shares)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sampleTs,
    episodeId,
    platform,
    metric.views ?? null,
    metric.likes ?? null,
    metric.comments ?? null,
    metric.favorites ?? null,
    metric.shares ?? null
  );

  db.prepare(`
    INSERT INTO ops_metrics (day, episode_id, platform, views, likes, comments, favorites, shares, extra_json, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, episode_id, platform) DO UPDATE SET
      views=COALESCE(excluded.views, ops_metrics.views),
      likes=COALESCE(excluded.likes, ops_metrics.likes),
      comments=COALESCE(excluded.comments, ops_metrics.comments),
      favorites=COALESCE(excluded.favorites, ops_metrics.favorites),
      shares=COALESCE(excluded.shares, ops_metrics.shares),
      extra_json=excluded.extra_json,
      collected_at=excluded.collected_at
  `).run(
    day,
    episodeId,
    platform,
    metric.views ?? null,
    metric.likes ?? null,
    metric.comments ?? null,
    metric.favorites ?? null,
    metric.shares ?? null,
    JSON.stringify(metric.extra ?? {}),
    now
  );
}

export function listEpisodeMetrics(db: DatabaseSync, episodeId: number): OpsMetricRecord[] {
  const rows = db.prepare('SELECT * FROM ops_metrics WHERE episode_id=? ORDER BY day ASC, platform ASC').all(episodeId) as Array<Record<string, unknown>>;
  return rows
    .filter(row => OPS_PLATFORM_SET.has(String(row.platform) as OpsPlatform))
    .map(row => {
      let extra: Record<string, number | null> = {};
      try { extra = JSON.parse(String(row.extra_json ?? '{}')) as Record<string, number | null>; } catch { /* 忽略损坏扩展字段 */ }
      return {
        day: String(row.day),
        episodeId: Number(row.episode_id),
        platform: String(row.platform) as OpsPlatform,
        views: typeof row.views === 'number' ? row.views : null,
        likes: typeof row.likes === 'number' ? row.likes : null,
        comments: typeof row.comments === 'number' ? row.comments : null,
        favorites: typeof row.favorites === 'number' ? row.favorites : null,
        shares: typeof row.shares === 'number' ? row.shares : null,
        extra,
        collectedAt: String(row.collected_at ?? '')
      };
    });
}

export function hasNotifiedMilestone(db: DatabaseSync, episodeId: number, milestoneDay: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM ops_notified_milestones WHERE episode_id=? AND milestone_day=?').get(episodeId, milestoneDay));
}

export function markMilestoneNotified(db: DatabaseSync, episodeId: number, milestoneDay: number, now = new Date().toISOString()): void {
  db.prepare('INSERT OR REPLACE INTO ops_notified_milestones (episode_id, milestone_day, notified_at) VALUES (?, ?, ?)')
    .run(episodeId, milestoneDay, now);
}
