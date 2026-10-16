export type LlmConfig = { apiKey: string; baseUrl: string; model: string };

export type ChatOptions = {
  /** 出现在报错里的服务名，例如“DeepSeek”“内容 API”。 */
  label?: string;
  /** 非流式：整个请求的超时。流式：从发出到生成结束的总时长上限（含重试）。 */
  timeoutMs?: number;
  temperature?: number;
  /** 是否要求 response_format=json_object；正文这类纯文本输出要关掉。 */
  json?: boolean;
  /**
   * 流式接收（stream: true），边生成边收。长输出用它：
   * 非流式要等整段生成完才返回，模型在高峰期出字慢时，明明一直在生成也会被总超时掐断。
   * 流式下只要模型还在出字（正文或思考过程）就不算超时，连续 idleMs 毫秒没有新内容才判定卡住。
   */
  stream?: boolean;
  /**
   * 流式下的“卡住”判定：连续这么久没有新的模型输出。默认 60 秒。
   * 只认真正的输出：服务排队时会持续发 `: keep-alive` 保活注释，那不算进展（实测 DeepSeek 过载时能这样挂好几分钟）。
   */
  idleMs?: number;
  /** 服务繁忙（HTTP 429 / 502 / 503）时的重试间隔；默认等 3 秒、8 秒各重试一次。 */
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
};

type ChatChoice = { message?: { content?: unknown }; delta?: Record<string, unknown> };

const BUSY_STATUS = new Set([429, 502, 503]);

class BusyError extends Error {}

/**
 * OpenAI 兼容的 chat/completions 调用，返回第一条回复的文本。
 * 所有模型调用都走这里：HTTP 错误详情、超时、繁忙重试与空回复的处理只有这一份。
 * 配置是否齐全由调用方先校验（不同入口的提示文案不同）。
 */
export async function requestChatContent(config: LlmConfig, system: string, user: string, options: ChatOptions = {}): Promise<string> {
  const label = options.label ?? 'DeepSeek';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const idleMs = options.idleMs ?? 60_000;
  const stream = options.stream === true;
  const delays = options.retryDelaysMs ?? [3_000, 8_000];
  const controller = new AbortController();
  let reason: 'total' | 'idle' | null = null;
  const total = setTimeout(() => { reason = 'total'; controller.abort(); }, timeoutMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const stopIdle = () => clearTimeout(idle);
  /** 有进展：重置“卡住”计时。只有流式需要。 */
  const progress = () => {
    if (!stream) return;
    stopIdle();
    idle = setTimeout(() => { reason = 'idle'; controller.abort(); }, idleMs);
  };
  const body = JSON.stringify({
    model: config.model, temperature: options.temperature ?? 0.2,
    response_format: options.json === false ? undefined : { type: 'json_object' },
    stream: stream || undefined,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  });

  const attempt = async (): Promise<string> => {
    progress();
    const response = await (options.fetchImpl ?? fetch)(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal, body,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
      let detail = '';
      try {
        const payload = await response.clone().json() as { error?: { message?: unknown } };
        detail = typeof payload.error?.message === 'string' ? payload.error.message.trim() : '';
      } catch { /* 有些网关返回的错误体不是 JSON */ }
      const message = `${label} 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`;
      throw BUSY_STATUS.has(response.status) ? new BusyError(message) : new Error(message);
    }
    if (stream && /text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
      return readEventStream(response, progress, label);
    }
    // 网关没按流式回（直接给整段 JSON）：这时等的是整段生成，只受总时长限制，不能按“卡住”掐断。
    stopIdle();
    return ((await response.json()) as { choices?: ChatChoice[] }).choices?.[0]?.message?.content as string;
  };

  try {
    for (let tries = 0; ; tries += 1) {
      try {
        const content = await attempt();
        if (typeof content !== 'string' || !content.trim()) throw new Error(`${label} 返回内容为空`);
        return content;
      } catch (error) {
        if (!(error instanceof BusyError) || tries >= delays.length || controller.signal.aborted) {
          if (error instanceof BusyError) throw new Error(`${label} 服务繁忙，已自动重试 ${tries} 次仍不可用，请过几分钟再试。${error.message}`);
          throw error;
        }
        stopIdle();
        await new Promise<void>(resolve => {
          const wait = setTimeout(resolve, delays[tries]);
          controller.signal.addEventListener('abort', () => { clearTimeout(wait); resolve(); }, { once: true });
        });
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      if (reason === 'idle') throw new Error(`${label} 连续 ${Math.round(idleMs / 1000)} 秒没有生成任何内容（服务可能在排队或繁忙），请稍后重试`);
      throw new Error(stream ? `${label} 生成超过 ${Math.round(timeoutMs / 60_000)} 分钟仍未完成，请稍后重试` : `${label} 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error instanceof Error ? error : new Error(`${label} 请求失败`);
  } finally {
    clearTimeout(total);
    stopIdle();
  }
}

/**
 * 读 SSE：每行 `data: {...}`，拼起 choices[0].delta.content；`data: [DONE]` 结束。
 * 只有模型真正吐出的内容（正文 content，或 reasoning_content 这类思考过程字段）才算进展；
 * `: keep-alive` 注释、空行、只带 role 的首包都不算。流里带 error 对象时按网关报错处理。
 */
async function readEventStream(response: Response, onProgress: () => void, label: string): Promise<string> {
  if (!response.body) throw new Error(`${label} 返回内容为空`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const handle = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return false;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return true;
    let chunk: { choices?: ChatChoice[]; error?: { message?: unknown } };
    try { chunk = JSON.parse(data); } catch { return false; }
    if (chunk.error) throw new Error(`${label} 请求失败${typeof chunk.error.message === 'string' ? `：${chunk.error.message}` : ''}`);
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.content === 'string') content += delta.content;
    if (Object.entries(delta).some(([key, value]) => key !== 'role' && typeof value === 'string' && value)) onProgress();
    return false;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (handle(line)) { await reader.cancel().catch(() => undefined); return content; }
    }
  }
  handle(buffer + decoder.decode());
  return content;
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
