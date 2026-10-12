import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { nativeImage } from 'electron';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolveVaultPath } from './services/vault-path';
import { defaultSettings, mergeSettings } from './services/app-settings';
import { CodexSessionAdapter, DEFAULT_CODEX_ORIGINATORS, KNOWN_CODEX_ORIGINATORS, shouldRunCodexCapture } from './services/codex-session-adapter';
import { ClaudeSessionAdapter, defaultClaudeProjectsRoot } from './services/claude-session-adapter';
import { migrateCodexEventColumns, persistAiMessage, persistCodexMessage } from './services/codex-event-store';
import { buildInsights, toAiTurns, writeAiReview, type AiInsights } from './services/ai-session-insights';
import { buildNoteUsage, renderNoteUsage } from './services/note-usage';
import { applyRulePatch, collectRuleEvidence, draftRuleText, getRuleCandidate, listRuleCandidates, migrateRuleTables, previewRulePatch, renderRuleSection, undoRulePatch, updateRuleCandidate, upsertRuleCandidates } from './services/evolution-rules';
import { markCardEvents, migrateCardColumns, requestExperienceCards, selectCardEvents, writeCardIndex, writeExperienceCards } from './services/experience-cards';
import type { LlmConfig } from './services/llm-json';
import { applyAiDraft, clearAiDraft, migrateAiDraftColumns, saveAiDraft } from './services/ai-draft-store';
import { buildDeepSeekInput } from './services/ai-draft-input';
import { requestEventDraft } from './services/deepseek';
import { requestContentStage } from './services/content-workflow';
import { exportContentArticle, parseContentSources } from './services/content-export';
import { assertContentDeliverable, assertContentStage, deliverableArticle, isContentPublishable, prepareContentEdit } from './services/content-policy';
import { WeChatClient, contentTypeFor } from './services/wechat-publisher';
import { DEFAULT_AIGC_FOOTER, makeDigest, normalizeTitle, renderWeChatHtml, toPlainText } from './services/article-html';
import { applyGeneratedImages, buildImagePrompt, collectTaskAssets, listInlineImages, planCoverAndInlineImages, planImageSlots } from './services/content-images';
import { DEFAULT_DIRECTION_NAME, DEFAULT_DIRECTION_NOTE, DEFAULT_SUBDIRECTIONS, LEGACY_CATEGORY_NAMES, describeDirection, findDirection, findSubdirection, normalizeTaxonomyInput, resolveDefaultSubdirection, subdirectionNames } from './services/content-taxonomy';
import type { ContentDirection, ContentDirectionInput, ContentSubdirection, ContentTaxonomy } from './shared';
import type { ImageSlot } from './services/content-images';
import { resolveLlmApiKey, SecretStore } from './services/secret-store';
import { writeFileAtomic } from './services/atomic-file';
import { ScreenFrameStore } from './services/screen-frame-store';
import { capturePrimaryScreen } from './services/screen-capture';
import { shouldCaptureScreen } from './services/screen-capture-policy';
import { InputFileWatcher } from './services/input-file-watcher';
import { classifyApplication } from './services/application-adapters';
import { describeCaptureObservation } from './services/capture-status';
import { writeConfirmedEvent, writeDailySummary as writeObsidianDailySummary, writeWeeklySummary as writeObsidianWeeklySummary, writeWorkflowCandidate } from './services/obsidian-output';
import { runWeWrite, runWeWriteJson, weWriteHome, resolveWeWriteBinary } from './services/wewrite-cli';
import { describeRun, parseThemes, pickArticlePath, summarizeRun } from './services/wewrite-runs';
import { countRuns, parseChecks, parseDiagnoseFiles, parseDiagnoseFlags, parseImageConfig, parseRecommendations, parseStyleSummary, parseSummary, parseWechatAuthor, normalizeWeWriteDraft, normalizeImageCost, serializeCliConfig, serializeStyleConfig, maskSecret, yamlBlock, yamlScalar } from './services/wewrite-config';
import { assertVideoExportable, assertVideoStage, parseVideoShots, prepareVideoEdit, VIDEO_PLATFORMS } from './services/video-pipeline';
import { requestVideoStage } from './services/video-workflow';
import { exportVideoPackage } from './services/video-export';
import type { ContentApiConfig } from './services/content-workflow';
import type { AiReviewResult, CardExtractResult, ClaudeCaptureStatus, CodexCaptureStatus, EvolutionState, ContentStage, ContentTask, Settings, VideoAssetBundle, VideoPlatform, VideoProject, VideoStage, WeWriteActionResult, WeWriteConfigDraft, WeWriteEnvironment, WeWriteOverview, WeWriteRunDetail, WeWriteRunSummary, WorkEvent } from './shared';
import type { CaptureStatus } from './shared';

const projectPath = path.resolve(__dirname, '../..');
const defaultVaultPath = String.raw`D:\33054\Documents\persornal\Sydney`;
let dataDir = '';
let settingsPath = '';
let db!: DatabaseSync;
let windowRef: BrowserWindow | null = null;
let captureTimer: NodeJS.Timeout | undefined;
let screenTimer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
let activeStartedAt = 0;
let activeApp = '';
let codexAdapter: CodexSessionAdapter | undefined;
let codexCapture: CodexCaptureStatus = { state: 'disabled', error: '' };
let claudeAdapter: ClaudeSessionAdapter | undefined;
let claudeAdapterKey = '';
let claudeCapture: ClaudeCaptureStatus = { state: 'disabled', error: '' };
let secretStore!: SecretStore;
let screenFrameStore!: ScreenFrameStore;
let fileWatcher!: InputFileWatcher;
let screenCapture = { state: 'disabled' as 'disabled' | 'stopped' | 'capturing' | 'error', saved: 0, error: '' };
let screenCaptureInFlight = false;
let weWriteWatchTimer: NodeJS.Timeout | undefined;
let weWriteWatcher: fs.FSWatcher | undefined;
let captureStatus: CaptureStatus = { state: 'idle', appName: '', windowTitle: '', sampledAt: '', message: '尚未采样' };

function currentSettings(): Settings {
  try { return mergeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')) as Partial<Settings>, defaultVaultPath, projectPath); }
  catch { return defaultSettings(defaultVaultPath, projectPath); }
}

/**
 * settings.json 用原子写：直接覆盖写一旦在写一半时被杀进程/被同步工具抢锁，
 * 文件会截断，currentSettings() 解析失败后会静默回退到默认值——用户看到的就是“配置全没了”。
 */
function writeSettings(config: Settings): void {
  writeFileAtomic(settingsPath, JSON.stringify(config, null, 2));
}

function broadcast() { windowRef?.webContents.send('state:changed'); }
function allEvents(): WorkEvent[] { return db.prepare('SELECT * FROM events ORDER BY datetime(created_at) DESC LIMIT 200').all() as WorkEvent[]; }
function confirmedEvents(limit = 200): WorkEvent[] {
  return db.prepare("SELECT * FROM events WHERE status='approved' ORDER BY datetime(created_at) DESC LIMIT ?").all(limit) as WorkEvent[];
}
function persistConfirmedEvent(id: number): string | null {
  const event = db.prepare("SELECT * FROM events WHERE id=? AND status='approved'").get(id) as WorkEvent | undefined;
  if (!event) return null;
  return writeConfirmedEvent(currentSettings().vaultPath, event);
}
function insertMetadataEvent(input: { kind: 'file_change' | 'adapter'; note: string; summary: string; source: 'file' | 'adapter'; relatedPath?: string; adapter?: string; changeType?: string; appName?: string; windowTitle?: string; durationSeconds?: number }): number {
  const result = db.prepare(`INSERT INTO events
    (created_at, app_name, window_title, kind, note, duration_seconds, status, value_score, summary, category, source, related_path, adapter, change_type)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, '提效方案', ?, ?, ?, ?)`)
    .run(new Date().toISOString(), input.appName || '', input.windowTitle || '', input.kind, input.note, input.durationSeconds || 0, input.summary, input.source, input.relatedPath || '', input.adapter || '', input.changeType || '');
  broadcast();
  return Number(result.lastInsertRowid);
}
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
  return { settings: currentSettings(), stats, events: allEvents(), codexCapture, claudeCapture, screenCapture, captureStatus };
}
function llmConfig(): LlmConfig {
  return {
    apiKey: resolveLlmApiKey(secretStore.read(), process.env.SYDNEY_LLM_API_KEY || ''),
    baseUrl: process.env.SYDNEY_LLM_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.SYDNEY_LLM_MODEL || 'deepseek-chat'
  };
}
function aiEventsSince(from: Date): WorkEvent[] {
  return db.prepare("SELECT * FROM events WHERE source IN ('codex','claude') AND status<>'rejected' AND created_at >= ? ORDER BY created_at").all(from.toISOString()) as WorkEvent[];
}
function aiInsightsBetween(from: Date, to: Date): AiInsights {
  return buildInsights(aiEventsSince(from), from, to);
}
function refreshInputWatcher(): void {
  const config = currentSettings();
  fileWatcher.stop();
  if (!config.inputWatchEnabled || !config.captureEnabled || config.capturePaused) return;
  const defaultInput = path.join(config.vaultPath, '01-输入');
  fs.mkdirSync(defaultInput, { recursive: true });
  fileWatcher.start(config.inputWatchPaths.length ? config.inputWatchPaths : [defaultInput]);
}
function refreshScreenCapture(): void {
  const config = currentSettings();
  if (screenTimer) clearInterval(screenTimer);
  screenTimer = undefined;
  if (!config.screenCaptureEnabled) {
    screenCapture = { state: 'disabled', saved: screenCapture.saved, error: '' };
    return;
  }
  if (!config.captureEnabled || config.capturePaused) {
    screenCapture = { state: 'stopped', saved: screenCapture.saved, error: '' };
    return;
  }
  if (!screenFrameStore.isAvailable()) {
    screenCapture = { state: 'error', saved: screenCapture.saved, error: '系统安全存储不可用，未采集屏幕' };
    return;
  }
  screenCapture = { state: 'capturing', saved: screenCapture.saved, error: '' };
  void screenCaptureTick();
  screenTimer = setInterval(() => void screenCaptureTick(), Math.max(15, config.screenCaptureIntervalSeconds) * 1000);
}
async function screenCaptureTick(): Promise<void> {
  if (screenCaptureInFlight) return;
  const config = currentSettings();
  if (!config.captureEnabled || config.capturePaused || !config.screenCaptureEnabled) return;
  screenCaptureInFlight = true;
  try {
    const activeWindow = await import('active-win');
    const active = await activeWindow.default();
    const appName = active?.owner?.name || '';
    const title = active?.title || '';
    const decision = shouldCaptureScreen({ appName, windowTitle: title, allowedApps: config.allowedApps, blockedApps: config.blockedApps });
    if (!decision.allowed) return;
    const png = await capturePrimaryScreen();
    const latest = currentSettings();
    if (!png || !latest.captureEnabled || latest.capturePaused || !latest.screenCaptureEnabled) return;
    const framePath = screenFrameStore.save(png);
    db.prepare('INSERT INTO screen_frames (captured_at, encrypted_path) VALUES (?, ?)').run(new Date().toISOString(), framePath);
    screenCapture = { state: 'capturing', saved: screenCapture.saved + 1, error: '' };
    broadcast();
  } catch (error) {
    screenCapture = { state: 'error', saved: screenCapture.saved, error: error instanceof Error ? error.message : String(error) };
    broadcast();
  } finally {
    screenCaptureInFlight = false;
  }
}
function cleanupScreenFrames(): void {
  const hours = currentSettings().screenRetentionHours;
  screenFrameStore.cleanup(hours);
  const cutoff = new Date(Date.now() - Math.max(1, hours) * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM screen_frames WHERE captured_at < ?').run(cutoff);
  screenCapture = { ...screenCapture, saved: Number((db.prepare('SELECT COUNT(*) AS count FROM screen_frames').get() as { count: number }).count) };
}
function refreshCodexAdapter(): void {
  const config = currentSettings();
  if (!shouldRunCodexCapture(config.codexCaptureEnabled, config.captureEnabled, config.capturePaused)) {
    codexAdapter?.stop();
    codexCapture = { state: config.codexCaptureEnabled ? 'stopped' : 'disabled', error: '' };
    return;
  }
  const originators = config.codexIncludeCli ? KNOWN_CODEX_ORIGINATORS : DEFAULT_CODEX_ORIGINATORS;
  if (!codexAdapter) {
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(app.getPath('home'), '.codex');
    codexAdapter = new CodexSessionAdapter(
      path.join(codexHome, 'sessions'),
      message => { persistCodexMessage(db, message); broadcast(); },
      error => { codexCapture = { state: 'error', error }; broadcast(); },
      1_000,
      originators
    );
  }
  codexAdapter.setOriginators(originators);
  codexAdapter.start();
  codexCapture = { state: 'listening', error: '' };
}
function claudeRoots(config: Settings): string[] {
  return [defaultClaudeProjectsRoot(app.getPath('home')), ...config.claudeExtraRoots.map(root => root.trim()).filter(Boolean)];
}
function refreshClaudeAdapter(): void {
  const config = currentSettings();
  if (!shouldRunCodexCapture(config.claudeCaptureEnabled, config.captureEnabled, config.capturePaused)) {
    claudeAdapter?.stop();
    claudeCapture = { state: config.claudeCaptureEnabled ? 'stopped' : 'disabled', error: '' };
    return;
  }
  const roots = claudeRoots(config);
  const key = roots.join('|');
  if (!claudeAdapter || key !== claudeAdapterKey) {
    claudeAdapter?.stop();
    claudeAdapterKey = key;
    claudeAdapter = new ClaudeSessionAdapter(
      roots,
      message => { persistAiMessage(db, 'claude', message); broadcast(); },
      error => { claudeCapture = { state: 'error', error }; broadcast(); }
    );
  }
  claudeAdapter.start();
  claudeCapture = { state: 'listening', error: '' };
}
function setCapture(mode: 'start' | 'pause' | 'stop') {
  const config = currentSettings();
  config.captureEnabled = mode !== 'stop';
  config.capturePaused = mode === 'pause';
  fs.mkdirSync(dataDir, { recursive: true }); writeSettings(config);
  if (captureTimer) clearInterval(captureTimer); captureTimer = undefined; activeStartedAt = 0; activeApp = '';
  captureStatus = mode === 'stop' ? { state: 'idle', appName: '', windowTitle: '', sampledAt: '', message: '记录已停止' } : captureStatus;
  if (config.captureEnabled && !config.capturePaused) { void captureTick(); captureTimer = setInterval(() => void captureTick(), Math.max(10, config.captureIntervalSeconds) * 1000); }
  refreshCodexAdapter();
  refreshClaudeAdapter();
  refreshInputWatcher();
  refreshScreenCapture();
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
    const sampledAt = new Date().toISOString();
    const observation = describeCaptureObservation({ appName, windowTitle: title.slice(0, 240), allowed, blocked, saveUnallowed: config.captureAllPending, sampledAt });
    captureStatus = observation;
    broadcast();
    if (!appName || blocked || (!allowed && !config.captureAllPending)) { activeApp = ''; activeStartedAt = 0; return; }
    const now = Date.now();
    const adapted = classifyApplication(appName, title.slice(0, 240));
    if (!activeStartedAt) {
      insertMetadataEvent({
        kind: 'adapter',
        note: adapted.note,
        summary: adapted.summary,
        source: 'adapter',
        adapter: adapted.adapter,
        appName,
        windowTitle: title.slice(0, 240),
        durationSeconds: 0
      });
    } else if (activeApp === appName) {
      insertMetadataEvent({
        kind: adapted.adapter === 'generic' ? 'adapter' : 'adapter',
        note: adapted.note,
        summary: adapted.summary,
        source: 'adapter',
        adapter: adapted.adapter,
        appName,
        windowTitle: title.slice(0, 240),
        durationSeconds: Math.max(1, Math.round((now - activeStartedAt) / 1000))
      });
    }
    activeApp = appName; activeStartedAt = now;
  } catch (error) {
    captureStatus = { state: 'error', appName: '', windowTitle: '', sampledAt: new Date().toISOString(), message: error instanceof Error ? `采样失败：${error.message}` : '采样失败' };
    broadcast();
  }
}
function registerIpc() {
  ipcMain.handle('state:get', () => getState());
  ipcMain.handle('event:create', (_event, input: Partial<WorkEvent>) => insertEvent(input));
  ipcMain.handle('event:update', (_event, id: number, patch: Partial<WorkEvent>) => {
    const allowed = ['note', 'status', 'category', 'value_score', 'summary'];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (entries.length) db.prepare(`UPDATE events SET ${entries.map(([key]) => `${key}=?`).join(', ')} WHERE id=?`).run(...entries.map(([, value]) => value), id);
    if (patch.status === 'approved') {
      const target = persistConfirmedEvent(id);
      if (target) writeObsidianDailySummary(currentSettings().vaultPath, confirmedEvents(), []);
    }
    broadcast();
  });
  ipcMain.handle('event:delete', (_event, id: number) => { db.prepare('DELETE FROM events WHERE id=?').run(id); broadcast(); });
  ipcMain.handle('event:draft', async (_event, id: number) => {
    const config = currentSettings();
    if (!config.llmEnabled) throw new Error('请先在设置中开启允许发送到 DeepSeek');
    const event = db.prepare('SELECT * FROM events WHERE id=?').get(id) as WorkEvent | undefined;
    if (!event) throw new Error('事件不存在或已被删除');
    if (event.status !== 'pending') throw new Error('只有待确认事件可以生成 AI 草稿');
    const draft = await requestEventDraft(buildDeepSeekInput(event), {
      apiKey: resolveLlmApiKey(secretStore.read(), process.env.SYDNEY_LLM_API_KEY || ''),
      baseUrl: process.env.SYDNEY_LLM_BASE_URL || 'https://api.deepseek.com/v1',
      model: process.env.SYDNEY_LLM_MODEL || 'deepseek-chat'
    });
    saveAiDraft(db, id, draft, process.env.SYDNEY_LLM_MODEL || 'deepseek-chat', new Date().toISOString());
    broadcast();
    return draft;
  });
  ipcMain.handle('llm-key:status', () => secretStore.getStatus());
  ipcMain.handle('llm-key:save', (_event, value: string) => { secretStore.save(value); return secretStore.getStatus(); });
  ipcMain.handle('llm-key:delete', () => { secretStore.remove(); return secretStore.getStatus(); });
  ipcMain.handle('event:draft:apply', (_event, id: number) => { applyAiDraft(db, id); broadcast(); });
  ipcMain.handle('event:draft:clear', (_event, id: number) => { clearAiDraft(db, id); broadcast(); });
  ipcMain.handle('capture:set', (_event, mode: 'start' | 'pause' | 'stop') => setCapture(mode));
  ipcMain.handle('settings:save', (_event, patch: Partial<Settings>) => {
    const previous = currentSettings();
    const next = { ...previous, ...patch };
    next.vaultPath = resolveVaultPath(next.vaultPath, defaultVaultPath, projectPath);
    writeSettings(next);
    if (next.captureEnabled !== previous.captureEnabled) setCapture(next.captureEnabled ? 'start' : 'stop');
    else {
      if (next.codexIncludeCli !== previous.codexIncludeCli) codexAdapter?.stop();
      refreshCodexAdapter();
      refreshClaudeAdapter();
      refreshInputWatcher();
      refreshScreenCapture();
    }
    broadcast(); return next;
  });
  ipcMain.handle('vault:choose', async () => {
    const result = await dialog.showOpenDialog(windowRef!, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const next = { ...currentSettings(), vaultPath: resolveVaultPath(result.filePaths[0], defaultVaultPath, projectPath) };
    writeSettings(next); broadcast(); return next.vaultPath;
  });
  ipcMain.handle('files:choose', async () => {
    const result = await dialog.showOpenDialog(windowRef!, { properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    return result.filePaths;
  });
  ipcMain.handle('summary:daily', () => writeObsidianDailySummary(currentSettings().vaultPath, confirmedEvents()));
  ipcMain.handle('summary:weekly', () => {
    const vaultPath = currentSettings().vaultPath;
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() || 7) - 1));
    monday.setHours(0, 0, 0, 0);
    const insights = aiInsightsBetween(monday, now);
    const reviewDir = path.join(vaultPath, '03-进化记录');
    const mondayDay = monday.toISOString().slice(0, 10);
    const reviewNote = fs.existsSync(reviewDir)
      ? fs.readdirSync(reviewDir).filter(name => /^AI协作复盘-\d{4}-\d{2}-\d{2}\.md$/.test(name) && name.slice(7, 17) >= mondayDay).sort().pop()
      : undefined;
    const rules = listRuleCandidates(db).filter(rule => rule.updatedAt >= monday.toISOString());
    return writeObsidianWeeklySummary(vaultPath, confirmedEvents(), insights.turns ? { insights, reviewNote: reviewNote ? path.join(reviewDir, reviewNote) : undefined, rules } : undefined);
  });
  ipcMain.handle('workflow:generate', () => {
    const rows = confirmedEvents().filter(item => item.value_score >= 2 || item.category === '提效方案' || item.category === '内容资产');
    return { target: writeWorkflowCandidate(currentSettings().vaultPath, rows), count: rows.length };
  });
  ipcMain.handle('ai-review:generate', (_event, days = 7): AiReviewResult => {
    const span = Math.min(90, Math.max(1, Math.round(Number(days) || 7)));
    const to = new Date();
    const from = new Date(to.getTime() - span * 24 * 60 * 60 * 1000);
    const insights = aiInsightsBetween(from, to);
    const touched = upsertRuleCandidates(db, insights, collectRuleEvidence(db, insights.friction));
    const touchedIds = new Set(touched.map(rule => rule.id));
    const projectDirs = new Set(insights.projects.map(stat => stat.cwd));
    const rules = listRuleCandidates(db).filter(rule => touchedIds.has(rule.id) || (projectDirs.has(rule.cwd) && rule.updatedAt >= from.toISOString()));
    // Knowledge reuse looks further back than the review window so "unused" means something.
    const usageDays = Math.max(span, 90);
    const usageFrom = new Date(to.getTime() - usageDays * 24 * 60 * 60 * 1000);
    const vaultPath = currentSettings().vaultPath;
    const usage = buildNoteUsage(toAiTurns(aiEventsSince(usageFrom)), vaultPath, usageDays);
    const target = writeAiReview(vaultPath, insights, { rulesSection: renderRuleSection(rules), notesSection: renderNoteUsage(usage) });
    broadcast();
    return { target, turns: insights.turns, repeats: insights.repeats.length, friction: insights.friction.length, rules: rules.filter(rule => rule.status === 'proposed').length, notesUsed: usage.used.length, staleNotes: usage.stale.length };
  });
  ipcMain.handle('evolution:state', (): EvolutionState => ({
    rules: listRuleCandidates(db),
    pendingCardEvents: selectCardEvents(db, 90, 1_000).length,
    llmEnabled: currentSettings().llmEnabled
  }));
  ipcMain.handle('rules:draft', async (_event, id: number) => {
    if (!currentSettings().llmEnabled) throw new Error('请先在设置中开启允许发送到 DeepSeek');
    const candidate = getRuleCandidate(db, id);
    if (candidate.status !== 'proposed') throw new Error('只有待确认的规则候选可以重新生成');
    const drafted = await draftRuleText(candidate, llmConfig());
    return updateRuleCandidate(db, id, drafted);
  });
  ipcMain.handle('rules:update', (_event, id: number, ruleText: string) => {
    if (getRuleCandidate(db, id).status !== 'proposed') throw new Error('已写入或已驳回的规则不能再修改');
    return updateRuleCandidate(db, id, { ruleText: String(ruleText ?? '').slice(0, 2_000) });
  });
  ipcMain.handle('rules:preview', (_event, id: number) => previewRulePatch(getRuleCandidate(db, id)).map(({ path: file, exists, added }) => ({ path: file, exists, added })));
  ipcMain.handle('rules:apply', (_event, id: number, targets: string[]) => {
    const candidate = getRuleCandidate(db, id);
    if (candidate.status !== 'proposed') throw new Error('这个规则候选已经处理过了');
    const applied = applyRulePatch(previewRulePatch(candidate, undefined, Array.isArray(targets) ? targets : []));
    return updateRuleCandidate(db, id, { status: 'applied', applied });
  });
  ipcMain.handle('rules:reject', (_event, id: number) => updateRuleCandidate(db, id, { status: 'rejected' }));
  ipcMain.handle('rules:undo', (_event, id: number) => {
    const candidate = getRuleCandidate(db, id);
    if (candidate.status !== 'applied') throw new Error('只有已写入的规则可以撤销');
    const result = undoRulePatch(candidate.applied);
    if (!result.restored.length) throw new Error('目标文件在写入后被修改过，未自动撤销，请手动删除对应规则');
    return { candidate: updateRuleCandidate(db, id, { status: 'proposed', applied: [] }), ...result };
  });
  ipcMain.handle('cards:extract', async (_event, days = 30): Promise<CardExtractResult> => {
    if (!currentSettings().llmEnabled) throw new Error('请先在设置中开启允许发送到 DeepSeek');
    const span = Math.min(180, Math.max(1, Math.round(Number(days) || 30)));
    const events = selectCardEvents(db, span, 20);
    const vaultPath = currentSettings().vaultPath;
    if (!events.length) return { considered: 0, created: [], updated: [], index: writeCardIndex(vaultPath) };
    const cards = await requestExperienceCards(events, llmConfig());
    const written = writeExperienceCards(vaultPath, cards, events);
    markCardEvents(db, events.map(event => event.id));
    broadcast();
    return { considered: events.length, ...written, index: writeCardIndex(vaultPath) };
  });
  ipcMain.handle('vault:open', () => shell.openPath(currentSettings().vaultPath));
  registerNativeContentIpc();
  registerVideoIpc();
  registerWeWriteIpc();
}
/* ── 桌面端原生公众号内容管道 ───────────────────────────────────── */

const contentRequests = new Set<number>();
/** 生图的取消句柄：按任务记，界面上「取消生成」就是把它 abort 掉。 */
const imageAborts = new Map<number, AbortController>();
const nativeWeChatClient = new WeChatClient();

async function withContentRequest<T>(id: number, operation: () => Promise<T>): Promise<T> {
  if (contentRequests.has(id)) throw new Error('这篇文章正在处理，请等待当前操作完成');
  contentRequests.add(id);
  try { return await operation(); } finally { contentRequests.delete(id); }
}

/** 任务查询统一带出分类名，界面不必再自己去查分类表。 */
const CONTENT_TASK_SELECT = `SELECT t.*, d.name AS direction_name, s.name AS subdirection_name
  FROM content_tasks t
  LEFT JOIN content_directions d ON d.id = t.direction_id
  LEFT JOIN content_subdirections s ON s.id = t.subdirection_id`;

function optionalId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function contentTaskFromRow(row: Record<string, unknown>): ContentTask {
  return {
    id: Number(row.id),
    directionId: optionalId(row.direction_id),
    subdirectionId: optionalId(row.subdirection_id),
    directionName: String(row.direction_name ?? ''),
    subdirectionName: String(row.subdirection_name ?? ''),
    topic: String(row.topic ?? ''), title: String(row.title ?? ''), status: String(row.status ?? 'idea') as ContentTask['status'],
    briefJson: String(row.brief_json ?? ''), claimsJson: String(row.claims_json ?? ''), sourcesJson: String(row.sources_json ?? ''), topicsJson: String(row.topics_json ?? ''),
    draft: String(row.draft ?? ''), finalArticle: String(row.final_article ?? ''), reviewJson: String(row.review_json ?? ''),
    coverPath: String(row.cover_path ?? ''), theme: String(row.theme ?? ''), publishJson: String(row.publish_json ?? ''), exportPath: String(row.export_path ?? ''), createdAt: String(row.created_at ?? ''), updatedAt: String(row.updated_at ?? '')
  };
}

function getContentTask(id: number): ContentTask {
  const row = db.prepare(`${CONTENT_TASK_SELECT} WHERE t.id=?`).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('文章任务不存在');
  return contentTaskFromRow(row);
}

/* ── 内容方向（两级，用户自维护） ─────────────────────────────── */

function readTaxonomy(): ContentTaxonomy {
  const directions = (db.prepare('SELECT * FROM content_directions ORDER BY sort_order, id').all() as Array<Record<string, unknown>>).map(row => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    note: String(row.note ?? ''),
    subdirections: [] as ContentSubdirection[]
  })) as ContentDirection[];
  const byId = new Map(directions.map(item => [item.id, item]));
  for (const row of db.prepare('SELECT * FROM content_subdirections ORDER BY sort_order, id').all() as Array<Record<string, unknown>>) {
    const parent = byId.get(Number(row.direction_id));
    if (parent) parent.subdirections.push({ id: Number(row.id), name: String(row.name ?? ''), note: String(row.note ?? '') });
  }
  const preferred = parseStyleSummary(weWriteFiles().styleText).defaultTopic;
  const fallback = resolveDefaultSubdirection({ directions, defaultSubdirectionId: null }, preferred);
  return { directions, defaultSubdirectionId: fallback.subdirectionId };
}

/** 首次启动写入默认方向，并把旧的 category 值映射到对应的二级方向。 */
function seedContentTaxonomy(): void {
  const now = new Date().toISOString();
  const count = Number((db.prepare('SELECT COUNT(*) AS count FROM content_directions').get() as { count: number }).count);
  if (!count) {
    const direction = db.prepare('INSERT INTO content_directions (name, note, sort_order, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run(DEFAULT_DIRECTION_NAME, DEFAULT_DIRECTION_NOTE, now, now);
    DEFAULT_SUBDIRECTIONS.forEach((name, index) => {
      db.prepare('INSERT INTO content_subdirections (direction_id, name, note, sort_order, created_at, updated_at) VALUES (?, ?, \'\', ?, ?, ?)')
        .run(Number(direction.lastInsertRowid), name, index, now, now);
    });
  }
  const subdirections = db.prepare('SELECT id, name FROM content_subdirections').all() as Array<{ id: number; name: string }>;
  for (const [legacy, name] of Object.entries(LEGACY_CATEGORY_NAMES)) {
    const target = subdirections.find(item => item.name === name);
    if (!target) continue;
    const parent = db.prepare('SELECT direction_id FROM content_subdirections WHERE id=?').get(target.id) as { direction_id: number } | undefined;
    if (!parent) continue;
    db.prepare('UPDATE content_tasks SET direction_id=?, subdirection_id=? WHERE subdirection_id IS NULL AND category=?')
      .run(Number(parent.direction_id), target.id, legacy);
  }
}

/**
 * 保存分类树：按 id 增改删。
 * 有任务引用的方向不允许删除——否则历史文章会突然没有归属，界面上也解释不清。
 */
function saveTaxonomy(input: unknown, defaultSubdirectionId?: number | null): ContentTaxonomy {
  const normalized = normalizeTaxonomyInput(input);
  const now = new Date().toISOString();
  const keepDirectionIds = new Set(normalized.map(item => item.id).filter((id): id is number => Boolean(id)));
  const keepSubIds = new Set(normalized.flatMap(item => item.subdirections.map(sub => sub.id)).filter((id): id is number => Boolean(id)));

  for (const direction of db.prepare('SELECT id, name FROM content_directions').all() as Array<{ id: number; name: string }>) {
    if (keepDirectionIds.has(direction.id)) continue;
    const used = Number((db.prepare('SELECT COUNT(*) AS count FROM content_tasks WHERE direction_id=?').get(direction.id) as { count: number }).count);
    if (used) throw new Error(`「${direction.name}」下还有 ${used} 篇文章，先改掉它们的分类再删除这个方向`);
    db.prepare('DELETE FROM content_subdirections WHERE direction_id=?').run(direction.id);
    db.prepare('DELETE FROM content_directions WHERE id=?').run(direction.id);
  }
  for (const subdirection of db.prepare('SELECT id, name FROM content_subdirections').all() as Array<{ id: number; name: string }>) {
    if (keepSubIds.has(subdirection.id)) continue;
    const used = Number((db.prepare('SELECT COUNT(*) AS count FROM content_tasks WHERE subdirection_id=?').get(subdirection.id) as { count: number }).count);
    if (used) throw new Error(`「${subdirection.name}」下还有 ${used} 篇文章，先把它们改成别的具体方向再删除`);
    db.prepare('DELETE FROM content_subdirections WHERE id=?').run(subdirection.id);
  }

  normalized.forEach((direction, index) => {
    const directionId = direction.id
      ? (db.prepare('UPDATE content_directions SET name=?, note=?, sort_order=?, updated_at=? WHERE id=?').run(direction.name, direction.note, index, now, direction.id), direction.id)
      : Number(db.prepare('INSERT INTO content_directions (name, note, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(direction.name, direction.note, index, now, now).lastInsertRowid);
    direction.subdirections.forEach((subdirection, subIndex) => {
      if (subdirection.id) {
        db.prepare('UPDATE content_subdirections SET direction_id=?, name=?, note=?, sort_order=?, updated_at=? WHERE id=?')
          .run(directionId, subdirection.name, subdirection.note, subIndex, now, subdirection.id);
      } else {
        db.prepare('INSERT INTO content_subdirections (direction_id, name, note, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(directionId, subdirection.name, subdirection.note, subIndex, now, now);
      }
    });
  });

  const taxonomy = readTaxonomy();
  const wanted = findSubdirection(taxonomy.directions, defaultSubdirectionId ?? null);
  const resolved = wanted ?? (() => {
    const fallback = resolveDefaultSubdirection({ directions: taxonomy.directions, defaultSubdirectionId: null });
    return fallback.subdirectionId ? findSubdirection(taxonomy.directions, fallback.subdirectionId) : null;
  })();
  syncStyleTopics(subdirectionNames(taxonomy.directions), resolved?.subdirection.name ?? '');
  broadcast();
  return readTaxonomy();
}

/**
 * 内容方向是 style.yaml 里 topics / default_topic 的唯一来源：
 * 两份配置各写一份必然漂移，这里在保存分类时统一回写，agent 侧的 WeWrite 流程也能读到。
 */
function syncStyleTopics(topics: string[], defaultTopic: string): void {
  try {
    const { styleText } = weWriteFiles();
    if (styleText === null) return;
    // 其余字段原样带回去，只替换 topics / default_topic，绝不动用户填过的内容。
    const style = parseStyleSummary(styleText);
    writeWeWriteFile(path.join(weWriteHome(), 'style.yaml'), serializeStyleConfig({ ...style, topics, defaultTopic }));
  } catch {
    // style.yaml 缺失或不可写时不影响分类本身落库。
  }
}

/**
 * 内容 API 配置：公众号与视频两条流水线共用同一份 writer 配置与密钥开关。
 * 关掉开关时两条流水线一起停，避免「我在公众号里关了模型调用，视频还在偷偷花钱」。
 */
function contentApiConfig(): ContentApiConfig {
  const { configText, styleText } = weWriteFiles();
  const writer = yamlBlock(configText, 'writer');
  const enabled = yamlScalar(writer, 'enabled');
  if (enabled ? enabled !== 'true' : !currentSettings().llmEnabled) throw new Error('请先在公众号配置中允许内容 API 调用');
  return {
    apiKey: resolveLlmApiKey(secretStore.read(), process.env.SYDNEY_LLM_API_KEY || ''),
    baseUrl: yamlScalar(writer, 'base_url') || process.env.SYDNEY_LLM_BASE_URL || 'https://api.deepseek.com/v1',
    model: yamlScalar(writer, 'model') || process.env.SYDNEY_LLM_MODEL || 'deepseek-chat',
    style: parseStyleSummary(styleText)
  };
}

function registerNativeContentIpc(): void {
  ipcMain.handle('content:list', () => (db.prepare(`${CONTENT_TASK_SELECT} ORDER BY t.updated_at DESC`).all() as Array<Record<string, unknown>>).map(contentTaskFromRow));
  ipcMain.handle('content:taxonomy', () => readTaxonomy());
  ipcMain.handle('content:taxonomy:save', (_event, directions: ContentDirectionInput[], defaultSubdirectionId?: number | null) => saveTaxonomy(directions, defaultSubdirectionId));
  /**
   * 新建任务：只传二级方向时自动带出一级方向；两者都空也允许，任务会以"未归类"存在。
   */
  ipcMain.handle('content:create', (_event, directionId: number | null, subdirectionId: number | null, topic = '') => {
    const taxonomy = readTaxonomy();
    const subdirection = findSubdirection(taxonomy.directions, optionalId(subdirectionId));
    if (subdirectionId && !subdirection) throw new Error('选择的具体方向已经不存在，请刷新后重试');
    const direction = subdirection?.direction ?? findDirection(taxonomy.directions, optionalId(directionId));
    if (directionId && !direction) throw new Error('选择的内容方向已经不存在，请刷新后重试');
    const now = new Date().toISOString();
    const result = db.prepare('INSERT INTO content_tasks (direction_id, subdirection_id, topic, status, created_at, updated_at) VALUES (?, ?, ?, \'idea\', ?, ?)')
      .run(direction?.id ?? null, subdirection?.subdirection.id ?? null, topic.trim(), now, now);
    broadcast();
    return getContentTask(Number(result.lastInsertRowid));
  });
  ipcMain.handle('content:update', (_event, id: number, patch: Partial<ContentTask>) => {
    if (contentRequests.has(id)) throw new Error('文章正在处理，请稍后保存');
    if (patch.subdirectionId !== undefined) {
      const taxonomy = readTaxonomy();
      const found = findSubdirection(taxonomy.directions, optionalId(patch.subdirectionId));
      if (patch.subdirectionId && !found) throw new Error('选择的具体方向已经不存在，请刷新后重试');
      // 一级方向永远由二级方向推导，避免两边指向不同的树。
      patch.directionId = found?.direction.id ?? optionalId(patch.directionId);
    }
    if (patch.sourcesJson !== undefined) {
      const canonical = JSON.stringify({ sources: parseContentSources(patch.sourcesJson) });
      patch.sourcesJson = getContentTask(id).sourcesJson === '' && canonical === '{"sources":[]}' ? '' : canonical;
    }
    return updateContentTask(id, prepareContentEdit(getContentTask(id), patch));
  });
  ipcMain.handle('content:generate', async (_event, id: number, stage: ContentStage) => withContentRequest(id, async () => {
    const task = getContentTask(id);
    assertContentStage(task, stage);
    const generated = await requestContentStage(task, stage, contentApiConfig());
    const patch: Partial<ContentTask> = { ...generated, finalArticle: '', reviewJson: '' };
    if (stage === 'topics') patch.status = 'idea';
    if (stage === 'brief' || stage === 'claims') patch.status = 'brief';
    if (stage === 'draft' || stage === 'revise') patch.status = 'draft';
    if (stage === 'review') {
      const review = JSON.parse(generated.reviewJson || '{}') as { decision?: string };
      patch.reviewJson = generated.reviewJson;
      patch.status = review.decision === 'pass' ? 'ready' : 'review';
      if (review.decision === 'pass') patch.finalArticle = task.draft;
    }
    return updateContentTask(id, patch);
  }));
  ipcMain.handle('content:cover:choose', async (_event, id: number) => {
    if (contentRequests.has(id)) throw new Error('文章正在处理，请稍后选择封面');
    const result = await dialog.showOpenDialog(windowRef!, { properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return updateContentTask(id, { coverPath: result.filePaths[0] });
  });
  ipcMain.handle('content:export', (_event, id: number, allowUnreviewed = false) => {
    if (contentRequests.has(id)) throw new Error('文章正在处理，请稍后导出');
    const task = getContentTask(id);
    const target = exportContentArticle(currentSettings().vaultPath, task, { allowUnreviewed });
    return updateContentTask(id, { exportPath: target });
  });
  /**
   * 直连微信公众号草稿箱（不经任何 CLI）。只创建草稿，绝不群发。
   * 三个硬前置：已配置凭证、有正文、有封面图——微信侧缺少封面素材会直接报错。
   */
  ipcMain.handle('content:publish', async (_event, id: number, allowUnreviewed = false) => withContentRequest(id, async () => {
    const { configText, styleText } = weWriteFiles();
    const appid = yamlScalar(configText, 'appid');
    const secret = yamlScalar(configText, 'secret');
    if (!appid || !secret) throw new Error('请先在「环境与配置」中填写公众号 AppID 与 AppSecret');
    const task = getContentTask(id);
    assertContentDeliverable(task, { allowUnreviewed });
    const article = deliverableArticle(task, allowUnreviewed);
    if (!task.coverPath) throw new Error('缺少封面图：请先选择本地图片或生成封面');
    if (!fs.existsSync(task.coverPath)) throw new Error('封面图文件已不存在，请重新选择');

    const title = normalizeTitle(task.title || toPlainText(article).slice(0, 40) || '未命名文章');
    if (!title) throw new Error('请先填写文章标题');
    const author = yamlScalar(configText, 'author') || yamlScalar(styleText, 'author');
    const client = nativeWeChatClient;
    const credentials = { appid, secret };
    // 正文里的本地配图在微信侧无法显示，必须先传上去换成微信图片地址。
    const uploadedImages = new Map<string, string>();
    for (const image of listInlineImages(article)) {
      if (/^https?:\/\//i.test(image.source) || image.source.startsWith('data:')) continue;
      if (!fs.existsSync(image.source)) throw new Error(`正文配图不存在，请重新生成或删除：${path.basename(image.source)}`);
      const prepared = prepareWeChatInlineImage(image.source);
      if (prepared.bytes.length > 1024 * 1024) throw new Error(`正文配图超过微信 1MB 限制，请压缩或重新生成：${path.basename(image.source)}`);
      uploadedImages.set(image.source, await client.uploadArticleImage(credentials, prepared));
    }
    const thumbMediaId = await client.uploadThumb(credentials, {
      bytes: fs.readFileSync(task.coverPath),
      filename: path.basename(task.coverPath),
      contentType: contentTypeFor(task.coverPath)
    });
    const mediaId = await client.createDraft(credentials, {
      title,
      author,
      digest: makeDigest(article),
      html: renderWeChatHtml(article, {
        theme: task.theme,
        aigcFooter: DEFAULT_AIGC_FOOTER,
        resolveImage: source => uploadedImages.get(source) ?? source
      }),
      thumbMediaId
    });
    const saved = updateContentTask(id, {
      status: 'published',
      publishJson: JSON.stringify({ mediaId, title, author, unreviewed: !isContentPublishable(task), publishedAt: new Date().toISOString() })
    });
    return { ...saved, mediaId };
  }));
  ipcMain.handle('content:cover:generate', async (_event, id: number) => withContentRequest(id, async () => {
    const task = getContentTask(id);
    const signal = beginImageJob(id);
    try { return updateContentTask(id, { coverPath: await generateCoverImage(task, signal) }); }
    finally { endImageJob(id); }
  }));
  /**
   * 正文配图：按小节挑位置，逐张生成后插回初稿。
   * 插入图片会改动正文，因此旧审稿与成稿一并失效（和手动改正文一致）。
   */
  ipcMain.handle('content:images:generate', async (_event, id: number, count = 3) => withContentRequest(id, async () => {
    const task = getContentTask(id);
    if (!task.draft.trim()) throw new Error('请先生成或填写正文，再配正文插图');
    const slots = planImageSlots(task.draft, clampImageCount(count));
    if (!slots.length) throw new Error('正文段落太短，暂时找不到合适的配图位置');
    const signal = beginImageJob(id);
    try {
      const { paths, failures } = await generateInlineImages(task, slots, Date.now(), signal);
      if (!paths.some(Boolean)) throw new Error(signal.aborted ? '已取消生成' : failures[0] || '正文配图生成失败');
      return updateContentTask(id, { draft: applyGeneratedImages(task.draft, slots, paths).draft, finalArticle: '', reviewJson: '', status: 'draft' });
    } finally { endImageJob(id); }
  }));
  /**
   * 一次动作同时出封面与正文配图：封面和配图并发生成，省掉来回点两次、等两轮。
   *
   * 三条容错规则：
   * 1. 正文为空/太短时只出封面，原因随 imageWarning 回给界面，不当成失败；
   * 2. 部分图片失败不影响已经生成的图片入库，失败原因一并放进 imageWarning；
   * 3. 封面与配图全失败才抛错。
   */
  ipcMain.handle('content:images:generate-all', async (_event, id: number, count = 3) => withContentRequest(id, async () => {
    const task = getContentTask(id);
    const plan = planCoverAndInlineImages(task.draft, clampImageCount(count));
    const signal = beginImageJob(id);
    const [cover, inline] = await Promise.all([
      generateCoverImage(task, signal).then(path => ({ path, error: '' }))
        .catch(error => ({ path: '', error: errorText(error) })),
      plan.withInline
        ? generateInlineImages(task, plan.slots, Date.now(), signal)
        : Promise.resolve({ paths: [] as Array<string | null>, failures: [] as string[] })
    ]).finally(() => endImageJob(id));
    const patch: Partial<ContentTask> = {};
    const warnings: string[] = [];
    if (plan.note) warnings.push(plan.note);
    if (cover.path) patch.coverPath = cover.path;
    else warnings.push(`封面生成失败：${cover.error}`);
    const merged = plan.withInline ? applyGeneratedImages(task.draft, plan.slots, inline.paths) : { draft: task.draft, inserted: 0, failed: 0 };
    if (merged.inserted) {
      patch.draft = merged.draft;
      patch.finalArticle = '';
      patch.reviewJson = '';
      patch.status = 'draft';
    } else if (inline.failures.length) {
      warnings.push(`正文配图生成失败：${inline.failures[0]}`);
    }
    if (merged.inserted && merged.failed) warnings.push(`有 ${merged.failed} 张配图没生成成功`);
    if (!patch.coverPath && !merged.inserted) throw new Error(signal.aborted ? '已取消生成' : warnings.join('；') || '图片生成失败');
    return { ...updateContentTask(id, patch), imageWarning: warnings.join('；') };
  }));
  /** 中断正在跑的生图：长等待时用户至少能自己退出，不必干等到超时。 */
  ipcMain.handle('content:images:cancel', (_event, id: number) => {
    const controller = imageAborts.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  });
  /** 预览走主进程：只有它能读本地图片并转成 data URI 塞进 iframe。 */
  ipcMain.handle('content:preview', (_event, id: number, source: 'draft' | 'final' = 'draft') => {
    const task = getContentTask(id);
    const markdown = source === 'final' && task.finalArticle.trim() ? task.finalArticle : task.draft;
    return {
      html: renderWeChatHtml(markdown, {
        theme: task.theme,
        aigcFooter: DEFAULT_AIGC_FOOTER,
        resolveImage: previewImageSource
      })
    };
  });
  /**
   * 前端直接显示封面与正文配图。
   * 传的是几万字节量级的缩略图，不是几 MB 的原图，避免 IPC 和界面被大图拖住。
   */
  ipcMain.handle('content:assets', (_event, id: number) => {
    const task = getContentTask(id);
    const assets = collectTaskAssets(task);
    return {
      cover: assets.cover ? { path: assets.cover, caption: '封面', thumbnail: imageThumbnail(assets.cover) } : null,
      images: assets.images.map(image => ({ path: image.source, caption: image.caption, thumbnail: imageThumbnail(image.source) }))
    };
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '图片接口超时（超过 180 秒没有返回）';
    if (error.name === 'AbortError') return '已取消生成';
    return error.message;
  }
  return String(error);
}

function beginImageJob(id: number): AbortSignal {
  const controller = new AbortController();
  imageAborts.set(id, controller);
  return controller.signal;
}

/** 超时信号与「用户点了取消」的信号，谁先到就中断请求。 */
function withDeadline(timeout: AbortSignal, cancel?: AbortSignal): AbortSignal {
  return cancel ? AbortSignal.any([timeout, cancel]) : timeout;
}

function endImageJob(id: number): void {
  imageAborts.delete(id);
}

/** 正文配图张数上限：再多也不会更贴合全文，只会让等待和费用线性上涨。 */
function clampImageCount(count: unknown): number {
  return Math.min(5, Math.max(1, Math.round(Number(count) || 3)));
}

function contentAssetDirectory(id: number): string {
  const directory = path.join(dataDir, 'content-assets', String(id));
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** 封面提示词：面向中老年读者，并且明确禁止文字与医疗符号。 */
function coverImagePrompt(task: ContentTask): string {
  return `公众号封面图，主题：${task.title || task.topic}。面向中老年读者，温暖写实、自然光、简洁清晰；不要文字、不要医疗符号、不要夸大疗效。`;
}

/** 生成封面并落盘，返回文件路径。 */
async function generateCoverImage(task: ContentTask, signal?: AbortSignal): Promise<string> {
  const target = path.join(contentAssetDirectory(task.id), `cover-${Date.now()}.png`);
  fs.writeFileSync(target, await requestGeneratedImage(coverImagePrompt(task), '1792x1024', signal));
  return target;
}

/**
 * 按位置并发生成正文配图：paths 与 slots 一一对应，失败的位置是 null。
 * 并发是为了让「封面 + 3 张配图」这种一次动作不被串行等待拖到一分多钟。
 */
async function generateInlineImages(task: ContentTask, slots: ImageSlot[], stamp: number, signal?: AbortSignal): Promise<{ paths: Array<string | null>; failures: string[] }> {
  const directory = contentAssetDirectory(task.id);
  const failures: string[] = [];
  const settled = await Promise.allSettled(slots.map((slot, index) => (async () => {
    const bytes = await requestGeneratedImage(buildImagePrompt({
      articleTitle: task.title || task.topic,
      heading: slot.heading,
      excerpt: slot.excerpt
    }), '1792x1024', signal);
    const target = path.join(directory, `inline-${stamp}-${index + 1}.png`);
    fs.writeFileSync(target, bytes);
    return target;
  })()));
  const paths = settled.map(item => {
    if (item.status === 'fulfilled') return item.value;
    failures.push(errorText(item.reason));
    return null;
  });
  return { paths, failures };
}

/** 生成一张图并返回字节；封面与正文配图共用同一套接口与错误处理。 */
async function requestGeneratedImage(prompt: string, size = '1792x1024', signal?: AbortSignal): Promise<Buffer> {
  const { configText } = weWriteFiles();
  const apiKey = yamlScalar(configText, 'api_key');
  if (!apiKey) throw new Error('请先在公众号「环境与配置」中配置图片 API Key');
  const baseUrl = (yamlScalar(configText, 'base_url') || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = yamlScalar(configText, 'model') || 'gpt-image-2';
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST', signal: withDeadline(AbortSignal.timeout(180_000), signal), headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, n: 1, size, response_format: 'url' })
  });
  if (!response.ok) throw new Error(`图片 API 请求失败（HTTP ${response.status}）`);
  const payload = await response.json() as { data?: Array<{ url?: string; b64_json?: string }> };
  const image = payload.data?.[0];
  let bytes: Buffer | null = image?.b64_json ? Buffer.from(image.b64_json, 'base64') : null;
  if (!bytes && image?.url) {
    const download = await fetch(image.url, { signal: withDeadline(AbortSignal.timeout(60_000), signal) });
    if (!download.ok || !download.headers.get('content-type')?.startsWith('image/')) throw new Error('图片下载失败或返回的不是图片');
    bytes = Buffer.from(await download.arrayBuffer());
  }
  if (!bytes?.length) throw new Error('图片 API 未返回可用图片');
  return bytes;
}

const PREVIEW_IMAGE_LIMIT = 4 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const THUMBNAIL_WIDTH = 560;

/** 给界面用的缩略图；文件缺失或不是图片时返回空串，由前端显示占位。 */
function imageThumbnail(source: string): string {
  try {
    if (!source || !fs.existsSync(source)) return '';
    const image = nativeImage.createFromPath(source);
    if (image.isEmpty()) return '';
    const { width, height } = image.getSize();
    const scaled = width > THUMBNAIL_WIDTH
      ? image.resize({ width: THUMBNAIL_WIDTH, height: Math.max(1, Math.round(height * THUMBNAIL_WIDTH / width)), quality: 'good' })
      : image;
    return `data:image/jpeg;base64,${scaled.toJPEG(78).toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * 微信正文图片上限 1MB，而图像接口给的 PNG 经常超标（虽然封面走素材接口能到 10MB）。
 * 这里用 Electron 自带的 nativeImage 缩到 1080 宽并转 JPEG，省掉一个图像处理依赖；
 * 转码之后反而更大就保留原图。
 */
function prepareWeChatInlineImage(source: string): { bytes: Buffer; filename: string; contentType: string } {
  const raw = fs.readFileSync(source);
  try {
    const image = nativeImage.createFromBuffer(raw);
    if (image.isEmpty()) return { bytes: raw, filename: path.basename(source), contentType: contentTypeFor(source) };
    const { width, height } = image.getSize();
    const maxWidth = 1080;
    const scaled = width > maxWidth ? image.resize({ width: maxWidth, height: Math.max(1, Math.round(height * maxWidth / width)), quality: 'good' }) : image;
    const jpeg = scaled.toJPEG(82);
    if (jpeg.length >= raw.length && raw.length <= 1024 * 1024) {
      return { bytes: raw, filename: path.basename(source), contentType: contentTypeFor(source) };
    }
    return { bytes: jpeg, filename: `${path.basename(source, path.extname(source))}.jpg`, contentType: 'image/jpeg' };
  } catch {
    return { bytes: raw, filename: path.basename(source), contentType: contentTypeFor(source) };
  }
}

/** 预览用的图片地址：远程地址原样返回，本地文件转 data URI（过大则保持原路径）。 */
function previewImageSource(source: string): string {
  if (/^https?:\/\//i.test(source) || source.startsWith('data:')) return source;
  try {
    if (!fs.existsSync(source)) return source;
    if (fs.statSync(source).size > PREVIEW_IMAGE_LIMIT) return source;
    const mime = MIME_BY_EXTENSION[path.extname(source).toLowerCase()] ?? 'image/png';
    return `data:${mime};base64,${fs.readFileSync(source).toString('base64')}`;
  } catch {
    return source;
  }
}

function updateContentTask(id: number, patch: Partial<ContentTask>): ContentTask {
  const columns: Record<string, string> = {
    directionId: 'direction_id', subdirectionId: 'subdirection_id',
    topic: 'topic', title: 'title', status: 'status', briefJson: 'brief_json', claimsJson: 'claims_json', sourcesJson: 'sources_json',
    topicsJson: 'topics_json', draft: 'draft', finalArticle: 'final_article', reviewJson: 'review_json', coverPath: 'cover_path',
    theme: 'theme', publishJson: 'publish_json', exportPath: 'export_path'
  };
  const entries = Object.entries(patch).filter(([key]) => columns[key]);
  if (entries.length) {
    const sets = entries.map(([key]) => `${columns[key]}=?`);
    const values = entries.map(([, value]) => value);
    sets.push('updated_at=?'); values.push(new Date().toISOString()); values.push(id);
    db.prepare(`UPDATE content_tasks SET ${sets.join(', ')} WHERE id=?`).run(...values);
  }
  broadcast();
  return getContentTask(id);
}

/* ── 视频创作流水线 ──────────────────────────────────────────────
 * 与公众号并列的第二条内容流水线。模型只做选题、口播脚本与分镜；
 * 字幕与制作包在本地确定性生成，导出只是写知识库，
 * 模块不渲染成片、也不代替任何平台做发布。
 */

const videoPlatformSet = new Set<VideoPlatform>(VIDEO_PLATFORMS.map(item => item.value));
const videoRequests = new Set<number>();

async function withVideoRequest<T>(id: number, operation: () => Promise<T>): Promise<T> {
  if (videoRequests.has(id)) throw new Error('这条视频正在处理，请等待当前操作完成');
  videoRequests.add(id);
  try { return await operation(); } finally { videoRequests.delete(id); }
}

function videoProjectFromRow(row: Record<string, unknown>): VideoProject {
  const platform = String(row.platform ?? 'general') as VideoPlatform;
  const seconds = Math.round(Number(row.duration_seconds));
  return {
    id: Number(row.id),
    platform: videoPlatformSet.has(platform) ? platform : 'general',
    topic: String(row.topic ?? ''), title: String(row.title ?? ''), audience: String(row.audience ?? ''),
    durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 60,
    status: String(row.status ?? 'idea') as VideoProject['status'],
    topicsJson: String(row.topics_json ?? ''), script: String(row.script ?? ''), storyboardJson: String(row.storyboard_json ?? ''),
    coverPath: String(row.cover_path ?? ''), exportPath: String(row.export_path ?? ''),
    createdAt: String(row.created_at ?? ''), updatedAt: String(row.updated_at ?? '')
  };
}

function getVideoProject(id: number): VideoProject {
  const row = db.prepare('SELECT * FROM video_projects WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error('视频任务不存在');
  return videoProjectFromRow(row);
}

function updateVideoProject(id: number, patch: Partial<VideoProject>): VideoProject {
  const columns: Record<string, string> = {
    platform: 'platform', topic: 'topic', title: 'title', audience: 'audience', durationSeconds: 'duration_seconds',
    status: 'status', topicsJson: 'topics_json', script: 'script', storyboardJson: 'storyboard_json',
    coverPath: 'cover_path', exportPath: 'export_path'
  };
  const entries = Object.entries(patch).filter(([key]) => columns[key]);
  if (entries.length) {
    const sets = entries.map(([key]) => `${columns[key]}=?`);
    const values = entries.map(([, value]) => value as string | number);
    sets.push('updated_at=?'); values.push(new Date().toISOString()); values.push(id);
    db.prepare(`UPDATE video_projects SET ${sets.join(', ')} WHERE id=?`).run(...values);
  }
  broadcast();
  return getVideoProject(id);
}

function videoAssetDirectory(id: number): string {
  const directory = path.join(dataDir, 'video-assets', String(id));
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** 竖版封面提示词：中老年观众、不要文字与医疗符号、不夸大疗效。 */
function videoCoverPrompt(project: VideoProject): string {
  return `短视频竖版封面图，主题：${project.title || project.topic}。面向中老年观众，写实、自然光、主体清楚、对比适中；画面里不要出现文字、不要医疗符号、不要夸大疗效。`;
}

/**
 * 生成竖版封面（9:16）。
 * 与公众号封面共用同一套图片接口与错误处理，但尺寸不同——竖屏封面的构图和横版不通用。
 */
async function generateVideoCover(project: VideoProject): Promise<string> {
  const target = path.join(videoAssetDirectory(project.id), `cover-${Date.now()}.png`);
  fs.writeFileSync(target, await requestGeneratedImage(videoCoverPrompt(project), '1024x1792'));
  return target;
}

function videoAssets(project: VideoProject): VideoAssetBundle {
  return {
    cover: project.coverPath
      ? { path: project.coverPath, caption: '封面', thumbnail: imageThumbnail(project.coverPath) }
      : null
  };
}

function registerVideoIpc(): void {
  ipcMain.handle('video:list', () => (db.prepare('SELECT * FROM video_projects ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>).map(videoProjectFromRow));
  ipcMain.handle('video:create', (_event, platform: VideoPlatform, topic = '') => {
    if (!videoPlatformSet.has(platform)) throw new Error('未知的视频平台');
    const now = new Date().toISOString();
    const result = db.prepare("INSERT INTO video_projects (platform, topic, status, created_at, updated_at) VALUES (?, ?, 'idea', ?, ?)").run(platform, String(topic).trim(), now, now);
    broadcast();
    return getVideoProject(Number(result.lastInsertRowid));
  });
  ipcMain.handle('video:update', (_event, id: number, patch: Partial<VideoProject>) => {
    if (videoRequests.has(id)) throw new Error('这条视频正在处理，请稍后保存');
    return updateVideoProject(id, prepareVideoEdit(getVideoProject(id), patch));
  });
  ipcMain.handle('video:assets', (_event, id: number) => videoAssets(getVideoProject(id)));
  /** 选题 / 口播脚本 / 分镜：每步完成即写库，失败不会回滚已经拿到的结果。 */
  ipcMain.handle('video:generate', async (_event, id: number, stage: VideoStage) => withVideoRequest(id, async () => {
    const project = getVideoProject(id);
    assertVideoStage(project, stage);
    const generated = await requestVideoStage(project, stage, contentApiConfig());
    const patch: Partial<VideoProject> = { ...generated };
    if (stage === 'script') patch.status = 'script';
    if (stage === 'storyboard') patch.status = parseVideoShots(generated.storyboardJson || '').length ? 'storyboard' : project.status;
    return updateVideoProject(id, patch);
  }));
  ipcMain.handle('video:cover:choose', async (_event, id: number) => {
    if (videoRequests.has(id)) throw new Error('这条视频正在处理，请稍后选择封面');
    const result = await dialog.showOpenDialog(windowRef!, { properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return updateVideoProject(id, { coverPath: result.filePaths[0] });
  });
  ipcMain.handle('video:cover:generate', async (_event, id: number) => withVideoRequest(id, async () => {
    const project = getVideoProject(id);
    if (!(project.title || project.topic).trim()) throw new Error('请先确定选题或填写标题，再生成封面');
    return updateVideoProject(id, { coverPath: await generateVideoCover(project) });
  }));
  /** 导出制作包：写知识库属于本地动作，但会生成一堆文件，所以先过门槛再落盘。 */
  ipcMain.handle('video:export', (_event, id: number) => {
    if (videoRequests.has(id)) throw new Error('这条视频正在处理，请稍后导出');
    const project = getVideoProject(id);
    assertVideoExportable(project);
    const target = exportVideoPackage(currentSettings().vaultPath, project);
    return updateVideoProject(id, { exportPath: target, status: 'exported' });
  });
  ipcMain.handle('video:open-package', async (_event, id: number) => {
    const project = getVideoProject(id);
    if (!project.exportPath.trim() || !fs.existsSync(project.exportPath)) throw new Error('还没有可打开的制作包，请先导出');
    return shell.openPath(project.exportPath);
  });
}

/* ── WeWrite 兼容视图（非桌面端原生工作流依赖） ──────────────────
 * 只做两件事：读取 ~/.wewrite 下由 CLI 产生的运行状态，以及触发确定性 CLI 命令。
 * 选题/写作/审稿属于 WeWrite 的提示词层，必须由 agent 执行，应用不代跑。
 */

function readTextFile(target: string): string | null {
  try { return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null; } catch { return null; }
}

/** 只读取已知的简单标量键；实现已移到 services/wewrite-config.ts 以便单测。 */

function weWriteFiles(): { styleText: string | null; configText: string | null } {
  const home = weWriteHome();
  return { styleText: readTextFile(path.join(home, 'style.yaml')), configText: readTextFile(path.join(home, 'config.yaml')) };
}

/** artifacts 里存的是相对 ~/.wewrite 的路径（如 runs/<id>/article.md），传给 CLI 前必须转成绝对路径。 */
function absoluteArtifact(value: string): string {
  return path.isAbsolute(value) ? value : path.join(weWriteHome(), value);
}

/** 从 images.json 里尽力找一张封面。上游未固定该清单的形状，所以只做保守的字符串扫描。 */
function detectCover(runId: string): string {
  const manifest = readTextFile(path.join(weWriteHome(), 'runs', runId, 'images.json'));
  if (!manifest) return '';
  try {
    const found: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        if (/\.(png|jpe?g|webp|gif)$/i.test(value)) found.push(value);
        return;
      }
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(JSON.parse(manifest));
    for (const candidate of found) {
      const resolved = absoluteArtifact(candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch { /* 清单损坏时退回手动选择封面 */ }
  return '';
}

/** 面板默认主题取 style.yaml 的 theme，而不是 CLI 硬编码的 professional-clean。 */
function defaultWeWriteTheme(): string {
  return yamlScalar(weWriteFiles().styleText, 'theme') || 'professional-clean';
}

async function rawRun(runId: string): Promise<Record<string, unknown> | null> {
  const result = await runWeWriteJson<Record<string, unknown>>(['run', 'show', runId]);
  return result.ok ? result.data : null;
}

function requireRun(state: Record<string, unknown> | null): Record<string, unknown> {
  if (!state) throw new Error('任务不存在或已被删除');
  return state;
}

async function renderRunPreview(runId: string, theme?: string): Promise<{ ok: true; html: string; target: string; stdout: string } | { ok: false; error: string; detail: string }> {
  const state = requireRun(await rawRun(runId));
  const article = pickArticlePath(state.artifacts);
  if (!article) return { ok: false, error: '这个任务还没有可排版的正文', detail: '需要先完成写作与审稿，产出 article.md 或 draft.md' };
  const target = path.join(weWriteHome(), 'runs', runId, 'preview.html');
  // --no-open 必须带：否则 CLI 会弹出系统浏览器窗口。
  const result = await runWeWrite(['preview', absoluteArtifact(article), '-t', theme?.trim() || defaultWeWriteTheme(), '-o', target, '--no-open']);
  if (!result.ok) return { ok: false, error: result.error, detail: result.detail };
  return { ok: true, html: readTextFile(target) ?? '', target, stdout: result.stdout.trim() };
}

/** 列出 ~/.agents/skills 下的 skill 名称（junction 与普通目录都算）。 */
function readSkillNames(directory: string): string[] {
  try { return fs.readdirSync(directory); } catch { return []; }
}

function writeWeWriteFile(target: string, content: string): void {
  writeFileAtomic(target, content, { mode: 0o600 });
  if (process.platform === 'win32') {
    const identity = `${process.env.USERDOMAIN || process.env.COMPUTERNAME || ''}\\${process.env.USERNAME || ''}`;
    if (identity.endsWith('\\')) return;
    spawnSync('icacls', [target, '/inheritance:r', '/grant:r', `${identity}:F`], { windowsHide: true, stdio: 'ignore' });
  }
}

function listLocalWeWriteThemes(): WeWriteOverview['themes'] {
  const themes = new Map<string, string>([['elder-clear', '中老年友好大字号'], ['professional-clean', '简洁排版']]);
  for (const directory of [path.join(app.getPath('home'), 'wewrite', 'src', 'wewrite', 'toolkit', 'themes'), path.join(weWriteHome(), 'themes')]) {
    if (!fs.existsSync(directory)) continue;
    for (const filename of fs.readdirSync(directory)) {
      if (!filename.endsWith('.yaml')) continue;
      const source = readTextFile(path.join(directory, filename));
      themes.set(filename.slice(0, -5), yamlScalar(source, 'description'));
    }
  }
  return [...themes].map(([name, description]) => ({ name, description }));
}

function collectWeWriteOverview(): Promise<WeWriteOverview> {
  return (async () => {
    const home = weWriteHome();
    const { styleText, configText } = weWriteFiles();
    const checks = [
      { group: 'config', name: '公众号资料', status: styleText ? 'PASS' : 'WARN', detail: styleText ? '已保存到本机' : '请填写公众号资料' },
      { group: 'config', name: 'Wechat Credentials', status: yamlScalar(configText, 'appid') && yamlScalar(configText, 'secret') ? 'PASS' : 'WARN', detail: '配置状态；实际连接由推送时验证' },
      { group: 'config', name: 'Image Api Key', status: yamlScalar(configText, 'api_key') ? 'PASS' : 'WARN', detail: '配置状态；实际连接由生图时验证' },
      { group: 'config', name: '内容生成 API', status: resolveLlmApiKey(secretStore.read(), process.env.SYDNEY_LLM_API_KEY || '') ? 'PASS' : 'WARN', detail: currentSettings().llmEnabled ? '已允许主动调用' : '请开启“允许发送到 DeepSeek”' }
    ];
    const themes = listLocalWeWriteThemes();
    const raw = {
      checks,
      summary: { passed: checks.filter(item => item.status === 'PASS').length, warnings: checks.filter(item => item.status === 'WARN').length, failures: 0, skipped: 0 },
      recommendations: [],
      files: {
        config_yaml: configText !== null, style_yaml: styleText !== null,
        playbook_md: fs.existsSync(path.join(home, 'playbook.md')), history_yaml: fs.existsSync(path.join(home, 'history.yaml')),
        persona: yamlScalar(styleText, 'writing_persona'), exemplars: []
      },
      flags: { skip_publish: !(yamlScalar(configText, 'appid') && yamlScalar(configText, 'secret')), skip_image_gen: !yamlScalar(configText, 'api_key'), needs_onboard: !styleText }
    };
    const runs = (db.prepare('SELECT status FROM content_tasks').all() as Array<{ status: string }>).map(item => ({ status: ['ready', 'published'].includes(item.status) ? 'completed' : 'active' }));
    const skillDirectory = path.join(app.getPath('home'), '.agents', 'skills');
    const skillNames = readSkillNames(skillDirectory);
    return {
      cliAvailable: fs.existsSync(resolveWeWriteBinary()),
      cliError: '',
      cliVersion: '可选兼容工具',
      writer: {
        baseUrl: yamlScalar(yamlBlock(configText, 'writer'), 'base_url') || process.env.SYDNEY_LLM_BASE_URL || 'https://api.deepseek.com/v1',
        model: yamlScalar(yamlBlock(configText, 'writer'), 'model') || process.env.SYDNEY_LLM_MODEL || 'deepseek-chat',
        apiKeyMasked: maskSecret(resolveLlmApiKey(secretStore.read(), process.env.SYDNEY_LLM_API_KEY || '')),
        enabled: yamlScalar(yamlBlock(configText, 'writer'), 'enabled') ? yamlScalar(yamlBlock(configText, 'writer'), 'enabled') === 'true' : currentSettings().llmEnabled
      },
      home,
      checks: parseChecks(raw.checks),
      summary: parseSummary(raw.summary),
      recommendations: parseRecommendations(raw.recommendations),
      files: parseDiagnoseFiles(raw.files),
      flags: parseDiagnoseFlags(raw.flags),
      image: parseImageConfig(configText),
      wechat: { author: parseWechatAuthor(configText) },
      style: parseStyleSummary(styleText),
      themes,
      skills: {
        total: skillNames.filter(name => name.startsWith('wewrite')).length,
        elderHealth: skillNames.includes('wewrite-elder-health'),
        complianceReference: fs.existsSync(path.join(skillDirectory, 'wewrite-elder-health', 'references', 'health-compliance.md')),
        topicReference: fs.existsSync(path.join(skillDirectory, 'wewrite-elder-health', 'references', 'topic-sources.md'))
      },
      counts: countRuns(runs)
    };
  })();
}

function registerWeWriteIpc(): void {
  ipcMain.handle('wewrite:overview', () => collectWeWriteOverview());

  ipcMain.handle('wewrite:config:save', async (_event, draft: WeWriteConfigDraft): Promise<WeWriteOverview> => {
    const current = weWriteFiles();
    const normalized = normalizeWeWriteDraft(draft, current);
    // 先落盘配置文件，再写入密钥：密钥保存失败不该让用户填的整套配置一起丢掉。
    writeWeWriteFile(path.join(weWriteHome(), 'style.yaml'), serializeStyleConfig(normalized.style));
    writeWeWriteFile(path.join(weWriteHome(), 'config.yaml'), serializeCliConfig(normalized));
    if (draft.writer?.apiKey.trim()) {
      try {
        secretStore.save(draft.writer.apiKey);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`配置已保存，但内容 API Key 未能写入系统安全存储：${detail}`);
      }
    }
    windowRef?.webContents.send('wewrite:changed');
    return collectWeWriteOverview();
  });

  ipcMain.handle('wewrite:environment', async (): Promise<WeWriteEnvironment> => {
    const home = weWriteHome();
    const { styleText, configText } = weWriteFiles();
    const themes = listLocalWeWriteThemes();
    return {
      cliAvailable: fs.existsSync(resolveWeWriteBinary()),
      cliError: fs.existsSync(resolveWeWriteBinary()) ? '' : '未安装可选 WeWrite CLI',
      home,
      theme: defaultWeWriteTheme(),
      themes,
      configFound: configText !== null,
      styleFound: styleText !== null,
      persona: yamlScalar(styleText, 'writing_persona'),
      defaultTopic: parseStyleSummary(styleText).defaultTopic,
      wechatConfigured: Boolean(yamlScalar(configText, 'appid') && yamlScalar(configText, 'secret')),
      imageConfigured: Boolean(yamlScalar(configText, 'api_key'))
    };
  });

  ipcMain.handle('wewrite:runs', async (_event, includeCompleted = true): Promise<WeWriteRunSummary[]> => {
    const result = await runWeWriteJson<unknown[]>(['run', 'list', ...(includeCompleted ? ['--all'] : [])]);
    if (!result.ok) throw new Error(result.error);
    return (Array.isArray(result.data) ? result.data : []).map(summarizeRun).filter(run => run.id);
  });

  ipcMain.handle('wewrite:run', async (_event, runId: string): Promise<WeWriteRunDetail> => describeRun(requireRun(await rawRun(runId))));

  ipcMain.handle('wewrite:preview', async (_event, runId: string, theme?: string): Promise<WeWriteActionResult> => {
    const rendered = await renderRunPreview(runId, theme);
    return rendered.ok ? { ok: true, output: rendered.stdout, html: rendered.html, target: rendered.target } : rendered;
  });

  ipcMain.handle('wewrite:validate', async (_event, runId: string): Promise<WeWriteActionResult> => {
    const rendered = await renderRunPreview(runId);
    if (!rendered.ok) return rendered;
    const result = await runWeWrite(['validate', rendered.target]);
    return result.ok
      ? { ok: true, output: result.stdout.trim(), target: rendered.target }
      : { ok: false, error: result.error, detail: result.detail };
  });

  ipcMain.handle('wewrite:score', async (_event, runId: string): Promise<WeWriteActionResult> => {
    const state = requireRun(await rawRun(runId));
    const article = pickArticlePath(state.artifacts);
    if (!article) return { ok: false, error: '这个任务还没有可评分的正文', detail: '需要先完成写作与审稿' };
    const result = await runWeWrite(['score', absoluteArtifact(article)]);
    return result.ok ? { ok: true, output: result.stdout.trim() } : { ok: false, error: result.error, detail: result.detail };
  });

  ipcMain.handle('wewrite:hotspots', async (_event, limit = 20): Promise<WeWriteActionResult> => {
    const result = await runWeWrite(['hotspots', '--limit', String(Math.min(Math.max(1, limit), 50))], 90_000);
    return result.ok ? { ok: true, output: result.stdout.trim() } : { ok: false, error: result.error, detail: result.detail };
  });

  ipcMain.handle('wewrite:search-articles', async (_event, query: string, days = 2): Promise<WeWriteActionResult> => {
    const keyword = query.trim();
    if (!keyword) return { ok: false, error: '请先输入搜索关键词', detail: '' };
    const window = [1, 2, 3, 4].includes(days) ? days : 2;
    const result = await runWeWrite(['search-articles', keyword, '-n', '15', '-t', String(window)], 90_000);
    return result.ok ? { ok: true, output: result.stdout.trim() } : { ok: false, error: result.error, detail: result.detail };
  });

  ipcMain.handle('wewrite:open-run', async (_event, runId: string): Promise<WeWriteActionResult> => {
    const target = path.join(weWriteHome(), 'runs', runId);
    if (!fs.existsSync(target)) return { ok: false, error: '任务目录不存在', detail: target };
    await shell.openPath(target);
    return { ok: true, output: target, target };
  });

  ipcMain.handle('wewrite:cover', async (_event, runId: string): Promise<WeWriteActionResult> => {
    const cover = detectCover(runId);
    return cover ? { ok: true, output: cover, target: cover } : { ok: true, output: '' };
  });

  /**
   * 推送草稿箱：对真实公众号创建一篇草稿（不会群发）。
   * 两个前置条件都是硬性的：微信凭证已配置，以及存在封面图——
   * 因为上游 create_draft 在缺少 thumb_media_id 时会直接抛错。
   * 授权按“本次点击”授予，推送后立即收回，使每次推送都需要一次新的人工确认。
   */
  ipcMain.handle('wewrite:publish', async (_event, runId: string, theme?: string, coverPath?: string): Promise<WeWriteActionResult> => {
    const { configText } = weWriteFiles();
    if (!(yamlScalar(configText, 'appid') && yamlScalar(configText, 'secret'))) {
      return { ok: false, error: '未配置微信凭证', detail: '请先在 ~/.wewrite/config.yaml 填写 wechat.appid 与 wechat.secret' };
    }
    const state = requireRun(await rawRun(runId));
    const article = pickArticlePath(state.artifacts);
    if (!article) return { ok: false, error: '这个任务还没有成稿', detail: '需要先完成写作与审稿，产出 article.md' };
    const cover = coverPath?.trim() || detectCover(runId);
    if (!cover) return { ok: false, error: '缺少封面图', detail: '推送草稿箱必须提供封面。请先让 agent 生成配图，或在面板里选择一张图片。' };
    if (!fs.existsSync(cover)) return { ok: false, error: '封面图文件不存在', detail: cover };

    await runWeWrite(['run', 'permission', 'publish', 'allow', '--run-id', runId]);
    const result = await runWeWrite(['publish', absoluteArtifact(article), '-t', theme?.trim() || defaultWeWriteTheme(), '--cover', cover], 180_000);
    await runWeWrite(['run', 'permission', 'publish', 'deny', '--run-id', runId]);
    return result.ok
      ? { ok: true, output: result.stdout.trim(), target: cover }
      : { ok: false, error: result.error, detail: result.detail };
  });
}

function watchWeWriteRuns(): void {
  const runsDir = path.join(weWriteHome(), 'runs');
  if (!fs.existsSync(runsDir)) return;
  try {
    weWriteWatcher = fs.watch(runsDir, { recursive: true }, () => {
      if (weWriteWatchTimer) clearTimeout(weWriteWatchTimer);
      weWriteWatchTimer = setTimeout(() => windowRef?.webContents.send('wewrite:changed'), 600);
    });
  } catch { /* 某些文件系统不支持递归监听，面板仍可手动刷新 */ }
}

function createWindow() {
  windowRef = new BrowserWindow({ width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: '#f7f8fa', title: 'Sydney', webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false } });
  if (process.env.ELECTRON_RENDERER_URL) void windowRef.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void windowRef.loadFile(path.join(__dirname, '../renderer/index.html'));
}
app.whenReady().then(() => {
  dataDir = app.getPath('userData'); settingsPath = path.join(dataDir, 'settings.json'); fs.mkdirSync(dataDir, { recursive: true });
  secretStore = new SecretStore(dataDir, safeStorage);
  screenFrameStore = new ScreenFrameStore(path.join(dataDir, 'screen-frames'), safeStorage);
  fileWatcher = new InputFileWatcher(change => {
    insertMetadataEvent({
      kind: 'file_change',
      note: `文件变化：${change.path}`,
      summary: `只记录路径，不读取文件内容（${change.changeType}）`,
      source: 'file',
      relatedPath: change.path,
      changeType: change.changeType
    });
  });
  db = new DatabaseSync(path.join(dataDir, 'sydney.db'));
  db.exec('CREATE TABLE IF NOT EXISTS screen_frames (id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL, encrypted_path TEXT NOT NULL);');
  screenCapture = { ...screenCapture, saved: Number((db.prepare('SELECT COUNT(*) AS count FROM screen_frames').get() as { count: number }).count) };
  db.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT '', window_title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '', duration_seconds INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', value_score INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '个人成长'); CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS content_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idea', brief_json TEXT NOT NULL DEFAULT '', claims_json TEXT NOT NULL DEFAULT '', sources_json TEXT NOT NULL DEFAULT '', topics_json TEXT NOT NULL DEFAULT '',
    draft TEXT NOT NULL DEFAULT '', final_article TEXT NOT NULL DEFAULT '', review_json TEXT NOT NULL DEFAULT '', cover_path TEXT NOT NULL DEFAULT '',
    theme TEXT NOT NULL DEFAULT '', publish_json TEXT NOT NULL DEFAULT '', export_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS video_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL DEFAULT 'general', topic TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT '', duration_seconds INTEGER NOT NULL DEFAULT 60, status TEXT NOT NULL DEFAULT 'idea',
    topics_json TEXT NOT NULL DEFAULT '', script TEXT NOT NULL DEFAULT '', storyboard_json TEXT NOT NULL DEFAULT '',
    cover_path TEXT NOT NULL DEFAULT '', export_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  migrateCodexEventColumns(db);
  migrateAiDraftColumns(db);
  migrateRuleTables(db);
  migrateCardColumns(db);
  const contentColumns = new Set((db.prepare('PRAGMA table_info(content_tasks)').all() as Array<{ name: string }>).map(column => column.name));
  if (!contentColumns.has('publish_json')) db.exec("ALTER TABLE content_tasks ADD COLUMN publish_json TEXT NOT NULL DEFAULT ''");
  if (!contentColumns.has('sources_json')) db.exec("ALTER TABLE content_tasks ADD COLUMN sources_json TEXT NOT NULL DEFAULT ''");
  if (!contentColumns.has('export_path')) db.exec("ALTER TABLE content_tasks ADD COLUMN export_path TEXT NOT NULL DEFAULT ''");
  if (!contentColumns.has('theme')) db.exec("ALTER TABLE content_tasks ADD COLUMN theme TEXT NOT NULL DEFAULT ''");
  const eventColumns = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, definition] of [['related_path', "TEXT NOT NULL DEFAULT ''"], ['adapter', "TEXT NOT NULL DEFAULT ''"], ['change_type', "TEXT NOT NULL DEFAULT ''"]] as const) {
    if (!eventColumns.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
  }
  const startupSettings = currentSettings();
  writeSettings({ ...startupSettings, captureEnabled: false, capturePaused: false });
  refreshCodexAdapter();
  refreshClaudeAdapter();
  retentionTimer = setInterval(cleanupScreenFrames, 60 * 60 * 1000);
  cleanupScreenFrames();
  registerIpc(); createWindow(); watchWeWriteRuns(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { codexAdapter?.stop(); claudeAdapter?.stop(); fileWatcher?.stop(); weWriteWatcher?.close(); if (weWriteWatchTimer) clearTimeout(weWriteWatchTimer); if (captureTimer) clearInterval(captureTimer); if (screenTimer) clearInterval(screenTimer); if (retentionTimer) clearInterval(retentionTimer); if (process.platform !== 'darwin') app.quit(); });
