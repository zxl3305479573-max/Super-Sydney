import { useCallback, useEffect, useRef, useState } from 'react';
import type { XianyuViewState } from '../shared';
import { Icon, readableError } from './ui';

/**
 * 闲鱼模块：把闲鱼网页版（goofish.com）嵌进来。
 *
 * 和 AI 代充一样，页面不在 DOM 里渲染：主进程把 WebContentsView 挂在窗口上，
 * 这里只报承载区域 .site-stage 的位置、转发后退 / 刷新这些操作。
 * 视图浮在页面之上，所以弹层打开时（overlay）必须先把它摘下来。
 */
export default function XianyuPanel({ overlay }: { overlay: boolean }) {
  const [state, setState] = useState<XianyuViewState | null>(null);
  const [error, setError] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      const next = await window.sydney.getXianyuView();
      if (alive) setState(next);
    };
    void pull();
    const off = window.sydney.onXianyuViewChanged(() => void pull());
    return () => { alive = false; off(); };
  }, []);

  const readStage = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
  }, []);

  useEffect(() => {
    if (overlay) {
      void window.sydney.closeXianyuView();
      return;
    }
    void window.sydney.openXianyuView();
    const report = () => void window.sydney.setXianyuViewBounds(readStage());
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
      void window.sydney.closeXianyuView();
    };
  }, [overlay, readStage]);

  const go = (action: 'back' | 'reload' | 'home') => {
    void window.sydney.xianyuViewGo(action).then(next => { setState(next); setError(''); }).catch(problem => setError(readableError(problem)));
  };

  return <section className="site-panel" aria-label="闲鱼">
    <div className="site-bar">
      <div className="site-actions">
        <button className="button button-quiet button-small" type="button" onClick={() => go('back')} disabled={!state?.canGoBack}><Icon name="undo" size={14} />后退</button>
        <button className="button button-quiet button-small" type="button" onClick={() => go('reload')}><Icon name="refresh" size={14} />刷新</button>
        <button className="button button-quiet button-small" type="button" onClick={() => go('home')}><Icon name="link" size={14} />回到闲鱼首页</button>
        <button className="button button-quiet button-small" type="button" onClick={() => void window.sydney.openXianyuInBrowser()}><Icon name="window" size={14} />在浏览器打开</button>
      </div>
    </div>
    {(error || state?.error) && <p className="site-error" role="alert"><Icon name="alert" size={14} /><span>{error || state?.error}</span></p>}
    <p className="site-meta">
      <span>当前页面</span>
      <strong>{state?.title || state?.url || '正在打开…'}</strong>
      {state?.loading && <span>载入中…</span>}
      {overlay && <span>弹层打开时先收起闲鱼页面</span>}
    </p>
    <div className="site-stage" ref={stageRef}>
      <p className="site-stage-hint">{state?.loading ? '正在打开闲鱼…' : '闲鱼页面正在接管这块区域'}</p>
    </div>
    <p className="site-privacy">页面由闲鱼提供，登录请在页面里扫码完成；应用不读它的 cookie，也不往页面里注入脚本。</p>
  </section>;
}
