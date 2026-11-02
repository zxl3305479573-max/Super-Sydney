import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import type { AppUpdateState } from '../shared.ts';

export type UpdateBackend = Pick<AppUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'autoRunAppAfterInstall' | 'allowDowngrade' | 'allowPrerelease' | 'on' | 'removeListener' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'>;

export class AppUpdateService {
  private readonly updater: UpdateBackend;
  private readonly broadcast: (state: AppUpdateState) => void;
  private state: AppUpdateState;
  private pendingCheck: Promise<AppUpdateState> | null = null;
  private pendingDownload: Promise<AppUpdateState> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(updater: UpdateBackend, options: { currentVersion: string; unsupportedReason?: string; broadcast: (state: AppUpdateState) => void }) {
    this.updater = updater;
    this.broadcast = options.broadcast;
    this.state = {
      status: options.unsupportedReason ? 'unsupported' : 'idle',
      supported: !options.unsupportedReason,
      currentVersion: options.currentVersion,
      latestVersion: '', releaseNotes: '', releaseDate: '',
      progress: 0, transferred: 0, total: 0, bytesPerSecond: 0,
      downloaded: false, checkedAt: '', error: options.unsupportedReason ?? ''
    };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('update-available', this.available);
    updater.on('update-not-available', this.notAvailable);
    updater.on('download-progress', this.progress);
    updater.on('update-downloaded', this.downloaded);
    updater.on('error', this.failed);
  }

  getState(): AppUpdateState {
    return { ...this.state };
  }

  start(): void {
    if (!this.state.supported || this.initialTimer || this.interval) return;
    this.initialTimer = setTimeout(() => { void this.check(); }, 10_000);
    this.interval = setInterval(() => { void this.check(); }, 4 * 60 * 60_000);
    this.initialTimer.unref?.();
    this.interval.unref?.();
  }

  dispose(): void {
    clearTimeout(this.initialTimer);
    clearInterval(this.interval);
    this.initialTimer = undefined;
    this.interval = undefined;
    this.updater.removeListener('update-available', this.available);
    this.updater.removeListener('update-not-available', this.notAvailable);
    this.updater.removeListener('download-progress', this.progress);
    this.updater.removeListener('update-downloaded', this.downloaded);
    this.updater.removeListener('error', this.failed);
  }

  check(): Promise<AppUpdateState> {
    if (!this.state.supported || this.pendingDownload || this.state.downloaded || this.state.status === 'installing') return Promise.resolve(this.getState());
    if (this.pendingCheck) return this.pendingCheck;
    this.pendingCheck = this.performCheck().finally(() => { this.pendingCheck = null; });
    return this.pendingCheck;
  }

  async download(): Promise<AppUpdateState> {
    if (!this.state.supported || this.state.downloaded || this.state.status === 'installing') return Promise.resolve(this.getState());
    if (this.pendingDownload) return this.pendingDownload;
    if (this.pendingCheck) {
      await this.pendingCheck;
      return this.download();
    }
    if (!this.state.latestVersion) return this.getState();
    this.pendingDownload = this.performDownload().finally(() => { this.pendingDownload = null; });
    return this.pendingDownload;
  }

  install(): AppUpdateState {
    if (!this.state.supported || !this.state.downloaded || this.state.status === 'installing') return this.getState();
    this.patch({ status: 'installing', error: '' });
    try { this.updater.quitAndInstall(true, true); } catch (error) { this.failed(error); }
    return this.getState();
  }

  private async performCheck(): Promise<AppUpdateState> {
    this.patch({ status: 'checking', error: '' });
    try {
      const result = await this.updater.checkForUpdates();
      if (!result) throw new Error('安装包缺少更新配置，请安装支持自动更新的新版安装包。');
      if (result.isUpdateAvailable) this.available(result.updateInfo);
      else this.notAvailable();
    } catch (error) {
      this.failed(error);
    }
    return this.getState();
  }

  private async performDownload(): Promise<AppUpdateState> {
    if (this.state.status === 'error') this.patch({ status: 'available', error: '' });
    this.patch({ status: 'downloading', error: '', progress: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.failed(error);
    }
    return this.getState();
  }

  private patch(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.broadcast(this.getState());
  }

  private available = (info: UpdateInfo): void => {
    const notes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map(item => `${item.version}\n${item.note ?? ''}`).join('\n\n')
      : info.releaseNotes ?? '';
    this.patch({
      status: 'available', latestVersion: info.version, releaseNotes: notes.slice(0, 12_000),
      releaseDate: info.releaseDate ?? '', checkedAt: new Date().toISOString(),
      downloaded: false, progress: 0, transferred: 0, total: 0, bytesPerSecond: 0, error: ''
    });
  };

  private notAvailable = (): void => {
    this.patch({
      status: 'not-available', latestVersion: '', releaseNotes: '', releaseDate: '',
      downloaded: false, progress: 0, transferred: 0, total: 0, bytesPerSecond: 0,
      checkedAt: new Date().toISOString(), error: ''
    });
  };

  private progress = (info: ProgressInfo): void => {
    const finite = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
    this.patch({
      status: 'downloading', progress: Math.min(100, finite(info.percent)),
      transferred: finite(info.transferred), total: finite(info.total), bytesPerSecond: finite(info.bytesPerSecond)
    });
  };

  private downloaded = (info: UpdateInfo): void => {
    this.patch({ status: 'downloaded', downloaded: true, latestVersion: info.version, progress: 100, bytesPerSecond: 0, error: '' });
  };

  private failed = (error: unknown): void => {
    this.patch({ status: 'error', bytesPerSecond: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 800) });
  };
}
