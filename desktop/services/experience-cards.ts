import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkEvent } from '../shared.ts';
import { clip, requestLlmJson, text, type LlmConfig } from './llm-json.ts';

/**
 * Experience cards: confirmed Codex / Claude turns are distilled into
 * "pitfall → solution" cards grouped by topic under 04-工作流/经验卡片.
 * Only events the person approved are sent, each event is distilled once,
 * and every card is written as `status: review`.
 */

export type ExperienceCard = {
  topic: string;
  title: string;
  pitfall: string;
  solution: string;
  steps: string[];
  appliesWhen: string;
  eventIds: number[];
};

export const CARD_DIR = path.join('04-工作流', '经验卡片');
const INDEX_START = '<!-- SYDNEY:CARDS:START -->';
const INDEX_END = '<!-- SYDNEY:CARDS:END -->';

export function migrateCardColumns(db: DatabaseSync): void {
  const columns = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(column => column.name));
  if (!columns.has('card_extracted_at')) db.exec("ALTER TABLE events ADD COLUMN card_extracted_at TEXT NOT NULL DEFAULT ''");
}

export function selectCardEvents(db: DatabaseSync, days: number, limit = 20): WorkEvent[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`SELECT * FROM events
    WHERE source IN ('codex','claude') AND status='approved' AND card_extracted_at='' AND codex_response<>'' AND created_at >= ?
    ORDER BY created_at LIMIT ?`).all(since, limit) as WorkEvent[];
}

export function markCardEvents(db: DatabaseSync, ids: number[], at = new Date().toISOString()): void {
  const statement = db.prepare('UPDATE events SET card_extracted_at=? WHERE id=?');
  for (const id of ids) statement.run(at, id);
}

export function buildCardInput(events: WorkEvent[]): Array<Record<string, unknown>> {
  return events.map(event => ({
    id: event.id,
    tool: event.source === 'claude' ? 'Claude Code' : 'Codex',
    project: (event.window_title || '').split(/[\\/]/).filter(Boolean).pop() || '',
    prompt: clip(event.codex_prompt || event.note || '', 500),
    answer: clip(event.codex_response || '', 900),
    note: clip(event.summary && event.summary !== event.codex_response ? event.summary : '', 300)
  }));
}

const CARD_SYSTEM = [
  '你是个人知识库的经验整理助手。输入是用户已确认的 AI 编程/写作对话（提示词 + 最终答复摘要）。',
  '只提炼“遇到的坑 → 怎么解决”这类以后能复用的经验；闲聊、一次性查询、没有结论的对话直接跳过。',
  '相同问题合并成一张卡片。topic 用 2-6 个字的中文主题（如“Electron 打包”“公众号排版”），同一主题保持同名。',
  'title 不超过 20 字；pitfall 和 solution 各不超过 120 字；steps 最多 5 步；applies_when 说明什么时候该想起这张卡片。',
  'event_ids 必须来自输入的 id。不要写入密钥、账号、个人隐私。',
  '只输出 JSON：{"cards":[{"topic":"","title":"","pitfall":"","solution":"","steps":[""],"applies_when":"","event_ids":[1]}]}'
].join('\n');

export function normalizeCards(value: Record<string, unknown>, validIds: Set<number>): ExperienceCard[] {
  const raw = Array.isArray(value.cards) ? value.cards : [];
  const cards: ExperienceCard[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const card = item as Record<string, unknown>;
    const title = safeSegment(text(card.title, 40));
    const topic = safeSegment(text(card.topic, 20)) || '未分类';
    const pitfall = text(card.pitfall, 400);
    const solution = text(card.solution, 400);
    if (!title || (!pitfall && !solution)) continue;
    const eventIds = (Array.isArray(card.event_ids) ? card.event_ids : []).map(Number).filter(id => validIds.has(id));
    if (!eventIds.length) continue;
    const steps = (Array.isArray(card.steps) ? card.steps : []).map(step => text(step, 200)).filter(Boolean).slice(0, 5);
    cards.push({ topic, title, pitfall, solution, steps, appliesWhen: text(card.applies_when, 200), eventIds });
  }
  return cards;
}

export async function requestExperienceCards(events: WorkEvent[], config: LlmConfig, fetchImpl?: typeof fetch): Promise<ExperienceCard[]> {
  if (!events.length) return [];
  const result = await requestLlmJson(CARD_SYSTEM, { conversations: buildCardInput(events) }, config, { timeoutMs: 90_000, fetchImpl });
  return normalizeCards(result, new Set(events.map(event => event.id)));
}

export function safeSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 40);
}

export function cardPath(vaultPath: string, card: ExperienceCard): string {
  return path.join(vaultPath, CARD_DIR, card.topic, `${card.title}.md`);
}

function renderCard(card: ExperienceCard, date: string, sources: string[]): string {
  return `---
type: experience-card
status: review
topic: ${JSON.stringify(card.topic)}
source: sydney-experience-cards
source_events: [${card.eventIds.join(', ')}]
created: ${date}
---

# ${card.title}

## 什么时候想起它

${card.appliesWhen || '（待补充）'}

## 坑

${card.pitfall || '（待补充）'}

## 解法

${card.solution || '（待补充）'}
${card.steps.length ? `\n## 步骤\n\n${card.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n` : ''}
## 出现记录

- ${date}：${sources.join('；')}

## 人工确认

- [ ] 已验证可复用
- [ ] 需要合并到正式 SOP
`;
}

/** Write new cards; an existing card with the same topic/title only gets a new occurrence line. */
export function writeExperienceCards(vaultPath: string, cards: ExperienceCard[], events: WorkEvent[], date = new Date().toISOString().slice(0, 10)): { created: string[]; updated: string[] } {
  const created: string[] = [];
  const updated: string[] = [];
  const byId = new Map(events.map(event => [event.id, event]));
  for (const card of cards) {
    const target = cardPath(vaultPath, card);
    const sources = card.eventIds.map(id => {
      const event = byId.get(id);
      const tool = event?.source === 'claude' ? 'Claude' : 'Codex';
      return `${tool} 事件 #${id}${event ? `「${clip((event.codex_prompt || event.note || '').replace(/\s+/g, ' '), 40)}」` : ''}`;
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const content = fs.readFileSync(target, 'utf8');
      const line = `- ${date}：${sources.join('；')}`;
      if (content.includes(line)) continue;
      const next = content.includes('## 出现记录')
        ? content.replace(/(## 出现记录\s*\n(?:\s*\n)?(?:- .*\n)*)/, match => `${match.replace(/\n*$/, '\n')}${line}\n`)
        : `${content.trimEnd()}\n\n## 出现记录\n\n${line}\n`;
      fs.writeFileSync(target, next, 'utf8');
      updated.push(target);
    } else {
      fs.writeFileSync(target, renderCard(card, date, sources), 'utf8');
      created.push(target);
    }
  }
  writeCardIndex(vaultPath);
  return { created, updated };
}

export function writeCardIndex(vaultPath: string): string {
  const root = path.join(vaultPath, CARD_DIR);
  const target = path.join(root, '索引.md');
  const topics: Array<{ topic: string; cards: string[] }> = [];
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      const cards = fs.readdirSync(path.join(root, entry.name)).filter(name => name.endsWith('.md')).sort((a, b) => a.localeCompare(b, 'zh-CN'));
      if (cards.length) topics.push({ topic: entry.name, cards });
    }
  }
  const relRoot = CARD_DIR.replace(/\\/g, '/');
  const body = topics.map(item => `## ${item.topic}（${item.cards.length}）\n\n${item.cards.map(card => `- [[${relRoot}/${item.topic}/${card.replace(/\.md$/, '')}|${card.replace(/\.md$/, '')}]]`).join('\n')}`).join('\n\n') || '暂无经验卡片。';
  const block = `${INDEX_START}\n${body}\n${INDEX_END}`;
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : `---\ntype: index\nsource: sydney-experience-cards\n---\n\n# 经验卡片索引\n\n${INDEX_START}\n${INDEX_END}\n`;
  const content = existing.includes(INDEX_START) && existing.includes(INDEX_END)
    ? existing.replace(new RegExp(`${INDEX_START}[\\s\\S]*?${INDEX_END}`), () => block)
    : `${existing.trimEnd()}\n\n${block}\n`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}
