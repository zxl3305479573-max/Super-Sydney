import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { AppContext } from './app-context';
import type { CaptureStatus, ClaudeCaptureStatus, CodexCaptureStatus, Settings } from './shared';
import { CodexSessionAdapter, DEFAULT_CODEX_ORIGINATORS, KNOWN_CODEX_ORIGINATORS, shouldRunCodexCapture } from './services/codex-session-adapter';
import { ClaudeSessionAdapter, defaultClaudeProjectsRoot } from './services/claude-session-adapter';
import { persistAiMessage, persistCodexMessage, type AiSource } from './services/codex-event-store';
import { backfillAiAnswers } from './services/ai-answer-backfill';
import { extendPendingActivity, insertMetadataEvent, type MetadataEventInput } from './services/event-store';
import { ActivitySegmenter, isSelfWindow, normalizeWindowTitle } from './services/activity-segment';
import { ScreenFrameStore } from './services/screen-frame-store';
import { capturePrimaryScreen } from './services/screen-capture';
import { shouldCaptureScreen } from './services/screen-capture-policy';
import { InputFileWatcher } from './services/input-file-watcher';
import { classifyApplication } from './services/application-adapters';
import { describeCaptureObservation } from './services/capture-status';

type ScreenCaptureState = { state: 'disabled' | 'stopped' | 'capturing' | 'error'; saved: number; error: string };
export type CaptureMode = 'start' | 'pause' | 'stop';

export function migrateScreenFrameTable(ctx: Pick<AppContext, 'db'>): void {
  ctx.db.exec('CREATE TABLE IF NOT EXISTS screen_frames (id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL, encrypted_path TEXT NOT NULL);');
}

/**
 * 采集运行时：前台窗口采样、屏幕帧、Codex/Claude 会话监听、输入目录监听。
 * 所有定时器与适配器都归它管，dispose() 一次性收回。
 */
export class CaptureRuntime {
  private readonly ctx: AppContext;
  private readonly screenFrameStore: ScreenFrameStore;
  private readonly fileWatcher: InputFileWatcher;
  private captureTimer: NodeJS.Timeout | undefined;
  private screenTimer: NodeJS.Timeout | undefined;
  private retentionTimer: NodeJS.Timeout | undefined;
  private readonly segmenter = new ActivitySegmenter();
  private codexAdapter: CodexSessionAdapter | undefined;
  private codexSessionsRoot = '';
  private codexCapture: CodexCaptureStatus = { state: 'disabled', error: '' };
  private claudeAdapter: ClaudeSessionAdapter | undefined;
  private claudeAdapterKey = '';
  private claudeCapture: ClaudeCaptureStatus = { state: 'disabled', error: '' };
  private screenCapture: ScreenCaptureState = { state: 'disabled', saved: 0, error: '' };
  private screenCaptureInFlight = false;
  private captureStatus: CaptureStatus = { state: 'idle', appName: '', windowTitle: '', sampledAt: '', message: '尚未采样' };

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.screenFrameStore = new ScreenFrameStore(path.join(ctx.dataDir, 'screen-frames'), safeStorage);
    this.fileWatcher = new InputFileWatcher(change => {
      this.recordMetadata({
        kind: 'file_change',
        note: `文件变化：${change.path}`,
        summary: `只记录路径，不读取文件内容（${change.changeType}）`,
        source: 'file',
        relatedPath: change.path,
        changeType: change.changeType
      });
    });
    this.screenCapture = { ...this.screenCapture, saved: this.countScreenFrames() };
  }

  /** 启动时调用：记录总开关一律复位为未开始（每次启动都要用户手动点「开始记录」），屏幕帧按保留时长清理。 */
  start(): void {
    const config = this.ctx.settings.read();
    if (config.captureEnabled || config.capturePaused) {
      config.captureEnabled = false;
      config.capturePaused = false;
      fs.mkdirSync(this.ctx.dataDir, { recursive: true }); this.ctx.settings.write(config);
    }
    this.refreshCodexAdapter();
    this.refreshClaudeAdapter();
    this.retentionTimer = setInterval(() => this.cleanupScreenFrames(), 60 * 60 * 1000);
    this.cleanupScreenFrames();
  }

  dispose(): void {
    this.codexAdapter?.stop();
    this.claudeAdapter?.stop();
    this.fileWatcher.stop();
    if (this.captureTimer) clearInterval(this.captureTimer);
    if (this.screenTimer) clearInterval(this.screenTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
  }

  snapshot(): { codexCapture: CodexCaptureStatus; claudeCapture: ClaudeCaptureStatus; screenCapture: ScreenCaptureState; captureStatus: CaptureStatus } {
    return { codexCapture: this.codexCapture, claudeCapture: this.claudeCapture, screenCapture: this.screenCapture, captureStatus: this.captureStatus };
  }

  setCapture(mode: CaptureMode): void {
    const config = this.ctx.settings.read();
    config.captureEnabled = mode !== 'stop';
    config.capturePaused = mode === 'pause';
    fs.mkdirSync(this.ctx.dataDir, { recursive: true }); this.ctx.settings.write(config);
    if (this.captureTimer) clearInterval(this.captureTimer); this.captureTimer = undefined; this.segmenter.reset();
    this.captureStatus = mode === 'stop' ? { state: 'idle', appName: '', windowTitle: '', sampledAt: '', message: '记录已停止' } : this.captureStatus;
    if (config.captureEnabled && !config.capturePaused) { void this.captureTick(); this.captureTimer = setInterval(() => void this.captureTick(), Math.max(10, config.captureIntervalSeconds) * 1000); }
    this.refreshCodexAdapter();
    this.refreshClaudeAdapter();
    this.refreshInputWatcher();
    this.refreshScreenCapture();
    this.ctx.broadcast();
  }

  /** 设置已落盘后调用：总开关变化走 setCapture，其余只刷新受影响的监听。 */
  applySettings(previous: Settings, next: Settings): void {
    if (next.captureEnabled !== previous.captureEnabled) { this.setCapture(next.captureEnabled ? 'start' : 'stop'); return; }
    if (next.codexIncludeCli !== previous.codexIncludeCli) this.codexAdapter?.stop();
    this.refreshCodexAdapter();
    this.refreshClaudeAdapter();
    this.refreshInputWatcher();
    this.refreshScreenCapture();
  }

  private recordMetadata(input: MetadataEventInput): void {
    insertMetadataEvent(this.ctx.db, input);
    this.ctx.broadcast();
  }

  private countScreenFrames(): number {
    return Number((this.ctx.db.prepare('SELECT COUNT(*) AS count FROM screen_frames').get() as { count: number }).count);
  }

  private refreshInputWatcher(): void {
    const config = this.ctx.settings.read();
    this.fileWatcher.stop();
    if (!config.inputWatchEnabled || !config.captureEnabled || config.capturePaused) return;
    const defaultInput = path.join(config.vaultPath, '01-输入');
    fs.mkdirSync(defaultInput, { recursive: true });
    this.fileWatcher.start(config.inputWatchPaths.length ? config.inputWatchPaths : [defaultInput]);
  }

  private refreshScreenCapture(): void {
    const config = this.ctx.settings.read();
    if (this.screenTimer) clearInterval(this.screenTimer);
    this.screenTimer = undefined;
    const saved = this.screenCapture.saved;
    if (!config.screenCaptureEnabled) { this.screenCapture = { state: 'disabled', saved, error: '' }; return; }
    if (!config.captureEnabled || config.capturePaused) { this.screenCapture = { state: 'stopped', saved, error: '' }; return; }
    if (!this.screenFrameStore.isAvailable()) { this.screenCapture = { state: 'error', saved, error: '系统安全存储不可用，未采集屏幕' }; return; }
    this.screenCapture = { state: 'capturing', saved, error: '' };
    void this.screenCaptureTick();
    this.screenTimer = setInterval(() => void this.screenCaptureTick(), Math.max(15, config.screenCaptureIntervalSeconds) * 1000);
  }

  private async screenCaptureTick(): Promise<void> {
    if (this.screenCaptureInFlight) return;
    const config = this.ctx.settings.read();
    if (!config.captureEnabled || config.capturePaused || !config.screenCaptureEnabled) return;
    this.screenCaptureInFlight = true;
    try {
      const activeWindow = await import('active-win');
      const active = await activeWindow.default();
      const appName = active?.owner?.name || '';
      const title = active?.title || '';
      const decision = shouldCaptureScreen({ appName, windowTitle: title, allowedApps: config.allowedApps, blockedApps: config.blockedApps });
      if (!decision.allowed) return;
      const png = await capturePrimaryScreen();
      const latest = this.ctx.settings.read();
      if (!png || !latest.captureEnabled || latest.capturePaused || !latest.screenCaptureEnabled) return;
      const framePath = this.screenFrameStore.save(png);
      this.ctx.db.prepare('INSERT INTO screen_frames (captured_at, encrypted_path) VALUES (?, ?)').run(new Date().toISOString(), framePath);
      this.screenCapture = { state: 'capturing', saved: this.screenCapture.saved + 1, error: '' };
      this.ctx.broadcast();
    } catch (error) {
      this.screenCapture = { state: 'error', saved: this.screenCapture.saved, error: error instanceof Error ? error.message : String(error) };
      this.ctx.broadcast();
    } finally {
      this.screenCaptureInFlight = false;
    }
  }

  private cleanupScreenFrames(): void {
    const hours = this.ctx.settings.read().screenRetentionHours;
    this.screenFrameStore.cleanup(hours);
    const cutoff = new Date(Date.now() - Math.max(1, hours) * 60 * 60 * 1000).toISOString();
    this.ctx.db.prepare('DELETE FROM screen_frames WHERE captured_at < ?').run(cutoff);
    this.screenCapture = { ...this.screenCapture, saved: this.countScreenFrames() };
  }

  private refreshCodexAdapter(): void {
    const config = this.ctx.settings.read();
    if (!shouldRunCodexCapture(config.codexCaptureEnabled, config.captureEnabled, config.capturePaused)) {
      this.codexAdapter?.stop();
      this.codexCapture = { state: config.codexCaptureEnabled ? 'stopped' : 'disabled', error: '' };
      return;
    }
    const originators = config.codexIncludeCli ? KNOWN_CODEX_ORIGINATORS : DEFAULT_CODEX_ORIGINATORS;
    if (!this.codexAdapter) {
      const codexHome = process.env.CODEX_HOME?.trim() || path.join(this.ctx.homeDir, '.codex');
      this.codexSessionsRoot = path.join(codexHome, 'sessions');
      this.codexAdapter = new CodexSessionAdapter(
        this.codexSessionsRoot,
        message => { persistCodexMessage(this.ctx.db, message); this.ctx.broadcast(); },
        error => { this.codexCapture = { state: 'error', error }; this.ctx.broadcast(); },
        1_000,
        originators
      );
    }
    this.codexAdapter.setOriginators(originators);
    const codexStarting = !this.codexAdapter.isRunning;
    this.codexAdapter.start();
    if (codexStarting) this.backfillAnswers('codex', [this.codexSessionsRoot]);
    this.codexCapture = { state: 'listening', error: '' };
  }

  private refreshClaudeAdapter(): void {
    const config = this.ctx.settings.read();
    if (!shouldRunCodexCapture(config.claudeCaptureEnabled, config.captureEnabled, config.capturePaused)) {
      this.claudeAdapter?.stop();
      this.claudeCapture = { state: config.claudeCaptureEnabled ? 'stopped' : 'disabled', error: '' };
      return;
    }
    const roots = [defaultClaudeProjectsRoot(this.ctx.homeDir), ...config.claudeExtraRoots.map(root => root.trim()).filter(Boolean)];
    const key = roots.join('|');
    if (!this.claudeAdapter || key !== this.claudeAdapterKey) {
      this.claudeAdapter?.stop();
      this.claudeAdapterKey = key;
      this.claudeAdapter = new ClaudeSessionAdapter(
        roots,
        message => { persistAiMessage(this.ctx.db, 'claude', message); this.ctx.broadcast(); },
        error => { this.claudeCapture = { state: 'error', error }; this.ctx.broadcast(); }
      );
    }
    const claudeStarting = !this.claudeAdapter.isRunning;
    this.claudeAdapter.start();
    this.claudeCapture = { state: 'listening', error: '' };
    if (claudeStarting) this.backfillAnswers('claude', roots);
  }

  /**
   * 监听刚启动时补齐错过的最终答复：提问记下了、AI 跑完时记录却没开的回合（见 ai-answer-backfill.ts）。
   * 放到下一轮事件循环里做，不拖慢「开始记录」本身；读日志失败不影响实时监听。
   */
  private backfillAnswers(source: AiSource, roots: string[]): void {
    setTimeout(() => {
      try {
        if (backfillAiAnswers(this.ctx.db, source, roots) > 0) this.ctx.broadcast();
      } catch (error) {
        console.warn(`补齐 ${source} 最终答复失败`, error);
      }
    }, 0);
  }

  private async captureTick(): Promise<void> {
    const config = this.ctx.settings.read();
    if (!config.captureEnabled || config.capturePaused) return;
    try {
      const activeWindow = await import('active-win');
      const active = await activeWindow.default();
      const appName = active?.owner?.name || '';
      const title = active?.title || '';
      const blocked = config.blockedApps.some(name => `${appName} ${title}`.toLowerCase().includes(name.toLowerCase())) || /password|sign in|login|payment|checkout|bank|密码|支付|银行卡|私聊|private/i.test(title);
      const allowed = !config.allowedApps.length || config.allowedApps.some(name => appName.toLowerCase().includes(name.toLowerCase()));
      const sampledAt = new Date().toISOString();
      this.captureStatus = describeCaptureObservation({ appName, windowTitle: title.slice(0, 240), allowed, blocked, saveUnallowed: config.captureAllPending, sampledAt });
      this.ctx.broadcast();
      const windowTitle = normalizeWindowTitle(appName, title).slice(0, 240);
      const skip = !appName || blocked || isSelfWindow(title) || (!allowed && !config.captureAllPending);
      const now = Date.now();
      // 连续两次采样都是同一窗口才算一段活动；之后的采样只延长这一条的时长。
      const action = this.segmenter.observe(skip ? null : `${appName}\n${windowTitle}`, now, Math.max(10, config.captureIntervalSeconds) * 2500);
      if (action.type === 'insert') {
        const adapted = classifyApplication(appName, windowTitle);
        this.segmenter.attach(insertMetadataEvent(this.ctx.db, {
          kind: 'adapter',
          note: adapted.note,
          summary: adapted.summary,
          source: 'adapter',
          adapter: adapted.adapter,
          appName,
          windowTitle,
          durationSeconds: action.durationSeconds,
          createdAt: new Date(action.startedAt).toISOString()
        }));
        this.ctx.broadcast();
      } else if (action.type === 'update') {
        if (extendPendingActivity(this.ctx.db, action.eventId, action.durationSeconds)) this.ctx.broadcast();
        else this.segmenter.restart(now);
      }
    } catch (error) {
      this.captureStatus = { state: 'error', appName: '', windowTitle: '', sampledAt: new Date().toISOString(), message: error instanceof Error ? `采样失败：${error.message}` : '采样失败' };
      this.ctx.broadcast();
    }
  }
}
