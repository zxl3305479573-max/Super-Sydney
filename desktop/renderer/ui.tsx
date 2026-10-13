import { useEffect, useRef, useState, type ReactNode } from 'react';

export function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '').trim() || '操作失败，请稍后重试';
}

/* ── Icons (1.6px stroke, 24 grid) ───────────────────────────── */
const paths: Record<string, ReactNode> = {
  today: <><rect x="3.5" y="4.5" width="17" height="16" rx="2.5" /><path d="M3.5 9.5h17M8 2.8v3.4M16 2.8v3.4" /><path d="m8.5 14.6 2.2 2.1 4.8-4.6" /></>,
  inbox: <><path d="M3.5 13.5 6 5.6A2 2 0 0 1 7.9 4.2h8.2A2 2 0 0 1 18 5.6l2.5 7.9v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 13.5h4.6l1.4 2.4h5l1.4-2.4h4.6" /></>,
  spark: <><path d="M12 3.5 13.9 9a2 2 0 0 0 1.2 1.2l5.4 1.8-5.4 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.1 15a2 2 0 0 0-1.2-1.2L3.5 12l5.4-1.8A2 2 0 0 0 10.1 9z" /></>,
  pen: <><path d="M4 20h4.2L19.4 8.8a2.1 2.1 0 0 0 0-3L18.2 4.6a2.1 2.1 0 0 0-3 0L4 15.8z" /><path d="m13.6 6.2 4.2 4.2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>,
  play: <path d="M7.5 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L8.7 4.5a.8.8 0 0 0-1.2.7z" />,
  pause: <><rect x="6.5" y="5" width="3.6" height="14" rx="1" /><rect x="13.9" y="5" width="3.6" height="14" rx="1" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.4 4.3L19 7.5" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  more: <><circle cx="5.5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18.5" cy="12" r="1.3" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  trash: <><path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7" /></>,
  eye: <><path d="M2.8 12S6.2 5.5 12 5.5 21.2 12 21.2 12 17.8 18.5 12 18.5 2.8 12 2.8 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  wand: <><path d="m4 20 10.5-10.5M13 5.5l1-2 1 2 2 1-2 1-1 2-1-2-2-1zM18.5 11l.7-1.4.7 1.4 1.4.7-1.4.7-.7 1.4-.7-1.4-1.4-.7z" /></>,
  file: <><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  window: <><rect x="3" y="4.5" width="18" height="15" rx="2.2" /><path d="M3 9h18" /><circle cx="6.3" cy="6.8" r=".5" /><circle cx="8.5" cy="6.8" r=".5" /></>,
  user: <><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20.2a7.5 7.5 0 0 1 15 0" /></>,
  bot: <><rect x="4.5" y="8" width="15" height="11.5" rx="3" /><path d="M12 4v4M9.2 13.2h.01M14.8 13.2h.01M9.5 16.5h5" /></>,
  terminal: <><rect x="3" y="4.5" width="18" height="15" rx="2.2" /><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5" /></>,
  screen: <><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8.5 20h7M12 16.5V20" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  calendar: <><rect x="3.5" y="4.5" width="17" height="16" rx="2.5" /><path d="M3.5 9.5h17M8 2.8v3.4M16 2.8v3.4" /></>,
  book: <><path d="M4.5 5.5A2 2 0 0 1 6.5 3.5H19.5v15H6.5a2 2 0 0 0-2 2z" /><path d="M4.5 20.5a2 2 0 0 1 2-2h13v2" /></>,
  shield: <path d="M12 3.2 5 5.8v5.6c0 4.4 3 8 7 9.4 4-1.4 7-5 7-9.4V5.8z" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="m10.9 12.1 8.6-8.6M16.5 6.5l2.5 2.5M14 9l2 2" /></>,
  undo: <><path d="M9 14.5 4.5 10 9 5.5" /><path d="M4.5 10h10a5 5 0 0 1 0 10H11" /></>,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  refresh: <><path d="M20 11.5A8 8 0 0 0 6.2 6.3L4 8.5M4 4v4.5h4.5M4 12.5a8 8 0 0 0 13.8 5.2l2.2-2.2M20 20v-4.5h-4.5" /></>,
  chart: <><path d="M4 20V4M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>,
  layers: <><path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z" /><path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5" /></>,
  link: <><path d="M10 14a4.5 4.5 0 0 0 6.4 0l2.8-2.8a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-2.8 2.8a4.5 4.5 0 0 0 6.4 6.4l1-1" /></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
  alert: <><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4.2M12 17h.01" /></>,
  video: <><rect x="3" y="5.5" width="12.5" height="13" rx="2.5" /><path d="m15.5 10.6 5.5-3.1v9l-5.5-3.1" /></>,
  mic: <><rect x="9" y="3" width="6" height="10.5" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.2" /></>,
  tag: <><path d="M4.5 4.5h6.2L20 13.8 13.8 20 4.5 10.7z" /><circle cx="8.6" cy="8.6" r="1.25" /></>,
  note: <><rect x="4.5" y="3.5" width="15" height="17" rx="3" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" /></>,
  card: <><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 9.8h19" /><path d="M6.2 14.6h4.6" /></>
};
export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/* ── Controls ────────────────────────────────────────────────── */
export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}><span /></button>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string; count?: number }>; onChange: (value: T) => void; label: string }) {
  return <div className="segmented" role="tablist" aria-label={label}>
    {options.map(option => <button key={option.value} role="tab" aria-selected={value === option.value} className={value === option.value ? 'is-active' : ''} onClick={() => onChange(option.value)}>
      {option.label}{option.count !== undefined && <span className="segmented-count">{option.count}</span>}
    </button>)}
  </div>;
}

/** Click once to arm, click again within 3s to confirm. Avoids blocking dialogs for routine deletes. */
export function ConfirmButton({ onConfirm, children, armedLabel = '确认删除？', className = '', title }: { onConfirm: () => void; children: ReactNode; armedLabel?: string; className?: string; title?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const timer = window.setTimeout(() => setArmed(false), 3000); return () => window.clearTimeout(timer); }, [armed]);
  return <button type="button" title={title} className={`${className} ${armed ? 'is-armed' : ''}`} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>{armed ? armedLabel : children}</button>;
}

export function Modal({ open, onClose, title, eyebrow, children, footer, width = 720 }: { open: boolean; onClose: () => void; title: ReactNode; eyebrow?: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" tabIndex={-1} ref={ref} style={{ width: `min(${width}px, calc(100vw - 48px))` }}>
      <header className="modal-head">
        <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </div>
  </div>;
}

/** Editable list of short strings shown as chips; Enter or comma adds, Backspace on empty removes last. */
export function TagEditor({ values, onChange, placeholder, tone = 'neutral' }: { values: string[]; onChange: (values: string[]) => void; placeholder: string; tone?: 'neutral' | 'danger' }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const items = raw.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
    if (!items.length) return;
    onChange([...new Set([...values, ...items])]);
    setDraft('');
  };
  return <div className={`tag-editor tag-editor-${tone}`} onClick={event => (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
    {values.map(value => <span key={value} className="chip">{value}<button type="button" aria-label={`移除 ${value}`} onClick={() => onChange(values.filter(item => item !== value))}><Icon name="x" size={12} /></button></span>)}
    <input value={draft} placeholder={values.length ? '' : placeholder} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ',' || event.key === '，') { event.preventDefault(); add(draft); }
        else if (event.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
      }}
      onBlur={() => add(draft)} onPaste={event => { const text = event.clipboardData.getData('text'); if (/[\n,，]/.test(text)) { event.preventDefault(); add(text); } }} />
  </div>;
}

/** Text area that only commits on blur, so typing a newline isn't swallowed by list normalisation. */
export function LinesEditor({ values, onChange, placeholder }: { values: string[]; onChange: (values: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(values.join('\n'));
  useEffect(() => { setText(values.join('\n')); }, [values]);
  return <textarea className="input" rows={3} value={text} placeholder={placeholder} onChange={event => setText(event.target.value)}
    onBlur={() => { const next = text.split(/\r?\n/).map(item => item.trim()).filter(Boolean); if (next.join('\n') !== values.join('\n')) onChange(next); }} />;
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon name={icon} size={22} /></span><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function relativeTime(value: string): string {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return value;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 月-日 时:分；非法日期原样截断显示，空值显示破折号。 */
export function shortTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 16).replace('T', ' ') : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(seconds: number): string {
  if (!seconds) return '0 分钟';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60 ? `${minutes % 60} 分` : ''}`.trim();
}
