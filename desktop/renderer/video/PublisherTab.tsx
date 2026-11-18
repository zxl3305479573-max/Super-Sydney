import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  VideoCoverRatio,
  VideoPlatformCopy,
  VideoProject,
  VideoPublishItemStatus,
  VideoPublishMode,
  VideoPublishPackView,
  VideoPublishPlatform,
  VideoPublishProgress,
  VideoPublishResult,
  VideoPublisherViewState
} from '../../shared';
import {
  COVER_RATIO_SPECS,
  OPS_STATE_LABELS,
  VIDEO_PUBLISH_PLATFORMS,
  isOpsStateLocked
} from '../../shared';
import { isRenderFresh } from '../../services/video-pipeline';
import {
  PLATFORM_COPY_RULES,
  charCount,
  composePlatformBody,
  validateVideoPublishPack
} from '../../services/video-publish-validate';
import { Icon, TagEditor, readableError, visibleStageBounds, type IconName } from '../ui';

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

const COVER_RATIOS: VideoCoverRatio[] = ['3:4', '4:3', '16:9', '9:16'];

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
  const [forceRefill, setForceRefill] = useState(false);
  const [packView, setPackView] = useState<VideoPublishPackView | null>(null);
  const [copiesDraft, setCopiesDraft] = useState<Record<VideoPublishPlatform, VideoPlatformCopy> | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState('');
  const [dirtyPack, setDirtyPack] = useState(false);
  const [viewState, setViewState] = useState<VideoPublisherViewState | null>(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<Partial<Record<VideoPublishPlatform, VideoPublishProgress>>>({});
  const [result, setResult] = useState<VideoPublishResult | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const activeMeta = VIDEO_PUBLISH_PLATFORMS.find(item => item.value === activePlatform)!;
  const ready = Boolean(project && project.assets.video && isRenderFresh(project));
  const hasCover = Boolean(project?.coverPath?.trim());

  const loadPack = useCallback(async (projectId: number) => {
    const next = await window.sydney.getVideoPublishPack(projectId);
    setPackView(next);
    setCopiesDraft(next.pack.copies);
    setScheduleDraft(next.pack.scheduledAt);
    setDirtyPack(false);
  }, []);

  useEffect(() => {
    if (!project) {
      setPackView(null);
      setCopiesDraft(null);
      setScheduleDraft('');
      setDirtyPack(false);
      return;
    }
    void loadPack(project.id).catch(error => notify(readableError(error)));
  }, [project?.id, project?.updatedAt, project?.coverPath, loadPack, notify]);

  useEffect(() => {
    if (!project) return;
    return window.sydney.onOpsChanged(() => {
      if (!dirtyPack) void loadPack(project.id).catch(() => undefined);
    });
  }, [project?.id, dirtyPack, loadPack]);

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

  const liveValidation = useMemo(() => {
    if (!copiesDraft) return packView?.validation ?? null;
    return validateVideoPublishPack(
      { copies: copiesDraft },
      { targetPlatforms: targets, faststart: packView?.validation.faststart ?? null }
    );
  }, [copiesDraft, targets, packView?.validation]);

  const taskByPlatform = useMemo(() => {
    const map = new Map<VideoPublishPlatform, NonNullable<VideoPublishPackView['episode']>['tasks'][number]>();
    for (const t of packView?.episode?.tasks ?? []) map.set(t.platform, t);
    return map;
  }, [packView?.episode]);

  const activeCopy = copiesDraft?.[activePlatform] ?? null;
  const activeRule = PLATFORM_COPY_RULES[activePlatform];
  const activeFullBody = activeCopy ? composePlatformBody(activeCopy) : '';
  const activeTask = taskByPlatform.get(activePlatform);

  const patchActiveCopy = (patch: Partial<VideoPlatformCopy>) => {
    if (!copiesDraft) return;
    setCopiesDraft({
      ...copiesDraft,
      [activePlatform]: { ...copiesDraft[activePlatform], ...patch }
    });
    setDirtyPack(true);
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); } catch (error) { notify(readableError(error)); } finally { setBusy(''); }
  };

  const savePack = async () => {
    if (!project || !copiesDraft) return;
    const saved = await window.sydney.saveVideoPublishPack(project.id, {
      scheduledAt: scheduleDraft,
      copies: copiesDraft
    });
    setPackView(saved);
    setCopiesDraft(saved.pack.copies);
    setScheduleDraft(saved.pack.scheduledAt);
    setDirtyPack(false);
  };

  const generateAiPack = () => void run('ai-pack', async () => {
    if (!project) return;
    if (dirtyPack) await savePack();
    const next = await window.sydney.generateVideoPublishPack(project.id);
    setPackView(next);
    setCopiesDraft(next.pack.copies);
    setDirtyPack(false);
    notify('已按四平台调性生成差异化标题、正文与话题标签');
  });

  const deriveCovers = () => void run('variants', async () => {
    if (!project) return;
    const next = await window.sydney.generateVideoCoverVariants(project.id);
    setPackView(next);
    notify(`已生成 ${next.coverVariants.length} 张多比例衍生封面`);
  });

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
    if (dirtyPack) await savePack();

    setResult(null);
    setProgress(Object.fromEntries(targets.map(platform => [platform, {
      jobId: 'pending',
      projectId: project.id,
      platform,
      status: 'pending',
      message: '等待开始',
      at: new Date().toISOString()
    }])) as Partial<Record<VideoPublishPlatform, VideoPublishProgress>>);

    const mode: VideoPublishMode = forceRefill ? 'draft-force' : 'draft';
    const next = await window.sydney.publishVideoToPlatforms(project.id, targets, mode);
    setResult(next);
    await loadPack(project.id);
    setForceRefill(false);

    const lockedCount = next.items.filter(item => item.locked).length;
    const drafts = next.items.filter(item => item.status === 'draft' && !item.locked).length;
    const failed = next.items.filter(item => item.status === 'failed').length;
    notify([
      drafts ? `${drafts} 个平台已填好草稿（请手动点发布）` : '',
      lockedCount ? `${lockedCount} 个防重保护跳过` : '',
      failed ? `${failed} 个失败` : ''
    ].filter(Boolean).join('，') || '发布任务已结束');
  });

  const blockingErrors = liveValidation?.issues.filter(i => i.level === 'error') ?? [];
  const warnings = liveValidation?.issues.filter(i => i.level === 'warn') ?? [];

  return <section className="publisher-panel" aria-label="多平台视频发布">
    <div className="publisher-platform-tabs" role="tablist" aria-label="查看平台窗口">
      {VIDEO_PUBLISH_PLATFORMS.map(item => {
        const task = taskByPlatform.get(item.value);
        const locked = isOpsStateLocked(task?.state);
        return <button
          key={item.value}
          className={`publisher-platform-tab ${activePlatform === item.value ? 'is-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activePlatform === item.value}
          disabled={busy === 'publish' && activePlatform !== item.value}
          onClick={() => openPlatform(item.value)}
        >
          <span>{item.label}</span>
          {locked && <small className="publish-lock-pill" title={`防重状态：${OPS_STATE_LABELS[task!.state]}`}>🔒 {OPS_STATE_LABELS[task!.state]}</small>}
          {!locked && progress[item.value] && <small className={`publish-status publish-status-${progress[item.value]!.status}`}>{statusNames[progress[item.value]!.status]}</small>}
        </button>;
      })}
    </div>

    {project && activeCopy && <div className="publisher-pack-card">
      <header className="publisher-pack-head">
        <div>
          <span className="eyebrow">多平台差异化发布包 · {activeMeta.label}</span>
          <h4>专属文案、封面比例与排期门禁</h4>
        </div>
        <div className="publisher-pack-actions">
          <button type="button" className="button button-secondary button-small" disabled={busy !== ''} onClick={generateAiPack}>
            <Icon name="wand" size={14} />{busy === 'ai-pack' ? 'AI 编写中…' : 'AI 生成四平台文案'}
          </button>
          <button type="button" className="button button-secondary button-small" disabled={busy !== '' || !hasCover} title={hasCover ? '用高斯模糊补边一次生成 3:4 / 4:3 / 16:9 衍生封面' : '请先在封面步骤设置主封面'} onClick={deriveCovers}>
            <Icon name="image" size={14} />{busy === 'variants' ? '衍生封面中…' : '生成多比例封面'}
          </button>
          <button type="button" className="button button-primary button-small" disabled={busy !== '' || !dirtyPack} onClick={() => void run('save-pack', async () => { await savePack(); notify('发布包已保存并同步到运营日历'); })}>
            {busy === 'save-pack' ? '保存中…' : dirtyPack ? '保存修改' : '已保存'}
          </button>
        </div>
      </header>

      <div className="publisher-pack-grid">
        <label className="publisher-field publisher-field-wide">
          <span>
            {activeMeta.label}标题（{charCount(activeCopy.title)} / {activeRule.minTitle > 1 ? `${activeRule.minTitle}–` : ''}{activeRule.maxTitle} 字）
          </span>
          <input
            value={activeCopy.title}
            disabled={busy !== ''}
            onChange={e => patchActiveCopy({ title: e.target.value })}
            placeholder={activePlatform === 'shipinhao' ? '视频号短标题要求 6–16 字' : `输入${activeMeta.label}专属标题`}
          />
        </label>

        <label className="publisher-field">
          <span>封面比例</span>
          <select
            value={activeCopy.coverRatio}
            disabled={busy !== ''}
            onChange={e => patchActiveCopy({ coverRatio: e.target.value as VideoCoverRatio })}
          >
            {COVER_RATIOS.map(r => <option key={r} value={r}>{COVER_RATIO_SPECS[r].label}</option>)}
          </select>
        </label>

        <label className="publisher-field">
          <span>计划排期时间（同步至运营日历）</span>
          <input
            value={scheduleDraft}
            disabled={busy !== ''}
            onChange={e => { setScheduleDraft(e.target.value); setDirtyPack(true); }}
            placeholder="如 2026-11-20 18:00（留空为随时发）"
          />
        </label>

        <label className="publisher-field publisher-field-full">
          <span>{activeMeta.label}正文描述（含话题共 {charCount(activeFullBody)} / {activeRule.maxBody} 字）</span>
          <textarea
            rows={4}
            value={activeCopy.body}
            disabled={busy !== ''}
            onChange={e => patchActiveCopy({ body: e.target.value })}
            placeholder={`输入${activeMeta.label}描述…`}
          />
        </label>

        <div className="publisher-field publisher-field-full">
          <span>话题标签（最多建议 {activeRule.maxTags} 个，回车添加，自动附在正文末尾）</span>
          <TagEditor
            values={activeCopy.tags}
            onChange={tags => patchActiveCopy({ tags })}
            placeholder="输入话题词（无需输入 #）回车添加"
          />
        </div>
      </div>

      {Boolean(packView?.coverVariants.length) && <div className="publisher-variants-strip">
        {packView!.coverVariants.map(v => <div key={v.ratio} className={`publisher-variant-item ${activeCopy.coverRatio === v.ratio ? 'is-selected' : ''}`} onClick={() => patchActiveCopy({ coverRatio: v.ratio })}>
          <img src={v.thumbnail} alt={v.label} />
          <span>{v.ratio}</span>
        </div>)}
      </div>}

      {liveValidation && <div className={`publisher-validation ${!liveValidation.ok ? 'is-error' : warnings.length ? 'is-warn' : 'is-ok'}`}>
        <div className="publisher-validation-summary">
          <Icon name={!liveValidation.ok ? 'alert' : 'check'} size={14} />
          <strong>
            {!liveValidation.ok
              ? `存在 ${blockingErrors.length} 项硬性校验未通过（阻止上传）`
              : warnings.length
                ? `硬校验通过，有 ${warnings.length} 条防限流建议`
                : '文案字数、防引流规则与 MP4 faststart 校验全部通过'}
          </strong>
          {liveValidation.faststart === true && <span className="badge badge-on">faststart ✓</span>}
          {liveValidation.faststart === false && <span className="badge badge-error">缺少 faststart</span>}
        </div>
        {(blockingErrors.length > 0 || warnings.length > 0) && <ul>
          {[...blockingErrors, ...warnings].map((issue, idx) => <li key={`${issue.code}-${idx}`} className={`is-${issue.level}`}>
            {issue.message}
          </li>)}
        </ul>}
      </div>}

      {activeTask && <div className="publisher-task-meta">
        <span>当前平台状态：<strong>{OPS_STATE_LABELS[activeTask.state]}</strong></span>
        {activeTask.postUrl && <button type="button" className="button button-quiet button-small" onClick={() => void window.sydney.openXhsLink(activeTask.postUrl)}><Icon name="link" size={13} />查看线上作品</button>}
      </div>}
    </div>}

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
        <label className={`publisher-force-toggle ${forceRefill ? 'is-checked' : ''}`} title="默认跳过已填过草稿或已发布的平台，防止同一视频重复上传触发风控">
          <input type="checkbox" checked={forceRefill} disabled={busy !== ''} onChange={e => setForceRefill(e.target.checked)} />
          <span>强制重填已锁定平台</span>
        </label>
      </div>
      <div className="publisher-run">
        <button className="button button-primary" type="button" disabled={busy !== '' || !ready || !targets.length || blockingErrors.length > 0} onClick={publish}>
          {busy === 'publish' ? '多平台处理中…' : `一键填草稿到 ${targets.length} 个平台`}
        </button>
      </div>
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

    {Boolean(Object.keys(progress).length) && <ol className="publisher-results" aria-label="发布结果">
      {VIDEO_PUBLISH_PLATFORMS.filter(item => progress[item.value]).map(item => {
        const current = progress[item.value]!;
        return <li key={item.value} className={`publish-result publish-result-${current.status}`}>
          <Icon name={statusIcons[current.status]} size={15} />
          <div><strong>{item.label} · {statusNames[current.status]}</strong><span>{current.message}</span></div>
          {current.status === 'failed' || current.status === 'needs-review' || current.status === 'draft' ? <button type="button" className="button button-quiet button-small" onClick={() => openPlatform(item.value)}>查看页面</button> : null}
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
    <p className="site-privacy">每个平台使用独立登录会话，工作台只上传成片/封面并填入专属标题与描述（自动开启防重复上传锁），最后一下「发布」始终交由你手动确认。</p>
  </section>;
}
