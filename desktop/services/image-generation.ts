import type { ImageApiConfig } from './content-api-config.ts';

/** OpenAI 兼容的图片生成接口调用，以及生图任务的取消句柄。 */

export function imageErrorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '图片接口超时（超过 180 秒没有返回）';
    if (error.name === 'AbortError') return '已取消生成';
    // Node fetch 的网络错误只说「fetch failed」，真正原因（连不上、证书、DNS）在 cause 里。
    const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
    if (error.message === 'fetch failed' && cause) return `连不上图片接口（${cause.code || cause.message}）：检查网络或代理`;
    return error.message;
  }
  return String(error);
}

/**
 * 发请求用的 fetch。主进程启动时换成 Electron 的 net.fetch：它走系统代理，
 * 而 Node 自带的 fetch 不读系统代理——国内网络下不少图片网关只能经代理访问，直连会连接超时。
 * 测试和纯 Node 环境保持默认的 fetch。
 */
let imageFetch: typeof fetch = (...args) => fetch(...args);
export function useImageFetch(impl: typeof fetch): void {
  imageFetch = impl;
}

/**
 * gpt-image 系列只认 1024x1024 / 1536x1024 / 1024x1536，传 DALL·E 3 的 1792 尺寸会被网关拒绝或挂起；
 * 按横竖方向换成它支持的尺寸，其它模型原样传。
 */
export function imageSizeFor(model: string, size: string): string {
  if (!/^gpt-image/i.test(model)) return size;
  const [width, height] = size.split('x').map(Number);
  if (!width || !height || width === height) return '1024x1024';
  return width > height ? '1536x1024' : '1024x1536';
}

/** 网关报错时带上它给的原因（例如 Model not found），只给状态码看不出哪里错了。 */
async function apiErrorText(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } | string; message?: string };
    const detail = typeof body.error === 'string' ? body.error : body.error?.message || body.message || '';
    return detail ? `：${detail.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

/** 超时信号与「用户点了取消」的信号，谁先到就中断请求。 */
function withDeadline(timeout: AbortSignal, cancel?: AbortSignal): AbortSignal {
  return cancel ? AbortSignal.any([timeout, cancel]) : timeout;
}

/** 正文配图张数上限：再多也不会更贴合全文，只会让等待和费用线性上涨。 */
export function clampImageCount(count: unknown): number {
  return Math.min(5, Math.max(1, Math.round(Number(count) || 3)));
}

/**
 * 同一处出几张候选：AI 生图常要「多出几张挑一张」，但每张都计费，
 * 所以上限 3 张，默认 1 张＝沿用「生成即插入」的老行为。
 */
export function clampCandidateCount(count: unknown): number {
  return Math.min(3, Math.max(1, Math.round(Number(count) || 1)));
}

/** 生成一张图并返回字节；封面与正文配图共用同一套接口与错误处理。 */
export async function requestGeneratedImage(config: ImageApiConfig, prompt: string, size = '1792x1024', signal?: AbortSignal): Promise<Buffer> {
  // response_format 不是每个模型都支持（网关文档要求只在支持时传），url 与 b64_json 两种返回都能处理，所以不传。
  const response = await imageFetch(`${config.baseUrl}/images/generations`, {
    method: 'POST', signal: withDeadline(AbortSignal.timeout(180_000), signal), headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, prompt, n: 1, size: imageSizeFor(config.model, size) })
  });
  if (!response.ok) throw new Error(`图片 API 请求失败（HTTP ${response.status}）${await apiErrorText(response)}`);
  const payload = await response.json() as { data?: Array<{ url?: string; b64_json?: string }> };
  const image = payload.data?.[0];
  let bytes: Buffer | null = image?.b64_json ? Buffer.from(image.b64_json, 'base64') : null;
  if (!bytes && image?.url) {
    const download = await imageFetch(image.url, { signal: withDeadline(AbortSignal.timeout(60_000), signal) });
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
