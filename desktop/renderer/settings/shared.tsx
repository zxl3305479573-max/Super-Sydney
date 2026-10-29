import { useEffect, useState, type ReactNode } from 'react';
import type { LlmKeyStatus, Settings } from '../../shared';

export type Patch = Partial<Settings>;

export function SettingRow({ title, description, control, children, badge }: { title: string; description?: ReactNode; control?: ReactNode; children?: ReactNode; badge?: ReactNode }) {
  return <div className="set-row">
    <div className="set-row-text"><strong>{title}{badge}</strong>{description && <p>{description}</p>}</div>
    {control && <div className="set-row-control">{control}</div>}
    {children && <div className="set-row-wide">{children}</div>}
  </div>;
}

export function statusBadge(status: { state: string; error: string }) {
  const map: Record<string, [string, string]> = { disabled: ['未开启', 'off'], stopped: ['开始记录后生效', 'idle'], listening: ['监听中', 'on'], capturing: ['采样中', 'on'], error: ['出错', 'error'] };
  const [text, tone] = map[status.state] ?? map.disabled;
  return <span className={`badge badge-${tone}`} title={status.error || text}>{status.state === 'error' ? `出错：${status.error}` : text}</span>;
}

export const keyBadge = (status: LlmKeyStatus) => <span className={`badge ${status.configured ? 'badge-on' : 'badge-off'}`}>{status.configured ? `已保存 ${status.masked}` : '未保存'}</span>;

export function NumberInput({ value, min, onCommit, suffix }: { value: number; min: number; onCommit: (value: number) => void; suffix: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => { const next = Math.max(min, Math.round(Number(draft) || min)); setDraft(String(next)); if (next !== value) onCommit(next); };
  return <label className="number-input"><input className="input" type="number" min={min} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit(); }} /><span>{suffix}</span></label>;
}

/** 同步时间显示：从未同步过时给友好提示。 */
export function syncTime(value: string): string {
  if (!value) return '尚未同步';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '尚未同步' : date.toLocaleString('zh-CN', { hour12: false });
}
