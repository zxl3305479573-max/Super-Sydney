import fs from 'node:fs';
import path from 'node:path';
import { session, shell, WebContentsView, type BrowserWindow } from 'electron';
import type { AppContext } from '../app-context';
import type { SiteViewBounds, XhsPageRead, XhsViewState } from '../shared';
import { clampSiteBounds } from './site-config';
import { XHS_PUBLISH_URL } from './xhs-catalog';
import { isXhsHost, normalizePageRead, XHS_PAGE_EXTRACT_SCRIPT, type RawPageExtract } from './xhs-page-parse';
import { listXhsAccounts } from './xhs-store';

/** 早期版本所有账号共用的会话分区；启动时迁给第一个账号（见 migrateLegacyPartition）。 */
const LEGACY_PARTITION = 'sydney-xhs';
const XHS_HOME = 'https://www.xiaohongshu.com/explore';
/** 两次读取之间至少隔这么久：读取是用户点出来的，但连点也不该连续请求页面。 */
const READ_INTERVAL_MS = 3000;

/** 每个账号一个会话分区：登录状态、cookie 互不相通，切账号不用退出重登。 */
export function xhsPartitionName(accountId: number): string {
  return `sydney-xhs-account-${accountId}`;
}

/** 一个账号的窗口：视图建好就留着，切回来时登录状态和浏览位置都还在。 */
type AccountView = { view: WebContentsView; loading: boolean; error: string; started: boolean };

/**
 * 应用内的小红书窗口（设计草案里的来源 ③）。
 *
 * 每个小红书账号一个挂在主窗口上的 WebContentsView，各用自己的会话分区：登录由用户在窗口里完成，
 * 应用不碰账号密码，A 号的登录状态不会出现在 B 号的窗口里。同一时刻只挂当前账号的那一个。
 * 「读取」只在用户点按钮时执行，只读当前已渲染的 DOM（见 xhs-page-parse 的抽取脚本），
 * 不自动滚动、不翻页、不调内部接口；遇到登录墙或验证页直接报错交给用户。
 */
export class XhsView {
  private views = new Map<number, AccountView>();
  private accountId = 0;
  private bounds: SiteViewBounds | null = null;
  private wanted = false;
  /** 当前挂在窗口上的账号；0 表示没挂。 */
  private attachedId = 0;
  private lastRead = 0;

  constructor(private readonly ctx: AppContext) {
    migrateLegacyPartition(ctx);
  }

  state(): XhsViewState {
    const current = this.views.get(this.accountId);
    const contents = this.liveContents();
    return {
      url: contents?.getURL() ?? '',
      title: contents?.getTitle() ?? '',
      loading: Boolean(current?.loading),
      canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
      visible: this.attachedId !== 0 && this.attachedId === this.accountId,
      error: current?.error ?? ''
    };
  }

  /** 显示某个账号的窗口；换了账号就把上一个摘下来（它的进程留着，切回来原样）。 */
  show(accountId: unknown): XhsViewState {
    const id = Number(accountId);
    if (!Number.isInteger(id) || id <= 0 || !listXhsAccounts(this.ctx.db).some(account => account.id === id)) throw new Error('小红书账号不存在');
    this.accountId = id;
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
    const current = this.ensureView();
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
    current.error = '';
    void this.load(current, url);
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

  /** 账号被删除：关掉它的窗口并清空它的会话数据（cookie、缓存、本地存储）。 */
  async forget(accountId: number): Promise<void> {
    const current = this.views.get(accountId);
    if (current) {
      if (this.attachedId === accountId) this.detach(current.view);
      try { current.view.webContents.close(); } catch { /* 进程已退出 */ }
      this.views.delete(accountId);
    }
    if (this.accountId === accountId) this.accountId = 0;
    try { await session.fromPartition(`persist:${xhsPartitionName(accountId)}`).clearStorageData(); } catch { /* 清不掉也不影响别的账号 */ }
  }

  dispose(): void {
    for (const current of this.views.values()) {
      this.detach(current.view);
      try { current.view.webContents.close(); } catch { /* 进程已退出 */ }
    }
    this.views.clear();
    this.attachedId = 0;
  }

  private liveWindow(): BrowserWindow | null {
    const win = this.ctx.window();
    return win && !win.isDestroyed() ? win : null;
  }

  private liveContents() {
    const contents = this.views.get(this.accountId)?.view.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  private notify(): void {
    this.ctx.window()?.webContents.send('xhs:view-changed');
  }

  private detach(view: WebContentsView): void {
    const win = this.liveWindow();
    if (win) {
      try { win.contentView.removeChildView(view); } catch { /* 已不在视图树上 */ }
    }
    this.attachedId = 0;
  }

  private sync(): void {
    const win = this.liveWindow();
    if (!win) return;
    const before = this.attachedId;
    const previous = this.views.get(this.attachedId);
    if (!this.wanted || !this.bounds || !this.accountId) {
      if (previous) this.detach(previous.view);
    } else {
      const current = this.ensureView();
      if (previous && this.attachedId !== this.accountId) this.detach(previous.view);
      if (!this.attachedId) { win.contentView.addChildView(current.view); this.attachedId = this.accountId; }
      current.view.setBounds(this.bounds);
      if (!current.started) void this.load(current, XHS_HOME);
    }
    if (before !== this.attachedId) this.notify();
  }

  private ensureView(): AccountView {
    const accountId = this.accountId;
    if (!accountId) throw new Error('还没有选定小红书账号');
    const existing = this.views.get(accountId);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    const view = new WebContentsView({ webPreferences: { partition: `persist:${xhsPartitionName(accountId)}`, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
    const current: AccountView = { view, loading: false, error: '', started: false };
    // 只有当前显示的账号的变化才需要让界面重新拉状态。
    const changed = () => { if (this.accountId === accountId) this.notify(); };
    const contents = view.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.setWindowOpenHandler(({ url }) => {
      // 小红书内部链接留在窗口里打开，其它站点交给系统浏览器。
      if (isXhsHost(url)) void this.load(current, url);
      else if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => { if (!/^https:\/\//.test(url)) event.preventDefault(); });
    contents.on('did-start-loading', () => { current.loading = true; current.error = ''; changed(); });
    contents.on('did-stop-loading', () => { current.loading = false; changed(); });
    contents.on('did-navigate', changed);
    contents.on('did-navigate-in-page', changed);
    contents.on('page-title-updated', changed);
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      current.loading = false;
      current.error = `页面打不开：${description}（${code}）`;
      changed();
    });
    contents.on('render-process-gone', () => { current.loading = false; current.error = '页面进程已退出，点「刷新」重试'; changed(); });
    this.views.set(accountId, current);
    return current;
  }

  /** started 标记「已经让视图打开过页面」：只看 getURL() 不够，跳转途中旧页已停、新页还没提交时它是空的。 */
  private async load(current: AccountView, url: string): Promise<void> {
    current.started = true;
    try {
      await current.view.webContents.loadURL(url);
    } catch (error) {
      // 被新的导航顶掉（ERR_ABORTED / -3）不算失败：新页面会接着加载，失败另有 did-fail-load 报。
      if (isAborted(error)) return;
      current.loading = false;
      if (!current.error) current.error = `页面打不开：${error instanceof Error ? error.message : String(error)}`;
      this.notify();
    }
  }
}

/**
 * 早期版本只有一个共用分区：把它整个目录改名给第一个账号，已经登录的那个号不用重新登录。
 * 只在新分区还不存在时做一次；必须在任何视图用到这些分区之前（构造时）执行。失败了顶多是要重新登录。
 */
function migrateLegacyPartition(ctx: AppContext): void {
  try {
    const first = listXhsAccounts(ctx.db)[0];
    if (!first) return;
    const root = path.join(ctx.dataDir, 'Partitions');
    const legacy = path.join(root, LEGACY_PARTITION);
    const target = path.join(root, xhsPartitionName(first.id));
    if (fs.existsSync(legacy) && !fs.existsSync(target)) fs.renameSync(legacy, target);
  } catch {
    // 目录被占用等情况：保留旧目录，第一个账号在窗口里重新登录即可。
  }
}

function isAborted(error: unknown): boolean {
  const record = error as { code?: unknown; errno?: unknown } | null;
  return record?.code === 'ERR_ABORTED' || record?.errno === -3;
}
