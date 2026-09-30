import type { EventDraft } from '../shared.ts';

export type DeepSeekConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type DeepSeekInput = {
  prompt: string;
  response: string;
};

const categories = new Set(['工作项目', 'AI 工具', '提效方案', '内容资产', '个人成长']);
const systemPrompt = [
  '你是 Sydney 的个人工作复盘助手。',
  '根据用户提示词和最终答复生成 JSON，不要输出 Markdown 或解释。',
  'JSON 必须包含 what_done、why、tools、problems、solution、result、reuse、category、content_candidate。',
  'category 只能使用：工作项目、AI 工具、提效方案、内容资产、个人成长。',
  'content_candidate 必须是 true 或 false。未知信息使用空字符串，不要臆造敏感信息。'
].join('\n');

export async function requestEventDraft(
  input: DeepSeekInput,
  config: DeepSeekConfig,
  fetchImpl: typeof fetch = fetch
): Promise<EventDraft> {
  if (!config.apiKey.trim()) throw new Error('缺少 DeepSeek API key');
  if (!config.baseUrl.trim()) throw new Error('缺少 DeepSeek base URL');
  if (!config.model.trim()) throw new Error('缺少 DeepSeek 模型');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify({ prompt: input.prompt, response: input.response }) }
        ]
      })
    });
    if (!response.ok) throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek 返回内容为空');
    return normalizeDraft(parseJsonContent(content));
  } catch (error) {
    if (controller.signal.aborted) throw new Error('DeepSeek 请求超时（30 秒）');
    if (error instanceof Error) throw error;
    throw new Error('DeepSeek 请求失败');
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonContent(content: string): unknown {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('DeepSeek 返回不是 JSON 对象');
    return parsed;
  } catch {
    throw new Error('DeepSeek 返回的内容不是有效 JSON');
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDraft(value: unknown): EventDraft {
  const source = value as Record<string, unknown>;
  const category = stringValue(source.category);
  return {
    what_done: stringValue(source.what_done),
    why: stringValue(source.why),
    tools: stringValue(source.tools),
    problems: stringValue(source.problems),
    solution: stringValue(source.solution),
    result: stringValue(source.result),
    reuse: stringValue(source.reuse),
    category: categories.has(category) ? category : '个人成长',
    content_candidate: source.content_candidate === true
  };
}
