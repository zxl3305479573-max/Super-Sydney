import type { DatabaseSync } from 'node:sqlite';
import type { EventDraft } from '../shared.ts';

const AI_COLUMNS: Array<[string, string]> = [
  ['ai_draft_json', "TEXT NOT NULL DEFAULT ''"],
  ['ai_draft_model', "TEXT NOT NULL DEFAULT ''"],
  ['ai_drafted_at', "TEXT NOT NULL DEFAULT ''"]
];
const categories = new Set(['工作项目', 'AI 工具', '提效方案', '内容资产', '个人成长']);

export function migrateAiDraftColumns(db: DatabaseSync): void {
  const existing = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, definition] of AI_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
  }
}

export function saveAiDraft(db: DatabaseSync, id: number, draft: EventDraft, model: string, draftedAt: string): void {
  db.prepare('UPDATE events SET ai_draft_json=?, ai_draft_model=?, ai_drafted_at=? WHERE id=?')
    .run(JSON.stringify(draft), model, draftedAt, id);
}

export function applyAiDraft(db: DatabaseSync, id: number): void {
  const row = db.prepare('SELECT ai_draft_json FROM events WHERE id=?').get(id) as { ai_draft_json?: string } | undefined;
  if (!row?.ai_draft_json) return;
  let draft: Partial<EventDraft>;
  try { draft = JSON.parse(row.ai_draft_json) as Partial<EventDraft>; } catch { return; }
  const summary = typeof draft.result === 'string' && draft.result.trim() ? draft.result.trim() : typeof draft.what_done === 'string' ? draft.what_done.trim() : '';
  const category = typeof draft.category === 'string' && categories.has(draft.category) ? draft.category : '';
  const entries: string[] = [];
  const values: string[] = [];
  if (summary) { entries.push('summary=?'); values.push(summary); }
  if (category) { entries.push('category=?'); values.push(category); }
  if (entries.length) db.prepare(`UPDATE events SET ${entries.join(', ')} WHERE id=?`).run(...values, id);
}

export function clearAiDraft(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE events SET ai_draft_json='', ai_draft_model='', ai_drafted_at='' WHERE id=?").run(id);
}
