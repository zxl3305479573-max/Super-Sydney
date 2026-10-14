import { shell, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import type { AppContext } from '../app-context';
import type { SiteEntry, SiteModuleState, SiteViewBounds } from '../shared';
import { keepLoginAcrossRestarts } from './session-cookies';
import { clampSiteBounds, readSiteConfig, sanitizeSiteEntries, writeSiteConfig } from './site-config';

function siteHost(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** 站点用独立会话分区：登录态与 cookie 留在它自己那里，不跟应用共享。 */
const SITE_PARTITION = 'persist:sydney-site';

/** 一个站点在这个会话里的运行状态。视图建好就留着，切回来时状态与滚动位置都还在。 */
type LiveSite = { view: WebContentsView; loading: boolean; error: string };

/**
 * 变现模块里嵌的第三方站点：可以有一串，同一时刻只显示当前选中的那个。
 *
 * 它不走渲染进程的 iframe，而是主进程挂在窗口上的 WebContentsView——
 * 站点的 X-Frame-Options / frame-ancestors 因此完全不参与，也不会被预览用的
 * srcdoc 沙箱牵连。视图没有 preload，站点拿不到 window.sydney，读不到应用数据。
 *
 * 每个站点第一次被打开时建自己的视图并常驻：切换是摘一个挂一个，不是重新加载；
 * 离开这个模块也只是摘下来。新窗口一律交给系统浏览器。
 */
export class SiteView {
  private live = new Map<string, LiveSite>();
  private sites: SiteEntry[] = [];
  private activeId = '';
  private bounds: SiteViewBounds | null = null;
  private wanted = false;
  /** 当前挂在窗口上的那个站点；空串表示没挂。 */
  private attachedId = '';

  constructor(private readonly ctx: AppContext) {
    const stored = readSiteConfig(ctx.dataDir);
    this.sites = stored.sites;
    this.activeId = stored.activeId;
  }

  state(): SiteModuleState {
    const active = this.activeSite();
    const contents = this.liveContents(active?.id);
    return {
      sites: this.sites.map(site => ({ ...site })),
      activeId: active?.id ?? '',
      currentUrl: contents?.getURL() ?? '',
      title: contents?.getTitle() ?? '',
      loading: Boolean(active && this.live.get(active.id)?.loading),
      canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
      visible: Boolean(active && this.attachedId === active.id),
      error: (active && this.live.get(active.id)?.error) || ''
    };
  }

  /** 存整份列表（增、删、改名、换地址都走这里），可选同时切到某个站点。 */
  save(input: unknown, activate?: unknown): SiteModuleState {
    const sites = sanitizeSiteEntries(input);
    const wanted = typeof activate === 'string' && sites.some(site => site.id === activate) ? activate : '';
    for (const [id, running] of this.live) {
      if (sites.some(site => site.id === id)) continue;
      if (this.attachedId === id) {
        this.detachView(running.view);
        this.attachedId = '';
      }
      this.closeView(running.view);
      this.live.delete(id);
    }
    for (const site of sites) {
      const previous = this.sites.find(entry => entry.id === site.id);
      const running = this.live.get(site.id);
      // 地址被改过的站点：清掉旧报错，已经开着的视图直接导航到新地址。
      if (!running || !previous || previous.url === site.url) continue;
      running.error = '';
      void this.load(running, site.url);
    }
    this.sites = sites;
    this.activeId = wanted || (sites.some(site => site.id === this.activeId) ? this.activeId : sites[0]?.id ?? '');
    writeSiteConfig(this.ctx.dataDir, { sites, activeId: this.activeId });
    this.sync();
    return this.state();
  }

  activate(id: unknown): SiteModuleState {
    const wanted = String(id ?? '');
    if (!this.sites.some(site => site.id === wanted)) throw new Error('这个站点不在列表里');
    this.activeId = wanted;
    const running = this.live.get(wanted);
    if (running) running.error = '';
    writeSiteConfig(this.ctx.dataDir, { sites: this.sites, activeId: wanted });
    this.sync();
    return this.state();
  }

  show(): SiteModuleState {
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
    if (!win) {
      this.bounds = null;
    } else {
      const [width, height] = win.getContentSize();
      this.bounds = clampSiteBounds(input, { width, height });
    }
    this.sync();
  }

  /** 后退 / 刷新都作用在当前显示的站点上，「回首页」回到它自己配的地址。 */
  go(action: 'back' | 'reload' | 'home'): SiteModuleState {
    const active = this.activeSite();
    const contents = this.liveContents(active?.id);
    const running = active ? this.live.get(active.id) : undefined;
    if (contents && running) {
      if (action === 'back') {
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      } else if (action === 'reload') {
        contents.reload();
      } else if (active) {
        void this.load(running, active.url);
      }
    }
    return this.state();
  }

  /** 支付页、客服链接这类需要完整浏览器能力的东西，交给系统浏览器。 */
  openExternal(): void {
    const active = this.activeSite();
    const target = this.liveContents(active?.id)?.getURL() || active?.url || '';
    if (target) void shell.openExternal(target);
  }

  dispose(): void {
    for (const running of this.live.values()) this.closeView(running.view);
    this.live.clear();
    this.attachedId = '';
    this.wanted = false;
  }

  private liveWindow(): BrowserWindow | null {
    const win = this.ctx.window();
    return win && !win.isDestroyed() ? win : null;
  }

  private activeSite(): SiteEntry | null {
    return this.sites.find(site => site.id === this.activeId) ?? null;
  }

  private liveContents(id: string | undefined): WebContents | null {
    const contents = id ? this.live.get(id)?.view.webContents : undefined;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  private sync(): void {
    const win = this.liveWindow();
    if (!win) return;
    const before = this.attachedId;
    const active = this.activeSite();
    if (!this.wanted || !this.bounds || !active) {
      if (before) {
        const previous = this.live.get(before);
        if (previous) this.detachView(previous.view);
        this.attachedId = '';
      }
    } else {
      const running = this.ensureView(active);
      if (before && before !== active.id) {
        const previous = this.live.get(before);
        if (previous) this.detachView(previous.view);
        this.attachedId = '';
      }
      if (!this.attachedId) {
        win.contentView.addChildView(running.view);
        this.attachedId = active.id;
      }
      running.view.setBounds(this.bounds);
      const contents = running.view.webContents;
      if (!contents.getURL() && !running.loading) void this.load(running, active.url);
    }
    if (before !== this.attachedId) this.notify();
  }

  private ensureView(site: SiteEntry): LiveSite {
    const existing = this.live.get(site.id);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    const view = new WebContentsView({
      webPreferences: {
        partition: SITE_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    });
    const running: LiveSite = { view, loading: false, error: '' };
    const contents = view.webContents;
    // 站点没有麦克风、摄像头、通知、定位这些需求，缺省全拒；要开也应该是显式配置。
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    // 列表里各站点的登录在重启应用后保留（见 session-cookies.ts）；列表改了也按最新列表判断。
    keepLoginAcrossRestarts(contents.session, () => this.sites.map(entry => siteHost(entry.url)).filter(Boolean));
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault();
    });
    contents.on('did-start-loading', () => {
      running.loading = true;
      running.error = '';
      this.notifyIfActive(site.id);
    });
    contents.on('did-stop-loading', () => {
      running.loading = false;
      this.notifyIfActive(site.id);
    });
    contents.on('did-navigate', () => this.notifyIfActive(site.id));
    contents.on('did-navigate-in-page', () => this.notifyIfActive(site.id));
    contents.on('page-title-updated', () => this.notifyIfActive(site.id));
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 是「这次加载被新导航打断」，不算失败。
      if (!isMainFrame || code === -3) return;
      running.loading = false;
      running.error = `站点打不开：${description}（${code}）`;
      this.notifyIfActive(site.id);
    });
    contents.on('render-process-gone', () => {
      running.loading = false;
      running.error = '站点页面进程已退出，点「刷新」重试';
      this.notifyIfActive(site.id);
    });
    this.live.set(site.id, running);
    return running;
  }

  private async load(running: LiveSite, url: string): Promise<void> {
    try {
      await running.view.webContents.loadURL(url);
    } catch (error) {
      running.loading = false;
      if (!running.error) running.error = `站点打不开：${error instanceof Error ? error.message : String(error)}`;
      this.notify();
    }
  }

  private detachView(view: WebContentsView): void {
    const win = this.liveWindow();
    if (!win) return;
    try {
      win.contentView.removeChildView(view);
    } catch {
      // 已经不在视图树上时不用管：摘不摘都不影响后面的挂载。
    }
  }

  private closeView(view: WebContentsView): void {
    const contents = view.webContents;
    if (!contents.isDestroyed()) contents.close();
  }

  /** 只有当前显示的那个站点的变化才值得让界面重新拉一次状态。 */
  private notifyIfActive(id: string): void {
    if (id === this.activeId) this.notify();
  }

  private notify(): void {
    this.ctx.notifySiteChanged();
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
