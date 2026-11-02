import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './ui';

export type ToastTone = 'info' | 'error';
export type ToastAction = { label: string; run: () => void };
export type ToastOptions = { action?: ToastAction; duration?: number };
type ToastItem = { id: number; message: string; tone: ToastTone; action?: ToastAction; duration: number; leaving: boolean };

const MAX_TOASTS = 4;
const GAP = 8;
const LEAVE_MS = 180;

/**
 * 右下角提示：新的在最前，旧的叠在后面露一条边；鼠标移上去展开成列表并暂停计时，移开后接着倒数。
 * 带动作（如「撤销」）的提示停留更久，点动作后立刻收起。
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => {
    setToasts(current => current.map(item => item.id === id ? { ...item, leaving: true } : item));
    window.setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), LEAVE_MS);
  }, []);
  const push = useCallback((message: string, tone: ToastTone = 'info', options: ToastOptions = {}) => {
    const id = Date.now() + Math.random();
    const duration = options.duration ?? (options.action ? 6000 : tone === 'error' ? 5000 : 3200);
    setToasts(current => [...current.filter(item => !item.leaving).slice(-(MAX_TOASTS - 1)), { id, message, tone, action: options.action, duration, leaving: false }]);
  }, []);
  return { toasts, push, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const measure = useCallback((id: number, height: number) => setHeights(current => current[id] === height ? current : { ...current, [id]: height }), []);
  useEffect(() => { if (!toasts.length) setExpanded(false); }, [toasts.length]);
  const ordered = [...toasts].reverse();
  let offset = 0;
  const placed = ordered.map((toast, index) => {
    const style = { '--index': index, '--offset': `${offset}px` } as CSSProperties;
    offset += (heights[toast.id] ?? 48) + GAP;
    return { toast, index, style };
  });
  const frontHeight = heights[ordered[0]?.id ?? -1] ?? 48;
  return <section className={`toasts ${expanded ? 'is-expanded' : ''}`} aria-label="通知" aria-live="polite"
    style={{ height: !ordered.length ? 0 : expanded ? offset - GAP : frontHeight + Math.min(ordered.length - 1, 2) * 10 }}
    onMouseEnter={() => setExpanded(true)} onMouseLeave={() => setExpanded(false)}>
    {placed.map(({ toast, index, style }) => <ToastCard key={toast.id} toast={toast} index={index} style={style} paused={expanded} onMeasure={measure} onDismiss={onDismiss} />)}
  </section>;
}

function ToastCard({ toast, index, style, paused, onMeasure, onDismiss }: {
  toast: ToastItem; index: number; style: CSSProperties; paused: boolean; onMeasure: (id: number, height: number) => void; onDismiss: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const remaining = useRef(toast.duration);
  useLayoutEffect(() => { if (ref.current) onMeasure(toast.id, ref.current.offsetHeight); }, [toast.id, toast.message, onMeasure]);
  useEffect(() => {
    if (paused || toast.leaving) return;
    const started = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(800, remaining.current - (Date.now() - started)); };
  }, [paused, toast.leaving, toast.id, onDismiss]);
  return <div ref={ref} role={toast.tone === 'error' ? 'alert' : 'status'} className={`toast toast-${toast.tone} ${toast.leaving ? 'is-leaving' : ''} ${index > 2 ? 'is-hidden' : ''}`} style={style}>
    <Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={15} />
    <span className="toast-message">{toast.message}</span>
    {toast.action && <button type="button" className="toast-action" onClick={() => { toast.action!.run(); onDismiss(toast.id); }}>{toast.action.label}</button>}
    <button type="button" className="toast-close" aria-label="关闭通知" onClick={() => onDismiss(toast.id)}><Icon name="x" size={12} /></button>
  </div>;
}
