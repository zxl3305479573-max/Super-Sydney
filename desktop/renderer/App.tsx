import { useCallback, useEffect, useState } from 'react';
import type { AppState, WorkEvent } from '../shared';
import WeWritePanel from './WeWritePanel';
import VideoPanel from './VideoPanel';
import EvolutionPanel from './EvolutionPanel';
import { TodayView } from './TodayView';
import { SettingsView } from './SettingsView';
import { EventDetails, ManualRecord, type EventActions } from './EventItem';
import { Icon, readableError, type IconName } from './ui';

type View = 'today' | 'review' | 'evolve' | 'wewrite' | 'video' | 'settings';
type Toast = { id: number; message: string; tone: 'info' | 'error' };

const empty: AppState = {
  settings: { captureEnabled: false, capturePaused: false, codexCaptureEnabled: false, codexIncludeCli: false, claudeCaptureEnabled: false, claudeExtraRoots: [], llmEnabled: false, allowedApps: [], blockedApps: [], captureIntervalSeconds: 30, captureAllPending: true, vaultPath: '', screenCaptureEnabled: false, screenCaptureIntervalSeconds: 60, screenRetentionHours: 24, inputWatchEnabled: false, inputWatchPaths: [] },
  stats: { total: 0, pending: 0, duration: 0 }, events: [], codexCapture: { state: 'disabled', error: '' }, claudeCapture: { state: 'disabled', error: '' }, screenCapture: { state: 'disabled', saved: 0, error: '' }, captureStatus: { state: 'idle', appName: '', windowTitle: '', sampledAt: '', message: '尚未采样' }
};

const NAV: Array<{ group: string; items: Array<{ view: View; label: string; icon: IconName }> }> = [
  { group: '工作记录', items: [{ view: 'today', label: '今日工作', icon: 'today' }, { view: 'review', label: '待确认', icon: 'inbox' }] },
  { group: '成长', items: [{ view: 'evolve', label: '自我进化', icon: 'spark' }] },
  { group: '内容', items: [{ view: 'wewrite', label: '公众号', icon: 'pen' }, { view: 'video', label: '视频', icon: 'video' }] }
];

const HEADERS: Record<Exclude<View, 'wewrite' | 'video'>, { title: string; subtitle: string }> = {
  today: { title: '今日工作', subtitle: '' },
  review: { title: '待确认', subtitle: '逐条确认或批量处理采集到的事件，确认后的内容才会沉淀到知识库。' },
  evolve: { title: '自我进化', subtitle: '从 AI 协作里找出重复劳动与返工，沉淀成项目规则和经验卡片。' },
  settings: { title: '隐私与设置', subtitle: '采集范围、AI 对话监听和知识库位置。所有数据默认只保存在本机。' }
};

function greeting(): string {
  const hour = new Date().getHours();
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  return `${hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'} · ${date}`;
}

export default function App() {
  const [state, setState] = useState<AppState>(empty);
  const [view, setView] = useState<View>('today');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  const refresh = useCallback(async () => setState(await window.sydney.getState()), []);
  useEffect(() => { void refresh(); return window.sydney.onChanged(() => void refresh()); }, [refresh]);
  const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(current => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), tone === 'error' ? 5000 : 3200);
  }, []);
  const notifyAny = useCallback((message: string) => notify(message, /失败|错误|无法|请先|不存在|超时|缺少/.test(message) ? 'error' : 'info'), [notify]);
  const guard = useCallback(async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { notify(readableError(error), 'error'); } }, [notify]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); setManualOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const actions: EventActions = {
    update: (id, patch, quiet) => guard(async () => { await window.sydney.updateEvent(id, patch); await refresh(); if (!quiet && patch.status === 'approved') notify('已确认，已写入知识库'); }),
    remove: id => guard(async () => { await window.sydney.deleteEvent(id); await refresh(); notify('事件已删除'); }),
    draft: id => guard(async () => { setDrafting(id); try { await window.sydney.draftEvent(id); notify('AI 草稿已生成，可在详情里查看'); } finally { setDrafting(null); } }),
    openDetails: (event: WorkEvent) => setDetailId(event.id)
  };
  const capture = (mode: 'start' | 'pause' | 'stop') => void guard(() => window.sydney.setCapture(mode));
  const summary = (kind: 'daily' | 'weekly') => void guard(async () => notify(`${kind === 'daily' ? '日报' : '周报'}已更新：${kind === 'daily' ? await window.sydney.generateDailySummary() : await window.sydney.generateWeeklySummary()}`));
  const chooseFiles = async () => { const files = await window.sydney.chooseFiles(); if (!files.length) return; await window.sydney.saveSettings({ inputWatchPaths: [...new Set([...state.settings.inputWatchPaths, ...files])], inputWatchEnabled: true }); await refresh(); notify(`已关联 ${files.length} 个文件`); };
  const setting = async (patch: Parameters<typeof window.sydney.saveSettings>[0]) => guard(async () => { await window.sydney.saveSettings(patch); await refresh(); });
  const saveManual = async (note: string, category: string) => guard(async () => { await window.sydney.createEvent({ note, category, kind: 'manual', status: 'pending' }); await refresh(); notify('已保存到待确认'); });

  const live = state.settings.captureEnabled && !state.settings.capturePaused;
  const pendingCount = state.events.filter(event => event.status === 'pending').length;
  const detailEvent = state.events.find(event => event.id === detailId) ?? null;
  const fullWidth = view === 'wewrite' || view === 'video';
  const header = fullWidth ? null : HEADERS[view as Exclude<View, 'wewrite' | 'video'>];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">S</span><div><strong>Sydney</strong><small>个人工作 OS</small></div></div>
      <nav className="nav" aria-label="主导航">
        {NAV.map(group => <div key={group.group} className="nav-group">
          <span className="nav-group-label">{group.group}</span>
          {group.items.map(item => <button key={item.view} className={`nav-item ${view === item.view ? 'active' : ''}`} aria-current={view === item.view ? 'page' : undefined} onClick={() => setView(item.view)}>
            <Icon name={item.icon} size={17} /><span>{item.label}</span>{item.view === 'review' && pendingCount > 0 && <em className="nav-badge">{pendingCount > 99 ? '99+' : pendingCount}</em>}
          </button>)}
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><Icon name="settings" size={17} /><span>隐私与设置</span></button>
        <div className={`rec-widget ${live ? 'is-live' : state.settings.captureEnabled ? 'is-paused' : ''}`}>
          <span className="rec-dot" aria-hidden="true" />
          <div><strong>{live ? '正在记录' : state.settings.captureEnabled ? '已暂停' : '未在记录'}</strong><small>{live ? state.captureStatus.appName || '等待采样' : '本地模式'}</small></div>
          {state.settings.captureEnabled
            ? <button className="icon-button" title={state.settings.capturePaused ? '继续记录' : '暂停记录'} onClick={() => capture(state.settings.capturePaused ? 'start' : 'pause')}><Icon name={state.settings.capturePaused ? 'play' : 'pause'} /></button>
            : <button className="icon-button" title="开始记录" onClick={() => capture('start')}><Icon name="play" /></button>}
        </div>
      </div>
    </aside>

    <main className={`main-content ${fullWidth ? 'main-content-wide' : ''}`}>
      {header && <header className="topbar">
        <div><p className="eyebrow">{view === 'today' ? greeting() : 'Sydney 工作台'}</p><h1>{header.title}</h1>{header.subtitle && <p className="topbar-sub">{header.subtitle}</p>}</div>
        <div className="top-actions">
          {view === 'review' && <button className="button button-secondary" onClick={() => setManualOpen(true)}><Icon name="plus" />手动记录</button>}
          {view !== 'today' && view !== 'settings' && (state.settings.captureEnabled
            ? <span className={`live-tag ${live ? 'is-live' : ''}`}><span className="rec-dot" />{live ? '正在记录' : '已暂停'}</span>
            : <button className="button button-primary" onClick={() => capture('start')}><Icon name="play" />开始记录</button>)}
        </div>
      </header>}
      {view === 'settings' ? <SettingsView state={state} onSetting={setting} onChooseFiles={chooseFiles} notify={notifyAny} />
        : view === 'evolve' ? <EvolutionPanel notify={notifyAny} />
        : view === 'wewrite' ? <WeWritePanel notify={notifyAny} />
        : view === 'video' ? <VideoPanel notify={notifyAny} />
        : <TodayView state={state} mode={view} drafting={drafting} actions={actions} onCapture={capture} onManual={() => setManualOpen(true)} onNavigate={setView} onSummary={summary} onBulkDone={message => notify(message)} />}
    </main>

    <EventDetails event={detailEvent} drafting={drafting === detailId} actions={actions} onClose={() => setDetailId(null)} />
    <ManualRecord open={manualOpen} onClose={() => setManualOpen(false)} onSave={saveManual} />
    <div className="toasts" role="status" aria-live="polite">{toasts.map(toast => <div key={toast.id} className={`toast toast-${toast.tone}`}><Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={15} /><span>{toast.message}</span></div>)}</div>
  </div>;
}
