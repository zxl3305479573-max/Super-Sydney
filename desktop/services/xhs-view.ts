import { shell, WebContentsView, type BrowserWindow } from 'electron';
import type { AppContext } from '../app-context';
import type { SiteViewBounds, XhsPageRead, XhsViewState } from '../shared';
import { clampSiteBounds } from './site-config';
import { XHS_PUBLISH_URL } from './xhs-catalog';
import { isXhsHost, normalizePageRead, XHS_PAGE_EXTRACT_SCRIPT, type RawPageExtract } from './xhs-page-parse';

const XHS_PARTITION = 'persist:sydney-xhs';
const XHS_HOME = 'https://www.xiaohongshu.com/explore';
/** 两次读取之间至少隔这么久：读取是用户点出来的，但连点也不该连续请求页面。 */
const READ_INTERVAL_MS = 3000;

/**
 * 应用内的小红书窗口（设计草案里的来源 ③）。
 *
 * 一个挂在主窗口上的 WebContentsView，独立会话分区：登录由用户自己在窗口里完成，应用不碰账号密码。
 * 「读取」只在用户点按钮时执行，只读当前已渲染的 DOM（见 xhs-page-parse 的抽取脚本），
 * 不自动滚动、不翻页、不调内部接口；遇到登录墙或验证页直接报错交给用户。
 */
export class XhsView {
  private view: WebContentsView | null = null;
  private bounds: SiteViewBounds | null = null;
  private wanted = false;
  private attached = false;
  private loading = false;
  /** 是否已经让视图打开过页面。只看 getURL() 不够：跳转途中旧页已停、新页还没提交时它是空的。 */
  private started = false;
  private error = '';
  private lastRead = 0;

  constructor(private readonly ctx: AppContext) {}

  state(): XhsViewState {
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

  show(): XhsViewState {
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

  navigate(target: { kind?: unknown; value?: unknown }): XhsViewState {
    const view = this.ensureView();
    let url = XHS_HOME;
    if (target.kind === 'search') {
      const keyword = String(target.value ?? '').trim();
      if (!keyword) throw new Error('请输入要搜索的关键词');
      url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
    } else if (target.kind === 'publish') {
      url = XHS_PUBLISH_URL;
    } else if (target.kind === 'url') {
      url = String(target.value ?? '').trim();
      if (!isXhsHost(url)) throw new Error('只能在这个窗口里打开小红书的页面');
    }
    this.error = '';
    void this.load(view, url);
    return this.state();
  }

  go(action: 'back' | 'reload'): XhsViewState {
    const contents = this.liveContents();
    if (contents) {
      if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      if (action === 'reload') contents.reload();
    }
    return this.state();
  }

  async read(): Promise<XhsPageRead> {
    const contents = this.liveContents();
    if (!contents || !contents.getURL()) throw new Error('小红书窗口还没打开页面');
    if (!isXhsHost(contents.getURL())) throw new Error('当前页面不是小红书，无法读取');
    const now = Date.now();
    if (now - this.lastRead < READ_INTERVAL_MS) throw new Error('读取太频繁了，请过几秒再试');
    this.lastRead = now;
    const raw = await contents.executeJavaScript(XHS_PAGE_EXTRACT_SCRIPT, true) as RawPageExtract;
    return normalizePageRead(raw ?? {});
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
    this.ctx.window()?.webContents.send('xhs:view-changed');
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
      if (!this.started) void this.load(view, XHS_HOME);
    }
    if (before !== this.attached) this.notify();
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({ webPreferences: { partition: XHS_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
    const contents = view.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.setWindowOpenHandler(({ url }) => {
      // 小红书内部链接留在窗口里打开，其它站点交给系统浏览器。
      if (isXhsHost(url)) void this.load(view, url);
      else if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => { if (!/^https:\/\//.test(url)) event.preventDefault(); });
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
