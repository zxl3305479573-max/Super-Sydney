import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AiInsights, FrictionItem } from './ai-session-insights.ts';
import { clip, requestLlmJson, text, type LlmConfig } from './llm-json.ts';

/**
 * Rule-patch loop: friction found by the AI review becomes a rule candidate
 * per project; the rule text can be drafted by DeepSeek or written by hand;
 * nothing touches AGENTS.md / CLAUDE.md until the person previews and applies
 * the patch, and every applied patch can be undone while the file is unchanged.
 */

export type RuleEvidence = { eventId: number; reason: string; prompt: string; previousPrompt: string; previousResponse: string };
export type RuleStatus = 'proposed' | 'applied' | 'rejected';
export type RuleCandidate = {
  id: number;
  project: string;
  cwd: string;
  evidence: RuleEvidence[];
  ruleText: string;
  rationale: string;
  status: RuleStatus;
  applied: AppliedFile[];
  createdAt: string;
  updatedAt: string;
};
export type AppliedFile = { path: string; before: string | null; after: string };
export type RulePatchFile = AppliedFile & { exists: boolean; added: string[] };

export const RULES_START = '<!-- SYDNEY:RULES:START -->';
export const RULES_END = '<!-- SYDNEY:RULES:END -->';
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md'];
const MIN_FRICTION = 2;
const MAX_EVIDENCE = 12;

export function migrateRuleTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS rule_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL, cwd TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    rule_text TEXT NOT NULL DEFAULT '', rationale TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'proposed', applied_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_rule_candidates_cwd ON rule_candidates(cwd, status)');
}

function rowToCandidate(row: Record<string, unknown>): RuleCandidate {
  const parse = <T>(value: unknown, fallback: T): T => { try { return value ? JSON.parse(String(value)) as T : fallback; } catch { return fallback; } };
  return {
    id: Number(row.id), project: String(row.project ?? ''), cwd: String(row.cwd ?? ''),
    evidence: parse<RuleEvidence[]>(row.evidence_json, []),
    ruleText: String(row.rule_text ?? ''), rationale: String(row.rationale ?? ''),
    status: (['proposed', 'applied', 'rejected'].includes(String(row.status)) ? row.status : 'proposed') as RuleStatus,
    applied: parse<AppliedFile[]>(row.applied_json, []),
    createdAt: String(row.created_at ?? ''), updatedAt: String(row.updated_at ?? '')
  };
}

export function listRuleCandidates(db: DatabaseSync, limit = 50): RuleCandidate[] {
  return (db.prepare("SELECT * FROM rule_candidates ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'applied' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>).map(rowToCandidate);
}

export function getRuleCandidate(db: DatabaseSync, id: number): RuleCandidate {
  const row = db.prepare('SELECT * FROM rule_candidates WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('规则候选不存在');
  return rowToCandidate(row);
}

export function updateRuleCandidate(db: DatabaseSync, id: number, patch: Partial<Pick<RuleCandidate, 'ruleText' | 'rationale' | 'status' | 'applied'>>): RuleCandidate {
  const current = getRuleCandidate(db, id);
  const next = { ...current, ...patch };
  db.prepare('UPDATE rule_candidates SET rule_text=?, rationale=?, status=?, applied_json=?, updated_at=? WHERE id=?')
    .run(next.ruleText, next.rationale, next.status, next.applied.length ? JSON.stringify(next.applied) : '', new Date().toISOString(), id);
  return getRuleCandidate(db, id);
}

/** The prompt that was corrected is usually the previous turn in the same session. */
export function collectRuleEvidence(db: DatabaseSync, items: FrictionItem[]): Map<string, RuleEvidence[]> {
  const byProject = new Map<string, RuleEvidence[]>();
  for (const item of items) {
    const row = db.prepare('SELECT id, source, source_session_id, codex_prompt, note FROM events WHERE id=?').get(item.eventId) as Record<string, unknown> | undefined;
    if (!row) continue;
    const previous = row.source_session_id
      ? db.prepare("SELECT codex_prompt, note, codex_response FROM events WHERE source=? AND source_session_id=? AND id<? ORDER BY id DESC LIMIT 1")
        .get(String(row.source), String(row.source_session_id), item.eventId) as Record<string, unknown> | undefined
      : undefined;
    const evidence: RuleEvidence = {
      eventId: item.eventId,
      reason: item.reason,
      prompt: clip(String(row.codex_prompt || row.note || ''), 400),
      previousPrompt: clip(String(previous?.codex_prompt || previous?.note || ''), 400),
      previousResponse: clip(String(previous?.codex_response || ''), 600)
    };
    byProject.set(item.project, [...(byProject.get(item.project) || []), evidence]);
  }
  return byProject;
}

/** Create or extend one open candidate per project directory that crossed the friction threshold. */
export function upsertRuleCandidates(db: DatabaseSync, insights: AiInsights, evidence: Map<string, RuleEvidence[]>): RuleCandidate[] {
  const closedIds = new Set<number>();
  for (const candidate of (db.prepare("SELECT * FROM rule_candidates WHERE status<>'proposed'").all() as Array<Record<string, unknown>>).map(rowToCandidate)) {
    for (const item of candidate.evidence) closedIds.add(item.eventId);
  }
  const touched: RuleCandidate[] = [];
  const now = new Date().toISOString();
  for (const stat of insights.projects) {
    if (!stat.cwd || !path.isAbsolute(stat.cwd)) continue;
    const fresh = (evidence.get(stat.project) || []).filter(item => !closedIds.has(item.eventId));
    if (fresh.length < MIN_FRICTION) continue;
    const open = db.prepare("SELECT * FROM rule_candidates WHERE cwd=? AND status='proposed' ORDER BY id DESC LIMIT 1").get(stat.cwd) as Record<string, unknown> | undefined;
    if (open) {
      const candidate = rowToCandidate(open);
      const known = new Set(candidate.evidence.map(item => item.eventId));
      const merged = [...candidate.evidence, ...fresh.filter(item => !known.has(item.eventId))].slice(-MAX_EVIDENCE);
      db.prepare('UPDATE rule_candidates SET evidence_json=?, updated_at=? WHERE id=?').run(JSON.stringify(merged), now, candidate.id);
      touched.push(getRuleCandidate(db, candidate.id));
    } else {
      const result = db.prepare('INSERT INTO rule_candidates (project, cwd, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(stat.project, stat.cwd, JSON.stringify(fresh.slice(-MAX_EVIDENCE)), now, now);
      touched.push(getRuleCandidate(db, Number(result.lastInsertRowid)));
    }
  }
  return touched;
}

const RULE_SYSTEM = [
  '你是 AI 编程助手协作规则的编辑。输入是某个项目里用户纠正或打断 AI 的记录（含被纠正的上一轮提示词和答复摘要）。',
  '找出反复出现的根因，写成可以直接放进该项目 AGENTS.md / CLAUDE.md 的规则。',
  '要求：1-3 条；每条以“- ”开头、单独一行、不超过 80 字；具体、可执行、可检查（例如“修改 X 前先运行 Y”），不要空话；',
  '不要包含密钥、个人信息或一次性的细节；如果证据不足以形成规则，rules 返回空字符串。',
  '只输出 JSON：{"rules": "- ...\\n- ...", "rationale": "一句话说明依据"}'
].join('\n');

export async function draftRuleText(candidate: RuleCandidate, config: LlmConfig, fetchImpl?: typeof fetch): Promise<{ ruleText: string; rationale: string }> {
  if (!candidate.evidence.length) throw new Error('这个规则候选没有可用的依据');
  const result = await requestLlmJson(RULE_SYSTEM, { project: candidate.project, evidence: candidate.evidence }, config, { fetchImpl });
  const ruleText = normalizeRuleLines(text(result.rules, 1_000)).join('\n');
  if (!ruleText) throw new Error('DeepSeek 认为证据不足以形成规则，可以手动填写');
  return { ruleText, rationale: text(result.rationale, 300) };
}

export function normalizeRuleLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:[-*•]|\d+[.)、])\s*/, '').trim())
    .filter(line => line.length > 0 && !line.includes(RULES_START) && !line.includes(RULES_END))
    .map(line => `- ${line.slice(0, 300)}`);
}

export function resolveRuleTargets(cwd: string): Array<{ path: string; exists: boolean }> {
  const existing = RULE_FILES.map(name => path.join(cwd, name)).filter(file => fs.existsSync(file));
  if (existing.length) return existing.map(file => ({ path: file, exists: true }));
  return [{ path: path.join(cwd, 'AGENTS.md'), exists: false }];
}

/** Insert rule lines into the managed block of a rule file, skipping lines already present. */
export function insertRules(content: string | null, rules: string[], date: string): { after: string; added: string[] } {
  const base = content ?? '';
  const existingLines = new Set(base.split(/\r?\n/).map(line => line.replace(/（\d{4}-\d{2}-\d{2}）\s*$/, '').trim()));
  const added = rules.filter(rule => !existingLines.has(rule.trim()));
  if (!added.length) return { after: base, added };
  const stamped = added.map(rule => `${rule}（${date}）`);
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  if (base.includes(RULES_START) && base.includes(RULES_END)) {
    const endIndex = base.indexOf(RULES_END);
    const before = base.slice(0, endIndex).replace(/\s*$/, '');
    return { after: `${before}${eol}${stamped.join(eol)}${eol}${base.slice(endIndex)}`, added };
  }
  const block = [RULES_START, '## Sydney 沉淀的协作规则', '', '> 来自 Sydney「AI 协作复盘」，经人工确认后写入；可直接修改或删除。', '', ...stamped, RULES_END].join(eol);
  const after = base.trim() ? `${base.replace(/\s*$/, '')}${eol}${eol}${block}${eol}` : `${block}${eol}`;
  return { after, added };
}

export function assertProjectDirectory(cwd: string): void {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('项目目录无效');
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`项目目录不存在：${cwd}`);
}

export function previewRulePatch(candidate: RuleCandidate, date = new Date().toISOString().slice(0, 10), targets?: string[]): RulePatchFile[] {
  assertProjectDirectory(candidate.cwd);
  const rules = normalizeRuleLines(candidate.ruleText);
  if (!rules.length) throw new Error('请先填写或生成规则内容');
  const allowed = resolveRuleTargets(candidate.cwd);
  const chosen = targets?.length ? allowed.filter(item => targets.includes(item.path)) : allowed;
  if (!chosen.length) throw new Error('没有可写入的目标文件');
  return chosen.map(target => {
    const before = target.exists ? fs.readFileSync(target.path, 'utf8') : null;
    const { after, added } = insertRules(before, rules, date);
    return { path: target.path, exists: target.exists, before, after, added };
  });
}

export function applyRulePatch(patches: RulePatchFile[]): AppliedFile[] {
  const applied: AppliedFile[] = [];
  for (const patch of patches) {
    if (!patch.added.length) continue;
    const current = fs.existsSync(patch.path) ? fs.readFileSync(patch.path, 'utf8') : null;
    if (current !== patch.before) throw new Error(`${path.basename(patch.path)} 在预览后被修改过，请重新预览`);
    fs.writeFileSync(patch.path, patch.after, 'utf8');
    applied.push({ path: patch.path, before: patch.before, after: patch.after });
  }
  if (!applied.length) throw new Error('规则已经存在于目标文件中，无需写入');
  return applied;
}

/** Restore files only if they still contain exactly what Sydney wrote. */
export function undoRulePatch(applied: AppliedFile[]): { restored: string[]; skipped: string[] } {
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const item of applied) {
    const current = fs.existsSync(item.path) ? fs.readFileSync(item.path, 'utf8') : null;
    if (current !== item.after) { skipped.push(item.path); continue; }
    if (item.before === null) fs.rmSync(item.path, { force: true });
    else fs.writeFileSync(item.path, item.before, 'utf8');
    restored.push(item.path);
  }
  return { restored, skipped };
}

export function renderRuleSection(candidates: RuleCandidate[]): string {
  const statusText: Record<RuleStatus, string> = { proposed: '待确认', applied: '已写入', rejected: '已驳回' };
  if (!candidates.length) return '- 本期没有项目达到返工阈值（同一项目 ≥2 次纠正或打断）。';
  return candidates.map(candidate => {
    const rules = candidate.ruleText ? candidate.ruleText.split('\n').map(line => `  ${line}`).join('\n') : '  - （待在 Sydney「自我进化」中生成或填写）';
    return `- [${candidate.status === 'applied' ? 'x' : ' '}] **${candidate.project}**（${statusText[candidate.status]}，依据 ${candidate.evidence.length} 条）\n${rules}`;
  }).join('\n');
}
