import type { ImageApiConfig } from './content-api-config.ts';

/** OpenAI 兼容的图片生成接口调用，以及生图任务的取消句柄。 */

export function imageErrorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '图片接口超时（超过 180 秒没有返回）';
    if (error.name === 'AbortError') return '已取消生成';
    return error.message;
  }
  return String(error);
}

/** 超时信号与「用户点了取消」的信号，谁先到就中断请求。 */
function withDeadline(timeout: AbortSignal, cancel?: AbortSignal): AbortSignal {
  return cancel ? AbortSignal.any([timeout, cancel]) : timeout;
}

/** 正文配图张数上限：再多也不会更贴合全文，只会让等待和费用线性上涨。 */
export function clampImageCount(count: unknown): number {
  return Math.min(5, Math.max(1, Math.round(Number(count) || 3)));
}

/** 生成一张图并返回字节；封面与正文配图共用同一套接口与错误处理。 */
export async function requestGeneratedImage(config: ImageApiConfig, prompt: string, size = '1792x1024', signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(`${config.baseUrl}/images/generations`, {
    method: 'POST', signal: withDeadline(AbortSignal.timeout(180_000), signal), headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt, n: 1, size, response_format: 'url' })
  });
  if (!response.ok) throw new Error(`图片 API 请求失败（HTTP ${response.status}）`);
  const payload = await response.json() as { data?: Array<{ url?: string; b64_json?: string }> };
  const image = payload.data?.[0];
  let bytes: Buffer | null = image?.b64_json ? Buffer.from(image.b64_json, 'base64') : null;
  if (!bytes && image?.url) {
    const download = await fetch(image.url, { signal: withDeadline(AbortSignal.timeout(60_000), signal) });
    if (!download.ok || !download.headers.get('content-type')?.startsWith('image/')) throw new Error('图片下载失败或返回的不是图片');
    bytes = Buffer.from(await download.arrayBuffer());
  }
  if (!bytes?.length) throw new Error('图片 API 未返回可用图片');
  return bytes;
}

/** 生图的取消句柄：按任务记，界面上「取消生成」就是把它 abort 掉。 */
export class ImageJobs {
  private readonly controllers = new Map<number, AbortController>();

  begin(id: number): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    return controller.signal;
  }

  end(id: number): void {
    this.controllers.delete(id);
  }

  /** 返回是否真的中断了某个请求。 */
  cancel(id: number): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}
