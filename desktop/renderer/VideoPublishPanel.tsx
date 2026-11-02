import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoPlatform, VideoPublishViewState } from '../shared';
import { Icon, readableError, visibleStageBounds } from './ui';

const LABELS: Record<Exclude<VideoPlatform, 'general'>, string> = {
  douyin: '抖音', shipinhao: '视频号', xiaohongshu: '小红书', bilibili: 'B 站'
};

export default function VideoPublishPanel({ platform, overlay = false }: { platform: Exclude<VideoPlatform, 'general'>; overlay?: boolean }) {
  const [state, setState] = useState<VideoPublishViewState | null>(null);
  const [error, setError] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);
  const label = LABELS[platform];

  useEffect(() => {
    let alive = true;
    setState(null);
    setError('');
    void window.sydney.getVideoPublishView(platform).then(next => { if (alive) setState(next); }).catch(problem => { if (alive) setError(readableError(problem)); });
    const off = window.sydney.onVideoPublishViewChanged(platform, () => {
      void window.sydney.getVideoPublishView(platform).then(next => { if (alive) setState(next); }).catch(problem => { if (alive) setError(readableError(problem)); });
    });
    return () => { alive = false; off(); };
  }, [platform]);

  const readStage = useCallback(() => visibleStageBounds(stageRef.current), []);
  useEffect(() => {
    if (overlay) {
      void window.sydney.closeVideoPublishView();
      return;
    }
    void window.sydney.openVideoPublishView(platform);
    const report = () => void window.sydney.setVideoPublishViewBounds(readStage());
    report();
    const observer = new ResizeObserver(report);
    if (stageRef.current) observer.observe(stageRef.current);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      void window.sydney.closeVideoPublishView();
    };
  }, [platform, overlay, readStage]);

  const go = (action: 'back' | 'reload' | 'home') => {
    void window.sydney.videoPublishViewGo(platform, action).then(next => { setState(next); setError(''); }).catch(problem => setError(readableError(problem)));
  };

  return <section className="site-panel video-publish-panel" aria-label={`${label}草稿页`}>
    <div className="site-bar">
      <div className="site-actions">
        <button className="button button-quiet button-small" type="button" onClick={() => go('back')} disabled={!state?.canGoBack}><Icon name="undo" size={14} />后退</button>
        <button className="button button-quiet button-small" type="button" onClick={() => go('reload')}><Icon name="refresh" size={14} />刷新</button>
        <button className="button button-quiet button-small" type="button" onClick={() => go('home')}><Icon name="link" size={14} />回到{label}发布页</button>
      </div>
    </div>
    {(error || state?.error) && <p className="site-error" role="alert"><Icon name="alert" size={14} /><span>{error || state?.error}</span></p>}
    <p className="site-meta"><span>当前页面</span><strong>{state?.title || state?.url || `正在打开${label}…`}</strong>{state?.loading && <span>载入中…</span>}</p>
    <div className="site-stage video-publish-stage" ref={stageRef}><p className="site-stage-hint">{state?.loading ? `正在打开${label}发布页…` : `${label}发布页正在接管这块区域`}</p></div>
    <p className="site-privacy">应用只上传视频并填写标题、简介，停在草稿页，不会点击发布。</p>
  </section>;
}
