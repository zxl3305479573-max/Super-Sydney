import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { AutoUpdateStatus } from './shared';

/** electron-updater is loaded at runtime so a source checkout can still run
 * before `npm install` has populated production dependencies. */
interface UpdateInfo {
  version: string;
  releaseName?: string;
  releaseNotes?: string | Array<{ note?: string }>;
}

interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

interface ElectronUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

// Keep the updater out of development runs. A packaged dependency is required at runtime;
// package.json deliberately lists it under dependencies so electron-builder bundles it.
const { autoUpdater } = require('electron-updater') as { autoUpdater: ElectronUpdater };

const STARTUP_CHECK_DELAY_MS = 10_000;

export class AutoUpdateManager {
  private status: AutoUpdateStatus = {
    supported: app.isPackaged && process.platform === 'win32',
    phase: app.isPackaged && process.platform === 'win32' ? 'idle' : 'unsupported'
  };
  private manualCheckPending = false;
  private showErrorToUser = false;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    if (!this.status.supported) return;

    // Do not download anything until the user explicitly approves it in the update dialog.
    autoUpdater.autoDownload = false;
    // If the user chooses “later” after a completed download, install on normal application exit.
    autoUpdater.autoInstallOnAppQuit = true;
    this.bindEvents();
  }

  registerIpc(): void {
    ipcMain.handle('auto-update:check', () => this.checkForUpdates(true));
  }

  checkAfterStartup(): void {
    if (!this.status.supported) return;
    setTimeout(() => { void this.checkForUpdates(false); }, STARTUP_CHECK_DELAY_MS);
  }

  async checkForUpdates(manual: boolean): Promise<AutoUpdateStatus> {
    if (!this.status.supported) return this.status;
    if (this.status.phase === 'checking' || this.status.phase === 'downloading') return this.status;

    this.manualCheckPending = manual;
    this.showErrorToUser = manual;
    this.setStatus({ phase: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // Some updater failures emit `error`; retain this fallback for synchronous setup failures.
      this.handleError(error);
    }
    return this.status;
  }

  private bindEvents(): void {
    autoUpdater.on('checking-for-update', () => this.setStatus({ phase: 'checking' }));
    autoUpdater.on('update-available', info => { void this.promptToDownload(info as UpdateInfo); });
    autoUpdater.on('update-not-available', () => {
      const showDialog = this.manualCheckPending;
      this.manualCheckPending = false;
      this.showErrorToUser = false;
      this.setStatus({ phase: 'idle' });
      if (showDialog) void dialog.showMessageBox(this.windowOptions({
        type: 'info',
        title: 'Sydney 已是最新版本',
        message: `当前版本 ${app.getVersion()} 已是最新版本。`
      }));
    });
    autoUpdater.on('download-progress', progress => this.handleDownloadProgress(progress as DownloadProgress));
    autoUpdater.on('update-downloaded', info => { void this.promptToInstall(info as UpdateInfo); });
    autoUpdater.on('error', error => this.handleError(error));
  }

  private async promptToDownload(info: UpdateInfo): Promise<void> {
    this.manualCheckPending = false;
    this.setStatus({ phase: 'available', version: info.version });
    const response = await dialog.showMessageBox(this.windowOptions({
      type: 'info',
      title: '发现新版本',
      message: `发现 Sydney ${info.version}，是否下载并安装？`,
      detail: this.releaseNotesText(info),
      buttons: ['下载并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }));
    if (response.response !== 0) return;

    this.showErrorToUser = true;
    this.setStatus({ phase: 'downloading', version: info.version, progress: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleDownloadProgress(progress: DownloadProgress): void {
    this.setStatus({
      phase: 'downloading',
      progress: Math.max(0, Math.min(100, Math.round(progress.percent))),
      message: `正在下载更新：${Math.round(progress.percent)}%`
    });
  }

  private async promptToInstall(info: UpdateInfo): Promise<void> {
    this.showErrorToUser = false;
    this.setStatus({ phase: 'downloaded', version: info.version, progress: 100 });
    const response = await dialog.showMessageBox(this.windowOptions({
      type: 'info',
      title: '更新已准备就绪',
      message: `Sydney ${info.version} 已下载完成。`,
      detail: '立即重启即可完成安装；选择“稍后”会在下次正常退出应用时安装。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }));
    if (response.response === 0) autoUpdater.quitAndInstall();
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[auto-update]', message);
    this.manualCheckPending = false;
    this.setStatus({ phase: 'error', message });
    if (!this.showErrorToUser) return;
    this.showErrorToUser = false;
    void dialog.showMessageBox(this.windowOptions({
      type: 'error',
      title: '检查或下载更新失败',
      message: '无法完成更新检查或下载。',
      detail: message
    }));
  }

  private setStatus(next: Omit<AutoUpdateStatus, 'supported'>): void {
    this.status = { supported: true, ...next };
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('auto-update:status', this.status);
  }

  private windowOptions<T extends Electron.MessageBoxOptions>(options: T): T & { window?: BrowserWindow } {
    const win = this.getWindow();
    return win && !win.isDestroyed() ? { ...options, window: win } : options;
  }

  private releaseNotesText(info: UpdateInfo): string {
    if (typeof info.releaseNotes === 'string' && info.releaseNotes.trim()) return info.releaseNotes;
    if (Array.isArray(info.releaseNotes)) return info.releaseNotes.map(item => item.note).filter(Boolean).join('\n');
    return '下载完成后可重启应用完成安装。';
  }
}
