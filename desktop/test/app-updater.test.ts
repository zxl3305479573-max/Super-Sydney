import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { UpdateInfo } from 'electron-updater';
import { AppUpdateService, type UpdateBackend } from '../services/app-updater.ts';
import type { AppUpdateState } from '../shared.ts';

const release: UpdateInfo = { version: '0.1.6', files: [], path: 'Sydney-Setup.exe', sha512: 'test-checksum', releaseDate: '2026-11-02T00:00:00Z', releaseNotes: '修复设置页面\n新增应用更新' };

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  allowDowngrade = true;
  checks = 0;
  downloads = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  checkAction: () => Promise<unknown> = async () => {
    this.emit('update-available', release);
    return { isUpdateAvailable: true, updateInfo: release };
  };
  downloadAction: () => Promise<string[]> = async () => {
    this.emit('download-progress', { percent: 50, transferred: 50, total: 100, bytesPerSecond: 20 });
    this.emit('update-downloaded', { ...release, downloadedFile: 'test.exe' });
    return ['test.exe'];
  };
  installAction: (() => void) | undefined;
  checkForUpdates() { this.checks += 1; return this.checkAction(); }
  downloadUpdate() { this.downloads += 1; return this.downloadAction(); }
  quitAndInstall(silent?: boolean, forceRun?: boolean) { this.installs.push([silent, forceRun]); this.installAction?.(); }
}

function setup(unsupportedReason?: string) {
  const backend = new FakeUpdater();
  const events: AppUpdateState[] = [];
  const service = new AppUpdateService(backend as unknown as UpdateBackend, {
    currentVersion: '0.1.5', unsupportedReason, broadcast: state => events.push(state)
  });
  return { backend, service, events };
}

test('发现更新只提醒，不自动下载或在普通退出时安装', async () => {
  const { backend, service } = setup();
  assert.equal(backend.autoDownload, false);
  assert.equal(backend.autoInstallOnAppQuit, false);
  assert.equal(backend.autoRunAppAfterInstall, true);
  assert.equal(backend.allowPrerelease, false);
  assert.equal(backend.allowDowngrade, false);
  const state = await service.check();
  assert.equal(state.status, 'available');
  assert.equal(state.currentVersion, '0.1.5');
  assert.equal(state.latestVersion, release.version);
  assert.equal(state.releaseNotes, release.releaseNotes);
  assert.ok(state.checkedAt);
  assert.equal(backend.downloads, 0);
  assert.equal(backend.installs.length, 0);
});

test('没有新版本时清理旧提示，保持当前版本', async () => {
  const { backend, service } = setup();
  await service.check();
  backend.checkAction = async () => {
    backend.emit('update-not-available', { ...release, version: '0.1.5' });
    return { isUpdateAvailable: false, updateInfo: release };
  };
  const state = await service.check();
  assert.equal(state.status, 'not-available');
  assert.equal(state.latestVersion, '');
  assert.equal(state.releaseNotes, '');
  assert.equal(state.currentVersion, '0.1.5');
});

test('不支持更新的运行模式不会检查、下载或安装', async () => {
  const { backend, service } = setup('开发模式不安装更新');
  service.start();
  await service.check();
  await service.download();
  service.install();
  assert.equal(service.getState().supported, false);
  assert.equal(service.getState().status, 'unsupported');
  assert.match(service.getState().error, /开发模式/);
  assert.equal(backend.checks, 0);
  assert.equal(backend.downloads, 0);
  assert.equal(backend.installs.length, 0);
  service.dispose();
});

test('并发检查共用同一个请求', async () => {
  const { backend, service } = setup();
  let finish!: (value: unknown) => void;
  backend.checkAction = () => new Promise(resolve => { finish = resolve; });
  const first = service.check();
  const second = service.check();
  assert.equal(backend.checks, 1);
  assert.equal(service.getState().status, 'checking');
  finish({ isUpdateAvailable: true, updateInfo: release });
  assert.equal((await first).status, 'available');
  assert.equal((await second).status, 'available');
});

test('在检查进行中点击更新，等待发现新版本后再开始下载', async () => {
  const { backend, service } = setup();
  let finish!: (value: unknown) => void;
  backend.checkAction = () => new Promise(resolve => { finish = resolve; });
  const check = service.check();
  const download = service.download();
  assert.equal(backend.checks, 1);
  assert.equal(backend.downloads, 0);
  finish({ isUpdateAvailable: true, updateInfo: release });
  assert.equal((await check).status, 'available');
  assert.equal((await download).status, 'downloaded');
  assert.equal(backend.downloads, 1);
});

test('下载进度实时推送，完成后等待用户选择重启', async () => {
  const { backend, service, events } = setup();
  await service.check();
  const state = await service.download();
  assert.ok(events.some(event => event.status === 'downloading' && event.progress === 50 && event.transferred === 50));
  assert.equal(state.status, 'downloaded');
  assert.equal(state.downloaded, true);
  assert.equal(state.progress, 100);
  assert.equal(backend.installs.length, 0);
  await service.check();
  await service.download();
  assert.equal(backend.checks, 1);
  assert.equal(backend.downloads, 1);
  service.install();
  service.install();
  assert.deepEqual(backend.installs, [[true, true]]);
  assert.equal(service.getState().status, 'installing');
});

test('下载过程中不会重复下载，也不会被定时检查打断', async () => {
  const { backend, service } = setup();
  await service.check();
  let finish!: (value: string[]) => void;
  backend.downloadAction = () => new Promise(resolve => { finish = resolve; });
  const first = service.download();
  const second = service.download();
  await service.check();
  assert.equal(backend.downloads, 1);
  assert.equal(backend.checks, 1);
  assert.equal(service.getState().status, 'downloading');
  backend.emit('update-downloaded', release);
  finish(['test.exe']);
  assert.equal((await first).status, 'downloaded');
  assert.equal((await second).status, 'downloaded');
});

test('先打开的旧版本提示不能覆盖之后到达的下载进度', async () => {
  const { backend, service } = setup();
  await service.check();
  let finish!: (value: string[]) => void;
  backend.downloadAction = () => new Promise(resolve => { finish = resolve; });
  const download = service.download();
  assert.equal(service.getState().status, 'downloading');
  assert.equal((await service.check()).status, 'downloading');
  assert.equal(service.getState().status, 'downloading');
  assert.equal(service.getState().progress, 0);
  assert.equal(service.getState().status, 'downloading');
  backend.emit('download-progress', { percent: 37, transferred: 37, total: 100, bytesPerSecond: 12 });
  assert.equal(service.getState().progress, 37);
  backend.emit('update-downloaded', release);
  finish(['test.exe']);
  assert.equal((await download).status, 'downloaded');
});

test('下载失败保留新版本信息，可以重试下载', async () => {
  const { backend, service } = setup();
  await service.check();
  backend.downloadAction = async () => { throw new Error('network timeout'); };
  const failed = await service.download();
  assert.equal(failed.status, 'error');
  assert.equal(failed.latestVersion, release.version);
  assert.equal(failed.downloaded, false);
  assert.match(failed.error, /network timeout/);
  service.install();
  assert.equal(backend.installs.length, 0);
  backend.downloadAction = async () => { backend.emit('update-downloaded', release); return ['test.exe']; };
  const retried = await service.download();
  assert.equal(retried.status, 'downloaded');
  assert.equal(retried.error, '');
});

test('安装失败保留已下载文件状态，允许再次安装', async () => {
  const { backend, service } = setup();
  await service.check();
  await service.download();
  backend.installAction = () => { backend.emit('error', new Error('installer unavailable')); };
  assert.equal(service.install().status, 'error');
  assert.equal(service.getState().downloaded, true);
  backend.installAction = undefined;
  assert.equal(service.install().status, 'installing');
  assert.equal(backend.installs.length, 2);
});

test('检查失败和缺少更新配置都会返回可重试错误', async () => {
  const { backend, service } = setup();
  backend.checkAction = async () => { throw new Error('connection failed'); };
  assert.match((await service.check()).error, /connection failed/);
  backend.checkAction = async () => null;
  assert.match((await service.check()).error, /缺少更新配置/);
  backend.checkAction = async () => ({ isUpdateAvailable: false, updateInfo: release });
  assert.equal((await service.check()).status, 'not-available');
});

test('错误事件不抹去已发现的新版本，后续检查可以恢复', async () => {
  const { backend, service } = setup();
  await service.check();
  backend.emit('error', new Error('temporary network failure'));
  assert.equal(service.getState().status, 'error');
  assert.equal(service.getState().latestVersion, release.version);
  assert.match(service.getState().error, /temporary network failure/);
  backend.checkAction = async () => ({ isUpdateAvailable: true, updateInfo: release });
  const recovered = await service.check();
  assert.equal(recovered.status, 'available');
  assert.equal(recovered.latestVersion, release.version);
  assert.equal(recovered.error, '');
});

test('非法进度不会使前端显示负数、NaN 或超过百分之百', async () => {
  const { backend, service, events } = setup();
  await service.check();
  backend.downloadAction = async () => {
    backend.emit('download-progress', { percent: 150, transferred: -1, total: NaN, bytesPerSecond: Infinity });
    backend.emit('update-downloaded', release);
    return ['test.exe'];
  };
  await service.download();
  const progress = events.find(event => event.status === 'downloading' && event.progress === 100)!;
  assert.equal(progress.transferred, 0);
  assert.equal(progress.total, 0);
  assert.equal(progress.bytesPerSecond, 0);
});

test('只返回状态副本，退出后解除事件监听', async () => {
  const { backend, service } = setup();
  service.getState().status = 'installing';
  assert.equal(service.getState().status, 'idle');
  assert.equal(backend.listenerCount('update-available'), 1);
  service.start();
  service.start();
  service.dispose();
  assert.equal(backend.listenerCount('update-available'), 0);
  assert.equal(backend.listenerCount('error'), 0);
});
