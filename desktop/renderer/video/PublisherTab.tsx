import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  VideoProject,
  VideoPublishItemStatus,
  VideoPublishMode,
  VideoPublishPlatform,
  VideoPublishProgress,
  VideoPublishResult,
  VideoPublisherViewState
} from '../../shared';
import { VIDEO_PUBLISH_PLATFORMS } from '../../shared';
import { isRenderFresh } from '../../services/video-pipeline';
import { videoPublishCopy } from '../../services/video-publish-copy';
import { Icon, readableError, visibleStageBounds, type IconName } from '../ui';

const statusNames: Record<VideoPublishItemStatus, string> = {
  pending: '等待',
  uploading: '上传中',
  filling: '填写中',
  publishing: '提交中',
  draft: '已填草稿',
  published: '已发布',
  'needs-review': '需检查',
  failed: '失败'
};

const statusIcons: Record<VideoPublishItemStatus, IconName> = {
  pending: 'clock',
  uploading: 'cloud',
  filling: 'pen',
  publishing: 'arrowRight',
  draft: 'check',
  published: 'check',
  'needs-review': 'alert',
  failed: 'alert'
};

export function PublisherTab({
  project,
  overlay,
  notify
}: {
  project: VideoProject | null;
  overlay: boolean;
  notify: (message: string) => void;
}) {
  const [activePlatform, setActivePlatform] = useState<VideoPublishPlatform>('douyin');
  const [targets, setTargets] = useState<VideoPublishPlatform[]>(VIDEO_PUBLISH_PLATFORMS.map(item => item.value));
  const mode: VideoPublishMode = 'draft';
  const [viewState, setViewState] = useState<VideoPublisherViewState | null>(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<Partial<Record<VideoPublishPlatform, VideoPublishProgress>>>({});
  const [result, setResult] = useState<VideoPublishResult | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const activeMeta = VIDEO_PUBLISH_PLATFORMS.find(item => item.value === activePlatform)!;
  const copy = useMemo(() => (project ? videoPublishCopy(project, activePlatform) : null), [project, activePlatform]);
  const ready = Boolean(project && project.assets.video && isRenderFresh(project));

  const refresh = useCallback((platform = activePlatform) => {
    void window.sydney.getVideoPublisherView(platform).then(next => {
      if (next.platform === platform) setViewState(next);
    }).catch(() => undefined);
  }, [activePlatform]);

  useEffect(() => {
    refresh(activePlatform);
    const off = window.sydney.onVideoPublisherViewChanged(platform => {
      if (platform === activePlatform) refresh(platform);
      else setActivePlatform(platform);
    });
    return off;
  }, [activePlatform, refresh]);

  useEffect(() => window.sydney.onVideoPublishProgress(next => {
    setActivePlatform(next.platform);
    setProgress(current => ({ ...current, [next.platform]: next }));
  }), []);

  const readStage = useCallback(() => visibleStageBounds(stageRef.current), []);
  useEffect(() => {
    if (overlay) {
      void window.sydney.closeVideoPublisherView();
      return;
    }
    let alive = true;
    void window.sydney.openVideoPublisherView(activePlatform).then(next => {
      if (alive) setViewState(next);
    }).catch(error => notify(readableError(error)));
    const report = () => void window.sydney.setVideoPublisherViewBounds(readStage()).catch(() => undefined);
    report();
    const observer = new ResizeObserver(report);
    if (stageRef.current) observer.observe(stageRef.current);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    return () => {
      alive = false;
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
      void window.sydney.closeVideoPublisherView().catch(() => undefined);
    };
  }, [activePlatform, overlay, readStage, notify]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); } catch (error) { notify(readableError(error)); } finally { setBusy(''); }
  };

  const navigate = (kind: 'home' | 'creator' | 'upload') => void run('navigate', async () => {
    setViewState(await window.sydney.navigateVideoPublisherView(activePlatform, { kind }));
  });
  const go = (action: 'back' | 'reload') => void run('navigate', async () => {
    setViewState(await window.sydney.videoPublisherViewGo(activePlatform, action));
  });
  const openPlatform = (platform: VideoPublishPlatform) => {
    setActivePlatform(platform);
    setViewState(null);
  };
  const toggleTarget = (platform: VideoPublishPlatform) => {
    setTargets(current => current.includes(platform)
      ? current.filter(item => item !== platform)
      : [...current, platform]);
  };
  const publish = () => void run('publish', async () => {
    if (!project) throw new Error('请先在视频工作台选择一条视频');
    if (!targets.length) throw new Error('请至少勾选一个发布平台');
    setResult(null);
    setProgress(Object.fromEntries(targets.map(platform => [platform, {
      jobId: 'pending',
      projectId: project.id,
      platform,
      status: 'pending',
      message: '等待开始',
      at: new Date().toISOString()
    }])) as Partial<Record<VideoPublishPlatform, VideoPublishProgress>>);
    const next = await window.sydney.publishVideoToPlatforms(project.id, targets, mode);
    setResult(next);
    const published = next.items.filter(item => item.status === 'published').length;
    const drafts = next.items.filter(item => item.status === 'draft').length;
    const review = next.items.filter(item => item.status === 'needs-review').length;
    const failed = next.items.filter(item => item.status === 'failed').length;
    notify([
      published ? `${published} 个已发布` : '',
      drafts ? `${drafts} 个已填草稿` : '',
      review ? `${review} 个需检查` : '',
      failed ? `${failed} 个失败` : ''
    ].filter(Boolean).join('，') || '发布任务已结束');
  });

  return <section className="publisher-panel" aria-label="多平台视频发布">
    <div className="publisher-platform-tabs" role="tablist" aria-label="查看平台窗口">
      {VIDEO_PUBLISH_PLATFORMS.map(item => <button
        key={item.value}
        className={`publisher-platform-tab ${activePlatform === item.value ? 'is-active' : ''}`}
        type="button"
        role="tab"
        aria-selected={activePlatform === item.value}
        disabled={busy === 'publish' && activePlatform !== item.value}
        onClick={() => openPlatform(item.value)}
      >
        <span>{item.label}</span>
        {progress[item.value] && <small className={`publish-status publish-status-${progress[item.value]!.status}`}>{statusNames[progress[item.value]!.status]}</small>}
      </button>)}
    </div>

    <div className="site-bar publisher-toolbar" aria-label={`${activeMeta.label}发布窗口工具栏`}>
      <button className="button button-quiet button-small" type="button" disabled={busy !== '' || !viewState?.canGoBack} onClick={() => go('back')}><Icon name="undo" size={14} />后退</button>
      <button className="button button-quiet button-small" type="button" disabled={busy !== ''} onClick={() => go('reload')}><Icon name="refresh" size={14} />刷新</button>
      <button className="button button-quiet button-small" type="button" disabled={busy !== ''} onClick={() => navigate('home')}>{activeMeta.label}首页</button>
      <button className="button button-quiet button-small" type="button" disabled={busy !== ''} onClick={() => navigate('creator')}>创作者中心</button>
      <button className="button button-quiet button-small" type="button" disabled={busy !== ''} onClick={() => navigate('upload')}>发布视频</button>
      <span className="flow-spacer" />
      <button className="button button-secondary button-small" type="button" disabled={busy !== ''} onClick={() => void window.sydney.openVideoPublisherInBrowser(activePlatform)}>在浏览器打开</button>
    </div>

    <div className="publisher-action-card">
      <div className="publisher-project">
        <span className="eyebrow">当前成片</span>
        <strong>{project ? project.title || project.topic || '未命名视频' : '还没有选择视频任务'}</strong>
        <small>{ready ? `有效成片 · ${project?.assets.video?.path ?? ''}` : '先在视频工作台渲染一条有效成片'}</small>
      </div>
      <div className="publisher-targets" aria-label="本次发布平台">
        <span>发布到</span>
        {VIDEO_PUBLISH_PLATFORMS.map(item => <label key={item.value} className={targets.includes(item.value) ? 'is-checked' : ''}>
          <input type="checkbox" checked={targets.includes(item.value)} disabled={busy !== ''} onChange={() => toggleTarget(item.value)} />
          <span>{item.label}</span>
        </label>)}
      </div>
      <div className="publisher-run">
        <button className="button button-primary" type="button" disabled={busy !== '' || !ready || !targets.length} onClick={publish}>
          {busy === 'publish' ? '多平台处理中…' : `一键填草稿到 ${targets.length} 个平台`}
        </button>
      </div>
    </div>

    {copy && <div className="publisher-copy-preview">
      <div><span>标题 · {Array.from(copy.title).length} 字</span><strong>{copy.title}</strong></div>
      <div><span>描述 · {Array.from(copy.body).length} 字</span><p>{copy.body}</p></div>
    </div>}

    {Boolean(Object.keys(progress).length) && <ol className="publisher-results" aria-label="发布结果">
      {VIDEO_PUBLISH_PLATFORMS.filter(item => progress[item.value]).map(item => {
        const current = progress[item.value]!;
        return <li key={item.value} className={`publish-result publish-result-${current.status}`}>
          <Icon name={statusIcons[current.status]} size={15} />
          <div><strong>{item.label} · {statusNames[current.status]}</strong><span>{current.message}</span></div>
          {current.status === 'failed' || current.status === 'needs-review' ? <button type="button" className="button button-quiet button-small" onClick={() => openPlatform(item.value)}>查看页面</button> : null}
        </li>;
      })}
    </ol>}

    {(viewState?.error) && <p className="site-error" role="alert"><Icon name="alert" size={14} /><span>{viewState.error}</span></p>}
    <p className="site-meta">
      <span>{activeMeta.label}当前页面</span>
      <strong>{viewState?.title || viewState?.url || '正在打开…'}</strong>
      {viewState?.loading && <span>载入中…</span>}
      {result && <span>任务 {result.jobId.slice(0, 8)}</span>}
    </p>
    <div ref={stageRef} className="site-stage publisher-stage">
      <p className="site-stage-hint">{viewState?.loading ? `正在打开${activeMeta.label}…` : `${activeMeta.label}页面正在接管这块区域`}</p>
    </div>
    <p className="site-privacy">每个平台使用独立登录会话，请先在对应平台页签里扫码登录。工作台只上传成片并填写标题和简介，不会点击发布。</p>
  </section>;
}
