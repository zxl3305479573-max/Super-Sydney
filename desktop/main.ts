import { app, BrowserWindow, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './app-context';
import { CaptureRuntime, migrateScreenFrameTable } from './capture-runtime';
import { registerCoreIpc } from './ipc/core';
import { registerContentIpc } from './ipc/content';
import { registerVideoIpc } from './ipc/video';
import { registerWeWriteIpc } from './ipc/wewrite';
import { registerArticleStatsIpc } from './ipc/article-stats';
import { migrateArticleStatTables } from './services/article-stats-store';
import { SettingsFile } from './services/app-settings';
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from './services/content-api-config';
import { migrateCodexEventColumns } from './services/codex-event-store';
import { migrateAiDraftColumns } from './services/ai-draft-store';
import { migrateRuleTables } from './services/evolution-rules';
import { migrateCardColumns } from './services/experience-cards';
import { migrateContentTables, seedContentTaxonomy } from './services/content-store';
import { migrateVideoTables } from './services/video-store';
import { migrateEventMetadataColumns, migrateEventTables } from './services/event-store';
import { resolveLlmApiKey, SecretStore } from './services/secret-store';

const projectPath = path.resolve(__dirname, '../..');
const defaultVaultPath = String.raw`D:\33054\Documents\persornal\Sydney`;

let windowRef: BrowserWindow | null = null;
let capture: CaptureRuntime | undefined;

/** 建表与补列。顺序有依赖：codex 迁移会给 events 加 source 列，元数据列要在它之后。 */
function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  migrateScreenFrameTable({ db });
  migrateEventTables(db);
  migrateContentTables(db);
  migrateVideoTables(db);
  migrateArticleStatTables(db);
  migrateCodexEventColumns(db);
  migrateAiDraftColumns(db);
  migrateRuleTables(db);
  migrateCardColumns(db);
  seedContentTaxonomy(db);
  migrateEventMetadataColumns(db);
  return db;
}

function createContext(): AppContext {
  const dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  const secretStore = new SecretStore(dataDir, safeStorage);
  const llmApiKey = () => resolveLlmApiKey(secretStore.read(), process.env.SYDNEY_LLM_API_KEY || '');
  return {
    db: openDatabase(path.join(dataDir, 'sydney.db')),
    dataDir,
    homeDir: app.getPath('home'),
    settings: new SettingsFile(path.join(dataDir, 'settings.json'), defaultVaultPath, projectPath),
    secretStore,
    llmApiKey,
    llmConfig: () => ({
      apiKey: llmApiKey(),
      baseUrl: process.env.SYDNEY_LLM_BASE_URL || DEFAULT_LLM_BASE_URL,
      model: process.env.SYDNEY_LLM_MODEL || DEFAULT_LLM_MODEL
    }),
    broadcast: () => windowRef?.webContents.send('state:changed'),
    notifyWeWriteChanged: () => windowRef?.webContents.send('wewrite:changed'),
    window: () => windowRef
  };
}

function createWindow() {
  windowRef = new BrowserWindow({ width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#f7f8fa', title: 'Sydney', webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false } });
  if (process.env.ELECTRON_RENDERER_URL) void windowRef.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void windowRef.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  const ctx = createContext();
  // 前台采样每次启动都从关闭状态开始，必须由用户在界面上重新开启。
  ctx.settings.write({ ...ctx.settings.read(), captureEnabled: false, capturePaused: false });
  capture = new CaptureRuntime(ctx);
  capture.start();
  registerCoreIpc(ctx, capture);
  registerContentIpc(ctx);
  registerVideoIpc(ctx);
  registerWeWriteIpc(ctx);
  registerArticleStatsIpc(ctx);
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => {
  capture?.dispose();
  if (process.platform !== 'darwin') app.quit();
});
