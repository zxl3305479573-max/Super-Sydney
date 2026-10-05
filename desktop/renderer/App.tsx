import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppState, EventDraft, EventStatus, LlmKeyStatus, WorkEvent } from '../shared';

type View = 'today' | 'review' | 'settings';
const empty: AppState = { settings: { captureEnabled: false, capturePaused: false, codexCaptureEnabled: false, llmEnabled: false, allowedApps: [], blockedApps: [], captureIntervalSeconds: 30, vaultPath: '' }, stats: { total: 0, pending: 0, duration: 0 }, events: [], codexCapture: { state: 'disabled', error: '' } };
const statusText: Record<EventStatus, string> = { pending: '待确认', approved: '已确认', rejected: '已忽略' };
const durationText = (seconds: number) => { const mins = Math.round(seconds / 60); return mins < 60 ? `${mins} 分钟` : `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`; };

export default function App() {
  const [state, setState] = useState<AppState>(empty);
  const [view, setView] = useState<View>('today');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const [draftingId, setDraftingId] = useState<number | null>(null);
  const [llmKeyStatus, setLlmKeyStatus] = useState<LlmKeyStatus>({ configured: false, masked: '', encryptionAvailable: true });
  const [llmKeyInput, setLlmKeyInput] = useState('');
  const refresh = useCallback(async () => setState(await window.sydney.getState()), []);
  useEffect(() => { void refresh(); void window.sydney.getLlmKeyStatus().then(setLlmKeyStatus); return window.sydney.onChanged(() => void refresh()); }, [refresh]);
  const events = useMemo(() => state.events.filter(event => `${event.note} ${event.summary} ${event.app_name} ${event.window_title}`.toLowerCase().includes(query.toLowerCase())), [state.events, query]);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2400); };
  const manual = async () => {
    const note = window.prompt('你正在做什么？');
    if (!note?.trim()) return;
    await window.sydney.createEvent({ note: note.trim(), kind: 'manual', status: 'pending', category: '个人成长' });
    notify('已保存到本地，等待确认');
  };
  const update = async (id: number, patch: Partial<WorkEvent>) => { await window.sydney.updateEvent(id, patch); await refresh(); };
  const chooseVault = async () => { const target = await window.sydney.chooseVault(); if (target) notify(`知识库路径已设置：${target}`); await refresh(); };
  const summary = async () => { const target = await window.sydney.generateDailySummary(); notify(`日报已更新：${target}`); };
  const draftEvent = async (id: number) => {
    setDraftingId(id);
    try { await window.sydney.draftEvent(id); await refresh(); notify('AI 草稿已保存'); }
    catch (error) { notify(error instanceof Error ? error.message : 'AI 整理失败'); }
    finally { setDraftingId(null); }
  };
  const applyDraft = async (id: number) => { await window.sydney.applyDraft(id); await refresh(); notify('草稿已应用到摘要'); };
  const clearDraft = async (id: number) => { await window.sydney.clearDraft(id); await refresh(); notify('AI 草稿已删除'); };
  const saveLlmKey = async () => {
    try { const status = await window.sydney.saveLlmKey(llmKeyInput); setLlmKeyStatus(status); setLlmKeyInput(''); notify('DeepSeek 密钥已安全保存'); }
    catch (error) { setLlmKeyInput(''); notify(error instanceof Error ? error.message : '密钥保存失败'); }
  };
  const deleteLlmKey = async () => {
    if (!window.confirm('删除程序内保存的 DeepSeek 密钥？删除后将尝试使用环境变量。')) return;
    try { setLlmKeyStatus(await window.sydney.deleteLlmKey()); notify('DeepSeek 密钥已删除'); }
    catch (error) { notify(error instanceof Error ? error.message : '密钥删除失败'); }
  };
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">S</span><div><strong>Sydney</strong><small>个人工作 OS</small></div></div><nav className="nav" aria-label="主导航">{(['today', 'review', 'settings'] as View[]).map((item, i) => <button key={item} className={`nav-item ${view === item ? 'active' : ''}`} onClick={() => setView(item)}><span>{['◷', '✓', '⚙'][i]}</span>{['今日工作', '待确认事件', '隐私与设置'][i]}</button>)}</nav><div className="sidebar-footer"><span className="status-dot" />本地模式</div></aside>
    <main className="main-content"><header className="topbar"><div><p className="eyebrow">工作台</p><h1>{view === 'today' ? '今日工作' : view === 'review' ? '待确认事件' : '隐私与设置'}</h1></div><div className="top-actions"><button className="button button-secondary" onClick={() => void window.sydney.getState().then(next => notify(next.settings.vaultPath))}>知识库路径</button><button className="button button-primary" onClick={() => void window.sydney.setCapture(state.settings.captureEnabled ? 'stop' : 'start')}>{state.settings.captureEnabled ? '停止记录' : '开始记录'}</button></div></header>
      <section className={`capture-strip ${state.settings.captureEnabled && !state.settings.capturePaused ? 'is-live' : ''}`}><div className="capture-icon">◉</div><div><strong>{!state.settings.captureEnabled ? '记录已停止' : state.settings.capturePaused ? '记录已暂停' : '正在记录允许应用的使用时长'}</strong><p>只记录应用、窗口标题和时长，不记录键盘输入、屏幕画面或私人聊天。</p></div><div className="capture-spacer"/><button className="button button-quiet" onClick={() => void window.sydney.setCapture(state.settings.capturePaused ? 'start' : 'pause')}>{state.settings.capturePaused ? '继续' : '暂停'}</button><button className="button button-quiet" onClick={() => void manual()}>+ 手动记录</button></section>
      {view === 'settings' && <section className="key-management"><div className="section-heading"><div><h2>DeepSeek API Key</h2><p>{llmKeyStatus.configured ? `已配置：${llmKeyStatus.masked}` : llmKeyStatus.encryptionAvailable ? '尚未配置，密钥会由系统加密保存。' : '系统凭据加密不可用，无法保存密钥。'}</p></div></div><div className="secret-actions"><input type="password" autoComplete="new-password" aria-label="DeepSeek API Key" placeholder="粘贴新的 API Key" value={llmKeyInput} onChange={e => setLlmKeyInput(e.target.value)} disabled={!llmKeyStatus.encryptionAvailable} /><button className="button button-secondary" disabled={!llmKeyInput.trim() || !llmKeyStatus.encryptionAvailable} onClick={() => void saveLlmKey()}>{llmKeyStatus.configured ? '替换密钥' : '保存密钥'}</button>{llmKeyStatus.configured && <button className="button button-quiet" onClick={() => void deleteLlmKey()}>删除密钥</button>}</div></section>}
      {view === 'settings' ? <section><div className="section-heading"><div><h2>本地采集设置</h2><p>项目数据保存在应用数据目录，知识库单独指定。</p></div><button className="button button-primary" onClick={() => void chooseVault()}>选择知识库目录</button></div><div className="settings-grid"><label className="setting"><span>允许采集的应用（每行一个）</span><textarea value={state.settings.allowedApps.join('\n')} onChange={e => setState(s => ({ ...s, settings: { ...s.settings, allowedApps: e.target.value.split(/\r?\n/).filter(Boolean) } }))} onBlur={() => void window.sydney.saveSettings({ allowedApps: state.settings.allowedApps })}/></label><label className="setting"><span>禁止采集的应用（每行一个）</span><textarea value={state.settings.blockedApps.join('\n')} onChange={e => setState(s => ({ ...s, settings: { ...s.settings, blockedApps: e.target.value.split(/\r?\n/).filter(Boolean) } }))} onBlur={() => void window.sydney.saveSettings({ blockedApps: state.settings.blockedApps })}/></label><label className="setting"><span>当前 Obsidian 知识库路径</span><small>{state.settings.vaultPath}</small></label><label className="setting"><span>采样间隔</span><input type="number" min="10" value={state.settings.captureIntervalSeconds} onChange={e => setState(s => ({ ...s, settings: { ...s.settings, captureIntervalSeconds: Number(e.target.value) } }))} onBlur={() => void window.sydney.saveSettings({ captureIntervalSeconds: Math.max(10, state.settings.captureIntervalSeconds) })}/></label><label className="setting setting-toggle"><span><input type="checkbox" checked={state.settings.codexCaptureEnabled} onChange={async e => { await window.sydney.saveSettings({ codexCaptureEnabled: e.target.checked }); await refresh(); }} />采集 Codex 桌面端对话</span><small>仅在 Sydney 正在记录时采集新提示词和最终答复。默认关闭，不导入历史、工具输出或终端内容。</small><b className={`adapter-state adapter-${state.codexCapture.state}`}>{state.codexCapture.state === 'listening' ? '正在监听新对话' : state.codexCapture.state === 'stopped' ? '已启用，等待开始记录' : state.codexCapture.state === 'error' ? `监听错误：${state.codexCapture.error}` : '未启用'}</b></label><label className="setting setting-toggle"><span><input type="checkbox" checked={state.settings.llmEnabled} onChange={async e => { await window.sydney.saveSettings({ llmEnabled: e.target.checked }); await refresh(); }} />允许发送到 DeepSeek</span><small>默认关闭。只有你点击单条事件的“AI 整理”时，才会发送该事件的提示词和最终答复。</small></label></div></section> : <section>
        {view === 'today' && <><div className="metric-grid"><article className="metric"><span>今日事件</span><strong>{state.stats.total}</strong><small>本地保存</small></article><article className="metric"><span>待确认</span><strong>{state.stats.pending}</strong><small>需要你的判断</small></article><article className="metric"><span>记录时长</span><strong>{durationText(state.stats.duration)}</strong><small>来自应用使用采样</small></article><article className="metric metric-accent"><span>今日焦点</span><strong>个人成长</strong><small>按工作事件沉淀</small></article></div><div className="section-heading"><div><h2>工作时间线</h2><p>记录先进入本地待确认列表。</p></div><div className="filter-row"><input placeholder="搜索事件" value={query} onChange={e => setQuery(e.target.value)}/><button className="button button-secondary" onClick={() => void summary()}>生成今日总结</button></div></div></>}
        {view === 'review' && <div className="section-heading"><div><h2>待确认事件</h2><p>确认、修改或删除后再沉淀。</p></div></div>}
        <div className="event-list">{events.filter(e => view !== 'review' || e.status === 'pending').map(event => <EventRow key={event.id} event={event} drafting={draftingId === event.id} onDraft={draftEvent} onApplyDraft={applyDraft} onClearDraft={clearDraft} onUpdate={update} onDelete={async id => { await window.sydney.deleteEvent(id); await refresh(); }} onEdit={async item => { const note = window.prompt('修改工作记录', item.note); if (note?.trim()) await update(item.id, { note: note.trim() }); }}/>)}</div>
      </section>}
    </main><div className={`toast ${toast ? 'show' : ''}`} role="status">{toast}</div>
  </div>;
}

function EventRow({ event, drafting, onDraft, onApplyDraft, onClearDraft, onUpdate, onDelete, onEdit }: { event: WorkEvent; drafting: boolean; onDraft: (id: number) => Promise<void>; onApplyDraft: (id: number) => Promise<void>; onClearDraft: (id: number) => Promise<void>; onUpdate: (id: number, patch: Partial<WorkEvent>) => Promise<void>; onDelete: (id: number) => Promise<void>; onEdit: (event: WorkEvent) => Promise<void> }) {
  const draft = parseDraft(event.ai_draft_json);
  return <article className={`event-row ${event.source === 'codex' ? 'event-codex' : ''}`}><time className="event-time">{new Date(event.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div className="event-body"><div className="event-title"><strong>{event.note || event.window_title || '活动采样'}</strong><span className="tag">{event.category}</span><small>{event.app_name || '手动记录'}</small>{event.source === 'codex' && <span className="local-sensitive">敏感内容，仅本地</span>}</div>{event.source === 'codex' ? <details className="codex-detail"><summary>{event.codex_response ? '查看 Codex 最终答复' : '等待 Codex 最终答复'}</summary>{event.codex_response && <pre>{event.codex_response}</pre>}<small>来源会话：{event.source_session_id || '未知'}，删除此事件不会删除 Codex 原会话。</small></details> : <div className="event-meta">{event.summary || `${event.kind === 'activity' ? '应用活动' : '手动记录'} · ${durationText(event.duration_seconds)}`}</div>}{draft && <DraftDetails draft={draft} model={event.ai_draft_model} draftedAt={event.ai_drafted_at} onApply={() => void onApplyDraft(event.id)} onClear={() => void onClearDraft(event.id)} />}</div><div className="event-actions"><span className={`status status-${event.status}`}>{statusText[event.status]}</span>{event.status === 'pending' && <button className="ai-draft-button" disabled={drafting} onClick={() => void onDraft(event.id)}>{drafting ? '整理中…' : 'AI 整理'}</button>}<button onClick={() => void onEdit(event)}>修改</button>{event.status === 'pending' && <button onClick={() => void onUpdate(event.id, { status: 'approved' })}>确认</button>}{event.status === 'pending' && <button onClick={() => void onUpdate(event.id, { status: 'rejected' })}>忽略</button>}<button onClick={() => void onDelete(event.id)}>删除</button></div></article>;
}

function parseDraft(value: string): EventDraft | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EventDraft>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      what_done: typeof parsed.what_done === 'string' ? parsed.what_done : '',
      why: typeof parsed.why === 'string' ? parsed.why : '',
      tools: typeof parsed.tools === 'string' ? parsed.tools : '',
      problems: typeof parsed.problems === 'string' ? parsed.problems : '',
      solution: typeof parsed.solution === 'string' ? parsed.solution : '',
      result: typeof parsed.result === 'string' ? parsed.result : '',
      reuse: typeof parsed.reuse === 'string' ? parsed.reuse : '',
      category: typeof parsed.category === 'string' ? parsed.category : '个人成长',
      content_candidate: parsed.content_candidate === true
    };
  } catch { return null; }
}

function DraftDetails({ draft, model, draftedAt, onApply, onClear }: { draft: EventDraft; model: string; draftedAt: string; onApply: () => void; onClear: () => void }) {
  const fields: Array<[string, string]> = [['做了什么', draft.what_done], ['为什么做', draft.why], ['使用工具', draft.tools], ['遇到问题', draft.problems], ['解决方式', draft.solution], ['最终结果', draft.result], ['如何复用', draft.reuse], ['知识分类', draft.category], ['内容候选', draft.content_candidate ? '是' : '否']];
  return <details className="ai-draft" open><summary>AI 整理草稿 · {model || 'DeepSeek'}</summary><div className="ai-draft-grid">{fields.map(([label, value]) => <div key={label}><span>{label}</span><p>{value || '未提供'}</p></div>)}</div><small>{draftedAt ? `生成于 ${new Date(draftedAt).toLocaleString('zh-CN')}` : '仅保存在本地'}</small><div className="ai-draft-actions"><button onClick={onApply}>应用到摘要</button><button onClick={onClear}>删除草稿</button></div></details>;
}
