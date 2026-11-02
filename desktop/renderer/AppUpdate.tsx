import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppUpdateState } from '../shared';
import { Icon, Modal, readableError } from './ui';

export function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState('');
  const prompted = useRef(new Set<string>());
  useEffect(() => {
    let alive = true;
    let received = false;
    const apply = (next: AppUpdateState) => {
      if (!alive) return;
      setState(next);
      if ((next.status === 'available' || next.status === 'downloaded') && next.latestVersion) {
        const key = `${next.latestVersion}:${next.status}`;
        if (!prompted.current.has(key)) {
          prompted.current.add(key);
          setOpen(true);
        }
      }
    };
    const off = window.sydney.onAppUpdateChanged(next => { received = true; apply(next); });
    void window.sydney.getAppUpdateState().then(next => { if (!received) apply(next); }).catch(error => {
      if (alive) setRequestError(readableError(error));
    });
    return () => { alive = false; off(); };
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const show = useCallback(() => setOpen(true), []);
  const run = async (action: () => Promise<AppUpdateState>) => {
    setPending(true);
    setRequestError('');
    try { setState(await action()); } catch (error) { setRequestError(readableError(error)); } finally { setPending(false); }
  };
  return {
    state, open, pending, requestError, close, show,
    check: () => run(() => window.sydney.checkAppUpdate()),
    download: () => run(() => window.sydney.downloadAppUpdate()),
    install: () => run(() => window.sydney.installAppUpdate())
  };
}

type UpdateController = ReturnType<typeof useAppUpdate>;

function badgeText(state: AppUpdateState | null): string {
  if (state?.status === 'installing') return '正在重启';
  if (state?.downloaded) return '重启更新';
  if (state?.status === 'downloading') return `更新 ${Math.floor(state.progress)}%`;
  if (state?.latestVersion) return state.status === 'error' ? '更新重试' : '发现更新';
  if (state?.status === 'checking') return '检查中';
  return state ? `v${state.currentVersion}` : '检查更新';
}

export function AppUpdateBadge({ update, compact = false }: { update: UpdateController; compact?: boolean }) {
  const hasUpdate = Boolean(update.state?.latestVersion);
  const label = badgeText(update.state);
  return <button type="button" className={`app-update-badge ${hasUpdate ? 'has-update' : ''} ${compact ? 'is-compact' : ''}`}
    title={hasUpdate ? `${label} · 新版本 v${update.state!.latestVersion}` : '检查 Sydney 更新'} aria-label={hasUpdate ? label : '检查 Sydney 更新'}
    aria-haspopup="dialog" onClick={update.show}>
    <Icon name={update.state?.downloaded ? 'refresh' : 'upload'} size={13} />
    <span>{label}</span>
    {hasUpdate && <i aria-hidden="true" />}
  </button>;
}

function bytes(value: number): string {
  return value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
}

export function AppUpdateDialog({ update }: { update: UpdateController }) {
  const { state, pending } = update;
  const downloading = state?.status === 'downloading';
  const installing = state?.status === 'installing';
  const checking = state?.status === 'checking';
  const busy = pending || downloading || installing || checking;
  const hasUpdate = Boolean(state?.latestVersion);
  const error = update.requestError || state?.error;
  const unsupportedTitle = state?.status === 'unsupported' && !state.supported;
  const title = installing ? '正在安装并重启'
    : state?.downloaded ? '更新已下载，重启即可使用'
      : downloading ? '正在下载更新'
        : hasUpdate ? `发现新版本 v${state!.latestVersion}` : '应用更新';
  return <Modal open={update.open} onClose={update.close} title={title} eyebrow="SYDNEY · 应用更新" width={560} backdropClassName="app-update-backdrop"
    footer={<>
      <button type="button" className="button button-secondary" onClick={update.close}>{downloading ? '后台下载' : hasUpdate ? '稍后再说' : '关闭'}</button>
      {state?.supported && (state.downloaded
        ? <button type="button" className="button button-primary" disabled={busy} onClick={() => void update.install()}><Icon name="refresh" />{installing ? '正在重启…' : '重启并更新'}</button>
        : hasUpdate && !checking
          ? <button type="button" className="button button-primary" disabled={busy} onClick={() => void update.download()}><Icon name="upload" />{downloading ? `下载中 ${Math.floor(state.progress)}%` : state.status === 'error' ? '重新下载' : '立即更新'}</button>
          : <button type="button" className="button button-primary" disabled={busy || state.status === 'unsupported'} onClick={() => void update.check()}><Icon name="refresh" />{checking ? '正在检查…' : '检查更新'}</button>)}
      {!state && <button type="button" className="button button-primary" disabled={pending} onClick={() => void update.check()}><Icon name="refresh" />{pending ? '正在检查…' : '检查更新'}</button>}
    </>}>
    <div className="app-update-content" aria-live="polite">
      <div className="app-update-version"><span>当前版本</span><strong>{state ? `v${state.currentVersion}` : '读取中…'}</strong>
        {hasUpdate && <><Icon name="arrowRight" size={16} /><strong className="app-update-latest">v{state!.latestVersion}</strong></>}
      </div>
      {downloading && <div className="app-update-download">
        <progress aria-label="更新下载进度" max={100} value={state.progress} />
        <div><span>{bytes(state.transferred)}{state.total > 0 ? ` / ${bytes(state.total)}` : ''}</span><span>{bytes(state.bytesPerSecond)}/s · {Math.floor(state.progress)}%</span></div>
      </div>}
      {state?.downloaded && <p>新版已准备好。请先保存当前编辑内容，再点击「重启并更新」，应用会安装新版并自动重新打开。</p>}
      {hasUpdate && !state?.downloaded && !downloading && <p>点击「立即更新」即可在应用内下载。下载期间可以继续使用，完成后由你选择重启时间。</p>}
      {state?.status === 'not-available' && <p className="app-update-current"><Icon name="check" />当前已是最新版本。</p>}
      {state?.status === 'idle' && <p>应用启动后会自动检查更新，运行期间每 4 小时检查一次，也可以手动检查。</p>}
      {unsupportedTitle && <p>你的安装版还没有应用内更新功能。下载并安装 v0.1.5 一次后，新版本即可直接在应用内安装与重启。</p>}
      {checking && <p>正在检查新版本…</p>}
      {state?.releaseNotes && <div className="app-update-notes"><h3>本次更新</h3><div>{state.releaseNotes}</div></div>}
      {error && <p className={state?.supported === false ? '' : 'app-update-error'} role={state?.supported === false ? undefined : 'alert'}>{error}</p>}
      {state?.checkedAt && <small className="app-update-checked">上次检查：{new Date(state.checkedAt).toLocaleString('zh-CN')}</small>}
    </div>
  </Modal>;
}
