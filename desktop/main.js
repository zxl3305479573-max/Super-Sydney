const { app, BrowserWindow, dialog, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { shouldCapture, sanitizeWindow, retentionCutoff } = require('./capture-policy');

const vault = path.resolve(__dirname, '..');
const dataDir = path.join(vault, '.sydney');
const dbPath = path.join(dataDir, 'sydney.db');
const settingsPath = path.join(dataDir, 'settings.json');
let db;
let mainWindow;
let captureTimer;
let captureStartedAt = null;
let fileWatchers = [];
const fileEventDebounce = new Map();

function ensureStorage() {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      app_name TEXT NOT NULL DEFAULT '',
      window_title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'manual',
      note TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      screenshot_path TEXT NOT NULL DEFAULT '',
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      value_score INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '个人成长',
      source TEXT NOT NULL DEFAULT 'desktop'
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
  `);
}

function settings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return {
      captureEnabled: false,
      allowedApps: ['Code', 'Visual Studio Code', 'Obsidian', 'Google Chrome', 'Microsoft Edge', 'Terminal', 'PowerShell'],
      blockedApps: ['1Password', 'KeePass', '微信', 'WhatsApp', 'Telegram'],
      captureIntervalSeconds: 30,
      screenSamplingEnabled: false,
      retentionHours: 48,
      watchInputFiles: true,
      autoWriteObsidian: true,
      vaultPath: vault,
      cloudSyncEnabled: false,
      cloudUrl: 'http://127.0.0.1:8787'
    };
  }
}

function encryptionKey() {
  const keyPath = path.join(dataDir, 'capture.key');
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
  return fs.readFileSync(keyPath);
}

function encryptCapture(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function purgeExpiredCaptures() {
  const captureDir = path.join(dataDir, 'captures');
  if (!fs.existsSync(captureDir)) return;
  const cutoff = retentionCutoff(new Date(), settings().retentionHours);
  for (const file of fs.readdirSync(captureDir)) {
    const target = path.join(captureDir, file);
    if (fs.statSync(target).mtime < cutoff) fs.rmSync(target, { force: true });
  }
}

function saveSettings(next) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function todayPrefix() { return new Date().toISOString().slice(0, 10); }
function rows(sql, params = []) { return db.prepare(sql).all(...params); }

function insertEvent(event) {
  const result = db.prepare(`INSERT INTO events
    (created_at, app_name, window_title, kind, note, file_path, screenshot_path, duration_seconds, status, value_score, summary, category, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      event.created_at || new Date().toISOString(), event.app_name || '', event.window_title || '', event.kind || 'manual',
      event.note || '', event.file_path || '', event.screenshot_path || '', event.duration_seconds || 0,
      event.status || 'pending', event.value_score || 0, event.summary || '', event.category || '个人成长', event.source || 'desktop'
    );
  return Number(result.lastInsertRowid);
}

function stats() {
  const day = todayPrefix();
  const total = rows('SELECT COUNT(*) AS count FROM events WHERE created_at LIKE ?', [`${day}%`])[0].count;
  const pending = rows("SELECT COUNT(*) AS count FROM events WHERE status = 'pending'")[0].count;
  const duration = rows('SELECT COALESCE(SUM(duration_seconds), 0) AS seconds FROM events WHERE created_at LIKE ?', [`${day}%`])[0].seconds;
  const topics = rows('SELECT category, COUNT(*) AS count FROM events WHERE created_at LIKE ? GROUP BY category ORDER BY count DESC LIMIT 5', [`${day}%`]);
  return { total, pending, duration, topics };
}

function events(filter = {}) {
  const clauses = [];
  const values = [];
  if (filter.status && filter.status !== 'all') { clauses.push('status = ?'); values.push(filter.status); }
  if (filter.query) { clauses.push('(note LIKE ? OR app_name LIKE ? OR window_title LIKE ?)'); const q = `%${filter.query}%`; values.push(q, q, q); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return rows(`SELECT * FROM events ${where} ORDER BY datetime(created_at) DESC LIMIT 100`, values);
}

function updateEvent(id, patch) {
  const allowed = ['status', 'note', 'summary', 'category', 'value_score'];
  const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  const values = entries.map(([, value]) => value);
  const set = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE events SET ${set} WHERE id = ?`).run(...values, id);
}

async function draftEvent(id) {
  const event = rows('SELECT * FROM events WHERE id = ?', [id])[0];
  if (!event) throw new Error('事件不存在');
  const base = {
    summary: `${event.app_name || '手动记录'} 中的工作：${event.note || event.window_title || '待补充上下文'}`,
    category: event.category || inferCategory(event.app_name, event.window_title),
    value_score: event.note ? 1 : 0
  };
  const baseUrl = (process.env.SYDNEY_LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.SYDNEY_LLM_API_KEY;
  const model = process.env.SYDNEY_LLM_MODEL;
  if (baseUrl && apiKey && model && typeof fetch === 'function') {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0.2, messages: [
          { role: 'system', content: '你是个人知识库整理助手，只输出 JSON，不执行外部操作。' },
          { role: 'user', content: `请整理这条工作事件为 JSON {"summary":"...","category":"工作项目|AI 工具|提效方案|内容资产|个人成长","value_score":0-3,"reuse":"...","content_idea":"..."}。事件：${JSON.stringify(event)}` }
        ] })
      });
      if (response.ok) {
        const body = await response.json();
        const text = body.choices?.[0]?.message?.content?.replace(/^```json\s*|\s*```$/gi, '').trim();
        const parsed = JSON.parse(text);
        Object.assign(base, parsed);
      }
    } catch { /* 本地草稿仍然可用 */ }
  }
  updateEvent(id, base);
  return rows('SELECT * FROM events WHERE id = ?', [id])[0];
}

function deleteEvent(id) { db.prepare('DELETE FROM events WHERE id = ?').run(id); }

function readInputMarkdown() {
  const dirs = [path.join(vault, '01-输入'), vault];
  const excluded = new Set(['.obsidian', '.sydney', '00-系统', '02-每日总结', '03-进化记录', '04-工作流', 'scripts', 'desktop', 'cloud_api', 'node_modules']);
  const files = [];
  const seen = new Set();
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.md') && !seen.has(absolute)) { seen.add(absolute); files.push(absolute); }
    }
  }
  dirs.forEach(walk);
  return files.map(file => ({ path: path.relative(vault, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') }));
}

function inferCategory(appName, title) {
  const text = `${appName} ${title}`.toLowerCase();
  if (/obsidian|notion|word|公众号|article|write/.test(text)) return '内容资产';
  if (/code|visual studio|terminal|powershell|python|node/.test(text)) return '工作项目';
  if (/chrome|edge|browser|search/.test(text)) return 'AI 工具';
  return '个人成长';
}

function markdownSummary({ weekly = false } = {}) {
  const days = weekly ? 7 : 1;
  const cutoff = Date.now() - days * 86400000;
  const eventRows = rows("SELECT * FROM events WHERE datetime(created_at) >= datetime(?) AND source <> 'codex' ORDER BY datetime(created_at) ASC", [new Date(cutoff).toISOString()]);
  const sourceNotes = readInputMarkdown();
  const lines = eventRows.map(item => `- ${item.created_at.slice(11, 16)} ${item.app_name || '手动记录'}：${item.note || item.window_title || '未填写'}（${item.status}）`);
  const categories = [...new Set(eventRows.map(item => item.category).filter(Boolean))];
  const ideas = eventRows.filter(item => item.value_score >= 2 || item.category === '内容资产').slice(0, 8);
  const title = weekly ? `本周成长总结 ${todayPrefix()}` : `每日工作总结 ${todayPrefix()}`;
  const content = `---\ntype: ${weekly ? 'weekly-review' : 'daily-review'}\nsource: sydney-desktop\n---\n\n# ${title}\n\n## 工作事件\n${lines.join('\n') || '- 暂无已记录事件。'}\n\n## 知识库输入\n${sourceNotes.map(note => `- [[${note.path.replace(/\.md$/, '')}]]`).join('\n') || '- 暂无新增输入笔记。'}\n\n## 主题分类\n${categories.map(item => `- ${item}`).join('\n') || '- 个人成长'}\n\n## 可转化内容\n${ideas.map(item => `- [ ] ${item.summary || item.note || item.window_title}`).join('\n') || '- [ ] 从今天最有价值的一条经验提炼一个选题。'}\n\n## 下一步行动\n- [ ] 确认一条值得沉淀为工作流的经验。\n- [ ] 删除或补充无效的自动记录。\n`;
  return { title, content, eventCount: eventRows.length, sourceCount: sourceNotes.length };
}

function writeObsidianSummary(kind) {
  const result = markdownSummary({ weekly: kind === 'weekly' });
  const folder = path.join(vault, kind === 'weekly' ? '03-进化记录' : '02-每日总结');
  fs.mkdirSync(folder, { recursive: true });
  const filename = kind === 'weekly' ? `${todayPrefix()}-周报.md` : `${todayPrefix()}.md`;
  const target = path.join(folder, filename);
  fs.writeFileSync(target, result.content, 'utf8');
  return { ...result, target };
}

function writeWorkflow() {
  const candidates = rows("SELECT * FROM events WHERE status = 'approved' AND value_score >= 1 AND source <> 'codex' ORDER BY datetime(created_at) DESC LIMIT 12");
  const title = `工作流候选-${todayPrefix()}`;
  const content = `---\ntype: workflow-candidate\nstatus: review\nsource: sydney-desktop\n---\n\n# ${title}\n\n## 适用场景\n${candidates.map(item => `- ${item.category}：${item.note || item.summary || item.window_title}`).join('\n') || '- 暂无已确认事件，请先确认至少一条高价值事件。'}\n\n## 建议步骤\n1. 触发：记录一个明确的输入或问题。\n2. 整理：补充上下文、工具、结果和失败边界。\n3. 验证：在下一个相似任务中复用并记录结果。\n4. 沉淀：确认后将步骤改写为稳定 SOP。\n\n## 人工确认\n- [ ] 这是重复出现的问题\n- [ ] 步骤可以交给 Agent 或脚本执行\n- [ ] 已写明输入、输出和人工检查点\n`;
  const folder = path.join(vault, '04-工作流');
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, `${title}.md`);
  fs.writeFileSync(target, content, 'utf8');
  return { target, count: candidates.length };
}

async function syncApprovedEvents() {
  const config = settings();
  if (!config.cloudSyncEnabled || !config.cloudUrl) return { synced: 0, skipped: true };
  const payload = rows("SELECT * FROM events WHERE status = 'approved' AND source <> 'codex' ORDER BY datetime(created_at) DESC LIMIT 100").map(event => ({ ...event, client_id: 'desktop' }));
  const response = await fetch(`${config.cloudUrl.replace(/\/$/, '')}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`云端同步失败：HTTP ${response.status}`);
  return { synced: payload.length, skipped: false };
}

async function activeWindow() {
  try {
    const module = await import('active-win');
    const result = await module.activeWindow();
    return { app_name: result?.owner?.name || '', window_title: result?.title || '' };
  } catch { return { app_name: '', window_title: '' }; }
}

async function captureScreenSample() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1440, height: 900 } });
  const image = sources[0]?.thumbnail;
  if (!image || image.isEmpty()) return '';
  const captureDir = path.join(dataDir, 'captures');
  fs.mkdirSync(captureDir, { recursive: true });
  const target = path.join(captureDir, `${Date.now()}.bin`);
  fs.writeFileSync(target, encryptCapture(image.toPNG()));
  purgeExpiredCaptures();
  return target;
}

function startFileWatchers() {
  stopFileWatchers();
  if (!settings().watchInputFiles) return;
  const watchPath = path.join(vault, '01-输入');
  if (!fs.existsSync(watchPath)) return;
  try {
    const watcher = fs.watch(watchPath, { recursive: true }, (_eventType, filename) => {
      if (!filename || String(filename).includes('截图')) return;
      const key = String(filename);
      const last = fileEventDebounce.get(key) || 0;
      if (Date.now() - last < 3000) return;
      fileEventDebounce.set(key, Date.now());
      insertEvent({ kind: 'file-change', note: `输入文件发生变化：${key}`, category: '个人成长', status: 'pending' });
      mainWindow?.webContents.send('events:changed');
    });
    fileWatchers.push(watcher);
  } catch { /* 某些 Windows 文件系统不支持递归监听，仍可使用活动采样 */ }
}

function stopFileWatchers() {
  fileWatchers.forEach(watcher => watcher.close());
  fileWatchers = [];
}

async function captureTick() {
  const config = settings();
  const active = await activeWindow();
  const window = { appName: active.app_name, title: active.window_title };
  if (!shouldCapture(window, config)) return;
  const sanitized = sanitizeWindow(window, config);
  const screenshotPath = config.screenSamplingEnabled ? await captureScreenSample() : '';
  insertEvent({ app_name: sanitized.appName, window_title: sanitized.windowTitle, kind: 'activity', duration_seconds: config.captureIntervalSeconds, screenshot_path: screenshotPath, category: inferCategory(sanitized.appName, sanitized.windowTitle) });
  mainWindow?.webContents.send('events:changed');
}

function setCapture(enabled) {
  const config = settings();
  config.captureEnabled = enabled;
  saveSettings(config);
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = null;
  captureStartedAt = enabled ? new Date().toISOString() : null;
  if (enabled) {
    captureTick();
    captureTimer = setInterval(captureTick, Math.max(10, config.captureIntervalSeconds) * 1000);
    startFileWatchers();
  } else {
    stopFileWatchers();
  }
  mainWindow?.webContents.send('capture:changed', { enabled });
  return enabled;
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#11131a', title: 'Sydney', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function registerIpc() {
  ipcMain.handle('app:state', () => ({ settings: settings(), stats: stats(), events: events(), captureStartedAt }));
  ipcMain.handle('events:list', (_event, filter) => events(filter || {}));
  ipcMain.handle('events:create', (_event, event) => { const id = insertEvent({ ...event, kind: event.kind || 'manual' }); mainWindow?.webContents.send('events:changed'); return { id }; });
  ipcMain.handle('events:update', (_event, { id, patch }) => { updateEvent(id, patch); mainWindow?.webContents.send('events:changed'); return true; });
  ipcMain.handle('events:draft', async (_event, id) => { const result = await draftEvent(id); mainWindow?.webContents.send('events:changed'); return result; });
  ipcMain.handle('events:delete', (_event, id) => { deleteEvent(id); mainWindow?.webContents.send('events:changed'); return true; });
  ipcMain.handle('capture:set', (_event, enabled) => setCapture(Boolean(enabled)));
  ipcMain.handle('settings:save', (_event, next) => {
    const saved = saveSettings({ ...settings(), ...next });
    if (saved.captureEnabled) setCapture(true);
    return saved;
  });
  ipcMain.handle('summary:generate', (_event, kind) => writeObsidianSummary(kind || 'daily'));
  ipcMain.handle('workflow:generate', () => writeWorkflow());
  ipcMain.handle('sync:push', () => syncApprovedEvents());
  ipcMain.handle('files:pick', async () => { const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] }); return result.canceled ? [] : result.filePaths; });
  ipcMain.handle('files:open', (_event, target) => shell.openPath(target));
  ipcMain.handle('screenshot:save', (_event, dataUrl) => { const dir = path.join(vault, '01-输入', '截图'); fs.mkdirSync(dir, { recursive: true }); const target = path.join(dir, `${Date.now()}.png`); fs.writeFileSync(target, Buffer.from(dataUrl.split(',')[1], 'base64')); return target; });
  ipcMain.handle('screenshot:capture', async () => { const dir = path.join(vault, '01-输入', '截图'); fs.mkdirSync(dir, { recursive: true }); const target = path.join(dir, `${Date.now()}.png`); const image = await mainWindow.capturePage(); fs.writeFileSync(target, image.toPNG()); return target; });
}

app.whenReady().then(() => {
  ensureStorage();
  registerIpc();
  createWindow();
  purgeExpiredCaptures();
  if (settings().captureEnabled) setCapture(true);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
