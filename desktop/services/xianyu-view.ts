import { shell, WebContentsView, type BrowserWindow } from 'electron';
import type { AppContext } from '../app-context';
import type { SiteViewBounds, XianyuViewState } from '../shared';
import { clampSiteBounds } from './site-config';

const XIANYU_PARTITION = 'persist:sydney-xianyu';
export const XIANYU_HOME = 'https://www.goofish.com/';

/**
 * 闲鱼模块里嵌的闲鱼网页版（goofish.com）。
 *
 * 和小红书窗口同一个做法：主进程挂在窗口上的 WebContentsView，独立会话分区，
 * 登录由用户自己在页面里扫码完成，应用不碰账号、不读 cookie、不注入脚本。
 * 闲鱼、淘宝、支付宝的页面（商品详情、扫码登录）留在视图里，别的站点交给系统浏览器。
 */
export class XianyuView {
  private view: WebContentsView | null = null;
  private bounds: SiteViewBounds | null = null;
  private wanted = false;
  private attached = false;
  private loading = false;
  private error = '';

  constructor(private readonly ctx: AppContext) {}

  state(): XianyuViewState {
    const contents = this.liveContents();
    return {
      url: contents?.getURL() ?? '',
      title: contents?.getTitle() ?? '',
      loading: this.loading,
      canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
      visible: this.attached,
      error: this.error
    };
  }

  show(): XianyuViewState {
    this.wanted = true;
    this.sync();
    return this.state();
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

  go(action: 'back' | 'reload' | 'home'): XianyuViewState {
    const contents = this.liveContents();
    if (contents) {
      if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      if (action === 'reload') contents.reload();
      if (action === 'home' && this.view) { this.error = ''; void this.load(this.view, XIANYU_HOME); }
    }
    return this.state();
  }

  openExternal(): void {
    const target = this.liveContents()?.getURL() || XIANYU_HOME;
    void shell.openExternal(target);
  }

  dispose(): void {
    if (this.view) {
      this.detach();
      try { this.view.webContents.close(); } catch { /* 进程已退出 */ }
    }
    this.view = null;
  }

  private liveWindow(): BrowserWindow | null {
    const win = this.ctx.window();
    return win && !win.isDestroyed() ? win : null;
  }

  private liveContents() {
    const contents = this.view?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  private notify(): void {
    this.ctx.window()?.webContents.send('xianyu:view-changed');
  }

  private detach(): void {
    const win = this.liveWindow();
    if (win && this.view && this.attached) {
      try { win.contentView.removeChildView(this.view); } catch { /* 已不在视图树上 */ }
    }
    this.attached = false;
  }

  private sync(): void {
    const win = this.liveWindow();
    if (!win) return;
    const before = this.attached;
    if (!this.wanted || !this.bounds) this.detach();
    else {
      const view = this.ensureView();
      if (!this.attached) { win.contentView.addChildView(view); this.attached = true; }
      view.setBounds(this.bounds);
      if (!view.webContents.getURL() && !this.loading) void this.load(view, XIANYU_HOME);
    }
    if (before !== this.attached) this.notify();
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({ webPreferences: { partition: XIANYU_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
    const contents = view.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.setWindowOpenHandler(({ url }) => {
      // 闲鱼的商品详情默认开新标签：同站的留在视图里打开，其它站点交给系统浏览器。
      if (isXianyuHost(url)) void this.load(view, url);
      else if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => { if (!/^https?:\/\//.test(url)) event.preventDefault(); });
    contents.on('did-start-loading', () => { this.loading = true; this.error = ''; this.notify(); });
    contents.on('did-stop-loading', () => { this.loading = false; this.notify(); });
    contents.on('did-navigate', () => this.notify());
    contents.on('did-navigate-in-page', () => this.notify());
    contents.on('page-title-updated', () => this.notify());
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.loading = false;
      this.error = `页面打不开：${description}（${code}）`;
      this.notify();
    });
    contents.on('render-process-gone', () => { this.loading = false; this.error = '页面进程已退出，点「刷新」重试'; this.notify(); });
    this.view = view;
    return view;
  }

  private async load(view: WebContentsView, url: string): Promise<void> {
    try {
      await view.webContents.loadURL(url);
    } catch (error) {
      this.loading = false;
      if (!this.error) this.error = `页面打不开：${error instanceof Error ? error.message : String(error)}`;
      this.notify();
    }
  }
}

/** 闲鱼及其登录、支付依赖的阿里系域名。 */
export function isXianyuHost(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    if (protocol !== 'https:') return false;
    return ['goofish.com', 'taobao.com', 'alipay.com', 'tmall.com'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}
