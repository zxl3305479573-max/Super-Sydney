import fs from 'node:fs';
import path from 'node:path';
import type { AiTurn } from './ai-session-insights.ts';

/**
 * Knowledge reuse: which vault notes Codex / Claude actually read or edited.
 * Only paths recorded in the turn trace are used; note contents are never read
 * here (the vault walk only looks at file names and modification times).
 */

export type NoteUse = { note: string; reads: number; edits: number; lastAt: string };
export type StaleNote = { note: string; modifiedAt: string };
export type NoteUsage = { used: NoteUse[]; stale: StaleNote[]; totalNotes: number; windowDays: number };

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '00-系统', '02-每日总结']);

function isWindowsLike(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.includes('\\');
}

function key(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindowsLike(value) ? slashed.toLowerCase() : slashed;
}

/** Resolve a traced path against the turn's cwd and return its vault-relative form, or null. */
export function vaultRelative(file: string, cwd: string, vaultPath: string): string | null {
  if (!file || !vaultPath) return null;
  const windows = isWindowsLike(vaultPath) || isWindowsLike(file) || isWindowsLike(cwd);
  const lib = windows ? path.win32 : path.posix;
  const absolute = lib.isAbsolute(file) ? lib.normalize(file) : cwd ? lib.resolve(cwd, file) : '';
  if (!absolute) return null;
  const root = key(lib.normalize(vaultPath));
  const target = key(absolute);
  if (!target.startsWith(`${root}/`)) return null;
  const relative = absolute.replace(/\\/g, '/').slice(root.length + 1);
  return /\.md$/i.test(relative) ? relative : null;
}

export function computeNoteUse(turns: AiTurn[], vaultPath: string): NoteUse[] {
  const uses = new Map<string, NoteUse>();
  const bump = (file: string, turn: AiTurn, field: 'reads' | 'edits') => {
    const note = vaultRelative(file, turn.cwd, vaultPath);
    if (!note) return;
    const id = key(note);
    const entry = uses.get(id) ?? { note, reads: 0, edits: 0, lastAt: turn.createdAt };
    entry[field] += 1;
    if (turn.createdAt > entry.lastAt) entry.lastAt = turn.createdAt;
    uses.set(id, entry);
  };
  for (const turn of turns) {
    for (const file of turn.trace?.reads || []) bump(file, turn, 'reads');
    for (const file of turn.trace?.files || []) bump(file, turn, 'edits');
  }
  return [...uses.values()].sort((a, b) => (b.reads + b.edits) - (a.reads + a.edits) || b.lastAt.localeCompare(a.lastAt));
}

export function listVaultNotes(vaultPath: string, limit = 20_000): Array<{ note: string; mtimeMs: number }> {
  const notes: Array<{ note: string; mtimeMs: number }> = [];
  if (!vaultPath || !fs.existsSync(vaultPath)) return notes;
  const walk = (directory: string, relative: string) => {
    if (notes.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(directory, entry.name), rel); }
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        try { notes.push({ note: rel, mtimeMs: fs.statSync(path.join(directory, entry.name)).mtimeMs }); } catch { /* vanished */ }
      }
    }
  };
  walk(vaultPath, '');
  return notes;
}

/** Notes that no AI turn touched in the window and that the person hasn't edited for `staleDays`. */
export function findStaleNotes(notes: Array<{ note: string; mtimeMs: number }>, used: NoteUse[], now: number, staleDays = 60, limit = 15): StaleNote[] {
  const usedKeys = new Set(used.map(item => key(item.note)));
  const cutoff = now - staleDays * 24 * 60 * 60 * 1000;
  return notes
    .filter(item => item.mtimeMs < cutoff && !usedKeys.has(key(item.note)) && !/^03-进化记录\/(?:AI协作复盘|.*周报)/.test(item.note))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, limit)
    .map(item => ({ note: item.note, modifiedAt: new Date(item.mtimeMs).toISOString() }));
}

export function buildNoteUsage(turns: AiTurn[], vaultPath: string, windowDays: number, now = Date.now()): NoteUsage {
  const used = computeNoteUse(turns, vaultPath);
  const notes = listVaultNotes(vaultPath);
  return { used, stale: findStaleNotes(notes, used, now), totalNotes: notes.length, windowDays };
}

function link(note: string): string {
  return `[[${note.replace(/\.md$/i, '')}]]`;
}

export function renderNoteUsage(usage: NoteUsage): string {
  const used = usage.used.slice(0, 15).map(item => `- ${link(item.note)} · 读取 ${item.reads} 次${item.edits ? ` · 修改 ${item.edits} 次` : ''} · 最近 ${item.lastAt.slice(0, 10)}`);
  const stale = usage.stale.map(item => `- [ ] ${link(item.note)}（最后修改 ${item.modifiedAt.slice(0, 10)}）→ 归档 / 合并 / 补链接`);
  const coverage = usage.totalNotes ? Math.round((usage.used.length / usage.totalNotes) * 100) : 0;
  return `近 ${usage.windowDays} 天 AI 用到了 ${usage.used.length} / ${usage.totalNotes} 篇笔记（${coverage}%）。

### 高频复用

${used.join('\n') || '- 还没有记录到 AI 读取知识库笔记。让 Codex / Claude 在知识库目录或引用笔记路径工作后，这里会出现数据。'}

### 长期未用（候选归档）

${stale.join('\n') || '- 没有超过 60 天未修改且未被 AI 使用的笔记。'}`;
}
