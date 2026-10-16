import { BrowserWindow, Menu, ipcMain, nativeTheme, type MenuItemConstructorOptions } from 'electron';
import { openUrl } from '../services/browser';
import type { AppTheme, WindowChromeState, WindowControl } from '../shared';
import { WINDOW_BACKGROUND, writeSavedTheme } from '../services/window-state';

/* ── 窗口外壳 ─────────────────────────────────────────────────
 * 主窗口不用系统标题栏和菜单栏：标题栏与最小化 / 最大化 / 关闭按钮由界面自绘（TitleBar），
 * 这里只负责执行按钮动作、把最大化与焦点变化推回界面。
 * 顺带补上桌面应用该有的边界：中文右键菜单、外链交给系统浏览器、主界面不会被拖进来的文件或链接导航走。
 */

export function chromeState(win: BrowserWindow | null): WindowChromeState {
  const alive = win && !win.isDestroyed() ? win : null;
  return { maximized: Boolean(alive?.isMaximized()), fullscreen: Boolean(alive?.isFullScreen()), focused: Boolean(alive?.isFocused()), platform: process.platform };
}

export function registerWindowIpc(getWindow: () => BrowserWindow | null, themeFile: string): void {
  ipcMain.handle('window:chrome', () => chromeState(getWindow()));
  ipcMain.handle('window:control', (_event, action: WindowControl) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'toggle-maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else if (action === 'close') win.close();
  });
  // 界面换主题：系统部件（右键菜单、滚动条外的窗口底色）跟着换，并记下来供下次建窗用。
  ipcMain.handle('window:theme', (_event, theme: AppTheme) => {
    const next = theme === 'dark' ? 'dark' : 'light';
    nativeTheme.themeSource = next;
    getWindow()?.setBackgroundColor(WINDOW_BACKGROUND[next]);
    writeSavedTheme(themeFile, next);
  });
}

/** 同一页面（只差查询串或锚点）的跳转放行，其余一律拦下。 */
function sameDocument(next: string, current: string): boolean {
  try {
    const a = new URL(next);
    const b = new URL(current);
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * 主窗口创建后调用一次。
 * devTools：开发模式下保留 F12 / Ctrl+Shift+I 与右键「检查元素」；正式使用时这些入口都不出现。
 */
export function bindWindowChrome(win: BrowserWindow, devTools: { shortcut: boolean; inspect: boolean }): void {
  const contents = win.webContents;
  // 主界面重载或崩溃的那一刻页面框架已经销毁，这时发消息会抛错；丢掉这一次即可，界面起来后会重新读取状态。
  const push = () => {
    if (win.isDestroyed() || contents.isDestroyed() || contents.isCrashed()) return;
    try { contents.send('window:chrome-changed', chromeState(win)); } catch { /* 页面正在重载 */ }
  };
  win.on('maximize', push);
  win.on('unmaximize', push);
  win.on('restore', push);
  win.on('enter-full-screen', push);
  win.on('leave-full-screen', push);
  win.on('focus', push);
  win.on('blur', push);

  // 界面里的外链（以及 target=_blank）一律交给系统浏览器，不在应用里开新窗口。
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void openUrl(url);
    return { action: 'deny' };
  });
  // 拖进窗口的文件、误点的链接都会让主界面整页跳走；只放行同一页面的刷新。
  contents.on('will-navigate', (event, url) => {
    if (sameDocument(url, contents.getURL())) return;
    event.preventDefault();
    if (isWebUrl(url)) void openUrl(url);
  });

  contents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    const flags = params.editFlags;
    if (params.isEditable) {
      template.push(
        { label: '撤销', role: 'undo', enabled: flags.canUndo },
        { label: '重做', role: 'redo', enabled: flags.canRedo },
        { type: 'separator' },
        { label: '剪切', role: 'cut', enabled: flags.canCut },
        { label: '复制', role: 'copy', enabled: flags.canCopy },
        { label: '粘贴', role: 'paste', enabled: flags.canPaste },
        { label: '粘贴为纯文本', role: 'pasteAndMatchStyle', enabled: flags.canPaste },
        { type: 'separator' },
        { label: '全选', role: 'selectAll', enabled: flags.canSelectAll }
      );
    } else if (params.selectionText.trim()) {
      template.push({ label: '复制', role: 'copy' });
    }
    if (isWebUrl(params.linkURL)) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: '在浏览器中打开链接', click: () => void openUrl(params.linkURL) });
    }
    if (devTools.inspect) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: '检查元素', click: () => contents.inspectElement(params.x, params.y) });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
  });

  if (devTools.shortcut) {
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        event.preventDefault();
        contents.toggleDevTools();
      }
    });
  }
}

/** Windows / Linux 不要菜单栏（复制粘贴等编辑快捷键由 Chromium 自己处理）；macOS 必须保留编辑菜单，否则 ⌘C / ⌘V 失效。 */
export function installApplicationMenu(): void {
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null);
}
