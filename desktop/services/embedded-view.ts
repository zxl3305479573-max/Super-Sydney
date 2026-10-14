import { shell, WebContentsView, type BrowserWindow } from 'electron';
import type { AppContext } from '../app-context';
import type { EmbeddedSiteKey, EmbeddedViewState, SiteViewBounds } from '../shared';
import { keepLoginAcrossRestarts } from './session-cookies';
import { clampSiteBounds } from './site-config';

/** 一个固定嵌入的站点（变现分组的站点、公众号后台）：自己的会话分区、首页，以及可以留在视图里打开的域名。 */
export type EmbeddedSiteConfig = {
  key: EmbeddedSiteKey; label: string; partition: string; home: string; hosts: string[];
};

/**
 * 变现分组里固定嵌入的站点。分区名一旦用过就不要改：改了等于换一个空会话，用户得重新登录。
 * hosts 里的域名（含子域）弹出的新窗口留在视图里打开，其它站点交给系统浏览器。
 */
export const EMBEDDED_SITES: Record<EmbeddedSiteKey, EmbeddedSiteConfig> = {
  xianyu: {
    key: 'xianyu', label: '闲鱼', partition: 'persist:sydney-xianyu', home: 'https://www.goofish.com/',
    // 闲鱼的扫码登录、商品详情、支付依赖这几个阿里系域名。
    hosts: ['goofish.com', 'taobao.com', 'alipay.com', 'tmall.com']
  },
  site16688: {
    key: 'site16688', label: '16688', partition: 'persist:sydney-16688', home: 'https://www.16688.com.cn/',
    hosts: ['16688.com.cn']
  },
  // 公众号模块里的「公众号后台」：微信公众平台（创作者发布平台）。扫码登录、草稿编辑器、
  // 预览都在 weixin.qq.com 下，编辑器从后台首页以新窗口打开，留在视图里继续编辑。
  wechatMp: {
    key: 'wechatMp', label: '公众号后台', partition: 'persist:sydney-wechat-mp', home: 'https://mp.weixin.qq.com/',
    hosts: ['weixin.qq.com']
  }
};

export function embeddedSite(key: unknown): EmbeddedSiteConfig {
  const site = typeof key === 'string' ? EMBEDDED_SITES[key as EmbeddedSiteKey] : undefined;
  if (!site) throw new Error('未知的嵌入站点');
  return site;
}

/** 链接是不是这个站点（或它依赖的域名）下的 https 页面。 */
export function isEmbeddedHost(site: EmbeddedSiteConfig, value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    if (protocol !== 'https:') return false;
    return site.hosts.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * 变现分组里嵌的一个第三方站点（闲鱼、16688 …）。
 *
 * 主进程挂在窗口上的 WebContentsView，每个站点一个独立会话分区：登录由用户自己在页面里完成，
 * 应用不碰账号、不读 cookie、不注入脚本，麦克风 / 摄像头 / 定位 / 通知等权限一律拒绝。
 * 离开模块只是摘下视图，页面进程留着，切回来登录态与浏览位置都还在。
 */
export class EmbeddedView {
  private view: WebContentsView | null = null;
  private bounds: SiteViewBounds | null = null;
  private wanted = false;
  private attached = false;
  private loading = false;
  /** 是否已经让视图打开过页面。只看 getURL() 不够：跳转途中旧页已停、新页还没提交时它是空的。 */
  private started = false;
  private error = '';

  constructor(private readonly ctx: AppContext, private readonly site: EmbeddedSiteConfig) {}

  state(): EmbeddedViewState {
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

  show(): EmbeddedViewState {
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

  go(action: 'back' | 'reload' | 'home'): EmbeddedViewState {
    const contents = this.liveContents();
    if (contents) {
      if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      if (action === 'reload') contents.reload();
      if (action === 'home' && this.view) { this.error = ''; void this.load(this.view, this.site.home); }
    }
    return this.state();
  }

  /** 支付页、需要完整浏览器能力的页面，交给系统浏览器。 */
  openExternal(): void {
    const target = this.liveContents()?.getURL() || this.site.home;
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
    this.ctx.window()?.webContents.send('embed:changed', this.site.key);
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
      if (!this.started) void this.load(view, this.site.home);
    }
    if (before !== this.attached) this.notify();
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({ webPreferences: { partition: this.site.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
    const contents = view.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    // 重启应用后不必重新登录：站点的会话 cookie 转成持久 cookie（见 session-cookies.ts）。
    keepLoginAcrossRestarts(contents.session, () => this.site.hosts);
    contents.setWindowOpenHandler(({ url }) => {
      // 站点自己的新标签（商品详情、订单页）留在视图里打开，其它站点交给系统浏览器。
      if (isEmbeddedHost(this.site, url)) void this.load(view, url);
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
    this.started = false;
    return view;
  }

  private async load(view: WebContentsView, url: string): Promise<void> {
    this.started = true;
    try {
      await view.webContents.loadURL(url);
    } catch (error) {
      // 被新的导航顶掉（ERR_ABORTED / -3）不算失败：新页面会接着加载，失败另有 did-fail-load 报。
      if (isAborted(error)) return;
      this.loading = false;
      if (!this.error) this.error = `页面打不开：${error instanceof Error ? error.message : String(error)}`;
      this.notify();
    }
  }
}

function isAborted(error: unknown): boolean {
  const record = error as { code?: unknown; errno?: unknown } | null;
  return record?.code === 'ERR_ABORTED' || record?.errno === -3;
}
