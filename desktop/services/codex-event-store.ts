import type { DatabaseSync } from 'node:sqlite';
import type { CodexCapturedMessage } from './codex-session-adapter.ts';
import type { AiTurnTrace } from './ai-trace.ts';

/**
 * Codex and Claude conversations share the same columns: `codex_prompt` /
 * `codex_response` hold the prompt and final answer for any AI source (the
 * names are kept for backward compatibility), `ai_trace_json` holds tool and
 * file metadata for the turn.
 */
const AI_COLUMNS: Array<[string, string]> = [
  ['source', "TEXT NOT NULL DEFAULT 'desktop'"],
  ['source_session_id', "TEXT NOT NULL DEFAULT ''"],
  ['source_turn_id', "TEXT NOT NULL DEFAULT ''"],
  ['source_message_id', "TEXT NOT NULL DEFAULT ''"],
  ['codex_prompt', "TEXT NOT NULL DEFAULT ''"],
  ['codex_response', "TEXT NOT NULL DEFAULT ''"],
  ['ai_trace_json', "TEXT NOT NULL DEFAULT ''"]
];

export type AiSource = 'codex' | 'claude';

export type AiCapturedMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  turnId?: string;
  sessionId: string;
  cwd: string;
  trace?: AiTurnTrace;
};

const SOURCE_LABEL: Record<AiSource, { app: string; kind: string }> = {
  codex: { app: 'Codex', kind: 'codex' },
  claude: { app: 'Claude Code', kind: 'claude' }
};

export function migrateCodexEventColumns(db: DatabaseSync): void {
  const existing = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, definition] of AI_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_message ON events(source, source_message_id) WHERE source_message_id <> ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_codex_turn ON events(source, source_session_id, source_turn_id) WHERE source='codex' AND source_turn_id <> ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_ai_turn ON events(source, source_session_id, source_turn_id) WHERE source_turn_id <> ''");
}

export function persistCodexMessage(db: DatabaseSync, message: CodexCapturedMessage): number | null {
  return persistAiMessage(db, 'codex', message);
}

/**
 * Pairs prompts with final answers per (source, session, turn).
 * `allowAnswerUpdate` lets a source refine an answer it already stored
 * (Claude re-emits when late text arrives after an idle flush).
 */
export function persistAiMessage(db: DatabaseSync, source: AiSource, message: AiCapturedMessage, allowAnswerUpdate = source === 'claude'): number | null {
  const label = SOURCE_LABEL[source];
  const trace = message.trace ? JSON.stringify(message.trace) : '';
  const existingMessage = db.prepare('SELECT id FROM events WHERE source=? AND source_message_id=?').get(source, message.id) as { id: number } | undefined;
  if (existingMessage) {
    if (message.role === 'user') return existingMessage.id;
    if (!allowAnswerUpdate) return null;
    db.prepare('UPDATE events SET codex_response=?, summary=?, ai_trace_json=? WHERE id=?').run(message.text, message.text, trace, existingMessage.id);
    return existingMessage.id;
  }
  if (message.role === 'user') {
    if (message.turnId) {
      const sameTurn = db.prepare('SELECT id FROM events WHERE source=? AND source_session_id=? AND source_turn_id=?').get(source, message.sessionId, message.turnId) as { id: number } | undefined;
      if (sameTurn) return sameTurn.id;
    }
    const result = db.prepare(`INSERT INTO events
      (created_at, app_name, window_title, kind, note, duration_seconds, status, value_score, summary, category,
       source, source_session_id, source_turn_id, source_message_id, codex_prompt, codex_response)
      VALUES (?, ?, ?, ?, ?, 0, 'pending', 0, '', 'AI 工具', ?, ?, ?, ?, ?, '')`)
      .run(new Date().toISOString(), label.app, message.cwd, label.kind, message.text, source, message.sessionId, message.turnId || '', message.id, message.text);
    return Number(result.lastInsertRowid);
  }

  if (message.turnId) {
    const completed = db.prepare("SELECT id FROM events WHERE source=? AND source_session_id=? AND source_turn_id=? AND codex_response<>'' LIMIT 1").get(source, message.sessionId, message.turnId) as { id: number } | undefined;
    if (completed) {
      if (!allowAnswerUpdate) return null;
      db.prepare('UPDATE events SET codex_response=?, summary=?, ai_trace_json=? WHERE id=?').run(message.text, message.text, trace, completed.id);
      return completed.id;
    }
  }

  const pending = message.turnId
    ? db.prepare(`SELECT id FROM events
      WHERE source=? AND source_session_id=? AND source_turn_id=? AND codex_response=''
      ORDER BY id DESC LIMIT 1`).get(source, message.sessionId, message.turnId) as { id: number } | undefined
    : db.prepare(`SELECT id FROM events
      WHERE source=? AND source_session_id=? AND codex_response=''
      ORDER BY id DESC LIMIT 1`).get(source, message.sessionId) as { id: number } | undefined;
  if (!pending) {
    const result = db.prepare(`INSERT INTO events
      (created_at, app_name, window_title, kind, note, duration_seconds, status, value_score, summary, category,
       source, source_session_id, source_turn_id, source_message_id, codex_prompt, codex_response, ai_trace_json)
      VALUES (?, ?, ?, ?, '', 0, 'pending', 0, ?, 'AI 工具', ?, ?, ?, ?, '', ?, ?)`)
      .run(new Date().toISOString(), label.app, message.cwd, label.kind, message.text, source, message.sessionId, message.turnId || '', message.id, message.text, trace);
    return Number(result.lastInsertRowid);
  }
  db.prepare('UPDATE events SET codex_response=?, summary=?, ai_trace_json=? WHERE id=?').run(message.text, message.text, trace, pending.id);
  return pending.id;
}
