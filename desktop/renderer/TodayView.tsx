import { useMemo, useState } from 'react';
import type { AppState, WorkEvent } from '../shared';
import { EventItem, KIND_META, eventSummary, eventTitle, kindOf, type EventActions, type EventKindView } from './EventItem';
import { EmptyState, Icon, Segmented, formatDuration, relativeTime } from './ui';

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';
type KindFilter = 'all' | 'ai' | EventKindView;

const KIND_FILTERS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: '全部来源' }, { value: 'ai', label: 'AI 对话' }, { value: 'app', label: '应用' }, { value: 'file', label: '文件' }, { value: 'manual', label: '手动' }
];

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

function groupByDay(events: WorkEvent[]): Array<{ label: string; items: WorkEvent[] }> {
  const groups: Array<{ label: string; items: WorkEvent[] }> = [];
  for (const event of events) {
    const label = dayLabel(event.created_at);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(event); else groups.push({ label, items: [event] });
  }
  return groups;
}

function matchKind(event: WorkEvent, filter: KindFilter): boolean {
  if (filter === 'all') return true;
  const kind = kindOf(event);
  return filter === 'ai' ? kind === 'claude' || kind === 'codex' : kind === filter;
}

function matchQuery(event: WorkEvent, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = `${eventTitle(event)} ${eventSummary(event)} ${event.note} ${event.app_name} ${event.window_title} ${event.category}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

const SOURCE_STATE: Record<string, { text: string; tone: string }> = {
  disabled: { text: '未开启', tone: 'off' }, stopped: { text: '待开始', tone: 'idle' }, listening: { text: '监听中', tone: 'on' },
  capturing: { text: '采样中', tone: 'on' }, error: { text: '出错', tone: 'error' }
};

export function CaptureCard({ state, onCapture, onManual, onOpenSettings }: { state: AppState; onCapture: (mode: 'start' | 'pause' | 'stop') => void; onManual: () => void; onOpenSettings: () => void }) {
  const { settings, captureStatus } = state;
  const live = settings.captureEnabled && !settings.capturePaused;
  const title = settings.captureEnabled ? settings.capturePaused ? '记录已暂停' : '正在记录' : '记录未开始';
  const recordingState = (enabled: boolean) => enabled ? live ? 'listening' : 'stopped' : 'disabled';
  const sources: Array<{ label: string; icon: Parameters<typeof Icon>[0]['name']; state: string; detail?: string }> = [
    { label: '应用活动', icon: 'window', state: live ? 'capturing' : 'stopped' },
    { label: 'Codex', icon: 'terminal', state: state.codexCapture.state, detail: state.codexCapture.error },
    { label: 'Claude', icon: 'bot', state: state.claudeCapture.state, detail: state.claudeCapture.error },
    { label: '01-输入', icon: 'folder', state: recordingState(settings.inputWatchEnabled) },
    { label: '屏幕', icon: 'screen', state: state.screenCapture.state, detail: state.screenCapture.error }
  ];
  return <section className={`capture-card ${live ? 'is-live' : settings.captureEnabled ? 'is-paused' : ''}`}>
    <div className="capture-head">
      <span className="capture-pulse" aria-hidden="true" />
      <div className="capture-title"><strong>{title}</strong><small>{live ? `每 ${settings.captureIntervalSeconds} 秒采样一次允许的应用；密码、支付与私人聊天会被跳过` : '开始后才会采样活动与监听 AI 对话'}</small></div>
      <div className="capture-actions">
        {settings.captureEnabled
          ? <><button className="button button-secondary" onClick={() => onCapture(settings.capturePaused ? 'start' : 'pause')}><Icon name={settings.capturePaused ? 'play' : 'pause'} />{settings.capturePaused ? '继续' : '暂停'}</button>
            <button className="button button-quiet" onClick={() => onCapture('stop')}><Icon name="stop" />停止</button></>
          : <button className="button button-primary" onClick={() => onCapture('start')}><Icon name="play" />开始记录</button>}
        <button className="button button-secondary" onClick={onManual}><Icon name="plus" />手动记录</button>
      </div>
    </div>
    <div className={`capture-now capture-now-${captureStatus.state}`}>
      <Icon name="window" size={15} />
      <div><strong>{captureStatus.appName || '暂无活动窗口'}</strong><span>{captureStatus.windowTitle || captureStatus.message}</span></div>
      <small>{captureStatus.sampledAt ? `最近采样 ${relativeTime(captureStatus.sampledAt)}` : '尚未采样'}</small>
    </div>
    <div className="source-row">
      {sources.map(source => {
        const meta = SOURCE_STATE[source.state] ?? SOURCE_STATE.disabled;
        return <button key={source.label} className={`source source-${meta.tone}`} title={source.detail || `${source.label}：${meta.text}（点击前往设置）`} onClick={onOpenSettings}>
          <Icon name={source.icon} size={13} /><span>{source.label}</span><b>{meta.text}</b>
        </button>;
      })}
    </div>
  </section>;
}

export function TodayView({ state, mode, drafting, actions, onCapture, onManual, onNavigate, onSummary, onBulkDone }: {
  state: AppState; mode: 'today' | 'review'; drafting: number | null; actions: EventActions;
  onCapture: (mode: 'start' | 'pause' | 'stop') => void; onManual: () => void;
  onNavigate: (view: 'review' | 'evolve' | 'settings') => void; onSummary: (kind: 'daily' | 'weekly') => void; onBulkDone: (message: string) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const review = mode === 'review';
  const effectiveStatus: StatusFilter = review ? 'pending' : statusFilter;

  const todayEvents = useMemo(() => state.events.filter(event => new Date(event.created_at).toDateString() === new Date().toDateString()), [state.events]);
  const counts = useMemo(() => ({
    all: state.events.length,
    pending: state.events.filter(event => event.status === 'pending').length,
    approved: state.events.filter(event => event.status === 'approved').length,
    rejected: state.events.filter(event => event.status === 'rejected').length
  }), [state.events]);
  const visible = useMemo(() => state.events.filter(event =>
    (effectiveStatus === 'all' || event.status === effectiveStatus) && matchKind(event, kindFilter) && matchQuery(event, query)), [state.events, effectiveStatus, kindFilter, query]);
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const aiToday = todayEvents.filter(event => event.source === 'codex' || event.source === 'claude').length;
  const visibleIds = visible.map(event => event.id);
  const selectedVisible = visibleIds.filter(id => selected.has(id));
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  const bulk = async (status: 'approved' | 'rejected') => {
    const ids = [...selectedVisible];
    for (const id of ids) await actions.update(id, { status }, true);
    setSelected(new Set());
    onBulkDone(`已${status === 'approved' ? '确认' : '忽略'} ${ids.length} 条事件`);
  };
  const toggle = (id: number, value: boolean) => setSelected(current => { const next = new Set(current); if (value) next.add(id); else next.delete(id); return next; });

  return <div className="view">
    {!review && <div className="overview">
      <CaptureCard state={state} onCapture={onCapture} onManual={onManual} onOpenSettings={() => onNavigate('settings')} />
      <div className="metrics">
        <Metric icon="calendar" label="今日事件" value={String(state.stats.total)} hint="保存在本地" />
        <Metric icon="inbox" label="待确认" value={String(counts.pending)} hint={counts.pending ? '点击去处理' : '都处理完了'} tone={counts.pending ? 'warn' : 'ok'} onClick={() => onNavigate('review')} />
        <Metric icon="clock" label="记录时长" value={formatDuration(state.stats.duration)} hint="来自应用采样" />
        <Metric icon="bot" label="AI 对话" value={String(aiToday)} hint="Codex + Claude 今日" />
      </div>
    </div>}

    {!review && <div className="quickbar">
      <span className="quickbar-label"><Icon name="book" size={15} />沉淀到 Obsidian</span>
      <button className="button button-secondary" onClick={() => onSummary('daily')}><Icon name="file" />生成日报</button>
      <button className="button button-secondary" onClick={() => onSummary('weekly')}><Icon name="calendar" />生成周报</button>
      <button className="button button-secondary" onClick={() => onNavigate('evolve')}><Icon name="spark" />AI 协作复盘</button>
      <span className="grow" />
      <small>只有「已确认」的事件会写入知识库</small>
    </div>}

    <section className="panel">
      <header className="panel-head timeline-head">
        <div className="panel-title"><h2>{review ? '待确认事件' : '工作时间线'}</h2><p>{review ? '确认后的事件才会沉淀到知识库；忽略的事件保留在本地，可随时改回。' : '最近 200 条，按时间倒序'}</p></div>
        <label className="search"><Icon name="search" size={15} /><input placeholder="搜索标题、应用、目录…" value={query} onChange={change => setQuery(change.target.value)} />{query && <button aria-label="清除搜索" onClick={() => setQuery('')}><Icon name="x" size={13} /></button>}</label>
      </header>
      <div className="toolbar">
        {review
          ? <label className="bulk-select"><input type="checkbox" checked={allSelected} disabled={!visibleIds.length} onChange={change => setSelected(change.target.checked ? new Set(visibleIds) : new Set())} />{selectedVisible.length ? `已选 ${selectedVisible.length} 条` : '全选'}</label>
          : <Segmented label="状态" value={statusFilter} onChange={setStatusFilter} options={[
            { value: 'all', label: '全部', count: counts.all }, { value: 'pending', label: '待确认', count: counts.pending },
            { value: 'approved', label: '已确认', count: counts.approved }, { value: 'rejected', label: '已忽略', count: counts.rejected }]} />}
        {review && selectedVisible.length > 0 && <div className="bulk-actions">
          <button className="button button-primary" onClick={() => void bulk('approved')}><Icon name="check" />确认所选</button>
          <button className="button button-secondary" onClick={() => void bulk('rejected')}><Icon name="x" />忽略所选</button>
        </div>}
        <span className="grow" />
        <div className="kind-filter">{KIND_FILTERS.map(item => <button key={item.value} className={`kind-chip ${kindFilter === item.value ? 'is-active' : ''}`} onClick={() => setKindFilter(item.value)}>
          {item.value !== 'all' && <Icon name={item.value === 'ai' ? 'bot' : KIND_META[item.value as EventKindView].icon} size={13} />}{item.label}</button>)}</div>
      </div>
      {review && <p className="kbd-hint"><Icon name="keyboard" size={14} />选中一行后：<kbd>A</kbd> 确认 <kbd>X</kbd> 忽略 <kbd>Enter</kbd> 详情 <kbd>Space</kbd> 勾选 · 双击打开详情</p>}

      {groups.length ? groups.map(group => <div key={group.label} className="day-group">
        <h3 className="day-label">{group.label}<span>{group.items.length} 条</span></h3>
        <div className="event-stack">{group.items.map(event => <EventItem key={event.id} event={event} drafting={drafting === event.id} actions={actions}
          selectable={review} selected={selected.has(event.id)} onSelect={value => toggle(event.id, value)} />)}</div>
      </div>)
        : review && !query && kindFilter === 'all'
          ? <EmptyState icon="check" title="待确认的事件都处理完了">新采集的活动、AI 对话和文件变化会出现在这里。</EmptyState>
          : state.events.length
            ? <EmptyState icon="search" title="没有匹配的事件">换个关键词或筛选条件试试。</EmptyState>
            : <EmptyState icon="today" title="还没有记录">点「开始记录」采集应用活动，或用「手动记录」写下正在做的事。</EmptyState>}
    </section>
  </div>;
}

function Metric({ icon, label, value, hint, tone, onClick }: { icon: Parameters<typeof Icon>[0]['name']; label: string; value: string; hint: string; tone?: 'warn' | 'ok'; onClick?: () => void }) {
  const body = <><span className="metric-label"><Icon name={icon} size={14} />{label}</span><strong>{value}</strong><small>{hint}</small></>;
  return onClick
    ? <button type="button" className={`metric metric-${tone ?? 'plain'} is-clickable`} onClick={onClick}>{body}</button>
    : <article className={`metric metric-${tone ?? 'plain'}`}>{body}</article>;
}
