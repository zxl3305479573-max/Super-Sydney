import fs from 'node:fs';
import path from 'node:path';
import { session, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { openUrl } from './browser';
import type { AppContext } from '../app-context';
import type { SiteViewBounds, XhsDraftFillResult, XhsPageRead, XhsViewState } from '../shared';
import { clampSiteBounds } from './site-config';
import { XHS_PUBLISH_URL } from './xhs-catalog';
import { isXhsHost, normalizePageRead, XHS_PAGE_EXTRACT_SCRIPT, type RawPageExtract } from './xhs-page-parse';
import { keepLoginAcrossRestarts } from './session-cookies';
import { listXhsAccounts } from './xhs-store';

/** 小红书网页版与创作者中心的登录 cookie 都写在 xiaohongshu.com 下。 */
const XHS_LOGIN_HOSTS = ['xiaohongshu.com'] as const;

/** 早期版本所有账号共用的会话分区；启动时迁给第一个账号（见 migrateLegacyPartition）。 */
const LEGACY_PARTITION = 'sydney-xhs';
const XHS_HOME = 'https://www.xiaohongshu.com/explore';
/** 两次读取之间至少隔这么久：读取是用户点出来的，但连点也不该连续请求页面。 */
const READ_INTERVAL_MS = 3000;
const DRAFT_PAGE_TIMEOUT_MS = 20_000;
const DRAFT_UPLOAD_TIMEOUT_MS = 120_000;

/** 切到图文发布 tab；页面有多套响应式节点，只在可见节点里找。 */
const XHS_IMAGE_PUBLISH_TAB_SCRIPT = `(() => {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const tab = Array.from(document.querySelectorAll('.creator-tab'))
    .find(element => visible(element) && (element.textContent || '').includes('上传图文'));
  if (!tab) return false;
  if (!tab.classList.contains('active')) tab.click();
  return true;
})()`;

const XHS_IMAGE_UPLOAD_READY_SCRIPT = `(() => Array.from(document.querySelectorAll('input.upload-input[type="file"]'))
  .some(element => (element.getAttribute('accept') || '').includes('.jpg') || (element.getAttribute('accept') || '').includes('image/')))()`;

const XHS_DRAFT_FORM_READY_SCRIPT = `(() => {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const title = Array.from(document.querySelectorAll('input.c-input_inner, input[placeholder*="标题"]')).find(visible);
  const editor = Array.from(document.querySelectorAll('.tiptap.ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"]'))
    .find(element => visible(element) && !element.closest('input'));
  return Boolean(title && editor);
})()`;

function fillDraftScript(input: { title: string; body: string }): string {
  return `(() => {
    const payload = ${JSON.stringify(input)};
    const visible = element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const title = Array.from(document.querySelectorAll('input.c-input_inner, input[placeholder*="标题"]')).find(visible);
    const editor = Array.from(document.querySelectorAll('.tiptap.ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"]'))
      .find(element => visible(element) && !element.closest('input'));
    if (!title || !editor) return { ok: false, reason: '发布页标题或正文输入框还没出现' };

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    title.focus();
    if (setter) setter.call(title, payload.title);
    else title.value = payload.title;
    title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload.title }));
    title.dispatchEvent(new Event('change', { bubbles: true }));
    title.blur();

    editor.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const inserted = document.execCommand('insertText', false, payload.body);
    if (!inserted) {
      editor.textContent = payload.body;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload.body }));
    }
    editor.blur();
    return {
      ok: true,
      title: title.value,
      bodyChars: (editor.innerText || editor.textContent || '').length
    };
  })()`;
}

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

  state(accountId: unknown): XhsViewState {
    const id = this.requireAccount(accountId);
    const current = this.views.get(id);
    const contents = this.liveContents(id);
    return {
      accountId: id,
      url: contents?.getURL() ?? '',
      title: contents?.getTitle() ?? '',
      loading: Boolean(current?.loading),
      canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
      visible: this.wanted && this.attachedId === id && this.accountId === id,
      error: current?.error ?? ''
    };
  }

  /** 显示某个账号的窗口；换了账号就把上一个摘下来（它的进程留着，切回来原样）。 */
  show(accountId: unknown): XhsViewState {
    const id = this.requireAccount(accountId);
    this.accountId = id;
    this.wanted = true;
    this.sync();
    return this.state(id);
  }

  close(accountId?: unknown): void {
    // 主界面重载 / 退出时没有账号上下文，只需把当前窗口摘下来。
    if (accountId === undefined) {
      this.wanted = false;
      this.sync();
      return;
    }
    const id = Number(accountId);
    if (!Number.isInteger(id) || id <= 0) return;
    // 旧账号卸载时发来的 close 可能晚于新账号的 open，不能把新账号的窗口关掉。
    if (this.accountId !== id) return;
    this.wanted = false;
    this.sync();
  }

  setBounds(accountId: unknown, input: unknown): void {
    const id = this.requireCurrent(accountId);
    const win = this.liveWindow();
    if (!win) this.bounds = null;
    else {
      const [width, height] = win.getContentSize();
      this.bounds = clampSiteBounds(input, { width, height });
    }
    this.sync();
    this.assertCurrent(id);
  }

  navigate(accountId: unknown, target: { kind?: unknown; value?: unknown }): XhsViewState {
    const id = this.requireCurrent(accountId);
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
    return this.state(id);
  }

  go(accountId: unknown, action: 'back' | 'reload'): XhsViewState {
    const id = this.requireCurrent(accountId);
    const contents = this.liveContents(id);
    if (contents) {
      if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      if (action === 'reload') contents.reload();
    }
    return this.state(id);
  }

  async read(accountId: unknown): Promise<XhsPageRead> {
    const id = this.requireCurrent(accountId);
    const contents = this.liveContents(id);
    if (!contents || !contents.getURL()) throw new Error('小红书窗口还没打开页面');
    if (!isXhsHost(contents.getURL())) throw new Error('当前页面不是小红书，无法读取');
    const now = Date.now();
    if (now - this.lastRead < READ_INTERVAL_MS) throw new Error('读取太频繁了，请过几秒再试');
    this.lastRead = now;
    const raw = await contents.executeJavaScript(XHS_PAGE_EXTRACT_SCRIPT, true) as RawPageExtract;
    // 页面脚本执行期间切了账号：这次结果属于旧账号，不能交给新账号的诊断 / 选题区。
    this.assertCurrent(id);
    return { ...normalizePageRead(raw ?? {}), accountId: id };
  }

  /**
   * 在当前账号的创作者中心前台页面里填入图文笔记。
   * 只通过页面自己的上传控件和输入框操作，最后停在编辑器，绝不点击发布按钮或调用内部接口。
   */
  async fillDraft(accountId: unknown, input: { title: string; body: string; images: string[] }): Promise<XhsDraftFillResult> {
    const id = this.requireAccount(accountId);
    this.accountId = id;
    this.wanted = true;
    this.sync();
    const current = this.ensureView();
    const contents = current.view.webContents;
    const images = [...new Set(input.images.map(file => path.resolve(file)))];
    if (!images.length) throw new Error('请至少添加一张图片，再填入发布页');
    if (images.length > 18) throw new Error('小红书图文笔记最多 18 张图片');
    for (const file of images) if (!fs.existsSync(file)) throw new Error(`图片文件不存在：${path.basename(file)}`);

    current.error = '';
    current.started = true;
    try {
      await contents.loadURL(XHS_PUBLISH_URL);
    } catch (error) {
      if (!isAborted(error)) throw error;
    }
    this.assertCurrent(id);
    await this.waitForScript(contents, XHS_IMAGE_PUBLISH_TAB_SCRIPT, DRAFT_PAGE_TIMEOUT_MS, '发布页没有出现「上传图文」入口，请先在当前账号的窗口里登录小红书');
    await wait(400);
    await this.waitForScript(contents, XHS_IMAGE_UPLOAD_READY_SCRIPT, DRAFT_PAGE_TIMEOUT_MS, '图文发布页没有出现图片上传控件');
    await this.setFileInput(contents, images);
    await this.waitForScript(contents, XHS_DRAFT_FORM_READY_SCRIPT, DRAFT_UPLOAD_TIMEOUT_MS, '图片上传后没有出现标题和正文编辑区；请检查图片是否上传成功');
    this.assertCurrent(id);
    const filled = await contents.executeJavaScript(fillDraftScript({ title: input.title, body: input.body }), true) as {
      ok?: boolean; reason?: string; title?: string; bodyChars?: number;
    };
    if (!filled?.ok) throw new Error(filled?.reason || '没有成功填入发布页');
    // 小红书在输入变化后自动把编辑中的笔记保存到浏览器草稿箱；留出一点时间让草稿状态落盘。
    await wait(2500);
    this.assertCurrent(id);
    return {
      accountId: id,
      imageCount: images.length,
      title: filled.title ?? input.title,
      bodyChars: filled.bodyChars ?? [...input.body].length
    };
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
    this.ctx.lastPages.forget(`xhs:${accountId}`);
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

  private liveContents(accountId = this.accountId) {
    const contents = this.views.get(accountId)?.view.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  private notify(accountId = this.accountId): void {
    this.ctx.window()?.webContents.send('xhs:view-changed', accountId);
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
      if (!current.started) {
        // 重启后第一次打开这个账号的窗口：回到上次停的小红书页面，否则首页。
        const saved = this.ctx.lastPages.get(`xhs:${this.accountId}`);
        void this.load(current, saved && isXhsHost(saved) ? saved : XHS_HOME);
      }
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
    const changed = () => { if (this.accountId === accountId) this.notify(accountId); };
    const contents = view.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    // 每个账号一个分区，各自保持登录：重启应用后不必重新扫码（见 session-cookies.ts）。
    keepLoginAcrossRestarts(contents.session, () => XHS_LOGIN_HOSTS);
    contents.setWindowOpenHandler(({ url }) => {
      // 小红书内部链接留在窗口里打开，其它站点交给系统浏览器。
      if (isXhsHost(url)) void this.load(current, url);
      else if (/^https?:\/\//.test(url)) void openUrl(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => { if (!/^https:\/\//.test(url)) event.preventDefault(); });
    contents.on('did-start-loading', () => { current.loading = true; current.error = ''; changed(); });
    contents.on('did-stop-loading', () => { current.loading = false; changed(); });
    const remember = (url: string) => { if (isXhsHost(url)) this.ctx.lastPages.set(`xhs:${accountId}`, url); };
    contents.on('did-navigate', (_event, url) => { remember(url); changed(); });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) remember(url); changed(); });
    contents.on('page-title-updated', changed);
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.ctx.lastPages.forget(`xhs:${accountId}`);
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
      this.notify(this.accountId);
    }
  }

  private requireAccount(value: unknown): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0 || !listXhsAccounts(this.ctx.db).some(account => account.id === id)) throw new Error('小红书账号不存在');
    return id;
  }

  /** 窗口操作必须属于当前选中的账号；上一个页面迟到的请求不能落到新账号上。 */
  private requireCurrent(value: unknown): number {
    const id = this.requireAccount(value);
    return this.assertCurrent(id);
  }

  private assertCurrent(id: number): number {
    if (this.accountId !== id) throw new Error('小红书账号已切换，已取消上一个账号的操作');
    return id;
  }

  private async waitForScript(contents: WebContents, script: string, timeoutMs: number, message: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      if (contents.isDestroyed()) throw new Error('小红书窗口已关闭');
      try {
        if (await contents.executeJavaScript(script, true)) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await wait(500);
    }
    throw new Error(`${message}${lastError ? `：${lastError}` : ''}`);
  }

  /** 文件框本身不接收脚本赋值，使用 Chromium 调试协议把本地图片交给它的 change 流程。 */
  private async setFileInput(contents: WebContents, files: string[]): Promise<void> {
    const cdp = contents.debugger;
    let attached = false;
    try {
      if (!cdp.isAttached()) {
        cdp.attach('1.3');
        attached = true;
      }
      const document = await cdp.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } };
      const found = await cdp.sendCommand('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: 'input.upload-input[type="file"][accept*=".jpg"]'
      }) as { nodeId: number };
      if (!found.nodeId) throw new Error('没有找到图片上传控件');
      await cdp.sendCommand('DOM.setFileInputFiles', { nodeId: found.nodeId, files });
    } finally {
      if (attached) {
        try { cdp.detach(); } catch { /* 页面已跳转 */ }
      }
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

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
