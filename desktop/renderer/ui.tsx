import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

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
  phone: <><rect x="6.5" y="2.8" width="11" height="18.4" rx="2.4" /><path d="M10.5 17.8h3" /></>,
  card: <><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 9.8h19" /><path d="M6.2 14.6h4.6" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sidebar: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M9 4.5v15" /></>,
  upload: <><path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9" /><path d="M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="m20.5 16-4.8-4.8L6 19.5" /></>,
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
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
export function ConfirmButton({ onConfirm, children, armedLabel = '确认删除？', className = '', title, disabled = false }: { onConfirm: () => void; children: ReactNode; armedLabel?: string; className?: string; title?: string; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const timer = window.setTimeout(() => setArmed(false), 3000); return () => window.clearTimeout(timer); }, [armed]);
  return <button type="button" title={title} disabled={disabled} className={`${className} ${armed ? 'is-armed' : ''}`} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>{armed ? armedLabel : children}</button>;
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

/**
 * 嵌入网页（主进程的 WebContentsView）承载区在窗口里真正露出来的那一块。
 * 视图浮在界面之上、不受 DOM 裁剪：承载区滚到标题栏底下时，必须按滚动区的可视范围裁掉，
 * 否则网页会盖住标题栏和窗口按钮。露出来太少时主进程会把视图摘下。
 */
/**
 * 进过的页面 / 子页签常驻不卸载：返回到目前为止显示过的那些，配合 <KeepAlive> 只隐藏没在看的。
 * 切走时正在跑的生成、没保存的表单、滚动位置都原样留着。
 */
export function useVisited<T>(current: T): T[] {
  const [visited, setVisited] = useState<T[]>([current]);
  useEffect(() => { setVisited(list => list.includes(current) ? list : [...list, current]); }, [current]);
  return visited.includes(current) ? visited : [...visited, current];
}

export function KeepAlive({ show, children }: { show: boolean; children: ReactNode }) {
  return <div className="keep-alive" hidden={!show}>{children}</div>;
}

/**
 * 切换任务或流水线步骤后，把当前步骤面板滚回步骤条下方。
 * 首次挂载不滚，避免覆盖应用为页面保存的滚动位置；后续切换用平滑滚动，
 * 用户点「下一步」时不会继续停在上一页的底部。
 */
export function useWorkflowStepScroll(signature: string) {
  const ref = useRef<HTMLElement>(null);
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (previous.current === null) {
      previous.current = signature;
      return;
    }
    if (previous.current === signature) return;
    previous.current = signature;
    const frame = window.requestAnimationFrame(() => {
      ref.current?.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [signature]);
  return ref;
}

export function visibleStageBounds(element: HTMLElement | null): { x: number; y: number; width: number; height: number } | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const scroller = element.closest<HTMLElement>('.main-scroll');
  const box = scroller?.getBoundingClientRect();
  // 流式网页视图浮在 DOM 之上：内容模块的吸顶导航挡住页面时，也要把它从视图可视区里裁掉。
  const stickyNav = element.closest<HTMLElement>('.wewrite, .xhs-panel')?.querySelector<HTMLElement>('.ww-nav-dock');
  const stickyBox = stickyNav?.getBoundingClientRect();
  const view = box && scroller
    ? {
        left: box.left + scroller.clientLeft,
        top: Math.max(box.top + scroller.clientTop, stickyBox?.bottom ?? 0),
        right: box.left + scroller.clientLeft + scroller.clientWidth,
        bottom: box.top + scroller.clientTop + scroller.clientHeight
      }
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const left = Math.max(rect.left, view.left);
  const top = Math.max(rect.top, view.top);
  return { x: left, y: top, width: Math.max(0, Math.min(rect.right, view.right) - left), height: Math.max(0, Math.min(rect.bottom, view.bottom) - top) };
}

/**
 * 空状态：虚线框 + 图标 + 一句话说明 + 可选的下一步动作。
 * compact 用在侧栏列表这类窄区域；默认尺寸用在编辑区、整块面板。
 */
export function EmptyState({ icon, title, children, action, compact = false, className = '' }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean; className?: string }) {
  return <div className={`empty ${compact ? 'empty-compact' : ''} ${className}`}>
    <span className="empty-icon"><Icon name={icon} size={compact ? 17 : 22} /></span>
    <strong>{title}</strong>
    {children && <p>{children}</p>}
    {action && <div className="empty-actions">{action}</div>}
  </div>;
}

/* ── Tabs：悬停高亮跟着鼠标滑动，选中项下方一条指示线 ─────────────── */
type Rect = { left: number; width: number };
const rectOf = (element: HTMLElement | null): Rect | null => element ? { left: element.offsetLeft, width: element.offsetWidth } : null;

export function Tabs<T extends string>({ value, items, onChange, label, className = '' }: {
  value: T; items: Array<{ value: T; label: ReactNode; title?: string; count?: number }>; onChange: (value: T) => void; label: string; className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Rect | null>(null);
  const [hover, setHover] = useState<Rect | null>(null);
  const [hovering, setHovering] = useState(false);
  // 模块被 KeepAlive 隐藏时量到的宽度是 0，重新显示时 ResizeObserver 会再量一次。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => setActive(rectOf(list.querySelector<HTMLElement>('[aria-selected="true"]')));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(list);
    return () => observer.disconnect();
  }, [value, items.length]);
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = items.findIndex(item => item.value === value);
    const next = items[(index + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
    event.preventDefault();
    onChange(next.value);
    window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  return <div ref={listRef} className={`tabs ${className}`} role="tablist" aria-label={label} onMouseLeave={() => setHovering(false)} onKeyDown={move}>
    <span className="tabs-hover" aria-hidden="true" style={hover ? { width: hover.width, transform: `translateX(${hover.left}px)`, opacity: hovering ? 1 : 0 } : { opacity: 0 }} />
    <span className="tabs-indicator" aria-hidden="true" style={active ? { width: active.width, transform: `translateX(${active.left}px)` } : { opacity: 0 }} />
    {items.map(item => {
      const selected = item.value === value;
      return <button key={item.value} type="button" role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} title={item.title}
        className={`tabs-item ${selected ? 'is-active' : ''}`}
        onMouseEnter={event => { setHover(rectOf(event.currentTarget)); setHovering(true); }}
        onClick={() => onChange(item.value)}>
        {item.label}{item.count !== undefined && <span className="tabs-count">{item.count}</span>}
      </button>;
    })}
  </div>;
}

/* ── Stepper：编号 + 状态 + 连接线，点击跳到对应步骤 ─────────────── */
export type StepState = 'done' | 'current' | 'attention' | 'pending';

export function Stepper<T extends string>({ steps, active, onSelect, label }: {
  steps: Array<{ value: T; label: string; hint?: string; state: StepState }>; active: T; onSelect: (value: T) => void; label: string;
}) {
  return <ol className="stepper" aria-label={label}>
    {steps.map((step, index) => <li key={step.value} className={`stepper-item is-${step.state} ${step.value === active ? 'is-active' : ''}`}>
      <button type="button" aria-current={step.value === active ? 'step' : undefined} title={step.hint} onClick={() => onSelect(step.value)}>
        <span className="stepper-dot">{step.state === 'done' ? <Icon name="check" size={13} /> : step.state === 'attention' ? '!' : index + 1}</span>
        <span className="stepper-text"><strong>{step.label}</strong>{step.hint && <small>{step.hint}</small>}</span>
      </button>
    </li>)}
  </ol>;
}

/* ── TaskList：逐项任务的 等待 / 进行中 / 完成 / 失败 ─────────────── */
export type TaskState = 'pending' | 'running' | 'done' | 'failed';

export function TaskList({ title, items, summary }: { title: ReactNode; items: Array<{ key: string; label: ReactNode; detail?: ReactNode; state: TaskState }>; summary?: ReactNode }) {
  const done = items.filter(item => item.state === 'done').length;
  return <div className="task-list" role="status" aria-live="polite">
    <header className="task-list-head">
      <strong>{title}</strong>
      <span>{summary ?? `${done} / ${items.length}`}</span>
    </header>
    <div className="task-list-track" aria-hidden="true"><i style={{ width: `${items.length ? done / items.length * 100 : 0}%` }} /></div>
    <ol>{items.map(item => <li key={item.key} className={`task-item is-${item.state}`}>
      <span className="task-icon" aria-hidden="true">{item.state === 'done' ? <Icon name="check" size={12} /> : item.state === 'failed' ? <Icon name="x" size={12} /> : null}</span>
      <span className="task-text"><span>{item.label}</span>{item.detail && <small>{item.detail}</small>}</span>
      <em>{item.state === 'done' ? '完成' : item.state === 'running' ? '进行中' : item.state === 'failed' ? '失败' : '等待'}</em>
    </li>)}</ol>
  </div>;
}

/* ── 小走势图与占比条 ───────────────────────────────────────── */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = 100 / (values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(28 - value / max * 24).toFixed(2)}`);
  return <svg className="sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={label}>
    <path className="sparkline-area" d={`M0,30 L${points.join(' L')} L100,30 Z`} />
    <polyline className="sparkline-line" points={points.join(' ')} vectorEffect="non-scaling-stroke" />
  </svg>;
}

export function PartitionBar({ segments, label, unit = '' }: { segments: Array<{ key: string; label: string; value: number; color: string }>; label: string; unit?: string }) {
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  const visible = segments.filter(item => item.value > 0);
  const percent = (value: number) => total ? Math.round(value / total * 100) : 0;
  return <div className="partition">
    <div className="partition-bar" role="img" aria-label={`${label}：${visible.map(item => `${item.label} ${percent(item.value)}%`).join('，') || '暂无数据'}`}>
      {visible.length ? visible.map(item => <i key={item.key} title={`${item.label}：${item.value}${unit}（${percent(item.value)}%）`} style={{ flexGrow: item.value, background: item.color }} />) : <i className="is-empty" />}
    </div>
    <ul className="partition-legend">{segments.map(item => <li key={item.key} className={item.value ? '' : 'is-zero'}>
      <i style={{ background: item.color }} /><span>{item.label}</span><b>{item.value}{unit}</b><small>{percent(item.value)}%</small>
    </li>)}</ul>
  </div>;
}

/* ── Timeline：按天分组的竖向时间线 ─────────────────────────── */
export type TimelineEntry = { key: string; time: string; title: ReactNode; detail?: ReactNode; tone?: 'primary' | 'success' | 'warning' | 'muted'; icon?: IconName };

export function Timeline({ groups }: { groups: Array<{ label: string; items: TimelineEntry[] }> }) {
  return <div className="timeline">{groups.map(group => <section key={group.label} className="timeline-group">
    <h4>{group.label}</h4>
    <ol>{group.items.map(item => <li key={item.key} className={`timeline-item tone-${item.tone ?? 'primary'}`}>
      <span className="timeline-dot" aria-hidden="true">{item.icon && <Icon name={item.icon} size={12} />}</span>
      <time>{item.time}</time>
      <div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}</div>
    </li>)}</ol>
  </section>)}</div>;
}

/* ── Dropzone：拖进文件或点击选择 ─────────────────────────────── */
export function Dropzone({ onFiles, onBrowse, extensions, disabled = false, title, hint }: {
  onFiles: (paths: string[]) => void; onBrowse: () => void; extensions: string[]; disabled?: boolean; title: string; hint?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const accepts = (name: string) => extensions.some(extension => name.toLowerCase().endsWith(`.${extension}`));
  const reset = () => { depth.current = 0; setDragging(false); };
  const over = (event: DragEvent<HTMLButtonElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; };
  return <button type="button" className={`dropzone ${dragging ? 'is-dragging' : ''}`} disabled={disabled} onClick={onBrowse}
    onDragEnter={event => { event.preventDefault(); depth.current += 1; if (!disabled) setDragging(true); }}
    onDragOver={over}
    onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); }}
    onDrop={event => {
      event.preventDefault();
      reset();
      if (disabled) return;
      const paths = [...event.dataTransfer.files].filter(file => accepts(file.name)).map(file => window.sydney.filePath(file)).filter(Boolean);
      onFiles(paths);
    }}>
    <span className="dropzone-icon" aria-hidden="true"><Icon name="upload" size={18} /></span>
    <strong>{dragging ? '松开即可导入' : title}</strong>
    <small>{hint ?? `支持 ${extensions.map(item => item.toUpperCase()).join(' / ')}，可一次拖入多张`}</small>
  </button>;
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
