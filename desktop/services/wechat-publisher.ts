import path from 'node:path';

/**
 * 微信草稿箱直连实现（不经过任何外部 CLI）。
 *
 * 三个必须遵守的事实：
 * 1. 微信接口即使出错也常返回 HTTP 200，真正的错误在 body 的 errcode 里，必须显式检查。
 * 2. access_token 有配额限制，必须缓存（这里按 expires_in - 300s 提前过期）。
 * 3. token 失效（40001/42001/40014）时要强制刷新并重试一次，而不是直接把错误抛给用户。
 */

export const WECHAT_API = 'https://api.weixin.qq.com';
const TOKEN_SAFETY_WINDOW_SECONDS = 300;
const INVALID_TOKEN_CODES = new Set([40001, 40014, 42001]);

export type WeChatCredentials = { appid: string; secret: string };

export type UploadFile = { bytes: Buffer; filename: string; contentType: string };

export type DraftInput = {
  title: string;
  author: string;
  digest: string;
  html: string;
  thumbMediaId: string;
};

export class WeChatError extends Error {
  readonly errcode: number;
  constructor(errcode: number, message: string) {
    super(errcode === 0 ? message : `微信接口错误 ${errcode}：${message}`);
    this.name = 'WeChatError';
    this.errcode = errcode;
  }
}

export function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

export class WeChatClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async accessToken(credentials: WeChatCredentials, forceRefresh = false): Promise<string> {
    const { appid, secret } = credentials;
    if (!appid.trim()) throw new WeChatError(0, '缺少公众号 AppID');
    if (!secret.trim()) throw new WeChatError(0, '缺少公众号 AppSecret');
    const cached = this.tokens.get(appid);
    if (!forceRefresh && cached && this.now() < cached.expiresAt) return cached.token;

    const url = `${WECHAT_API}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
    const response = await this.fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(30_000) });
    const data = await readWeChatJson(response);
    const token = data.access_token;
    if (typeof token !== 'string' || !token) throw new WeChatError(0, '微信未返回 access_token');
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 7200;
    this.tokens.set(appid, { token, expiresAt: this.now() + Math.max(60, expiresIn - TOKEN_SAFETY_WINDOW_SECONDS) * 1000 });
    return token;
  }

  /** 上传封面为永久素材，返回 thumb_media_id。 */
  async uploadThumb(credentials: WeChatCredentials, file: UploadFile): Promise<string> {
    return this.withToken(credentials, async token => {
      const form = new FormData();
      form.append('media', new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.filename);
      const response = await this.fetchImpl(`${WECHAT_API}/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
      const data = await readWeChatJson(response);
      const mediaId = data.media_id;
      if (typeof mediaId !== 'string' || !mediaId) throw new WeChatError(0, '微信未返回封面 media_id');
      return mediaId;
    });
  }

  /**
   * 上传正文内图片，返回可直接写进文章 HTML 的微信图片地址。
   *
   * 与封面的区别：封面要 media_id，正文图片要 URL；本地路径在微信侧无法显示，
   * 推送前必须逐张换成这个地址。
   */
  async uploadArticleImage(credentials: WeChatCredentials, file: UploadFile): Promise<string> {
    return this.withToken(credentials, async token => {
      const form = new FormData();
      form.append('media', new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.filename);
      const response = await this.fetchImpl(`${WECHAT_API}/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
      const data = await readWeChatJson(response);
      const url = data.url;
      if (typeof url !== 'string' || !url) throw new WeChatError(0, '微信未返回正文图片地址');
      return url;
    });
  }

  /** 创建草稿。不会群发，只进入公众号草稿箱。 */
  async createDraft(credentials: WeChatCredentials, input: DraftInput): Promise<string> {
    return this.withToken(credentials, async token => {
      const body = {
        articles: [{
          title: input.title,
          author: input.author,
          digest: input.digest,
          content: input.html,
          show_cover_pic: 0,
          thumb_media_id: input.thumbMediaId
        }]
      };
      const response = await this.fetchImpl(`${WECHAT_API}/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        // 必须保留中文原文：转成 \uXXXX 后微信会把转义序列当成正文存储。
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body)
      });
      const data = await readWeChatJson(response);
      const mediaId = data.media_id;
      if (typeof mediaId !== 'string' || !mediaId) throw new WeChatError(0, '微信未返回草稿 media_id');
      return mediaId;
    });
  }

  private async withToken<T>(credentials: WeChatCredentials, run: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(credentials);
    try {
      return await run(token);
    } catch (error) {
      // token 失效是常见瞬时错误：刷新后重试一次，而不是让用户重试整个流程。
      if (!(error instanceof WeChatError) || !INVALID_TOKEN_CODES.has(error.errcode)) throw error;
      const refreshed = await this.accessToken(credentials, true);
      return run(refreshed);
    }
  }
}

async function readWeChatJson(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WeChatError(0, `微信接口返回非 JSON 响应（HTTP ${response.status}）`);
  }
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (!response.ok) throw new WeChatError(0, `微信接口 HTTP ${response.status}`);
  const errcode = typeof data.errcode === 'number' ? data.errcode : 0;
  if (errcode !== 0) throw new WeChatError(errcode, typeof data.errmsg === 'string' ? data.errmsg : '未知错误');
  return data;
}
