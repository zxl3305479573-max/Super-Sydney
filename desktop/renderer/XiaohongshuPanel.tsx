import { useCallback, useEffect, useRef, useState } from 'react';
import type { XhsAccount, XhsHotNote, XhsNote, XhsStepKey, XhsTab } from '../shared';
import { XHS_TAB_LABELS } from '../services/xhs-catalog';
import { readPositioning } from '../services/xhs-pipeline';
import { ConfirmButton, Icon, KeepAlive, readableError, useVisited } from './ui';
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

/** 上次选中的账号只是界面偏好，存在本机 localStorage；读不到就用第一个账号。 */
const ACCOUNT_KEY = 'sydney.xhs.accountId';
const TAB_KEY = 'sydney.xhs.tab';

/** 上次停在哪个分区，重新打开应用回到那里。 */
function storedTab(): XhsTab {
  try {
    const saved = localStorage.getItem(TAB_KEY) as XhsTab | null;
    if (saved && TABS.includes(saved)) return saved;
  } catch { /* 读不到就从首页开始 */ }
  return 'home';
}
function storedAccountId(): number {
  try { return Number(localStorage.getItem(ACCOUNT_KEY)) || 0; } catch { return 0; }
}
function rememberAccountId(id: number): void {
  try { localStorage.setItem(ACCOUNT_KEY, String(id)); } catch { /* 存不下也不影响使用 */ }
}

export default function XiaohongshuPanel({ notify, overlay }: { notify: (message: string) => void; overlay: boolean }) {
  const [account, setAccount] = useState<XhsAccount | null>(null);
  const [accounts, setAccounts] = useState<XhsAccount[]>([]);
  /** 当前账号 id 放在 ref 里：全局 state:changed 触发的刷新要按「现在选中的」账号拉，而不是闭包里的旧值。 */
  const selectedRef = useRef(storedAccountId());
  /** 连续刷新 / 切换账号时，只接受最后一次请求的结果。 */
  const refreshSeq = useRef(0);
  const [editing, setEditing] = useState<'' | 'add' | 'rename'>('');
  /** 笔记创作里有没有未保存的修改：切换账号会重新挂载各分区，修改会丢。 */
  const notesDirty = useRef(false);
  const trackDirty = useCallback((dirty: boolean) => { notesDirty.current = dirty; }, []);
  const [notes, setNotes] = useState<XhsNote[]>([]);
  const [tab, setTab] = useState<XhsTab>(storedTab);
  const visited = useVisited(tab);
  useEffect(() => { try { localStorage.setItem(TAB_KEY, tab); } catch { /* 存不下也不影响使用 */ } }, [tab]);
  const [noteTarget, setNoteTarget] = useState<{ id: number; step?: XhsStepKey; nonce: number } | null>(null);
  /** 小红书窗口里读到的笔记，交给「热点选题」展示；读到的主页交给「账号诊断」。 */
  const [viewNotes, setViewNotes] = useState<{ notes: XhsHotNote[]; url: string } | null>(null);
  const [viewProfile, setViewProfile] = useState<AuditPrefill>(null);
  const [nameDraft, setNameDraft] = useState('');

  const refresh = useCallback(async () => {
    const ticket = ++refreshSeq.current;
    const list = await window.sydney.listXhsAccounts();
    if (ticket !== refreshSeq.current) return;
    const current = list.find(item => item.id === selectedRef.current) ?? list[0] ?? null;
    if (current) selectedRef.current = current.id;
    const currentNotes = current ? await window.sydney.listXhsNotes(current.id) : [];
    // 拉取期间又切了账号：丢掉这次结果，等新账号的那次刷新。
    if (ticket !== refreshSeq.current || (current && current.id !== selectedRef.current)) return;
    setAccounts(list);
    setAccount(current);
    setNotes(currentNotes);
  }, []);
  useEffect(() => {
    void refresh().catch(error => notify(readableError(error)));
    return window.sydney.onChanged(() => void refresh().catch(() => undefined));
  }, [refresh, notify]);
  useEffect(() => { if (editing !== 'add') setNameDraft(account?.name ?? ''); }, [account?.name, editing]);

  const goTo = useCallback((next: XhsTab) => setTab(next), []);
  const openNote = useCallback((id: number, step?: XhsStepKey) => { setNoteTarget({ id, step, nonce: Date.now() }); setTab('notes'); }, []);

  if (!account) return <section className="xhs-panel"><p className="empty-state"><strong>正在加载小红书模块…</strong></p></section>;

  const ctx: XhsContext = { account, notes, notify, goTo, openNote, refresh };
  /** 子页的异步回包可能在切号后才到；不属于当前账号的账号对象不能写回页头。 */
  const applyAccount = (next: XhsAccount) => {
    if (next.id === selectedRef.current) setAccount(next);
  };
  const saveAccount = async (patch: Parameters<typeof window.sydney.updateXhsAccount>[1]) => {
    try { applyAccount(await window.sydney.updateXhsAccount(account.id, patch)); }
    catch (error) { notify(readableError(error)); }
  };
  const positioning = readPositioning(account);

  /** 切换账号：各分区按账号重新挂载，上一个账号的笔记跳转、窗口读取结果都不带过去。 */
  const switchAccount = (id: number) => {
    if (id === account.id) return;
    if (notesDirty.current && !window.confirm('当前笔记有未保存的修改，切换账号后会丢失。继续？')) return;
    notesDirty.current = false;
    selectedRef.current = id;
    rememberAccountId(id);
    setEditing('');
    setNoteTarget(null);
    setViewNotes(null);
    setViewProfile(null);
    void refresh().catch(error => notify(readableError(error)));
  };
  const submitName = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = nameDraft.trim();
    if (!name) return;
    try {
      if (editing === 'add') {
        const created = await window.sydney.createXhsAccount(name);
        setEditing('');
        switchAccount(created.id);
        notify(`已添加账号「${created.name}」，先去「账号定位」做定位档案`);
        setTab('positioning');
      } else {
        if (name !== account.name) await saveAccount({ name });
        setEditing('');
      }
    } catch (error) {
      notify(readableError(error));
    }
  };
  const removeAccount = async () => {
    try {
      await window.sydney.deleteXhsAccount(account.id);
      const rest = accounts.filter(item => item.id !== account.id);
      notify(`已删除账号「${account.name}」`);
      if (rest[0]) switchAccount(rest[0].id);
    } catch (error) {
      notify(readableError(error));
    }
  };

  return <section className="xhs-panel native-content" aria-label="小红书">
    <header className="ww-page-header">
      <div>
        <p className="eyebrow">内容工作区</p>
        <h1>小红书</h1>
        <p>定位 → 选题 → 写作 → 视觉 → 复盘，10 个能力按链路串起来。只交付发布包，由你手动发布。</p>
      </div>
      <div className="xhs-account-bar">
        {editing ? <form className="xhs-account-row" onSubmit={event => void submitName(event)}>
          <label><span>{editing === 'add' ? '新账号名称' : '账号改名'}</span>
            <input className="input" autoFocus maxLength={40} value={nameDraft} onChange={event => setNameDraft(event.target.value)} placeholder="例如：主号、职场副号" onKeyDown={event => { if (event.key === 'Escape') setEditing(''); }} />
          </label>
          <button className="button button-primary button-small" type="submit" disabled={!nameDraft.trim()}>{editing === 'add' ? '添加' : '保存'}</button>
          <button className="button button-quiet button-small" type="button" onClick={() => setEditing('')}>取消</button>
        </form> : <div className="xhs-account-row">
          <label><span>当前账号</span>
            <select className="input" value={account.id} onChange={event => switchAccount(Number(event.target.value))} aria-label="切换小红书账号">
              {accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button className="button button-secondary button-small" type="button" onClick={() => { setNameDraft(''); setEditing('add'); }}><Icon name="plus" size={14} />添加账号</button>
          <button className="button button-quiet button-small" type="button" onClick={() => { setNameDraft(account.name); setEditing('rename'); }}>改名</button>
          {accounts.length > 1 && notes.length === 0 && <ConfirmButton className="button button-danger-quiet button-small" armedLabel="确认删除" title="只能删除还没有笔记和数据的账号" onConfirm={() => void removeAccount()}>删除</ConfirmButton>}
        </div>}
        <small>{positioning ? `定位：${positioning.statement}` : '还没有定位档案'} · {notes.length} 篇笔记{accounts.length > 1 ? ` · 共 ${accounts.length} 个账号` : ''}</small>
      </div>
    </header>

    <nav className="ww-nav-dock" aria-label="小红书分区">
      <div className="ww-tabs xhs-tabs" role="tablist" aria-label="小红书分区">
        {TABS.map(item => <button key={item} role="tab" aria-selected={tab === item} className={`ww-tab ${tab === item ? 'is-active' : ''}`} onClick={() => setTab(item)}>{XHS_TAB_LABELS[item]}</button>)}
      </div>
    </nav>

    <div key={account.id} className="xhs-account-scope">
      {visited.includes('home') && <KeepAlive show={tab === 'home'}><HomeTab ctx={ctx} /></KeepAlive>}
      {visited.includes('positioning') && <KeepAlive show={tab === 'positioning'}><PositioningTab ctx={ctx} onAccount={applyAccount} /></KeepAlive>}
      {visited.includes('hotspot') && <KeepAlive show={tab === 'hotspot'}><HotspotTab ctx={ctx} viewNotes={viewNotes} onClearViewNotes={() => setViewNotes(null)} /></KeepAlive>}
      {visited.includes('notes') && <KeepAlive show={tab === 'notes'}><NotesTab ctx={ctx} target={noteTarget} onDirtyChange={trackDirty} /></KeepAlive>}
      {visited.includes('audit') && <KeepAlive show={tab === 'audit'}><AuditTab ctx={ctx} prefill={viewProfile} onPrefillUsed={() => setViewProfile(null)} /></KeepAlive>}
      {visited.includes('analytics') && <KeepAlive show={tab === 'analytics'}><AnalyticsTab ctx={ctx} /></KeepAlive>}
      {visited.includes('browser') && <KeepAlive show={tab === 'browser'}><BrowserTab ctx={ctx} overlay={overlay || tab !== 'browser'}
        onNotes={(accountId, read, url) => {
          if (accountId !== selectedRef.current) return;
          setViewNotes({ notes: read, url });
          setTab('hotspot');
        }}
        onProfile={(accountId, prefill) => {
          if (accountId !== selectedRef.current) return;
          setViewProfile(prefill);
          setTab('audit');
        }} /></KeepAlive>}
    </div>
  </section>;
}
