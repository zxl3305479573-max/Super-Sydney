import fs from 'node:fs';
import path from 'node:path';
import type { WorkEvent } from '../shared.ts';
import { formatTrace } from './ai-trace.ts';
import type { AiInsights } from './ai-session-insights.ts';

const categoryFolders: Record<string, string> = {
  '工作项目': '03-进化记录',
  'AI 工具': '03-进化记录',
  '提效方案': '04-工作流',
  '内容资产': '05-内容资产',
  '个人成长': '03-进化记录'
};

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名事件';
}

function wikiLinkFor(filePath: string, vaultPath: string): string {
  const relative = path.relative(vaultPath, filePath).replace(/\\/g, '/').replace(/\.md$/i, '');
  return `[[${relative}]]`;
}

function upsertMarkedBlock(target: string, heading: string, body: string, startMarker: string, endMarker: string): void {
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : `${heading}\n`;
  const block = `${startMarker}\n${body.trim()}\n${endMarker}`;
  const content = existing.includes(startMarker) && existing.includes(endMarker)
    ? existing.replace(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`), () => block)
    : `${existing.trimEnd()}\n\n${block}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

export function writeConfirmedEvent(vaultPath: string, event: WorkEvent): string {
  const folder = categoryFolders[event.category] || '03-进化记录';
  const stamp = event.created_at.replace(/[:.]/g, '-');
  const title = safeName(event.note || event.summary || event.window_title || `${event.category}-${stamp}`);
  const target = path.join(vaultPath, folder, `${stamp.slice(0, 16)}-${title}.md`);
  const source = event.related_path
    ? `- 文件来源：${path.resolve(event.related_path).startsWith(path.resolve(vaultPath)) ? wikiLinkFor(event.related_path, vaultPath) : event.related_path}`
    : '- 来源：本地活动采集';
  const aiName = event.source === 'claude' ? 'Claude Code' : 'Codex';
  const traceLine = event.ai_trace_json ? formatTrace(event.ai_trace_json) : '';
  const codex = event.codex_prompt ? `\n## ${aiName} 提示词\n\n${event.codex_prompt}\n\n## ${aiName} 最终答复\n\n${event.codex_response || '（尚未采集到最终答复）'}\n${traceLine ? `\n> 过程元数据：${traceLine}\n` : ''}` : '';
  const draft = event.ai_draft_json ? (() => {
    try {
      const value = JSON.parse(event.ai_draft_json) as Record<string, unknown>;
      return `\n## AI 整理\n\n${Object.entries(value).map(([key, item]) => `- ${key}: ${String(item ?? '')}`).join('\n')}\n`;
    } catch { return ''; }
  })() : '';
  const content = `---
type: confirmed-event
source: sydney-desktop
event_id: ${event.id}
category: ${event.category}
confirmed_at: ${new Date().toISOString()}
---

# ${title}

## 做了什么

${event.note || event.summary || event.window_title || '未填写'}

## 结果与复用

${event.summary || '请补充这次工作的结果、问题和可复用步骤。'}

## 原始来源

- 时间：${event.created_at}
- 应用：${event.app_name || '手动记录'}
- 窗口：${event.window_title || '—'}
- 状态：${event.status}（人工确认）
${source}
${codex}${draft}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

export function writeDailySummary(vaultPath: string, rows: WorkEvent[], sourceNotes: string[] = []): string {
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(vaultPath, '02-每日总结', `${day}.md`);
  const lines = rows.map(event => `- ${event.created_at.slice(11, 16)} ${event.note || event.summary || event.window_title || '工作事件'}（${event.category}，${event.status}，${Math.round(event.duration_seconds / 60)} 分钟）`);
  const links = sourceNotes.map(item => `- ${wikiLinkFor(item, vaultPath)}`);
  const body = `## Sydney 工作记录

${lines.join('\n') || '- 今天还没有记录的工作事件。'}

## 知识库输入

${links.join('\n') || '- 暂无新增输入笔记。'}

## 内容与工作流候选

${rows.filter(item => item.value_score >= 2 || item.category === '内容资产').map(item => `- [ ] ${item.summary || item.note || item.window_title}`).join('\n') || '- [ ] 从今天最有价值的一条经验提炼一个选题。'}

## 明日重点

- [ ] 根据今天的记录补充明天最重要的任务。
`;
  upsertMarkedBlock(target, `# 每日总结 ${day}`, body, '<!-- SYDNEY:GENERATED:START -->', '<!-- SYDNEY:GENERATED:END -->');
  return target;
}

export type WeeklyReviewInput = {
  insights: AiInsights;
  /** Absolute path of the AI review note written for the same period. */
  reviewNote?: string;
  rules?: Array<{ project: string; status: string; ruleText: string }>;
};

function weeklyReviewSections(vaultPath: string, rows: WorkEvent[], review?: WeeklyReviewInput): string {
  const contentRows = rows.filter(event => {
    if (event.category === '内容资产') return true;
    try { return Boolean(event.ai_draft_json && (JSON.parse(event.ai_draft_json) as { content_candidate?: boolean }).content_candidate); } catch { return false; }
  });
  const contentIdeas = contentRows.map(event => `- [ ] ${event.summary || event.note || event.window_title}`);
  if (!review) {
    return `## 复盘与下周方向

- 重复出现的问题：待结合事件补充（点击「AI 协作复盘」后重新生成周报可自动填充）
- 可以自动化的工作：待结合事件补充
- 值得深入学习的方向：待结合事件补充
- 可制作的教程、模板或公众号选题：
${contentIdeas.join('\n') || '  - 待结合事件补充'}
`;
  }
  const { insights } = review;
  const frictionByProject = new Map<string, string[]>();
  for (const item of insights.friction) frictionByProject.set(item.project, [...(frictionByProject.get(item.project) || []), `${item.reason}「${item.prompt}」`]);
  const problems = [...frictionByProject.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5)
    .map(([project, items]) => `- **${project}** 返工 ${items.length} 次，例如 ${items.slice(0, 2).join('、')}`);
  const rules = (review.rules || []).filter(rule => rule.status !== 'rejected')
    .map(rule => `- ${rule.status === 'applied' ? '✅ 已写入' : '⏳ 待确认'} ${rule.project}：${rule.ruleText.split('\n')[0]?.replace(/^- /, '') || '规则待生成'}`);
  const automation = insights.repeats.slice(0, 5).map(item => `- [ ] 「${item.sample}」重复 ${item.count} 次 → 做成 skill / 斜杠命令 / 脚本`);
  const learning = [
    ...insights.projects.filter(stat => stat.turns >= 3 && stat.corrections + stat.interrupted > 0)
      .sort((a, b) => (b.corrections + b.interrupted) / b.turns - (a.corrections + a.interrupted) / a.turns).slice(0, 3)
      .map(stat => `- ${stat.project}：${stat.turns} 轮里返工/打断 ${stat.corrections + stat.interrupted} 次，说明这块上下文还不够熟`),
    ...insights.hotFiles.slice(0, 3).map(item => `- 热点文件 \`${item.file}\`（改动 ${item.count} 轮）值得补一份说明或测试`)
  ];
  const tutorials = [
    ...contentIdeas,
    ...insights.repeats.slice(0, 3).map(item => `- [ ] 把「${item.sample}」的做法写成教程或模板`)
  ];
  const reviewLink = review.reviewNote ? `\n> 详见 ${wikiLinkFor(review.reviewNote, vaultPath)}\n` : '';
  return `## 复盘与下周方向
${reviewLink}
### 重复出现的问题

${problems.join('\n') || '- 本周没有明显的返工。'}
${rules.length ? `\n${rules.join('\n')}\n` : ''}
### 可以自动化的工作

${automation.join('\n') || '- 本周没有重复 3 次以上的请求。'}

### 值得深入学习的方向

${learning.join('\n') || '- 本周 AI 协作顺畅，暂无明显短板。'}

### 可制作的教程、模板或公众号选题

${tutorials.join('\n') || '- [ ] 从本周最有价值的一条经验提炼一个选题。'}
`;
}

export function writeWeeklySummary(vaultPath: string, rows: WorkEvent[], review?: WeeklyReviewInput): string {
  const day = new Date();
  const weekday = day.getDay() || 7;
  const monday = new Date(day);
  monday.setDate(day.getDate() - weekday + 1);
  const start = monday.toISOString().slice(0, 10);
  const target = path.join(vaultPath, '03-进化记录', `${start}-周报.md`);
  const aiLine = review ? `\n- AI 协作：${review.insights.turns} 轮（${Object.entries(review.insights.bySource).map(([source, count]) => `${source === 'claude' ? 'Claude Code' : 'Codex'} ${count}`).join('，') || '无'}）` : '';
  const body = `## 本周完成

${rows.map(event => `- ${event.created_at.slice(0, 10)} ${event.note || event.summary || event.window_title || '工作事件'}（${event.category}）`).join('\n') || '- 本周还没有已确认事件。'}${aiLine}

${weeklyReviewSections(vaultPath, rows, review)}`;
  upsertMarkedBlock(target, `# 周报 ${start}`, body, '<!-- SYDNEY:WEEKLY:START -->', '<!-- SYDNEY:WEEKLY:END -->');
  return target;
}

export function writeWorkflowCandidate(vaultPath: string, rows: WorkEvent[]): string {
  const title = `工作流候选-${new Date().toISOString().slice(0, 10)}`;
  const target = path.join(vaultPath, '04-工作流', `${title}.md`);
  const body = `---
type: workflow-candidate
status: review
source: sydney-desktop
---

# ${title}

## 适用场景

${rows.map(item => `- ${item.category}：${item.note || item.summary || item.window_title || '工作事件'}`).join('\n') || '- 暂无已确认事件。'}

## 建议步骤

1. 触发：记录一个明确的输入或问题。
2. 整理：补充上下文、工具、结果和失败边界。
3. 验证：在下一个相似任务中复用并记录结果。
4. 沉淀：确认后将步骤改写为稳定 SOP。

## 人工确认

- [ ] 这是重复出现的问题
- [ ] 步骤可以交给 Agent 或脚本执行
- [ ] 已写明输入、输出和人工检查点
`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
  return target;
}
