import { useCallback, useEffect, useState } from 'react';
import type { XhsAccount, XhsHotNote, XhsNote, XhsStepKey, XhsTab } from '../shared';
import { XHS_TAB_LABELS } from '../services/xhs-catalog';
import { readPositioning } from '../services/xhs-pipeline';
import { readableError } from './ui';
import type { XhsContext } from './xiaohongshu/common';
import { HomeTab } from './xiaohongshu/HomeTab';
import { PositioningTab } from './xiaohongshu/PositioningTab';
import { HotspotTab } from './xiaohongshu/HotspotTab';
import { NotesTab } from './xiaohongshu/NotesTab';
import { AuditTab, type AuditPrefill } from './xiaohongshu/AuditTab';
import { AnalyticsTab } from './xiaohongshu/AnalyticsTab';
import { BrowserTab } from './xiaohongshu/BrowserTab';

/**
 * 小红书模块。
 *
 * 按推文《小红书运营 Skill》的拆法：定位、选题、写作、视觉、复盘五个环节 + 一个总控（向导），共 10 个能力，
 * 三条标准链路（从零起号 / 日常产出 / 诊断改进）。设计见 docs/superpowers/specs/2026-10-13-xiaohongshu-module-design.md。
 * 模块不代发布：终点是知识库里的发布包。
 */

const TABS: XhsTab[] = ['home', 'positioning', 'hotspot', 'notes', 'audit', 'analytics', 'browser'];

export default function XiaohongshuPanel({ notify, overlay }: { notify: (message: string) => void; overlay: boolean }) {
  const [account, setAccount] = useState<XhsAccount | null>(null);
  const [notes, setNotes] = useState<XhsNote[]>([]);
  const [tab, setTab] = useState<XhsTab>('home');
  const [noteTarget, setNoteTarget] = useState<{ id: number; step?: XhsStepKey; nonce: number } | null>(null);
  /** 小红书窗口里读到的笔记，交给「热点选题」展示；读到的主页交给「账号诊断」。 */
  const [viewNotes, setViewNotes] = useState<{ notes: XhsHotNote[]; url: string } | null>(null);
  const [viewProfile, setViewProfile] = useState<AuditPrefill>(null);
  const [nameDraft, setNameDraft] = useState('');

  const refresh = useCallback(async () => {
    const accounts = await window.sydney.listXhsAccounts();
    const current = accounts[0] ?? null;
    setAccount(current);
    setNotes(current ? await window.sydney.listXhsNotes(current.id) : []);
  }, []);
  useEffect(() => {
    void refresh().catch(error => notify(readableError(error)));
    return window.sydney.onChanged(() => void refresh().catch(() => undefined));
  }, [refresh, notify]);
  useEffect(() => { setNameDraft(account?.name ?? ''); }, [account?.name]);

  const goTo = useCallback((next: XhsTab) => setTab(next), []);
  const openNote = useCallback((id: number, step?: XhsStepKey) => { setNoteTarget({ id, step, nonce: Date.now() }); setTab('notes'); }, []);

  if (!account) return <section className="xhs-panel"><p className="empty-state"><strong>正在加载小红书模块…</strong></p></section>;

  const ctx: XhsContext = { account, notes, notify, goTo, openNote, refresh };
  const saveAccount = async (patch: Parameters<typeof window.sydney.updateXhsAccount>[1]) => {
    try { setAccount(await window.sydney.updateXhsAccount(account.id, patch)); }
    catch (error) { notify(readableError(error)); }
  };
  const positioning = readPositioning(account);

  return <section className="xhs-panel native-content" aria-label="小红书">
    <header className="ww-page-header">
      <div>
        <p className="eyebrow">内容工作区</p>
        <h1>小红书</h1>
        <p>定位 → 选题 → 写作 → 视觉 → 复盘，10 个能力按链路串起来。只交付发布包，由你手动发布。</p>
      </div>
      <div className="xhs-account-bar">
        <label><span>账号</span><input className="input" value={nameDraft} onChange={event => setNameDraft(event.target.value)} onBlur={() => { if (nameDraft.trim() && nameDraft.trim() !== account.name) void saveAccount({ name: nameDraft.trim() }); else setNameDraft(account.name); }} /></label>
        <small>{positioning ? `定位：${positioning.statement}` : '还没有定位档案'} · {notes.length} 篇笔记</small>
      </div>
    </header>

    <nav className="ww-tabs xhs-tabs" role="tablist" aria-label="小红书分区">
      {TABS.map(item => <button key={item} role="tab" aria-selected={tab === item} className={`ww-tab ${tab === item ? 'is-active' : ''}`} onClick={() => setTab(item)}>{XHS_TAB_LABELS[item]}</button>)}
    </nav>

    {tab === 'home' && <HomeTab ctx={ctx} />}
    {tab === 'positioning' && <PositioningTab ctx={ctx} onAccount={setAccount} />}
    {tab === 'hotspot' && <HotspotTab ctx={ctx} viewNotes={viewNotes} onClearViewNotes={() => setViewNotes(null)} />}
    {tab === 'notes' && <NotesTab ctx={ctx} target={noteTarget} />}
    {tab === 'audit' && <AuditTab ctx={ctx} prefill={viewProfile} onPrefillUsed={() => setViewProfile(null)} />}
    {tab === 'analytics' && <AnalyticsTab ctx={ctx} />}
    {tab === 'browser' && <BrowserTab ctx={ctx} overlay={overlay}
      onNotes={(read, url) => { setViewNotes({ notes: read, url }); setTab('hotspot'); }}
      onProfile={prefill => { setViewProfile(prefill); setTab('audit'); }} />}
  </section>;
}
