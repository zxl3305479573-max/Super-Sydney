import { useCallback, useState } from 'react';
import type { XhsAccount, XhsFunnelLayer, XhsHotNote, XhsNote, XhsStepKey, XhsTab } from '../../shared';
import { fuzzyCount } from '../../services/xhs-hotspot';
import { Icon, readableError } from '../ui';

/** 小红书各分页共用的上下文、格式化工具与小组件。 */

export type XhsContext = {
  account: XhsAccount;
  notes: XhsNote[];
  notify: (message: string) => void;
  goTo: (tab: XhsTab) => void;
  openNote: (id: number, step?: XhsStepKey) => void;
  refresh: () => Promise<void>;
};

/** 按钮级的忙碌状态：同一时间只跑一个动作，失败统一走 notify。 */
export function useBusy(notify: (message: string) => void) {
  const [busy, setBusy] = useState('');
  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); } catch (error) { notify(readableError(error)); } finally { setBusy(''); }
  }, [notify]);
  return { busy, run, locked: busy !== '' };
}

export function percent(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`;
}

export function layerValue(layer: XhsFunnelLayer, value: number | null): string {
  if (value === null) return '—';
  if (layer === 'exposure') return fuzzyCount(value) === '--' ? '0' : value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(Math.round(value));
  if (layer === 'depth' && value > 1) return `${value.toFixed(0)} 秒`;
  return percent(value);
}

export function sourceOf(note: XhsNote): { id?: string; title?: string; link?: string; interactive?: number; unverified?: boolean } | null {
  try { return note.sourceJson ? JSON.parse(note.sourceJson) : null; } catch { return null; }
}

export function adoptedIds(notes: XhsNote[]): Set<string> {
  return new Set(notes.flatMap(note => { const source = sourceOf(note); return source?.id ? [String(source.id)] : []; }));
}

export function openLink(url: string, notify: (message: string) => void) {
  void window.sydney.openXhsLink(url).catch(error => notify(readableError(error)));
}

export function HotNoteRow({ note, onAdopt, onOpen, adopted }: { note: XhsHotNote; onAdopt: () => void; onOpen: () => void; adopted: boolean }) {
  return <li className="xhs-hot">
    <div className="xhs-hot-main">
      <button className="xhs-hot-title" title="在浏览器中打开" onClick={onOpen}>{note.title}</button>
      <p className="xhs-hot-meta">
        <span>{note.author.nickname}{note.author.fans ? `（${fuzzyCount(note.author.fans)}粉）` : ''}</span>
        {note.createTime && <span>{note.createTime.slice(0, 10)}</span>}
        {note.score && <span title="相关性 / 热度 / 时效">评分 {note.score.total.toFixed(1)}</span>}
      </p>
      {note.desc && note.unverified && <p className="xhs-hot-desc">{note.desc}</p>}
      {note.topics.length > 0 && <div className="xhs-chip-row">{note.topics.slice(0, 4).map(topic => <span key={topic} className="chip chip-soft">#{topic}</span>)}</div>}
    </div>
    <div className="xhs-hot-stats">
      {note.unverified ? <><strong>—</strong><small>热度未知</small></> : <><strong>{fuzzyCount(note.interactive)}</strong><small>{note.collected || note.comments ? '互动' : '点赞'}</small>
        {(note.collected > 0 || note.comments > 0) && <span>赞 {fuzzyCount(note.liked)} · 藏 {fuzzyCount(note.collected)}</span>}</>}
    </div>
    <button className="button button-secondary" disabled={adopted} onClick={onAdopt}>{adopted ? '已转选题' : <><Icon name="plus" />转为选题</>}</button>
  </li>;
}

/** 卡片式区块：标题 + 说明 + 右侧操作。 */
export function Section({ title, hint, actions, children, className = '' }: { title: string; hint?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`xhs-card ${className}`}>
    <header className="xhs-card-head"><div><h2>{title}</h2>{hint && <p>{hint}</p>}</div>{actions && <div className="xhs-card-actions">{actions}</div>}</header>
    {children}
  </section>;
}

export function ScoreBar({ value, max }: { value: number | null; max: number }) {
  const ratio = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  return <span className={`xhs-scorebar ${value === null ? 'is-empty' : ''}`} aria-hidden="true"><i style={{ width: `${ratio * 100}%` }} /></span>;
}
