import type { PipelineStep } from '../../services/content-pipeline';
import type { ContentStage } from '../../shared';

/** 公众号创作流水线界面用的标签与格式化工具（纯函数，无 React）。 */

export const stageLabels: Record<ContentStage, string> = { topics: '生成选题', brief: '生成任务书', claims: '生成证据计划', draft: '生成初稿', review: 'AI 审稿', revise: '按审稿意见修改' };
export const statusNames: Record<string, string> = { idea: '选题', brief: '任务书', draft: '初稿', review: '待修改', ready: '已通过', published: '已推送草稿' };
export const stateNames: Record<PipelineStep['state'], string> = { done: '已完成', current: '当前步骤', attention: '需处理', ready: '可进行', locked: '未解锁' };

export type Source = { title: string; url: string; excerpt: string; status: 'user_provided' };
export type Env = { wechatConfigured: boolean };

/** 预览正文由主进程渲染：只有它能读本地配图并转成 data URI。 */
export function wrapPreviewHtml(body: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="max-width:720px;margin:0 auto;padding:24px">${body}</body></html>`;
}
export function parseObject(value: string): Record<string, unknown> | null {
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; }
}
export function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const primary = record.title ?? record.heading ?? record.name ?? record.claim ?? record.issue ?? record.change;
    const rest = Object.entries(record).filter(([key]) => !['title', 'heading', 'name', 'claim', 'issue', 'change'].includes(key)).map(([, item]) => text(item)).filter(Boolean).join('；');
    return [primary ? text(primary) : '', rest].filter(Boolean).join(' — ');
  }
  return '';
}
export function list(value: unknown): string[] { return Array.isArray(value) ? value.map(text).filter(Boolean) : value ? [text(value)] : []; }
export function topicSuggestions(value: string): Array<{ title: string; angle: string; risk: string }> {
  const parsed = parseObject(value) as { topics?: Array<{ title?: string; angle?: string; risk_note?: string }> } | null;
  return (parsed?.topics || []).filter(item => typeof item.title === 'string').map(item => ({ title: item.title!, angle: item.angle || '', risk: item.risk_note || '' }));
}
export function readSources(value: string): Source[] {
  const data = parseObject(value || '{}') as { sources?: Array<{ title?: string; url?: string; excerpt?: string }> } | null;
  return (data?.sources || []).map(item => ({ title: item.title || '', url: item.url || '', excerpt: item.excerpt || '', status: 'user_provided' }));
}
export function countChars(value: string): number { return value.replace(/[#>*_`\-\s]/g, '').length; }
