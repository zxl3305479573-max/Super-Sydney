import { app, BrowserWindow, nativeTheme, net, safeStorage, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './app-context';
import { CaptureRuntime, migrateScreenFrameTable } from './capture-runtime';
import { registerCoreIpc } from './ipc/core';
import { registerContentIpc } from './ipc/content';
import { registerVideoIpc } from './ipc/video';
import { registerModelIpc } from './ipc/models';
import { registerWeWriteIpc } from './ipc/wewrite';
import { registerArticleStatsIpc } from './ipc/article-stats';
import { registerSiteIpc } from './ipc/site';
import { registerEmbeddedIpc } from './ipc/embedded';
import { registerXhsIpc } from './ipc/xiaohongshu';
import { registerIpIpc } from './ipc/ip';
import { IpLibrary } from './services/ip-library';
import { registerLinksIpc } from './ipc/links';
import { bindWindowChrome, installApplicationMenu, registerWindowIpc } from './ipc/window';
import { MIN_WINDOW_SIZE, WINDOW_BACKGROUND, readSavedTheme, readWindowState, restoreWindowState, settleWindowBounds, writeWindowState } from './services/window-state';
import iconIco from './assets/icon.ico?asset';
import iconPng from './assets/icon.png?asset';
import { migrateArticleStatTables } from './services/article-stats-store';
import { SettingsFile } from './services/app-settings';
import { writerEndpoint } from './services/content-api-config';
import { migrateCodexEventColumns } from './services/codex-event-store';
import { migrateAiDraftColumns } from './services/ai-draft-store';
import { migrateRuleTables } from './services/evolution-rules';
import { migrateCardColumns } from './services/experience-cards';
import { adoptAccountProfile, migrateContentTables, seedContentTaxonomy } from './services/content-store';
import { parseStyleSummary, yamlBlock, yamlScalar } from './services/wewrite-config';
import { readWeWriteFiles } from './services/wewrite-files';
import { migrateVideoTables } from './services/video-store';
import { migrateXhsTables } from './services/xhs-store';
import { migrateLinkTables } from './services/link-store';
import { migrateEventMetadataColumns, migrateEventTables } from './services/event-store';
import { useImageFetch } from './services/image-generation';
import { ModelPresetStore } from './services/model-presets';
import { resolveLlmApiKey, SecretStore } from './services/secret-store';
import { LastPages } from './services/last-pages';
import { SiteView } from './services/site-view';
import { XhsView } from './services/xhs-view';

const projectPath = path.resolve(__dirname, '../..');
const defaultVaultPath = String.raw`D:\33054\Documents\persornal\Sydney`;

let windowRef: BrowserWindow | null = null;
let capture: CaptureRuntime | undefined;
let siteView: SiteView | undefined;
let xhsView: XhsView | undefined;
let embeddedViews: { closeAll(): void; dispose(): void } | undefined;

/**
 * 嵌入的网页（公众号后台、小红书、闲鱼、站点）是独立进程，盖在主界面上。
 * 主界面重载或崩溃时它们不会跟着消失，会悬浮在黑底上；先全部收起，界面起来后哪个页面需要会自己再打开。
 */
function closeEmbeddedViews(): void {
  siteView?.close();
  xhsView?.close();
  embeddedViews?.closeAll();
}

/** 主界面进程退出的原因记到 userData/crash.log，下次出现黑窗时有据可查。 */
function logRendererGone(details: Electron.RenderProcessGoneDetails): void {
  const line = `${new Date().toISOString()} 主界面进程退出：reason=${details.reason} exitCode=${details.exitCode}\n`;
  console.error(line.trim());
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line); } catch { /* 写日志失败不影响恢复 */ }
}

/** 建表与补列。顺序有依赖：codex 迁移会给 events 加 source 列，元数据列要在它之后。 */
function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  migrateScreenFrameTable({ db });
  migrateEventTables(db);
  const profileColumnsAdded = migrateContentTables(db);
  migrateVideoTables(db);
  migrateXhsTables(db);
  migrateLinkTables(db);
  migrateArticleStatTables(db);
  migrateCodexEventColumns(db);
  migrateAiDraftColumns(db);
  migrateRuleTables(db);
  migrateCardColumns(db);
  seedContentTaxonomy(db);
  // 写作配置下放到公众号资料：刚补列时把 style.yaml 里的旧值迁过去（必须在种子数据之后）。
  if (profileColumnsAdded) {
    const { styleText, configText } = readWeWriteFiles();
    adoptAccountProfile(db, parseStyleSummary(styleText), yamlScalar(yamlBlock(configText, 'wechat'), 'author'));
  }
  migrateEventMetadataColumns(db);
  return db;
}

function createContext(): AppContext {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  const secretStore = new SecretStore(dataDir, safeStorage);
  const llmApiKey = () => resolveLlmApiKey(secretStore.read(), process.env.SYDNEY_LLM_API_KEY || '');
  const redfoxKeyStore = new SecretStore(dataDir, safeStorage, 'redfox-api-key.bin');
  return {
    db: openDatabase(path.join(dataDir, 'sydney.db')),
    dataDir,
    homeDir: app.getPath('home'),
    settings: new SettingsFile(path.join(dataDir, 'settings.json'), defaultVaultPath, projectPath),
    secretStore,
    redfoxKeyStore,
    videoTtsKeyStore: new SecretStore(dataDir, safeStorage, 'video-tts-api-key.bin'),
    lastPages: new LastPages(dataDir),
    ipLibrary: new IpLibrary(dataDir),
    modelPresets: new ModelPresetStore(dataDir, new SecretStore(dataDir, safeStorage, 'model-preset-keys.bin')),
    llmApiKey,
    redfoxApiKey: () => resolveLlmApiKey(redfoxKeyStore.read(), process.env.REDFOX_API_KEY || ''),
    // 和公众号、视频、小红书用同一个内容模型（「设置 → 模型」）。
    llmConfig: () => ({ apiKey: llmApiKey(), ...writerEndpoint(readWeWriteFiles().configText) }),
    broadcast: () => windowRef?.webContents.send('state:changed'),
    notifyWeWriteChanged: () => windowRef?.webContents.send('wewrite:changed'),
    notifySiteChanged: () => windowRef?.webContents.send('site:changed'),
    notifyIpChanged: () => windowRef?.webContents.send('ip:changed'),
    window: () => windowRef
  };
}

const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const themeFile = () => path.join(app.getPath('userData'), 'appearance.json');

/**
 * 主窗口不带系统标题栏和菜单栏：标题栏、窗口按钮由界面自绘（renderer/TitleBar.tsx）。
 * Windows 上用 titleBarStyle: 'hidden' 而不是 frame: false——前者保留系统边框，拖边缩放、贴靠分屏、阴影都还在。
 * 窗口先隐藏，界面画出第一帧再显示，避免启动时闪一下白底；位置与尺寸沿用上次关闭时的。
 */
function createWindow() {
  const mac = process.platform === 'darwin';
  const dev = Boolean(process.env.ELECTRON_RENDERER_URL);
  const saved = restoreWindowState(readWindowState(windowStateFile()), screen.getAllDisplays().map(display => display.workArea));
  // 没选过主题时跟随系统，和界面首帧的判断一致。
  const theme = readSavedTheme(themeFile()) ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  nativeTheme.themeSource = theme;
  const win = new BrowserWindow({
    x: saved.x, y: saved.y, width: saved.width, height: saved.height,
    minWidth: MIN_WINDOW_SIZE.width, minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    backgroundColor: WINDOW_BACKGROUND[theme],
    title: 'Sydney',
    icon: process.platform === 'win32' ? iconIco : iconPng,
    // 拼写检查词典要从 Google 下载，国内网络下只会失败；中文写作场景也用不上英文拼写下划线。
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  windowRef = win;
  // 建窗后立刻读回的边界做参照：关窗时没被用户改过的项沿用请求值（高 DPI 下读回值会多几像素，见 settleWindowBounds）。
  const reported = win.getBounds();
  bindWindowChrome(win, { shortcut: !app.isPackaged, inspect: dev });
  // 主界面重新加载（包括崩溃后的自动重载、开发时的整页刷新）前，先把嵌入网页收起来。
  win.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) closeEmbeddedViews(); });
  // 主界面崩溃时自动重载；一分钟内崩了 3 次以上就停手，免得反复崩溃把机器拖住。
  let crashes: number[] = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    logRendererGone(details);
    closeEmbeddedViews();
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    crashes = [...crashes.filter(at => now - at < 60_000), now];
    if (crashes.length <= 3) win.webContents.reload();
  });
  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize();
    win.show();
  });
  win.on('close', () => writeWindowState(windowStateFile(), settleWindowBounds(saved, reported, win.getNormalBounds()), win.isMaximized()));
  win.on('closed', () => { if (windowRef === win) windowRef = null; });
  if (dev) void win.loadURL(process.env.ELECTRON_RENDERER_URL as string);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// 只允许一个实例：两个进程同时写同一个 sydney.db 和采样状态会互相打架。再次启动时把已有窗口叫到前台。
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  if (!windowRef || windowRef.isDestroyed()) return;
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.show();
  windowRef.focus();
});
if (process.platform === 'win32') app.setAppUserModelId('com.sydney.workos');

if (primaryInstance) app.whenReady().then(() => {
  // 生图请求走 Electron 的网络栈：跟随系统代理（Node 自带的 fetch 不读代理，国内直连图片网关会超时）。
  useImageFetch((input, init) => net.fetch(input as string, init));
  installApplicationMenu();
  const ctx = createContext();
  // 前台采样每次启动都从关闭状态开始，必须由用户在界面上重新开启。
  ctx.settings.write({ ...ctx.settings.read(), captureEnabled: false, capturePaused: false });
  capture = new CaptureRuntime(ctx);
  capture.start();
  // 变现模块的站点视图：窗口还没创建时只构造，真正挂上去要等界面报位置。
  siteView = new SiteView(ctx);
  registerCoreIpc(ctx, capture);
  registerContentIpc(ctx);
  registerVideoIpc(ctx);
  xhsView = new XhsView(ctx);
  registerIpIpc(ctx);
  registerXhsIpc(ctx, xhsView);
  registerWeWriteIpc(ctx);
  registerModelIpc(ctx);
  registerArticleStatsIpc(ctx);
  registerLinksIpc(ctx);
  registerSiteIpc(ctx, siteView);
  // 变现分组里固定嵌入的站点（闲鱼、16688）：每个站点一个独立会话的视图。
  embeddedViews = registerEmbeddedIpc(ctx);
  // 网页地址的记录是攒一会儿再落盘的，退出前补写一次。
  app.on('will-quit', () => ctx.lastPages.flush());
  registerWindowIpc(() => windowRef, themeFile());
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => {
  capture?.dispose();
  siteView?.dispose();
  xhsView?.dispose();
  embeddedViews?.dispose();
  if (process.platform !== 'darwin') app.quit();
});
