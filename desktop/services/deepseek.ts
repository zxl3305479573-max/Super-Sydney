import type { EventDraft } from '../shared.ts';
import { requestLlmJson, type LlmConfig } from './llm-json.ts';

export type DeepSeekConfig = LlmConfig;
export type DeepSeekInput = { prompt: string; response: string };

const categories = new Set(['工作项目', 'AI 工具', '提效方案', '内容资产', '个人成长']);
const systemPrompt = [
  '你是 Sydney 的个人工作复盘助手。',
  '根据用户提示词和最终答复生成 JSON，不要输出 Markdown 或解释。',
  'JSON 必须包含 what_done、why、tools、problems、solution、result、reuse、category、content_candidate。',
  'category 只能使用：工作项目、AI 工具、提效方案、内容资产、个人成长。',
  'content_candidate 必须是 true 或 false。未知信息使用空字符串，不要臆造敏感信息。'
].join('\n');

export async function requestEventDraft(input: DeepSeekInput, config: DeepSeekConfig, fetchImpl: typeof fetch = fetch): Promise<EventDraft> {
  return normalizeDraft(await requestLlmJson(systemPrompt, { prompt: input.prompt, response: input.response }, config, { timeoutMs: 30_000, fetchImpl }));
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function normalizeDraft(value: unknown): EventDraft {
  const source = value as Record<string, unknown>;
  const category = stringValue(source.category);
  return {
    what_done: stringValue(source.what_done), why: stringValue(source.why), tools: stringValue(source.tools),
    problems: stringValue(source.problems), solution: stringValue(source.solution), result: stringValue(source.result),
    reuse: stringValue(source.reuse), category: categories.has(category) ? category : '个人成长',
    content_candidate: source.content_candidate === true
  };
}
