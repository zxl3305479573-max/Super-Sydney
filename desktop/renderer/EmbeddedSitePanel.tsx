import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmbeddedSiteKey, EmbeddedViewState } from '../shared';
import { Icon, readableError, visibleStageBounds } from './ui';

/**
 * 变现分组里固定嵌入的站点（闲鱼、16688 …）。
 *
 * 和 AI 代充一样，页面不在 DOM 里渲染：主进程把 WebContentsView 挂在窗口上，
 * 这里只报承载区域 .site-stage 的位置、转发后退 / 刷新这些操作。
 * 视图浮在页面之上，所以模块被隐藏或弹层打开时（overlay）必须先把它摘下来；
 * covered 只表示「是弹层挡住了」，用来给出提示。
 */
export default function EmbeddedSitePanel({ siteKey, label, privacy, overlay, covered = overlay }: { siteKey: EmbeddedSiteKey; label: string; privacy: string; overlay: boolean; covered?: boolean }) {
  const [state, setState] = useState<EmbeddedViewState | null>(null);
  const [error, setError] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setState(null);
    setError('');
    const pull = async () => {
      const next = await window.sydney.getEmbeddedView(siteKey);
      if (alive) setState(next);
    };
    void pull();
    const off = window.sydney.onEmbeddedViewChanged(siteKey, () => void pull());
    return () => { alive = false; off(); };
  }, [siteKey]);

  const readStage = useCallback(() => {
    return visibleStageBounds(stageRef.current);
  }, []);

  useEffect(() => {
    if (overlay) {
      void window.sydney.closeEmbeddedView(siteKey);
      return;
    }
    void window.sydney.openEmbeddedView(siteKey);
    const report = () => void window.sydney.setEmbeddedViewBounds(siteKey, readStage());
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
      void window.sydney.closeEmbeddedView(siteKey);
    };
  }, [siteKey, overlay, readStage]);

  const go = (action: 'back' | 'reload' | 'home') => {
    void window.sydney.embeddedViewGo(siteKey, action).then(next => { setState(next); setError(''); }).catch(problem => setError(readableError(problem)));
  };

  return <section className="site-panel" aria-label={label}>
    <div className="site-bar">
      <div className="site-actions">
        <button className="button button-quiet button-small" type="button" onClick={() => go('back')} disabled={!state?.canGoBack}><Icon name="undo" size={14} />后退</button>
        <button className="button button-quiet button-small" type="button" onClick={() => go('reload')}><Icon name="refresh" size={14} />刷新</button>
        <button className="button button-quiet button-small" type="button" onClick={() => go('home')}><Icon name="link" size={14} />回到{label}首页</button>
        <button className="button button-quiet button-small" type="button" onClick={() => void window.sydney.openEmbeddedInBrowser(siteKey)}><Icon name="window" size={14} />在浏览器打开</button>
      </div>
    </div>
    {(error || state?.error) && <p className="site-error" role="alert"><Icon name="alert" size={14} /><span>{error || state?.error}</span></p>}
    <p className="site-meta">
      <span>当前页面</span>
      <strong>{state?.title || state?.url || '正在打开…'}</strong>
      {state?.loading && <span>载入中…</span>}
      {covered && <span>弹层打开时先收起{label}页面</span>}
    </p>
    <div className="site-stage" ref={stageRef}>
      <p className="site-stage-hint">{state?.loading ? `正在打开${label}…` : `${label}页面正在接管这块区域`}</p>
    </div>
    <p className="site-privacy">{privacy}</p>
  </section>;
}
