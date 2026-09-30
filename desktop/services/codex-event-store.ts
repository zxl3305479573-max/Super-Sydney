import type { DatabaseSync } from 'node:sqlite';
import type { CodexCapturedMessage } from './codex-session-adapter.ts';

const CODEX_COLUMNS: Array<[string, string]> = [
  ['source', "TEXT NOT NULL DEFAULT 'desktop'"],
  ['source_session_id', "TEXT NOT NULL DEFAULT ''"],
  ['source_message_id', "TEXT NOT NULL DEFAULT ''"],
  ['codex_prompt', "TEXT NOT NULL DEFAULT ''"],
  ['codex_response', "TEXT NOT NULL DEFAULT ''"]
];

export function migrateCodexEventColumns(db: DatabaseSync): void {
  const existing = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, definition] of CODEX_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_message ON events(source, source_message_id) WHERE source_message_id <> ''");
}

export function persistCodexMessage(db: DatabaseSync, message: CodexCapturedMessage): number | null {
  if (message.role === 'user') {
    const existing = db.prepare("SELECT id FROM events WHERE source='codex' AND source_message_id=?").get(message.id) as { id: number } | undefined;
    if (existing) return existing.id;
    const result = db.prepare(`INSERT INTO events
      (created_at, app_name, window_title, kind, note, duration_seconds, status, value_score, summary, category,
       source, source_session_id, source_message_id, codex_prompt, codex_response)
      VALUES (?, 'Codex', ?, 'codex', ?, 0, 'pending', 0, '', 'AI 工具', 'codex', ?, ?, ?, '')`)
      .run(new Date().toISOString(), message.cwd, message.text, message.sessionId, message.id, message.text);
    return Number(result.lastInsertRowid);
  }

  const pending = db.prepare(`SELECT id FROM events
    WHERE source='codex' AND source_session_id=? AND codex_response=''
    ORDER BY id DESC LIMIT 1`).get(message.sessionId) as { id: number } | undefined;
  if (!pending) return null;
  db.prepare('UPDATE events SET codex_response=?, summary=? WHERE id=?').run(message.text, message.text, pending.id);
  return pending.id;
}
