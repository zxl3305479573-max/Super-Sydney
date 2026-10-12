import { useEffect, useRef, useState } from 'react';
import type { EventDraft, WorkEvent } from '../shared';
import { formatTrace } from '../services/ai-trace';
import { ConfirmButton, Icon, Modal, formatDuration, type IconName } from './ui';

export const CATEGORIES = ['工作项目', 'AI 工具', '提效方案', '内容资产', '个人成长'];
export const STATUS_TEXT = { pending: '待确认', approved: '已确认', rejected: '已忽略' } as const;

export type EventKindView = 'claude' | 'codex' | 'file' | 'manual' | 'app';
export const KIND_META: Record<EventKindView, { label: string; icon: IconName }> = {
  claude: { label: 'Claude', icon: 'bot' },
  codex: { label: 'Codex', icon: 'terminal' },
  file: { label: '文件', icon: 'file' },
  manual: { label: '手动', icon: 'pen' },
  app: { label: '应用', icon: 'window' }
};

export function kindOf(event: WorkEvent): EventKindView {
  if (event.source === 'claude') return 'claude';
  if (event.source === 'codex') return 'codex';
  if (event.source === 'file' || event.kind === 'file_change') return 'file';
  if (event.kind === 'manual') return 'manual';
  return 'app';
}

const GENERIC_SUMMARY = /^(应用活动|VS Code 开发活动|终端命令行活动|浏览器研究或内容活动)$/;

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

export function eventTitle(event: WorkEvent): string {
  const kind = kindOf(event);
  if (kind === 'claude' || kind === 'codex') return (event.codex_prompt || event.note || '（只采集到答复）').trim();
  if (kind === 'file') return basename(event.related_path || event.note.replace(/^文件变化：/, ''));
  if (kind === 'app') return (event.window_title || event.note.replace(/^[^：]+：/, '') || event.app_name || '应用活动').trim();
  return event.note || '手动记录';
}

export function eventSummary(event: WorkEvent): string {
  const kind = kindOf(event);
  if (kind === 'claude' || kind === 'codex') return event.codex_response || '等待最终答复…';
  if (kind === 'file') return event.related_path || event.summary;
  const summary = event.summary?.trim();
  if (summary && !GENERIC_SUMMARY.test(summary) && summary !== eventTitle(event)) return summary;
  return '';
}

function parseDraft(event: WorkEvent): EventDraft | null {
  try { return event.ai_draft_json ? JSON.parse(event.ai_draft_json) as EventDraft : null; } catch { return null; }
}

function clock(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export type EventActions = {
  update: (id: number, patch: Partial<WorkEvent>, quiet?: boolean) => Promise<void>;
  remove: (id: number) => Promise<void>;
  draft: (id: number) => Promise<void>;
  openDetails: (event: WorkEvent) => void;
};

export function EventItem({ event, drafting, actions, selectable, selected, onSelect }: {
  event: WorkEvent; drafting: boolean; actions: EventActions;
  selectable?: boolean; selected?: boolean; onSelect?: (value: boolean) => void;
}) {
  const kind = kindOf(event);
  const meta = KIND_META[kind];
  const summary = eventSummary(event);
  const trace = event.ai_trace_json ? formatTrace(event.ai_trace_json) : '';
  const hasDraft = Boolean(parseDraft(event));
  const pending = event.status === 'pending';
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (mouse: MouseEvent) => { if (!menuRef.current?.contains(mouse.target as Node)) setMenu(false); };
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') setMenu(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape); };
  }, [menu]);

  const onKeyDown = (keyboard: React.KeyboardEvent<HTMLElement>) => {
    if (keyboard.target !== keyboard.currentTarget) return;
    const key = keyboard.key.toLowerCase();
    if (key === 'enter') { keyboard.preventDefault(); actions.openDetails(event); }
    else if (pending && key === 'a') { keyboard.preventDefault(); void actions.update(event.id, { status: 'approved' }); }
    else if (pending && key === 'x') { keyboard.preventDefault(); void actions.update(event.id, { status: 'rejected' }); }
    else if (key === ' ' && selectable) { keyboard.preventDefault(); onSelect?.(!selected); }
  };

  return <article className={`event status-line-${event.status} ${selected ? 'is-selected' : ''}`} tabIndex={0} onKeyDown={onKeyDown} onDoubleClick={() => actions.openDetails(event)}>
    {selectable && <input type="checkbox" className="event-select" aria-label="选择事件" checked={Boolean(selected)} onChange={change => onSelect?.(change.target.checked)} />}
    <time className="event-clock">{clock(event.created_at)}</time>
    <span className={`event-avatar kind-${kind}`} title={meta.label}><Icon name={meta.icon} size={15} /></span>
    <div className="event-main">
      <button type="button" className="event-heading" onClick={() => actions.openDetails(event)} title="查看详情（Enter）">{eventTitle(event)}</button>
      {summary && <p className={`event-summary ${kind === 'file' ? 'is-path' : ''}`}>{summary}</p>}
      <div className="event-tags">
        <span className="chip chip-soft">{event.category}</span>
        <span>{kind === 'claude' || kind === 'codex' ? basename(event.window_title) || meta.label : event.app_name || meta.label}</span>
        {event.duration_seconds > 0 && <span><Icon name="clock" size={12} />{formatDuration(event.duration_seconds)}</span>}
        {trace && <span className="event-trace" title={trace}><Icon name="layers" size={12} />{trace}</span>}
        {hasDraft && <button type="button" className="chip chip-accent" onClick={() => actions.openDetails(event)}><Icon name="wand" size={12} />AI 草稿</button>}
      </div>
    </div>
    <div className="event-side">
      {!pending && <span className={`pill pill-${event.status}`}>{STATUS_TEXT[event.status]}</span>}
      <div className="event-buttons">
        {pending && <button type="button" className="act act-approve" title="确认（A）" onClick={() => void actions.update(event.id, { status: 'approved' })}><Icon name="check" size={15} />确认</button>}
        {pending && <button type="button" className="act" title="忽略（X）" onClick={() => void actions.update(event.id, { status: 'rejected' })}><Icon name="x" size={15} />忽略</button>}
        {!pending && <button type="button" className="act" onClick={() => actions.openDetails(event)}><Icon name="eye" size={15} />详情</button>}
        <div className="menu-anchor" ref={menuRef}>
          <button type="button" className="act act-icon" aria-label="更多操作" aria-expanded={menu} onClick={() => setMenu(value => !value)}><Icon name="more" size={16} /></button>
          {menu && <div className="menu" role="menu">
            {pending && <button role="menuitem" onClick={() => { setMenu(false); actions.openDetails(event); }}><Icon name="eye" />查看详情</button>}
            {pending && <button role="menuitem" disabled={drafting} onClick={() => { setMenu(false); void actions.draft(event.id); }}><Icon name="wand" />{drafting ? 'AI 整理中…' : 'AI 整理'}</button>}
            {!pending && <button role="menuitem" onClick={() => { setMenu(false); void actions.update(event.id, { status: 'pending' }); }}><Icon name="undo" />改回待确认</button>}
            <div className="menu-sep" />
            <ConfirmButton className="danger" armedLabel="再点一次确认删除" onConfirm={() => { setMenu(false); void actions.remove(event.id); }}><Icon name="trash" />删除</ConfirmButton>
          </div>}
        </div>
      </div>
    </div>
  </article>;
}

export function EventDetails({ event, drafting, actions, onClose }: { event: WorkEvent | null; drafting: boolean; actions: EventActions; onClose: () => void }) {
  const [summary, setSummary] = useState('');
  const [category, setCategory] = useState('');
  useEffect(() => { setSummary(event?.summary ?? ''); setCategory(event?.category ?? ''); }, [event?.id, event?.summary, event?.category]);
  if (!event) return null;
  const kind = kindOf(event);
  const draft = parseDraft(event);
  const trace = event.ai_trace_json ? formatTrace(event.ai_trace_json) : '';
  const isAi = kind === 'claude' || kind === 'codex';
  const dirty = summary !== event.summary || category !== event.category;
  const save = async () => { await actions.update(event.id, { summary, category }); };
  const facts: Array<[string, string]> = [
    ['时间', new Date(event.created_at).toLocaleString('zh-CN')],
    ['来源', KIND_META[kind].label],
    [isAi ? '项目目录' : '应用', isAi ? event.window_title || '—' : event.app_name || '—'],
    ...(!isAi && event.window_title ? [['窗口', event.window_title] as [string, string]] : []),
    ...(event.duration_seconds ? [['时长', formatDuration(event.duration_seconds)] as [string, string]] : []),
    ...(event.related_path ? [['文件', event.related_path] as [string, string]] : []),
    ...(trace ? [['过程', trace] as [string, string]] : [])
  ];
  const draftFields: Array<[keyof EventDraft, string]> = [['what_done', '做了什么'], ['why', '为什么'], ['tools', '工具'], ['problems', '问题'], ['solution', '解决方式'], ['result', '结果'], ['reuse', '可复用'], ['category', '分类']];

  return <Modal open onClose={onClose} eyebrow={`${KIND_META[kind].label} · ${STATUS_TEXT[event.status]}`} title={eventTitle(event)} width={780}
    footer={<>
      <ConfirmButton className="button button-danger-quiet" onConfirm={() => { void actions.remove(event.id); onClose(); }}><Icon name="trash" />删除</ConfirmButton>
      <span className="grow" />
      {event.status === 'pending' && <button className="button button-secondary" disabled={drafting} onClick={() => void actions.draft(event.id)}><Icon name="wand" />{drafting ? '整理中…' : 'AI 整理'}</button>}
      {dirty && <button className="button button-secondary" onClick={() => void save()}>保存修改</button>}
      {event.status === 'pending'
        ? <><button className="button button-secondary" onClick={() => { void actions.update(event.id, { status: 'rejected' }); onClose(); }}>忽略</button>
          <button className="button button-primary" onClick={() => { void actions.update(event.id, { status: 'approved', summary, category }); onClose(); }}><Icon name="check" />确认并沉淀</button></>
        : <button className="button button-secondary" onClick={() => void actions.update(event.id, { status: 'pending' })}><Icon name="undo" />改回待确认</button>}
    </>}>
    <dl className="facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>

    {isAi && <section className="detail-block"><h3><Icon name="user" />提示词</h3><pre>{event.codex_prompt || '（未采集到提示词）'}</pre></section>}
    {isAi && <section className="detail-block"><h3><Icon name="bot" />最终答复</h3><pre>{event.codex_response || '（尚未采集到最终答复）'}</pre></section>}
    {!isAi && event.note && event.note !== eventTitle(event) && <section className="detail-block"><h3>识别内容</h3><pre>{event.note}</pre></section>}

    {draft && <section className="detail-block detail-draft">
      <h3><Icon name="wand" />AI 整理草稿{event.ai_draft_model && <small>{event.ai_draft_model}</small>}</h3>
      <dl className="draft-grid">{draftFields.filter(([key]) => String(draft[key] ?? '').trim()).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{String(draft[key])}</dd></div>)}</dl>
      <div className="inline-actions">
        <button className="button button-secondary" onClick={() => { setSummary(draft.result || draft.what_done || summary); if (CATEGORIES.includes(draft.category)) setCategory(draft.category); }}>填入下方结果</button>
        <button className="button button-quiet" onClick={() => void window.sydney.clearDraft(event.id)}>删除草稿</button>
      </div>
    </section>}

    <section className="detail-block">
      <h3>沉淀到知识库的内容</h3>
      <div className="form-row">
        <label className="field"><span>分类</span><select className="input" value={category} onChange={change => setCategory(change.target.value)}>{[...new Set([...CATEGORIES, event.category])].map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field field-grow"><span>结果与复用（确认后写入 Obsidian）</span><textarea className="input" rows={3} value={summary} onChange={change => setSummary(change.target.value)} placeholder="这次做成了什么、遇到什么问题、下次怎么复用" /></label>
      </div>
    </section>
  </Modal>;
}

export function ManualRecord({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (note: string, category: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [category, setCategory] = useState('工作项目');
  useEffect(() => { if (open) setNote(''); }, [open]);
  const submit = async () => { if (!note.trim()) return; await onSave(note.trim(), category); onClose(); };
  return <Modal open={open} onClose={onClose} eyebrow="手动记录" title="你正在做什么？" width={560}
    footer={<><span className="hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 保存</span><span className="grow" /><button className="button button-secondary" onClick={onClose}>取消</button><button className="button button-primary" disabled={!note.trim()} onClick={() => void submit()}>保存到待确认</button></>}>
    <div className="form-stack">
      <textarea autoFocus className="input" rows={4} value={note} placeholder="例如：和读者沟通了下周的选题方向" onChange={change => setNote(change.target.value)}
        onKeyDown={key => { if (key.key === 'Enter' && (key.ctrlKey || key.metaKey)) { key.preventDefault(); void submit(); } }} />
      <div className="choice-row">{CATEGORIES.map(item => <button key={item} type="button" className={`choice ${category === item ? 'is-active' : ''}`} onClick={() => setCategory(item)}>{item}</button>)}</div>
    </div>
  </Modal>;
}
