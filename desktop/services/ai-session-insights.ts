import fs from 'node:fs';
import path from 'node:path';
import type { WorkEvent } from '../shared.ts';
import type { AiTurnTrace } from './ai-trace.ts';

/**
 * Turns captured Codex / Claude conversations into self-evolution signals:
 *  - repeated requests  → candidates for a skill, slash command or script
 *  - corrections / interrupts → missing context for AGENTS.md / CLAUDE.md
 *  - hot files and tool mix → where the work actually happens
 * Everything is computed locally; the note is written only on explicit request
 * and lands as an evolution candidate that still needs human review.
 */

export type AiTurn = {
  id: number;
  source: string;
  createdAt: string;
  sessionId: string;
  project: string;
  cwd: string;
  prompt: string;
  response: string;
  trace: AiTurnTrace | null;
};

export type RepeatCluster = { sample: string; count: number; sessions: number; projects: string[]; eventIds: number[] };
export type FrictionItem = { eventId: number; project: string; source: string; prompt: string; reason: string };
export type ProjectStat = { project: string; cwd: string; turns: number; answered: number; interrupted: number; corrections: number; durationMs: number; tools: Record<string, number>; files: Record<string, number> };

export type AiInsights = {
  from: string;
  to: string;
  turns: number;
  bySource: Record<string, number>;
  projects: ProjectStat[];
  repeats: RepeatCluster[];
  friction: FrictionItem[];
  commands: Array<{ command: string; count: number }>;
  hotFiles: Array<{ file: string; count: number }>;
};

const CORRECTION = /^(?:不对|不是这样|不是|错了|还是不行|还是报错|还是有问题|依然|仍然|怎么又|你没有|没有生效|没生效|重新来|重来|撤销|回滚|别这样|不要这样|no[,，\s]|wrong|that'?s not|still (?:not|failing|broken)|revert|undo)/i;
const CORRECTION_ANYWHERE = /(还是不行|又报错|还是报错|没生效|没有生效|不是我要的|理解错了|你改错了|跑不起来)/;

export function toAiTurns(events: WorkEvent[]): AiTurn[] {
  return events
    .filter(event => (event.source === 'codex' || event.source === 'claude') && event.status !== 'rejected')
    .map(event => {
      let trace: AiTurnTrace | null = null;
      try { trace = event.ai_trace_json ? JSON.parse(event.ai_trace_json) as AiTurnTrace : null; } catch { trace = null; }
      return {
        id: event.id,
        source: event.source,
        createdAt: event.created_at,
        sessionId: event.source_session_id || '',
        project: projectName(event.window_title),
        cwd: (event.window_title || '').trim(),
        prompt: (event.codex_prompt || event.note || '').trim(),
        response: (event.codex_response || '').trim(),
        trace
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function projectName(cwd: string): string {
  const trimmed = (cwd || '').replace(/[\\/]+$/, '');
  if (!trimmed) return '未知项目';
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

/** Normalise a prompt for similarity: drop paths, code, numbers and punctuation. */
export function normalizePrompt(value: string): string {
  return value
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/(?:[a-z]:)?[\\/][^\s]+/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\d+/g, '#')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 400);
}

function bigrams(value: string): Set<string> {
  const grams = new Set<string>();
  if (value.length < 2) { if (value) grams.add(value); return grams; }
  for (let index = 0; index < value.length - 1; index += 1) grams.add(value.slice(index, index + 2));
  return grams;
}

export function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function findRepeats(turns: AiTurn[], threshold = 0.45, minCount = 3): RepeatCluster[] {
  const clusters: Array<{ key: string; members: AiTurn[] }> = [];
  for (const turn of turns) {
    const key = normalizePrompt(turn.prompt);
    if (key.length < 4) continue;
    const match = clusters.find(cluster => similarity(cluster.key, key) >= threshold);
    if (match) match.members.push(turn);
    else clusters.push({ key, members: [turn] });
  }
  return clusters
    .filter(cluster => cluster.members.length >= minCount)
    .map(cluster => ({
      sample: snippet(cluster.members[cluster.members.length - 1].prompt),
      count: cluster.members.length,
      sessions: new Set(cluster.members.map(member => member.sessionId)).size,
      projects: [...new Set(cluster.members.map(member => member.project))],
      eventIds: cluster.members.map(member => member.id)
    }))
    .sort((a, b) => b.count - a.count);
}

export function detectFriction(turns: AiTurn[]): FrictionItem[] {
  const items: FrictionItem[] = [];
  for (const turn of turns) {
    if (turn.trace?.interrupted) items.push({ eventId: turn.id, project: turn.project, source: turn.source, prompt: snippet(turn.prompt), reason: '中途打断' });
    else if (CORRECTION.test(turn.prompt.trim()) || CORRECTION_ANYWHERE.test(turn.prompt)) items.push({ eventId: turn.id, project: turn.project, source: turn.source, prompt: snippet(turn.prompt), reason: '纠正 / 返工' });
  }
  return items;
}

export function buildInsights(events: WorkEvent[], from: Date, to: Date): AiInsights {
  const turns = toAiTurns(events).filter(turn => {
    const at = Date.parse(turn.createdAt);
    return at >= from.getTime() && at <= to.getTime();
  });
  const friction = detectFriction(turns);
  const frictionIds = new Set(friction.filter(item => item.reason !== '中途打断').map(item => item.eventId));
  const projects = new Map<string, ProjectStat>();
  const commands = new Map<string, number>();
  const hotFiles = new Map<string, number>();
  const bySource: Record<string, number> = {};
  for (const turn of turns) {
    bySource[turn.source] = (bySource[turn.source] || 0) + 1;
    const stat = projects.get(turn.project) ?? { project: turn.project, cwd: turn.cwd, turns: 0, answered: 0, interrupted: 0, corrections: 0, durationMs: 0, tools: {}, files: {} };
    stat.turns += 1;
    if (!stat.cwd && turn.cwd) stat.cwd = turn.cwd;
    if (turn.response) stat.answered += 1;
    if (turn.trace?.interrupted) stat.interrupted += 1;
    if (frictionIds.has(turn.id)) stat.corrections += 1;
    stat.durationMs += turn.trace?.durationMs || 0;
    for (const [tool, count] of Object.entries(turn.trace?.tools || {})) stat.tools[tool] = (stat.tools[tool] || 0) + count;
    for (const file of turn.trace?.files || []) {
      stat.files[file] = (stat.files[file] || 0) + 1;
      hotFiles.set(file, (hotFiles.get(file) || 0) + 1);
    }
    projects.set(turn.project, stat);
    const command = turn.prompt.match(/^\/[\w:-]+/)?.[0];
    if (command) commands.set(command, (commands.get(command) || 0) + 1);
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    turns: turns.length,
    bySource,
    projects: [...projects.values()].sort((a, b) => b.turns - a.turns),
    repeats: findRepeats(turns),
    friction,
    commands: [...commands.entries()].map(([command, count]) => ({ command, count })).sort((a, b) => b.count - a.count),
    hotFiles: [...hotFiles.entries()].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count).slice(0, 10)
  };
}

function snippet(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function minutes(ms: number): string {
  return ms ? `${Math.max(1, Math.round(ms / 60_000))} 分钟` : '—';
}

function topTools(tools: Record<string, number>, limit = 4): string {
  return Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => `${name}×${count}`).join('、') || '—';
}

const SOURCE_NAMES: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };

export type ReviewExtras = { rulesSection?: string; notesSection?: string };

export function renderInsightsMarkdown(insights: AiInsights, extras: ReviewExtras = {}): string {
  const day = insights.to.slice(0, 10);
  const sources = Object.entries(insights.bySource).map(([source, count]) => `${SOURCE_NAMES[source] || source} ${count} 轮`).join('，') || '无';
  const projectRows = insights.projects.map(stat =>
    `| ${stat.project} | ${stat.turns} | ${stat.answered} | ${stat.corrections} | ${stat.interrupted} | ${minutes(stat.durationMs)} | ${topTools(stat.tools)} |`);
  const repeats = insights.repeats.map(item =>
    `- [ ] **重复 ${item.count} 次**（${item.sessions} 个会话，${item.projects.join('、')}）：「${item.sample}」→ 考虑沉淀为 skill / 斜杠命令 / 脚本`);
  const frictionByProject = new Map<string, FrictionItem[]>();
  for (const item of insights.friction) frictionByProject.set(item.project, [...(frictionByProject.get(item.project) || []), item]);
  const friction = [...frictionByProject.entries()].sort((a, b) => b[1].length - a[1].length).map(([project, items]) =>
    `- **${project}**（${items.length} 次）\n${items.slice(0, 5).map(item => `  - ${item.reason}：「${item.prompt}」`).join('\n')}`);
  const rules = [...frictionByProject.entries()].filter(([, items]) => items.length >= 2).map(([project]) =>
    `- [ ] 在 **${project}** 的 AGENTS.md / CLAUDE.md 补充一条约束，避免上面的返工再次发生`);
  const commands = insights.commands.map(item => `- \`${item.command}\` × ${item.count}`);
  const hot = insights.hotFiles.map(item => `- \`${item.file}\` 被改动 ${item.count} 轮`);

  return `## 概览

- 时间范围：${insights.from.slice(0, 10)} ~ ${day}
- AI 对话：${insights.turns} 轮（${sources}）
- 纠正 / 返工信号：${insights.friction.filter(item => item.reason !== '中途打断').length} 次；中途打断：${insights.friction.filter(item => item.reason === '中途打断').length} 次

## 项目分布

| 项目 | 轮次 | 有答复 | 纠正 | 打断 | AI 用时 | 主要工具 |
| --- | --- | --- | --- | --- | --- | --- |
${projectRows.join('\n') || '| — | 0 | 0 | 0 | 0 | — | — |'}

## 重复出现的请求（可沉淀）

${repeats.join('\n') || '- 暂未发现重复 3 次以上的请求。'}

## 返工与摩擦

${friction.join('\n') || '- 暂未发现明显的纠正或打断。'}

## 建议补充的项目规则

> 在 Sydney「自我进化」里生成规则、预览补丁后再写入 AGENTS.md / CLAUDE.md，写入后可撤销。

${extras.rulesSection ?? (rules.join('\n') || '- [ ] 本期没有项目达到返工阈值，保持现有规则。')}

## 斜杠命令 / Skill 使用

${commands.join('\n') || '- 本期未使用斜杠命令。'}

## 热点文件

${hot.join('\n') || '- 暂无文件改动记录。'}
${extras.notesSection ? `\n## 知识库复用\n\n${extras.notesSection}\n` : ''}`;
}

export function writeAiReview(vaultPath: string, insights: AiInsights, extras: ReviewExtras = {}): string {
  const day = insights.to.slice(0, 10);
  const target = path.join(vaultPath, '03-进化记录', `AI协作复盘-${day}.md`);
  const start = '<!-- SYDNEY:AI-REVIEW:START -->';
  const end = '<!-- SYDNEY:AI-REVIEW:END -->';
  const block = `${start}\n${renderInsightsMarkdown(insights, extras).trim()}\n${end}`;
  const header = `---
type: evolution-candidate
status: review
source: sydney-ai-review
---

# ${day} AI 协作复盘

> 由 Sydney 根据本地采集的 Codex / Claude 对话生成，只包含提示词摘要和工具/文件元数据。勾选的建议需要人工验证后再写入正式工作流。
`;
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : `${header}\n${start}\n${end}\n\n## 人工确认\n\n- [ ] 采用\n- [ ] 驳回\n- [ ] 需要验证\n`;
  const content = existing.includes(start) && existing.includes(end)
    ? existing.replace(new RegExp(`${start}[\\s\\S]*?${end}`), () => block)
    : `${existing.trimEnd()}\n\n${block}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}
