import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppState, WorkEvent } from '../shared';
import WeWritePanel from './WeWritePanel';
import VideoPanel from './VideoPanel';
import EmbeddedSitePanel from './EmbeddedSitePanel';
import HeroSmsPanel from './HeroSmsPanel';
import XiaohongshuPanel from './XiaohongshuPanel';
import SitePanel from './SitePanel';
import EvolutionPanel from './EvolutionPanel';
import LinksPanel from './LinksPanel';
import { TodayView } from './TodayView';
import { SettingsView } from './SettingsView';
import { EventDetails, ManualRecord, type EventActions } from './EventItem';
import { Icon, KeepAlive, readableError, useVisited, type IconName } from './ui';
import { TitleBar, useWindowChrome } from './TitleBar';
import { useTheme } from './theme';

type View = 'today' | 'review' | 'evolve' | 'links' | 'wewrite' | 'video' | 'xiaohongshu' | 'xianyu' | 'site16688' | 'heroSms' | 'site' | 'settings';
type Toast = { id: number; message: string; tone: 'info' | 'error' };

const empty: AppState = {
  settings: { captureEnabled: false, capturePaused: false, codexCaptureEnabled: false, codexIncludeCli: false, claudeCaptureEnabled: false, claudeExtraRoots: [], llmEnabled: false, allowedApps: [], blockedApps: [], captureIntervalSeconds: 30, captureAllPending: false, vaultPath: '', screenCaptureEnabled: false, screenCaptureIntervalSeconds: 60, screenRetentionHours: 24, inputWatchEnabled: false, inputWatchPaths: [] },
  stats: { total: 0, pending: 0, duration: 0 }, events: [], codexCapture: { state: 'disabled', error: '' }, claudeCapture: { state: 'disabled', error: '' }, screenCapture: { state: 'disabled', saved: 0, error: '' }, captureStatus: { state: 'idle', appName: '', windowTitle: '', sampledAt: '', message: '尚未采样' }
};

const NAV: Array<{ group: string; items: Array<{ view: View; label: string; icon: IconName }> }> = [
  { group: '工作记录', items: [{ view: 'today', label: '今日工作', icon: 'today' }, { view: 'review', label: '待确认', icon: 'inbox' }] },
  { group: '成长', items: [{ view: 'evolve', label: '自我进化', icon: 'spark' }, { view: 'links', label: '链接收藏', icon: 'link' }] },
  { group: '内容', items: [{ view: 'wewrite', label: '公众号', icon: 'pen' }, { view: 'video', label: '视频', icon: 'video' }, { view: 'xiaohongshu', label: '小红书', icon: 'note' }] },
  { group: '变现', items: [{ view: 'xianyu', label: '闲鱼', icon: 'tag' }, { view: 'site16688', label: '16688', icon: 'chart' }, { view: 'heroSms', label: '接码', icon: 'phone' }, { view: 'site', label: 'AI 代充', icon: 'card' }] }
];

const HEADERS: Record<Exclude<View, 'wewrite' | 'video' | 'xiaohongshu'>, { title: string; subtitle: string }> = {
  today: { title: '今日工作', subtitle: '' },
  review: { title: '待确认', subtitle: '逐条确认或批量处理采集到的事件，确认后的内容才会沉淀到知识库。' },
  evolve: { title: '自我进化', subtitle: '从 AI 协作里找出重复劳动与返工，沉淀成项目规则和经验卡片。' },
  links: { title: '链接收藏', subtitle: '看到值得回头看的文章、工具、教程，随手存在这里，按标签和关键词找回来。数据只存在本机。' },
  xianyu: { title: '闲鱼', subtitle: '闲鱼网页版直接嵌在这里：首次使用在页面里扫码登录，登录态只留在这个模块自己的会话里。' },
  site16688: { title: '16688', subtitle: '16688 商家后台直接嵌在这里：首次使用在页面里登录，登录态只留在这个模块自己的会话里。' },
  heroSms: { title: '接码', subtitle: '通过 HeroSMS 官方开放 API 查余额、购买号码、接收验证码和管理激活；Key 只保存在系统安全存储。' },
  site: { title: 'AI 代充', subtitle: '把常用的代充 / 发卡站点都放进来：上面选站点，下面直接操作。站点开在它自己的会话里，应用只负责给它让出这块位置。' },
  settings: { title: '隐私与设置', subtitle: '采集范围、AI 对话监听和知识库位置。所有数据默认只保存在本机。' }
};

/** 标题栏里的位置：分组 › 页面。 */
function crumbsOf(view: View): string[] {
  if (view === 'settings') return ['系统', '隐私与设置'];
  for (const group of NAV) {
    const item = group.items.find(entry => entry.view === view);
    if (item) return [group.group, item.label];
  }
  return [];
}

const VIEWS: View[] = ['today', 'review', 'evolve', 'links', 'wewrite', 'video', 'xiaohongshu', 'xianyu', 'site16688', 'heroSms', 'site', 'settings'];
const VIEW_KEY = 'sydney.view';

/** 上次退出时停在哪个模块，重新打开应用就回到那里。 */
function initialView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY) as View | null;
    if (saved && VIEWS.includes(saved)) return saved;
  } catch { /* 读不到就从今日工作开始 */ }
  return 'today';
}

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function greeting(): string {
  const hour = new Date().getHours();
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  return `${hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'} · ${date}`;
}

export default function App() {
  const [state, setState] = useState<AppState>(empty);
  const [view, setView] = useState<View>(initialView);
  // 进过的模块都留着不卸载，只是隐藏：切走时正在跑的生成、表单里没存的内容、子页签都原样保留。
  const mounted = useVisited(view);
  const scrollByView = useRef<Partial<Record<View, number>>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const chrome = useWindowChrome();
  const [theme, toggleTheme] = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);

  // 内容区是共用的滚动容器：切页面时回到这个页面上次的滚动位置，并淡入一下（只动透明度，不影响嵌入网页的定位）。
  useLayoutEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* 存不了就下次从今日工作开始 */ }
    const top = scrollByView.current[view] ?? 0;
    scrollRef.current?.scrollTo({ top });
    setScrolled(top > 2);
    if (!reduceMotion()) mainRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
  }, [view]);

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
  const fullWidth = view === 'wewrite' || view === 'video' || view === 'xiaohongshu';
  const header = fullWidth ? null : HEADERS[view as Exclude<View, 'wewrite' | 'video' | 'xiaohongshu'>];

  const covered = manualOpen || detailId !== null;
  /**
   * 嵌入网页是主进程浮在界面之上的视图：模块被隐藏或有弹层时把它摘下来（overlay），
   * 页面进程本身留着，切回来登录态、浏览位置、表单内容都还在。
   */
  const renderView = (name: View) => {
    const hideWeb = covered || name !== view;
    switch (name) {
      case 'settings': return <SettingsView state={state} onSetting={setting} onChooseFiles={chooseFiles} notify={notifyAny} />;
      case 'evolve': return <EvolutionPanel notify={notifyAny} />;
      case 'links': return <LinksPanel notify={notifyAny} />;
      case 'wewrite': return <WeWritePanel notify={notifyAny} overlay={hideWeb} />;
      case 'video': return <VideoPanel notify={notifyAny} />;
      case 'xiaohongshu': return <XiaohongshuPanel notify={notifyAny} overlay={hideWeb} />;
      case 'xianyu': return <EmbeddedSitePanel siteKey="xianyu" label="闲鱼" overlay={hideWeb} covered={covered}
        privacy="页面由闲鱼提供，登录请在页面里扫码完成；应用不读它的 cookie，也不往页面里注入脚本。" />;
      case 'site16688': return <EmbeddedSitePanel siteKey="site16688" label="16688" overlay={hideWeb} covered={covered}
        privacy="页面由 16688 提供，登录请在页面里完成；应用不读它的 cookie，也不往页面里注入脚本，订单与账号问题以站点为准。" />;
      case 'heroSms': return <HeroSmsPanel active={name === view} notify={notifyAny} />;
      case 'site': return <SitePanel overlay={hideWeb} notify={notifyAny} />;
      default: return <TodayView state={state} mode={name} drafting={drafting} actions={actions} onCapture={capture} onManual={() => setManualOpen(true)} onNavigate={setView} onSummary={summary} onBulkDone={message => notify(message)} />;
    }
  };

  return <div className={`app-shell platform-${chrome.platform} ${chrome.focused ? '' : 'is-blurred'}`}>
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

    <div className="workspace">
      <TitleBar crumbs={crumbsOf(view)} chrome={chrome} scrolled={scrolled} theme={theme} onToggleTheme={toggleTheme} />
      <div className="main-scroll" ref={scrollRef} onScroll={event => { scrollByView.current[view] = event.currentTarget.scrollTop; setScrolled(event.currentTarget.scrollTop > 2); }}>
        <main ref={mainRef} className={`main-content ${fullWidth ? 'main-content-wide' : ''}`}>
          {header && <header className="topbar">
            <div><p className="eyebrow">{view === 'today' ? greeting() : 'Sydney 工作台'}</p><h1>{header.title}</h1>{header.subtitle && <p className="topbar-sub">{header.subtitle}</p>}</div>
            <div className="top-actions">
              {view === 'review' && <button className="button button-secondary" onClick={() => setManualOpen(true)}><Icon name="plus" />手动记录</button>}
              {view !== 'today' && view !== 'settings' && (state.settings.captureEnabled
                ? <span className={`live-tag ${live ? 'is-live' : ''}`}><span className="rec-dot" />{live ? '正在记录' : '已暂停'}</span>
                : <button className="button button-primary" onClick={() => capture('start')}><Icon name="play" />开始记录</button>)}
            </div>
          </header>}
          {mounted.map(name => <KeepAlive key={name} show={name === view}>{renderView(name)}</KeepAlive>)}
        </main>
      </div>
    </div>

    <EventDetails event={detailEvent} drafting={drafting === detailId} actions={actions} onClose={() => setDetailId(null)} />
    <ManualRecord open={manualOpen} onClose={() => setManualOpen(false)} onSave={saveManual} />
    <div className="toasts" role="status" aria-live="polite">{toasts.map(toast => <div key={toast.id} className={`toast toast-${toast.tone}`}><Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={15} /><span>{toast.message}</span></div>)}</div>
  </div>;
}
