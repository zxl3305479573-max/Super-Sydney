export type LlmConfig = { apiKey: string; baseUrl: string; model: string };

export type ChatOptions = {
  /** 出现在报错里的服务名，例如“DeepSeek”“内容 API”。 */
  label?: string;
  timeoutMs?: number;
  temperature?: number;
  /** 是否要求 response_format=json_object；正文这类纯文本输出要关掉。 */
  json?: boolean;
  fetchImpl?: typeof fetch;
};

/**
 * OpenAI 兼容的 chat/completions 调用，返回第一条回复的文本。
 * 所有模型调用都走这里：HTTP 错误详情、超时与空回复的处理只有这一份。
 * 配置是否齐全由调用方先校验（不同入口的提示文案不同）。
 */
export async function requestChatContent(config: LlmConfig, system: string, user: string, options: ChatOptions = {}): Promise<string> {
  const label = options.label ?? 'DeepSeek';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model, temperature: options.temperature ?? 0.2,
        response_format: options.json === false ? undefined : { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      })
    });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.clone().json() as { error?: { message?: unknown } };
        detail = typeof body.error?.message === 'string' ? body.error.message.trim() : '';
      } catch { /* 有些网关返回的错误体不是 JSON */ }
      throw new Error(`${label} 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    }
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(`${label} 返回内容为空`);
    return content;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error instanceof Error ? error : new Error(`${label} 请求失败`);
  } finally {
    clearTimeout(timeout);
  }
}

export function assertLlmConfig(config: LlmConfig): void {
  if (!config.apiKey.trim()) throw new Error('缺少 DeepSeek API key');
  if (!config.baseUrl.trim()) throw new Error('缺少 DeepSeek base URL');
  if (!config.model.trim()) throw new Error('缺少 DeepSeek 模型');
}

/** 发送 JSON 负载、要求 JSON 对象回复。复盘、规则、经验卡片、事件草稿共用。 */
export async function requestLlmJson(
  system: string,
  payload: unknown,
  config: LlmConfig,
  options: Omit<ChatOptions, 'json'> = {}
): Promise<Record<string, unknown>> {
  assertLlmConfig(config);
  return parseJsonObject(await requestChatContent(config, system, JSON.stringify(payload), options), options.label);
}

/** 去掉模型偶尔包的 ``` 代码块后解析成 JSON 对象。 */
export function parseJsonObject(content: string, label = 'DeepSeek'): Record<string, unknown> {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(normalized); }
  catch { throw new Error(`${label} 返回的内容不是有效 JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} 必须返回 JSON 对象`);
  return parsed as Record<string, unknown>;
}

export function text(value: unknown, max = 2_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function clip(value: string, max: number): string {
  const flat = value.replace(/\s+\n/g, '\n').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
