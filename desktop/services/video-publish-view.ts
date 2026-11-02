import fs from 'node:fs';
import path from 'node:path';
import { WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import type { AppContext } from '../app-context';
import type { SiteViewBounds, VideoDraftFillResult, VideoPlatform, VideoPublishViewState, VideoProject } from '../shared';
import { keepLoginAcrossRestarts } from './session-cookies';
import { clampSiteBounds } from './site-config';

type VideoPublishConfig = {
  platform: PublishPlatform;
  label: string;
  partition: string;
  home: string;
  hosts: string[];
  titleSelectors: string[];
  bodySelectors: string[];
};

type PublishPlatform = Exclude<VideoPlatform, 'general'>;

const VIDEO_PUBLISH_CONFIGS: Record<PublishPlatform, VideoPublishConfig> = {
  douyin: {
    platform: 'douyin', label: '抖音', partition: 'persist:sydney-video-douyin',
    home: 'https://creator.douyin.com/creator-micro/content/upload', hosts: ['creator.douyin.com'],
    titleSelectors: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', 'input[placeholder*="作品"]'],
    bodySelectors: ['textarea[placeholder*="描述"]', 'textarea[placeholder*="简介"]', '[contenteditable="true"]']
  },
  shipinhao: {
    platform: 'shipinhao', label: '视频号', partition: 'persist:sydney-video-shipinhao',
    home: 'https://channels.weixin.qq.com/platform/post/create', hosts: ['channels.weixin.qq.com', 'weixin.qq.com'],
    titleSelectors: ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]'],
    bodySelectors: ['textarea[placeholder*="描述"]', 'textarea[placeholder*="简介"]', '[contenteditable="true"]']
  },
  xiaohongshu: {
    platform: 'xiaohongshu', label: '小红书', partition: 'persist:sydney-video-xiaohongshu',
    home: 'https://creator.xiaohongshu.com/publish/publish', hosts: ['creator.xiaohongshu.com', 'xiaohongshu.com'],
    titleSelectors: ['input[placeholder*="标题"]', 'input.d-text', 'input.c-input_inner'],
    bodySelectors: ['textarea[placeholder*="正文"]', 'textarea[placeholder*="描述"]', '.tiptap.ProseMirror[contenteditable="true"]', '[contenteditable="true"]']
  },
  bilibili: {
    platform: 'bilibili', label: 'B 站', partition: 'persist:sydney-video-bilibili',
    home: 'https://member.bilibili.com/platform/upload/video/frame', hosts: ['member.bilibili.com', 'bilibili.com'],
    titleSelectors: ['input[placeholder*="标题"]', 'input[placeholder*="视频标题"]', 'input[type="text"]'],
    bodySelectors: ['textarea[placeholder*="简介"]', 'textarea[placeholder*="描述"]', '[contenteditable="true"]']
  }
};

const PAGE_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

function configFor(platform: VideoPlatform): VideoPublishConfig {
  if (platform === 'general') throw new Error('通用视频没有对应的发布平台');
  return VIDEO_PUBLISH_CONFIGS[platform];
}

function platformHost(config: VideoPublishConfig, url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && config.hosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function visibleScript(selectors: string[]): string {
  return `(() => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const selectors = ${JSON.stringify(selectors)};
    for (const selector of selectors) {
      try {
        const element = Array.from(document.querySelectorAll(selector)).find(item => visible(item));
        if (element) return true;
      } catch {}
    }
    return false;
  })()`;
}

function focusFieldScript(selectors: string[]): string {
  return `(() => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const selectors = ${JSON.stringify(selectors)};
    for (const selector of selectors) {
      try {
        const element = Array.from(document.querySelectorAll(selector)).find(item => visible(item));
        if (!element) continue;
        element.focus();
        if (element.matches('input, textarea')) element.select();
        else {
          const selection = window.getSelection();
          if (selection) { const range = document.createRange(); range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range); }
        }
        return true;
      } catch {}
    }
    return false;
  })()`;
}

function readFieldScript(selectors: string[]): string {
  return `(() => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const selectors = ${JSON.stringify(selectors)};
    for (const selector of selectors) {
      try {
        const element = Array.from(document.querySelectorAll(selector)).find(item => visible(item));
        if (element) return element.value ?? element.innerText ?? element.textContent ?? '';
      } catch {}
    }
    return '';
  })()`;
}

function isAborted(error: unknown): boolean {
  const record = error as { code?: unknown; errno?: unknown } | null;
  return record?.code === 'ERR_ABORTED' || record?.errno === -3;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type PublishView = { view: WebContentsView; loading: boolean; error: string; started: boolean };

export class VideoPublishView {
  private views = new Map<VideoPlatform, PublishView>();
  private platform: VideoPlatform = 'general';
  private bounds: SiteViewBounds | null = null;
  private wanted = false;
  private attachedPlatform: VideoPlatform = 'general';

  constructor(private readonly ctx: AppContext) {}

  state(platform: VideoPlatform): VideoPublishViewState {
    const publishPlatform = configFor(platform).platform;
    const current = this.views.get(publishPlatform);
    const contents = current?.view.webContents;
    return {
      platform: publishPlatform,
      url: contents && !contents.isDestroyed() ? contents.getURL() : '',
      title: contents && !contents.isDestroyed() ? contents.getTitle() : '',
      loading: Boolean(current?.loading),
      canGoBack: Boolean(contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()),
      visible: this.attachedPlatform === publishPlatform,
      error: current?.error ?? ''
    };
  }

  show(platform: VideoPlatform, bounds?: unknown): VideoPublishViewState {
    const publishPlatform = configFor(platform).platform;
    this.platform = publishPlatform;
    this.wanted = true;
    if (bounds !== undefined) this.setBounds(bounds);
    else this.sync();
    return this.state(publishPlatform);
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

  go(platform: VideoPlatform, action: 'back' | 'reload' | 'home'): VideoPublishViewState {
    const publishPlatform = configFor(platform).platform;
    const current = this.views.get(publishPlatform);
    const contents = current?.view.webContents;
    if (contents && !contents.isDestroyed()) {
      if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      if (action === 'reload') contents.reload();
      if (action === 'home') void this.load(this.ensureView(publishPlatform), configFor(publishPlatform).home);
    }
    return this.state(publishPlatform);
  }

  async fillDraft(project: VideoProject): Promise<VideoDraftFillResult> {
    const config = configFor(project.platform);
    const video = project.assets.video;
    if (!video || !fs.existsSync(video.path)) throw new Error('当前项目还没有可用的成片，请先渲染并检查成片');
    this.platform = config.platform;
    this.wanted = true;
    this.sync();
    const current = this.ensureView(config.platform);
    const contents = current.view.webContents;
    current.error = '';
    current.started = true;
    try {
      await contents.loadURL(config.home);
    } catch (error) {
      if (!isAborted(error)) throw error;
    }
    await this.waitForScript(contents, visibleScript(['input[type="file"]']), PAGE_TIMEOUT_MS, `${config.label}发布页没有出现视频上传控件，请先在当前窗口登录`);
    await this.setFileInput(contents, video.path);
    await this.waitForScript(contents, visibleScript(config.titleSelectors), UPLOAD_TIMEOUT_MS, `${config.label}上传视频后没有出现标题输入框，请检查页面是否完成加载`);
    const title = (project.title.trim() || project.topic.trim() || '短视频').slice(0, 80);
    const body = (project.script.trim() || project.topic.trim()).slice(0, 10_000);
    if (!await contents.executeJavaScript(focusFieldScript(config.titleSelectors), true)) throw new Error(`${config.label}没有找到标题输入框`);
    contents.insertText(title);
    if (body) {
      const hasBody = await contents.executeJavaScript(visibleScript(config.bodySelectors), true);
      if (!hasBody) throw new Error(`${config.label}没有找到简介或描述输入框`);
      if (!await contents.executeJavaScript(focusFieldScript(config.bodySelectors), true)) throw new Error(`${config.label}没有找到简介或描述输入框`);
      contents.insertText(body);
    }
    await wait(700);
    const filledTitle = String(await contents.executeJavaScript(readFieldScript(config.titleSelectors), true) ?? '').trim();
    const filledBody = body ? String(await contents.executeJavaScript(readFieldScript(config.bodySelectors), true) ?? '') : '';
    if (filledTitle !== title) throw new Error(`${config.label}没有成功填入标题，请检查页面后重试`);
    if (body && !filledBody.trim()) throw new Error(`${config.label}没有成功填入简介或描述，请检查页面后重试`);
    return { platform: config.platform, title: filledTitle, bodyChars: filledBody.length, videoPath: video.path };
  }

  closeAll(): void {
    this.wanted = false;
    this.sync();
  }

  dispose(): void {
    for (const current of this.views.values()) {
      this.detach(current.view);
      try { current.view.webContents.close(); } catch { /* 页面进程已退出 */ }
    }
    this.views.clear();
    this.attachedPlatform = 'general';
  }

  private liveWindow(): BrowserWindow | null {
    const win = this.ctx.window();
    return win && !win.isDestroyed() ? win : null;
  }

  private notify(platform = this.platform): void {
    this.ctx.window()?.webContents.send('video:publish:changed', platform);
  }

  private detach(view: WebContentsView): void {
    const win = this.liveWindow();
    if (win) {
      try { win.contentView.removeChildView(view); } catch { /* 已不在视图树上 */ }
    }
    this.attachedPlatform = 'general';
  }

  private sync(): void {
    const win = this.liveWindow();
    if (!win) return;
    const previous = this.views.get(this.attachedPlatform);
    if (!this.wanted || !this.bounds || this.platform === 'general') {
      if (previous) this.detach(previous.view);
    } else {
      const current = this.ensureView(this.platform);
      if (previous && this.attachedPlatform !== this.platform) this.detach(previous.view);
      if (this.attachedPlatform !== this.platform) {
        win.contentView.addChildView(current.view);
        this.attachedPlatform = this.platform;
      }
      current.view.setBounds(this.bounds);
      if (!current.started) void this.load(current, this.resumeUrl(this.platform));
    }
    this.notify();
  }

  private ensureView(platform: Exclude<VideoPlatform, 'general'>): PublishView {
    const existing = this.views.get(platform);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    const config = configFor(platform);
    const view = new WebContentsView({ webPreferences: { partition: config.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
    const current: PublishView = { view, loading: false, error: '', started: false };
    const contents = view.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    keepLoginAcrossRestarts(contents.session, () => config.hosts);
    contents.setWindowOpenHandler(({ url }) => {
      if (platformHost(config, url)) void this.load(current, url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => { if (!platformHost(config, url)) event.preventDefault(); });
    const changed = () => { if (this.platform === platform) this.notify(platform); };
    contents.on('did-start-loading', () => { current.loading = true; current.error = ''; changed(); });
    contents.on('did-stop-loading', () => { current.loading = false; changed(); });
    const remember = (url: string) => { if (platformHost(config, url)) this.ctx.lastPages.set(`video-publish:${platform}`, url); };
    contents.on('did-navigate', (_event, url) => { remember(url); changed(); });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) remember(url); changed(); });
    contents.on('page-title-updated', changed);
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.ctx.lastPages.forget(`video-publish:${platform}`);
      current.loading = false;
      current.error = `页面打不开：${description}（${code}）`;
      changed();
    });
    contents.on('render-process-gone', () => { current.loading = false; current.error = '页面进程已退出，点刷新重试'; changed(); });
    this.views.set(platform, current);
    return current;
  }

  private resumeUrl(platform: Exclude<VideoPlatform, 'general'>): string {
    const config = configFor(platform);
    const saved = this.ctx.lastPages.get(`video-publish:${platform}`);
    return saved && platformHost(config, saved) ? saved : config.home;
  }

  private async load(current: PublishView, url: string): Promise<void> {
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

  private async waitForScript(contents: WebContents, script: string, timeoutMs: number, message: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (contents.isDestroyed()) throw new Error('发布页面已关闭');
      try {
        if (await contents.executeJavaScript(script, true)) return;
      } catch {
        // 页面仍在导航或渲染，继续等待。
      }
      await wait(500);
    }
    throw new Error(message);
  }

  private async setFileInput(contents: WebContents, file: string): Promise<void> {
    const cdp = contents.debugger;
    let attached = false;
    try {
      if (!cdp.isAttached()) { cdp.attach('1.3'); attached = true; }
      const document = await cdp.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } };
      let found = await cdp.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type="file"][accept*="video"]' }) as { nodeId: number };
      if (!found.nodeId) found = await cdp.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[type="file"]' }) as { nodeId: number };
      if (!found.nodeId) throw new Error('没有找到视频上传控件');
      await cdp.sendCommand('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [path.resolve(file)] });
    } finally {
      if (attached) {
        try { cdp.detach(); } catch { /* 页面已跳转 */ }
      }
    }
  }
}
