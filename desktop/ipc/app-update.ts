import { app, ipcMain, session, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import { AppUpdateService } from '../services/app-updater';

export function registerAppUpdateIpc(getWindow: () => BrowserWindow | null): AppUpdateService {
  const unsupportedReason = !app.isPackaged
    ? '开发模式不安装更新，请使用正式安装版体验应用内更新。'
    : process.platform !== 'win32'
      ? '当前平台暂不支持应用内更新。'
      : process.env.PORTABLE_EXECUTABLE_FILE
        ? '便携版暂不支持应用内替换，请使用安装版接收自动更新。'
        : '';
  const service = new AppUpdateService(autoUpdater, {
    currentVersion: app.getVersion(),
    unsupportedReason,
    broadcast: state => {
      const win = getWindow();
      if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
      try { win.webContents.send('app-update:changed', state); } catch {}
    }
  });
  const trusted = (event: IpcMainInvokeEvent) => {
    const win = getWindow();
    if (!win || win.webContents !== event.sender) throw new Error('只允许主界面操作应用更新。');
  };
  ipcMain.handle('app-update:state', (event: IpcMainInvokeEvent) => { trusted(event); return service.getState(); });
  ipcMain.handle('app-update:check', (event: IpcMainInvokeEvent) => { trusted(event); return service.check(); });
  ipcMain.handle('app-update:download', (event: IpcMainInvokeEvent) => { trusted(event); return service.download(); });
  ipcMain.handle('app-update:install', (event: IpcMainInvokeEvent) => { trusted(event); return service.install(); });
  const proxy = process.env.SYDNEY_UPDATE_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const updateSession = session.fromPartition('electron-updater', { cache: false });
  void updateSession.setProxy(proxy
    ? { proxyRules: proxy, proxyBypassRules: '<local>' }
    : { mode: 'system' })
    .then(() => service.start())
    .catch(error => console.error('应用更新代理设置失败', error));
  app.once('before-quit', () => service.dispose());
  return service;
}
