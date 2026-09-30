import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolveVaultPath } from './services/vault-path';
import { defaultSettings, mergeSettings } from './services/app-settings';
import { CodexSessionAdapter, shouldRunCodexCapture } from './services/codex-session-adapter';
import { migrateCodexEventColumns, persistCodexMessage } from './services/codex-event-store';
import type { CodexCaptureStatus, Settings, WorkEvent } from './shared';

const projectPath = path.resolve(__dirname, '../..');
const defaultVaultPath = String.raw`D:\33054\Documents\persornal\Sydney`;
let dataDir = '';
let settingsPath = '';
let db!: DatabaseSync;
let windowRef: BrowserWindow | null = null;
let captureTimer: NodeJS.Timeout | undefined;
let activeStartedAt = 0;
let activeApp = '';
let codexAdapter: CodexSessionAdapter | undefined;
let codexCapture: CodexCaptureStatus = { state: 'disabled', error: '' };

function currentSettings(): Settings {
  try { return mergeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Partial<Settings>, defaultVaultPath, projectPath); }
  catch { return defaultSettings(defaultVaultPath, projectPath); }
}

function broadcast() { windowRef?.webContents.send('state:changed'); }
function allEvents(): WorkEvent[] { return db.prepare('SELECT * FROM events ORDER BY datetime(created_at) DESC LIMIT 200').all() as WorkEvent[]; }
function insertEvent(event: Partial<WorkEvent>): number {
  const result = db.prepare(`INSERT INTO events (created_at, app_name, window_title, kind, note, duration_seconds, status, value_score, summary, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.created_at || new Date().toISOString(), event.app_name || '', event.window_title || '', event.kind || 'manual', event.note || '', event.duration_seconds || 0, event.status || 'pending', event.value_score || 0, event.summary || '', event.category || '个人成长');
  broadcast();
  return Number(result.lastInsertRowid);
}
function getState() {
  const day = new Date().toISOString().slice(0, 10);
  const stats = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, COALESCE(SUM(duration_seconds),0) AS duration FROM events WHERE created_at LIKE ?`).get(`${day}%`) as { total: number; pending: number; duration: number };
  return { settings: currentSettings(), stats, events: allEvents(), codexCapture };
}
function refreshCodexAdapter(): void {
  const config = currentSettings();
  if (!shouldRunCodexCapture(config.codexCaptureEnabled, config.captureEnabled, config.capturePaused)) {
    codexAdapter?.stop();
    codexCapture = { state: config.codexCaptureEnabled ? 'stopped' : 'disabled', error: '' };
    return;
  }
  if (!codexAdapter) {
    codexAdapter = new CodexSessionAdapter(
      path.join(app.getPath('home'), '.codex', 'sessions'),
      message => { persistCodexMessage(db, message); broadcast(); },
      error => { codexCapture = { state: 'error', error }; broadcast(); }
    );
  }
  codexAdapter.start();
  codexCapture = { state: 'listening', error: '' };
}
function setCapture(mode: 'start' | 'pause' | 'stop') {
  const config = currentSettings();
  config.captureEnabled = mode !== 'stop';
  config.capturePaused = mode === 'pause';
  fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2));
  if (captureTimer) clearInterval(captureTimer); captureTimer = undefined; activeStartedAt = 0; activeApp = '';
  if (config.captureEnabled && !config.capturePaused) { void captureTick(); captureTimer = setInterval(() => void captureTick(), Math.max(10, config.captureIntervalSeconds) * 1000); }
  refreshCodexAdapter();
  broadcast();
}
async function captureTick() {
  const config = currentSettings();
  if (!config.captureEnabled || config.capturePaused) return;
  try {
    const activeWindow = await import('active-win');
    const active = await activeWindow.default();
    const appName = active?.owner?.name || '';
    const title = active?.title || '';
    const blocked = config.blockedApps.some(name => `${appName} ${title}`.toLowerCase().includes(name.toLowerCase())) || /password|sign in|login|payment|checkout|bank|密码|支付|银行卡|私聊|private/i.test(title);
    const allowed = !config.allowedApps.length || config.allowedApps.some(name => appName.toLowerCase().includes(name.toLowerCase()));
    if (!appName || blocked || !allowed) { activeApp = ''; activeStartedAt = 0; return; }
    const now = Date.now();
    if (activeApp === appName && activeStartedAt) {
      insertEvent({ kind: 'activity', app_name: appName, window_title: title.slice(0, 240), duration_seconds: Math.max(1, Math.round((now - activeStartedAt) / 1000)), status: 'pending' });
    }
    activeApp = appName; activeStartedAt = now;
  } catch { /* Active-window support is platform dependent. */ }
}
function writeDailySummary() {
  const vault = currentSettings().vaultPath;
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(vault, '02-每日总结', `${day}.md`);
  const rows = db.prepare(`SELECT * FROM events WHERE created_at LIKE ? AND source <> 'codex' ORDER BY datetime(created_at) ASC`).all(`${day}%`) as WorkEvent[];
  const generated = `## Sydney 工作记录\n\n${rows.map(event => `- ${event.created_at.slice(11, 16)} ${event.app_name || '手动记录'}：${event.note || event.window_title || '未填写'}（${event.status}，${Math.round(event.duration_seconds / 60)} 分钟）`).join('\n') || '- 今天还没有记录的工作事件。'}\n\n## 明日重点\n\n- [ ] 根据今天的记录补充明日最重要任务。`;
  const start = '<!-- SYDNEY:GENERATED:START -->'; const end = '<!-- SYDNEY:GENERATED:END -->';
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : `# 每日总结 ${day}\n`;
  const block = `${start}\n${generated}\n${end}`;
  const content = existing.includes(start) && existing.includes(end) ? existing.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block) : `${existing.trimEnd()}\n\n${block}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, 'utf8');
  return target;
}
function registerIpc() {
  ipcMain.handle('state:get', () => getState());
  ipcMain.handle('event:create', (_event, input: Partial<WorkEvent>) => insertEvent(input));
  ipcMain.handle('event:update', (_event, id: number, patch: Partial<WorkEvent>) => {
    const allowed = ['note', 'status', 'category', 'value_score', 'summary'];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (entries.length) db.prepare(`UPDATE events SET ${entries.map(([key]) => `${key}=?`).join(', ')} WHERE id=?`).run(...entries.map(([, value]) => value), id);
    broadcast();
  });
  ipcMain.handle('event:delete', (_event, id: number) => { db.prepare('DELETE FROM events WHERE id=?').run(id); broadcast(); });
  ipcMain.handle('capture:set', (_event, mode: 'start' | 'pause' | 'stop') => setCapture(mode));
  ipcMain.handle('settings:save', (_event, patch: Partial<Settings>) => {
    const previous = currentSettings();
    const next = { ...previous, ...patch };
    next.vaultPath = resolveVaultPath(next.vaultPath, defaultVaultPath, projectPath);
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
    if (next.captureEnabled !== previous.captureEnabled) setCapture(next.captureEnabled ? 'start' : 'stop');
    else refreshCodexAdapter();
    broadcast(); return next;
  });
  ipcMain.handle('vault:choose', async () => {
    const result = await dialog.showOpenDialog(windowRef!, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const next = { ...currentSettings(), vaultPath: resolveVaultPath(result.filePaths[0], defaultVaultPath, projectPath) };
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2)); broadcast(); return next.vaultPath;
  });
  ipcMain.handle('summary:daily', () => writeDailySummary());
  ipcMain.handle('vault:open', () => shell.openPath(currentSettings().vaultPath));
}
function createWindow() {
  windowRef = new BrowserWindow({ width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#f7f8fa', title: 'Sydney', webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false } });
  if (process.env.ELECTRON_RENDERER_URL) void windowRef.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void windowRef.loadFile(path.join(__dirname, '../renderer/index.html'));
}
app.whenReady().then(() => {
  dataDir = app.getPath('userData'); settingsPath = path.join(dataDir, 'settings.json'); fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'sydney.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT '', window_title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '', duration_seconds INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', value_score INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '个人成长'); CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);`);
  migrateCodexEventColumns(db);
  const startupSettings = currentSettings();
  fs.writeFileSync(settingsPath, JSON.stringify({ ...startupSettings, captureEnabled: false, capturePaused: false }, null, 2));
  refreshCodexAdapter();
  registerIpc(); createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { codexAdapter?.stop(); if (process.platform !== 'darwin') app.quit(); });
