import { useCallback, useEffect, useRef, useState } from 'react';
import type { SiteEntry, SiteModuleState } from '../shared';
import { ConfirmButton, Icon, readableError, visibleStageBounds } from './ui';

/**
 * 变现 · 站点模块（AI 代充）。
 *
 * 页面本身不在这里渲染：主进程把每个站点挂在窗口上的 WebContentsView 里，
 * 这里只做三件事——管理站点列表、报出承载区域的位置、转发操作。
 *
 * 因为视图浮在页面之上而不是嵌在 DOM 里：.site-stage 里不放需要点击的内容；
 * 弹层打开时必须先把它摘下来，否则它会盖在弹层上面。
 */
export default function SitePanel({ overlay, notify }: { overlay: boolean; notify: (message: string) => void }) {
  const [state, setState] = useState<SiteModuleState | null>(null);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [error, setError] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);

  const sites = state?.sites ?? [];
  const active = sites.find(site => site.id === state?.activeId) ?? null;
  const configured = Boolean(active);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      const next = await window.sydney.getSiteModule();
      if (alive) setState(next);
    };
    void pull();
    const off = window.sydney.onSiteModuleChanged(() => void pull());
    return () => { alive = false; off(); };
  }, []);

  // 只在当前站点（或它的问题地址）变了之后回填输入框，不在每次状态刷新时覆盖正在输入的内容。
  useEffect(() => {
    setEditName(active?.name ?? '');
    setEditUrl(active?.url ?? '');
  }, [active?.id, active?.name, active?.url]);

  const readStage = useCallback(() => {
    return visibleStageBounds(stageRef.current);
  }, []);

  useEffect(() => {
    if (!configured || overlay) {
      void window.sydney.closeSiteModule();
      return;
    }
    void window.sydney.openSiteModule();
    const report = () => void window.sydney.setSiteModuleBounds(readStage());
    report();
    const observer = new ResizeObserver(report);
    if (stageRef.current) observer.observe(stageRef.current);
    window.addEventListener('resize', report);
    // 捕获阶段监听：真正滚动的是外层容器，不是 window 本身。
    window.addEventListener('scroll', report, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      void window.sydney.closeSiteModule();
    };
  }, [configured, overlay, readStage]);

  const apply = (next: SiteModuleState) => { setState(next); setError(''); };
  const failed = (problem: unknown) => setError(readableError(problem));

  /** 保存整份列表：主进程负责校验、落盘，并把删掉的站点从会话里清掉。 */
  const save = async (next: SiteEntry[], activateId?: string) => {
    try {
      apply(await window.sydney.saveSiteModule(next, activateId ?? null));
      return true;
    } catch (problem) {
      failed(problem);
      return false;
    }
  };

  const addSite = async (event: React.FormEvent) => {
    event.preventDefault();
    const entry: SiteEntry = { id: newId(), name: newName.trim(), url: newUrl };
    if (await save([...sites, entry], entry.id)) {
      setNewName('');
      setNewUrl('');
      notify('站点已添加');
    }
  };

  const saveActive = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!active) return;
    const next = sites.map(site => (site.id === active.id ? { ...site, name: editName, url: editUrl } : site));
    if (await save(next)) notify('站点已保存');
  };

  const activate = async (id: string) => {
    try {
      apply(await window.sydney.activateSiteModule(id));
    } catch (problem) {
      failed(problem);
    }
  };

  const go = (action: 'back' | 'reload' | 'home') => {
    void window.sydney.siteModuleGo(action).then(apply).catch(failed);
  };

  return <section className="site-panel" aria-label="AI 代充">
    <form className="site-add-bar" onSubmit={addSite}>
      <span className="site-add-label">添加站点</span>
      <input className="input site-add-name" value={newName} onChange={event => setNewName(event.target.value)} placeholder="名称（留空按域名）" aria-label="新站点名称" />
      <input className="input site-add-url" value={newUrl} onChange={event => setNewUrl(event.target.value)} placeholder="https://…" aria-label="新站点地址" />
      <button className="button button-secondary button-small" type="submit"><Icon name="plus" size={14} />添加</button>
    </form>
    {active && <div className="site-bar">
      <form className="site-address" onSubmit={saveActive}>
        <label htmlFor="site-switch">站点</label>
        <select id="site-switch" className="site-switch" value={state?.activeId ?? ''} onChange={event => void activate(event.target.value)}>
          {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
        <label htmlFor="site-name">名称</label>
        <input id="site-name" className="input site-name-input" value={editName} onChange={event => setEditName(event.target.value)} />
        <label htmlFor="site-url">地址</label>
        <input id="site-url" className="input" value={editUrl} onChange={event => setEditUrl(event.target.value)} />
        <button className="button button-secondary button-small" type="submit">保存</button>
        <ConfirmButton className="button button-danger-quiet button-small" armedLabel="确认移除" title="把这个站点从列表里移除" onConfirm={() => void save(sites.filter(item => item.id !== active.id))}>
          <Icon name="trash" size={14} />移除站点
        </ConfirmButton>
      </form>
      <div className="site-actions">
        <button className="button button-quiet button-small" type="button" onClick={() => go('back')} disabled={!state?.canGoBack}><Icon name="undo" size={14} />后退</button>
        <button className="button button-quiet button-small" type="button" onClick={() => go('reload')}><Icon name="refresh" size={14} />刷新</button>
        <button className="button button-quiet button-small" type="button" onClick={() => go('home')}><Icon name="link" size={14} />回到站点首页</button>
        <button className="button button-quiet button-small" type="button" onClick={() => void window.sydney.openSiteModuleInBrowser()}><Icon name="window" size={14} />在浏览器打开</button>
      </div>
    </div>}
    {(error || state?.error) && <p className="site-error" role="alert"><Icon name="alert" size={14} /><span>{error || state?.error}</span></p>}
    {active && <p className="site-meta">
      <span>当前页面</span>
      <strong>{state?.title || state?.currentUrl || '正在打开…'}</strong>
      {state?.loading && <span>载入中…</span>}
      {overlay && <span>弹层打开时先收起站点视图</span>}
    </p>}
    <div className="site-stage" ref={stageRef}>
      {active
        ? <p className="site-stage-hint">{state?.loading ? '正在打开站点…' : '站点视图正在接管这块区域'}</p>
        : <div className="site-empty">
          <span className="site-empty-mark" aria-hidden="true"><Icon name="card" size={22} /></span>
          <strong>还没有站点</strong>
          <p>在最上面那一行填上站点名称与地址，逐个添加。每个站点会以独立会话嵌在这里，登录态只存在这个模块里，不写进应用的数据库。</p>
          <ul className="site-notes">
            <li>同一时刻只显示一个站点：用上面那个下拉框切换，已经打开过的站点切回来是原样，不重新加载。</li>
            <li>站点是第三方页面：它自己打开的支付页、客服链接会交给系统浏览器处理。</li>
            <li>应用不读站点的 cookie，也不往页面里注入脚本；采集与截屏都不会碰这些页面。</li>
          </ul>
        </div>}
    </div>
    <p className="site-privacy">站点内容由第三方提供，应用只负责给它让出这块位置，订单与账号问题以站点为准。</p>
  </section>;
}

/** 站点的 id 只是列表里的身份，界面生成即可；crypto.randomUUID 在 file:// 下也可用，兜底只是保险。 */
function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `site-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
