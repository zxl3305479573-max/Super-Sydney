import fs from 'node:fs';
import path from 'node:path';
import { WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import type { AppContext } from '../app-context';
import type {
  SiteViewBounds,
  VideoPublishItemStatus,
  VideoPublishMode,
  VideoPublishPlatform,
  VideoPublisherViewState
} from '../shared';
import { openUrl } from './browser';
import { keepLoginAcrossRestarts } from './session-cookies';
import { clampSiteBounds } from './site-config';

type VideoPublisherConfig = {
  platform: VideoPublishPlatform;
  label: string;
  partition: string;
  home: string;
  creator: string;
  upload: string;
  hosts: string[];
  titleSelectors: string[];
  bodySelectors: string[];
  fileSelectors: string[];
  prepareUploadScript?: string;
  publishLabels: string[];
  confirmLabels: string[];
};

export const VIDEO_PUBLISHER_CONFIGS: Record<VideoPublishPlatform, VideoPublisherConfig> = {
  douyin: {
    platform: 'douyin',
    label: '抖音',
    // 沿用上一版抖音发布窗口的分区，升级后不用重新扫码。
    partition: 'persist:sydney-douyin',
    home: 'https://www.douyin.com/',
    creator: 'https://creator.douyin.com/',
    upload: 'https://creator.douyin.com/creator-micro/content/upload',
    hosts: ['douyin.com', 'douyincdn.com', 'byteimg.com'],
    titleSelectors: ['input[placeholder*="作品标题"]', 'input[placeholder*="标题"]'],
    bodySelectors: ['[contenteditable="true"]', 'textarea[placeholder*="描述"]', 'textarea'],
    fileSelectors: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]', 'input[type="file"]'],
    publishLabels: ['发布', '立即发布'],
    confirmLabels: ['确认发布', '确定发布']
  },
  shipinhao: {
    platform: 'shipinhao',
    label: '微信视频号',
    partition: 'persist:sydney-video-publish-shipinhao',
    home: 'https://channels.weixin.qq.com/',
    creator: 'https://channels.weixin.qq.com/platform',
    upload: 'https://channels.weixin.qq.com/platform/post/create',
    hosts: ['weixin.qq.com', 'wechat.com', 'qpic.cn'],
    titleSelectors: ['input[placeholder*="标题"]', 'input[placeholder*="作品名称"]'],
    bodySelectors: ['textarea[placeholder*="描述"]', '[contenteditable="true"]', 'textarea'],
    fileSelectors: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]', 'input[type="file"]'],
    prepareUploadScript: clickVisibleTextScript(['上传视频']),
    publishLabels: ['发表', '发布', '立即发表'],
    confirmLabels: ['确认发表', '确认发布', '确定发表']
  },
  xiaohongshu: {
    platform: 'xiaohongshu',
    label: '小红书',
    partition: 'persist:sydney-video-publish-xiaohongshu',
    home: 'https://www.xiaohongshu.com/explore',
    creator: 'https://creator.xiaohongshu.com/',
    upload: 'https://creator.xiaohongshu.com/publish/publish?source=official',
    hosts: ['xiaohongshu.com'],
    titleSelectors: ['input[placeholder*="填写标题"]', 'input[placeholder*="标题"]'],
    bodySelectors: ['.tiptap.ProseMirror[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', '[contenteditable="true"]', 'textarea'],
    fileSelectors: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]', 'input[type="file"]'],
    prepareUploadScript: clickVisibleTextScript(['上传视频']),
    publishLabels: ['发布', '立即发布'],
    confirmLabels: ['确认发布', '确定发布']
  },
  bilibili: {
    platform: 'bilibili',
    label: 'B 站',
    partition: 'persist:sydney-video-publish-bilibili',
    home: 'https://www.bilibili.com/',
    creator: 'https://member.bilibili.com/platform/home',
    upload: 'https://member.bilibili.com/platform/upload/video/frame',
    hosts: ['bilibili.com', 'bilivideo.com', 'hdslb.com'],
    titleSelectors: ['input[placeholder*="标题"]', '.video-title input', 'input.input-val'],
    bodySelectors: ['textarea[placeholder*="简介"]', 'textarea[placeholder*="描述"]', '.ql-editor[contenteditable="true"]', '[contenteditable="true"]', 'textarea'],
    fileSelectors: ['input[type="file"][accept*="video"]', 'input[type="file"][accept*=".mp4"]', 'input[type="file"]'],
    publishLabels: ['立即投稿', '投稿', '发布'],
    confirmLabels: ['确认投稿', '确定投稿', '确认发布']
  }
};

const PAGE_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 240_000;
const PUBLISH_BUTTON_TIMEOUT_MS = 180_000;
const PUBLISH_RESULT_TIMEOUT_MS = 75_000;

type PlatformView = {
  view: WebContentsView;
  loading: boolean;
  error: string;
  started: boolean;
};

export type VideoPublisherPageResult = {
  status: Extract<VideoPublishItemStatus, 'draft' | 'published' | 'needs-review'>;
  title: string;
  bodyChars: number;
  videoPath: string;
  url: string;
  message: string;
};

/**
 * 多平台成片发布窗口。
 *
 * 每个平台有自己的持久化分区和 WebContentsView，登录与浏览位置互不影响。
 * 一次发布任务按平台顺序切换窗口，避免多个网页同时抢占焦点。所有操作都走创作者中心
 * 已渲染的页面控件；不读取账号密码，也不调用站点内部接口。
 */
export class VideoPublisherView {
  private views = new Map<VideoPublishPlatform, PlatformView>();
  private currentPlatform: VideoPublishPlatform = 'douyin';
  private bounds: SiteViewBounds | null = null;
  private wanted = false;
  private attachedPlatform: VideoPublishPlatform | null = null;

  constructor(private readonly ctx: AppContext) {}

  state(platform: unknown = this.currentPlatform): VideoPublisherViewState {
    const key = requirePlatform(platform);
    const current = this.views.get(key);
    const contents = this.liveContents(key);
    return {
      platform: key,
      url: contents?.getURL() ?? '',
      title: contents?.getTitle() ?? '',
      loading: Boolean(current?.loading),
      canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
      visible: this.wanted && this.currentPlatform === key && this.attachedPlatform === key,
      error: current?.error ?? ''
    };
  }

  show(platform: unknown): VideoPublisherViewState {
    const key = requirePlatform(platform);
    this.currentPlatform = key;
    this.wanted = true;
    this.sync();
    return this.state(key);
  }

  close(): void {
    this.wanted = false;
    this.sync();
  }

  setBounds(input: unknown): void {
    const win = this.liveWindow();
    if (!win) this.bounds = null;
    else {
      const [width, height] = win.getContentSize();
      this.bounds = clampSiteBounds(input, { width, height });
    }
    this.sync();
  }

  navigate(platform: unknown, target: { kind?: unknown; value?: unknown }): VideoPublisherViewState {
    const key = this.requireCurrent(platform);
    const config = VIDEO_PUBLISHER_CONFIGS[key];
    let url = config.home;
    if (target.kind === 'creator') url = config.creator;
    else if (target.kind === 'upload') url = config.upload;
    else if (target.kind === 'url') {
      url = String(target.value ?? '').trim();
      if (!isPublisherUrl(config, url)) throw new Error(`只能在${config.label}窗口里打开该平台的页面`);
    }
    const current = this.ensureView(key);
    current.error = '';
    void this.load(current, url);
    return this.state(key);
  }

  go(platform: unknown, action: 'back' | 'reload'): VideoPublisherViewState {
    const key = this.requireCurrent(platform);
    const contents = this.liveContents(key);
    if (contents) {
      if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      if (action === 'reload') contents.reload();
    }
    return this.state(key);
  }

  openExternal(platform: unknown): void {
    const key = this.requireCurrent(platform);
    const target = this.liveContents(key)?.getURL() || VIDEO_PUBLISHER_CONFIGS[key].creator;
    void openUrl(target);
  }

  /**
   * 上传成片并填入平台发布页。mode=publish 时会等待按钮可用并点击，
   * 随后读取页面成功 / 失败提示；没有明确成功时返回 needs-review，留给用户检查。
   */
  async fillAndPublish(
    platform: unknown,
    input: { title: string; body: string; videoPath: string },
    mode: VideoPublishMode,
    report: (status: Extract<VideoPublishItemStatus, 'uploading' | 'filling' | 'publishing'>, message: string) => void
  ): Promise<VideoPublisherPageResult> {
    const key = requirePlatform(platform);
    const config = VIDEO_PUBLISHER_CONFIGS[key];
    const videoPath = path.resolve(input.videoPath);
    if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) throw new Error('成片文件不存在，请先重新渲染视频');

    this.currentPlatform = key;
    this.wanted = true;
    this.sync();
    const current = this.ensureView(key);
    const contents = current.view.webContents;
    current.error = '';
    current.started = true;

    report('uploading', `正在打开${config.label}发布页…`);
    try {
      await contents.loadURL(config.upload);
    } catch (error) {
      if (!isAborted(error)) throw error;
    }
    this.assertCurrent(key);
    await wait(600);
    if (config.prepareUploadScript) {
      try { await contents.executeJavaScript(config.prepareUploadScript, true); } catch { /* 页面可能已经在上传视频 tab */ }
      await wait(500);
    }
    await this.waitForScript(contents, UPLOAD_READY_SCRIPT, PAGE_TIMEOUT_MS,
      `${config.label}上传页没有出现视频上传控件，请先在窗口里完成登录`);
    report('uploading', `已选择成片，正在上传到${config.label}…`);
    await this.setFileInput(contents, videoPath, config.fileSelectors);
    await this.waitForScript(contents, formReadyScript(config), UPLOAD_TIMEOUT_MS,
      `${config.label}没有在视频上传后出现标题和描述编辑区，请检查视频是否上传成功`);
    this.assertCurrent(key);

    report('filling', `正在填写${config.label}标题和描述…`);
    if (!await contents.executeJavaScript(focusFieldScript(config, 'title'), true)) throw new Error(`没有找到${config.label}标题输入框`);
    await contents.insertText(input.title);
    if (input.body.trim()) {
      if (!await contents.executeJavaScript(focusFieldScript(config, 'body'), true)) throw new Error(`没有找到${config.label}描述编辑区`);
      await contents.insertText(input.body);
    }
    await wait(700);
    const filled = await contents.executeJavaScript(readFieldsScript(config), true) as {
      ok?: boolean;
      title?: string;
      bodyChars?: number;
    };
    if (!filled?.ok || !filled.title?.trim()) throw new Error(`${config.label}发布页没有接受填入的标题`);
    if (input.body.trim() && !Number(filled.bodyChars)) throw new Error(`${config.label}发布页没有接受填入的描述`);

    if (mode === 'draft') {
      // 给页面自己的自动草稿一点落盘时间；这里不会点击发布。
      await wait(1800);
      this.assertCurrent(key);
      return {
        status: 'draft',
        title: filled.title.trim(),
        bodyChars: Number(filled.bodyChars ?? 0),
        videoPath,
        url: contents.getURL(),
        message: `已上传并填入${config.label}草稿`
      };
    }

    report('publishing', `正在等待${config.label}发布按钮可用…`);
    await this.executeAgreementScript(contents);
    await this.waitForPublishButton(contents, config, PUBLISH_BUTTON_TIMEOUT_MS);
    await wait(350);
    const clicked = await contents.executeJavaScript(publishButtonScript(config.publishLabels), true) as { clicked?: boolean; label?: string };
    if (!clicked?.clicked) throw new Error(`${config.label}发布按钮没有成功点击`);
    report('publishing', `已点击${config.label}「${clicked.label || '发布'}」，正在核对结果…`);

    // 有些平台点发布后还会弹二次确认；只在出现明确确认按钮时再点一次。
    await wait(900);
    try { await contents.executeJavaScript(publishButtonScript(config.confirmLabels), true); } catch { /* 没有二次确认 */ }

    const outcome = await this.waitForPublishOutcome(contents);
    if (outcome.state === 'error') throw new Error(`${config.label}发布失败：${outcome.message || '页面提示错误'}`);
    if (outcome.state === 'success') {
      return {
        status: 'published',
        title: filled.title.trim(),
        bodyChars: Number(filled.bodyChars ?? 0),
        videoPath,
        url: contents.getURL(),
        message: `${config.label}已确认发布${outcome.message ? `：${outcome.message}` : ''}`
      };
    }
    return {
      status: 'needs-review',
      title: filled.title.trim(),
      bodyChars: Number(filled.bodyChars ?? 0),
      videoPath,
      url: contents.getURL(),
      message: `已点击${config.label}发布，但页面没有给出明确成功提示，请检查当前页面`
    };
  }

  dispose(): void {
    for (const current of this.views.values()) {
      this.detach(current.view);
      try { current.view.webContents.close(); } catch { /* 进程已退出 */ }
    }
    this.views.clear();
    this.attachedPlatform = null;
  }

  private liveWindow(): BrowserWindow | null {
    const win = this.ctx.window();
    return win && !win.isDestroyed() ? win : null;
  }

  private liveContents(platform: VideoPublishPlatform): WebContents | null {
    const contents = this.views.get(platform)?.view.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  private notify(platform = this.currentPlatform): void {
    this.ctx.window()?.webContents.send('video-publish:view-changed', platform);
  }

  private detach(view: WebContentsView): void {
    const win = this.liveWindow();
    if (win) {
      try { win.contentView.removeChildView(view); } catch { /* 已不在视图树上 */ }
    }
    this.attachedPlatform = null;
  }

  private sync(): void {
    const win = this.liveWindow();
    if (!win) return;
    const before = this.attachedPlatform;
    const previous = before ? this.views.get(before) : undefined;
    if (!this.wanted || !this.bounds) {
      if (previous) this.detach(previous.view);
    } else {
      if (previous && before !== this.currentPlatform) this.detach(previous.view);
      const current = this.ensureView(this.currentPlatform);
      if (!this.attachedPlatform) {
        win.contentView.addChildView(current.view);
        this.attachedPlatform = this.currentPlatform;
      }
      current.view.setBounds(this.bounds);
      if (!current.started) {
        const saved = this.ctx.lastPages.get(`video-publish:${this.currentPlatform}`);
        const config = VIDEO_PUBLISHER_CONFIGS[this.currentPlatform];
        void this.load(current, saved && isPublisherUrl(config, saved) ? saved : config.home);
      }
    }
    if (before !== this.attachedPlatform) this.notify();
  }

  private ensureView(platform: VideoPublishPlatform): PlatformView {
    const existing = this.views.get(platform);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    const config = VIDEO_PUBLISHER_CONFIGS[platform];
    const view = new WebContentsView({
      webPreferences: {
        partition: config.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    });
    const current: PlatformView = { view, loading: false, error: '', started: false };
    const changed = () => { if (this.currentPlatform === platform) this.notify(platform); };
    const contents = view.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    keepLoginAcrossRestarts(contents.session, () => config.hosts);
    contents.setWindowOpenHandler(({ url }) => {
      if (isPublisherUrl(config, url)) void this.load(current, url);
      else if (/^https?:\/\//.test(url)) void openUrl(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => { if (!isPublisherUrl(config, url)) event.preventDefault(); });
    contents.on('did-start-loading', () => { current.loading = true; current.error = ''; changed(); });
    contents.on('did-stop-loading', () => { current.loading = false; changed(); });
    contents.on('did-navigate', (_event, url) => { this.remember(platform, config, url); changed(); });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.remember(platform, config, url);
      changed();
    });
    contents.on('page-title-updated', changed);
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.ctx.lastPages.forget(`video-publish:${platform}`);
      current.loading = false;
      current.error = `页面打不开：${description}（${code}）`;
      changed();
    });
    contents.on('render-process-gone', () => {
      current.loading = false;
      current.error = `${config.label}页面进程已退出，点「刷新」重试`;
      changed();
    });
    this.views.set(platform, current);
    return current;
  }

  private remember(platform: VideoPublishPlatform, config: VideoPublisherConfig, url: string): void {
    if (isPublisherUrl(config, url)) this.ctx.lastPages.set(`video-publish:${platform}`, url);
  }

  private async load(current: PlatformView, url: string): Promise<void> {
    current.started = true;
    try {
      await current.view.webContents.loadURL(url);
    } catch (error) {
      if (isAborted(error)) return;
      current.loading = false;
      if (!current.error) current.error = `页面打不开：${error instanceof Error ? error.message : String(error)}`;
      this.notify();
    }
  }

  private requireCurrent(value: unknown): VideoPublishPlatform {
    const platform = requirePlatform(value);
    if (platform !== this.currentPlatform) throw new Error('发布平台已切换，已取消上一个平台的操作');
    return platform;
  }

  private assertCurrent(platform: VideoPublishPlatform): void {
    if (this.currentPlatform !== platform) throw new Error('发布平台已切换，已取消上一个平台的操作');
  }

  private async waitForScript<T>(contents: WebContents, script: string, timeoutMs: number, message: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      if (contents.isDestroyed()) throw new Error('发布窗口已关闭');
      try {
        const result = await contents.executeJavaScript(script, true) as T;
        if (result) return result;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await wait(500);
    }
    throw new Error(`${message}${lastError ? `：${lastError}` : ''}`);
  }

  private async waitForPublishButton(contents: WebContents, config: VideoPublisherConfig, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (contents.isDestroyed()) throw new Error('发布窗口已关闭');
      const result = await contents.executeJavaScript(publishButtonProbeScript(config.publishLabels), true) as { found?: boolean; enabled?: boolean };
      if (result?.found && result.enabled) return;
      await wait(700);
    }
    throw new Error(`${config.label}发布按钮一直没有变为可用，请在当前页面检查必要声明或上传状态`);
  }

  private async executeAgreementScript(contents: WebContents): Promise<void> {
    try { await contents.executeJavaScript(AGREEMENT_SCRIPT, true); } catch { /* 没有协议勾选项 */ }
  }

  private async waitForPublishOutcome(contents: WebContents): Promise<{ state: 'success' | 'error' | 'idle'; message: string }> {
    const deadline = Date.now() + PUBLISH_RESULT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (contents.isDestroyed()) throw new Error('发布窗口已关闭');
      const result = await contents.executeJavaScript(READ_PUBLISH_OUTCOME_SCRIPT, true) as {
        state?: 'success' | 'error' | 'idle';
        message?: string;
      };
      if (result?.state === 'success' || result?.state === 'error') {
        return { state: result.state, message: String(result.message ?? '') };
      }
      await wait(700);
    }
    return { state: 'idle', message: '' };
  }

  /** 文件框本身不接收脚本赋值，使用 Chromium 调试协议把本地成片交给页面自己的上传流程。 */
  private async setFileInput(contents: WebContents, file: string, selectors: string[]): Promise<void> {
    const cdp = contents.debugger;
    let attached = false;
    try {
      if (!cdp.isAttached()) {
        cdp.attach('1.3');
        attached = true;
      }
      const document = await cdp.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } };
      let nodeId = 0;
      for (const selector of selectors) {
        const found = await cdp.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector }) as { nodeId: number };
        if (found.nodeId) { nodeId = found.nodeId; break; }
      }
      if (!nodeId) throw new Error('没有找到视频上传控件');
      await cdp.sendCommand('DOM.setFileInputFiles', { nodeId, files: [file] });
    } finally {
      if (attached) {
        try { cdp.detach(); } catch { /* 页面已跳转 */ }
      }
    }
  }
}

const UPLOAD_READY_SCRIPT = `(() => Array.from(document.querySelectorAll('input[type="file"]')).some(element => {
  const accept = (element.getAttribute('accept') || '').toLowerCase();
  return !accept || accept.includes('video') || accept.includes('.mp4') || accept.includes('.mov') || accept.includes('.mkv');
}))()`;

const FIELD_HELPERS = `
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const config = ${JSON.stringify({
    douyin: {},
    shipinhao: {},
    xiaohongshu: {},
    bilibili: {}
  })};
  const findFirst = (selectors) => {
    for (const selector of selectors) {
      try {
        const found = Array.from(document.querySelectorAll(selector)).find(visible);
        if (found) return found;
      } catch {}
    }
    return null;
  };
  const inputLabel = element => [
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
    element.getAttribute('data-placeholder'),
    element.getAttribute('name')
  ].filter(Boolean).join(' ');
  const textInputs = Array.from(document.querySelectorAll('input')).filter(element => {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return visible(element) && !['file', 'checkbox', 'radio', 'hidden', 'button', 'submit'].includes(type);
  });
  const bodyCandidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(visible);
`;

function fieldsLocatorScript(config: VideoPublisherConfig): string {
  return `(() => {
    ${FIELD_HELPERS}
    const titleSelectors = ${JSON.stringify(config.titleSelectors)};
    const bodySelectors = ${JSON.stringify(config.bodySelectors)};
    const title = findFirst(titleSelectors)
      || textInputs.find(element => /标题|作品名称|title/i.test(inputLabel(element)))
      || textInputs[0]
      || null;
    const body = findFirst(bodySelectors)
      || bodyCandidates.find(element => element !== title && /描述|简介|正文|说明|desc|body/i.test(inputLabel(element)))
      || bodyCandidates.find(element => element !== title)
      || null;
    return { title, body };
  })()`;
}

function formReadyScript(config: VideoPublisherConfig): string {
  return `(() => {
    const fields = ${fieldsLocatorScript(config)};
    return Boolean(fields.title && fields.body);
  })()`;
}

function focusFieldScript(config: VideoPublisherConfig, field: 'title' | 'body'): string {
  return `(() => {
    const fields = ${fieldsLocatorScript(config)};
    const target = ${JSON.stringify(field)} === 'title' ? fields.title : fields.body;
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.select();
    } else {
      const selection = window.getSelection();
      if (!selection) return false;
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  })()`;
}

function readFieldsScript(config: VideoPublisherConfig): string {
  return `(() => {
    const fields = ${fieldsLocatorScript(config)};
    return {
      ok: Boolean(fields.title && fields.body),
      title: fields.title?.value ?? fields.title?.innerText ?? fields.title?.textContent ?? '',
      bodyChars: (fields.body?.value ?? fields.body?.innerText ?? fields.body?.textContent ?? '').length
    };
  })()`;
}

function publishButtonProbeScript(labels: string[]): string {
  return `(() => {
    const normalize = value => String(value || '').replace(/\\s+/g, '').trim();
    const wanted = ${JSON.stringify(labels.map(label => label.replace(/\s+/g, '')))};
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const button = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .find(element => wanted.includes(normalize(element.innerText || element.textContent)));
    const disabled = !button || Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true'
      || /disabled|is-disabled/.test(button.className || '');
    return { found: Boolean(button), enabled: Boolean(button && !disabled), label: normalize(button?.innerText || button?.textContent) };
  })()`;
}

function publishButtonScript(labels: string[]): string {
  return `(() => {
    const normalize = value => String(value || '').replace(/\\s+/g, '').trim();
    const wanted = ${JSON.stringify(labels.map(label => label.replace(/\s+/g, '')))};
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const button = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .find(element => wanted.includes(normalize(element.innerText || element.textContent)));
    if (!button) return { clicked: false };
    const disabled = Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true'
      || /disabled|is-disabled/.test(button.className || '');
    if (disabled) return { clicked: false, label: normalize(button.innerText || button.textContent) };
    button.scrollIntoView({ block: 'center' });
    button.click();
    return { clicked: true, label: normalize(button.innerText || button.textContent) };
  })()`;
}

const AGREEMENT_SCRIPT = `(() => {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  for (const checkbox of Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(visible)) {
    if (checkbox.checked) continue;
    const label = checkbox.closest('label')?.innerText || checkbox.parentElement?.innerText || '';
    if (/我已阅读|同意|协议/.test(label)) checkbox.click();
  }
  return true;
})()`;

const READ_PUBLISH_OUTCOME_SCRIPT = `(() => {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const dialogs = Array.from(document.querySelectorAll(
    '[role="alert"], [role="alertdialog"], [role="dialog"], .toast, .semi-toast, .arco-message, .ant-message, .el-message'
  )).filter(visible);
  const text = dialogs.map(element => element.innerText || element.textContent || '').join('\\n').trim();
  const error = text.match(/(发布失败|上传失败|投稿失败|提交失败|请先登录|登录已失效|账号异常|内容违规|不可发布)/);
  if (error) return { state: 'error', message: error[0] };
  const success = text.match(/(发布成功|发表成功|投稿成功|提交成功|作品已发布|已提交审核|审核中)/);
  if (success) return { state: 'success', message: success[0] };
  const href = location.href;
  if (/(?:\\/success|\\/result|\\/manage|\\/upload-manager)(?:[/?#]|$)/i.test(href)) {
    return { state: 'success', message: '页面已进入发布结果或作品管理页' };
  }
  return { state: 'idle', message: '' };
})()`;

function clickVisibleTextScript(labels: string[]): string {
  return `(() => {
    const normalize = value => String(value || '').replace(/\\s+/g, '').trim();
    const wanted = ${JSON.stringify(labels.map(label => label.replace(/\s+/g, '')))};
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const target = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], .creator-tab'))
      .filter(visible)
      .find(element => wanted.includes(normalize(element.innerText || element.textContent)));
    if (!target) return false;
    target.click();
    return true;
  })()`;
}

function requirePlatform(value: unknown): VideoPublishPlatform {
  if (value === 'douyin' || value === 'shipinhao' || value === 'xiaohongshu' || value === 'bilibili') return value;
  throw new Error('不支持的视频发布平台');
}

function isPublisherUrl(config: VideoPublisherConfig, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return config.hosts.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function isAborted(error: unknown): boolean {
  const record = error as { code?: unknown; errno?: unknown } | null;
  return record?.code === 'ERR_ABORTED' || record?.errno === -3;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
