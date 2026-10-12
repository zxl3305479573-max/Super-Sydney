export type LlmConfig = { apiKey: string; baseUrl: string; model: string };

/** Minimal OpenAI-compatible JSON chat call shared by the evolution features. */
export async function requestLlmJson(
  system: string,
  payload: unknown,
  config: LlmConfig,
  options: { timeoutMs?: number; temperature?: number; fetchImpl?: typeof fetch } = {}
): Promise<Record<string, unknown>> {
  if (!config.apiKey.trim()) throw new Error('缺少 DeepSeek API key');
  if (!config.baseUrl.trim()) throw new Error('缺少 DeepSeek base URL');
  if (!config.model.trim()) throw new Error('缺少 DeepSeek 模型');
  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model, temperature: options.temperature ?? 0.2, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(payload) }]
      })
    });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.clone().json() as { error?: { message?: unknown } };
        detail = typeof body.error?.message === 'string' ? body.error.message.trim() : '';
      } catch { /* non-JSON error body */ }
      throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    }
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek 返回内容为空');
    return parseJsonObject(content);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`DeepSeek 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error instanceof Error ? error : new Error('DeepSeek 请求失败');
  } finally {
    clearTimeout(timeout);
  }
}

export function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('DeepSeek 返回的内容不是有效 JSON');
  }
}

export function text(value: unknown, max = 2_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function clip(value: string, max: number): string {
  const flat = value.replace(/\s+\n/g, '\n').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
