import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
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
import { formatDuration, isRenderFresh } from '../../services/video-pipeline';
import {
  PLATFORM_COPY_RULES,
  charCount,
  composePlatformBody,
  validateVideoPublishPack
} from '../../services/video-publish-validate';
import { Dropzone, Icon, TagEditor, readableError, visibleStageBounds, type IconName } from '../ui';

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
const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'];
const COVER_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const COPY_EXTS = ['txt', 'md', 'markdown'];

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function hasAllowedExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some(ext => lower.endsWith(`.${ext}`));
}

export function PublisherTab({
  project,
  overlay,
  notify,
  onProjectUpserted
}: {
  project: VideoProject | null;
  overlay: boolean;
  notify: (message: string) => void;
  onProjectUpserted: (project: VideoProject, select?: boolean) => void;
}) {
  const [activePlatform, setActivePlatform] = useState<VideoPublishPlatform>('douyin');
  const [targets, setTargets] = useState<VideoPublishPlatform[]>(VIDEO_PUBLISH_PLATFORMS.map(item => item.value));
  const [forceRefill, setForceRefill] = useState(false);
  const [packView, setPackView] = useState<VideoPublishPackView | null>(null);
  const [copiesDraft, setCopiesDraft] = useState<Record<VideoPublishPlatform, VideoPlatformCopy> | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState('');
  const [neutralCopyDraft, setNeutralCopyDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [dirtyPack, setDirtyPack] = useState(false);
  const [dirtyTitle, setDirtyTitle] = useState(false);
  const [showVideoPreview, setShowVideoPreview] = useState(false);
  const [copyDropActive, setCopyDropActive] = useState(false);
  const [viewState, setViewState] = useState<VideoPublisherViewState | null>(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<Partial<Record<VideoPublishPlatform, VideoPublishProgress>>>({});
  const [result, setResult] = useState<VideoPublishResult | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const activeMeta = VIDEO_PUBLISH_PLATFORMS.find(item => item.value === activePlatform)!;
  const isDirectUpload = project?.options.workflow === 'direct-upload';
  const ready = Boolean(project && project.assets.video && isRenderFresh(project));
  const hasCover = Boolean(project?.coverPath?.trim());

  const applyPackView = useCallback((next: VideoPublishPackView) => {
    setPackView(next);
    setCopiesDraft(next.pack.copies);
    setScheduleDraft(next.pack.scheduledAt);
    setNeutralCopyDraft(next.pack.neutralCopy);
    setDirtyPack(false);
  }, []);

  const loadPack = useCallback(async (projectId: number) => {
    const next = await window.sydney.getVideoPublishPack(projectId);
    applyPackView(next);
  }, [applyPackView]);

  useEffect(() => {
    setShowVideoPreview(false);
    setProgress({});
    setResult(null);
    if (!project) {
      setPackView(null);
      setCopiesDraft(null);
      setScheduleDraft('');
      setDirtyPack(false);
      setDirtyTitle(false);
      return;
    }
    setTitleDraft(project.title);
    setDirtyTitle(false);
    void loadPack(project.id).catch(error => notify(readableError(error)));
  }, [project?.id, loadPack, notify]);

  // 同一项目在外部更新封面、成片或标题时刷新发布包视图（不冲掉用户未保存的编辑）。
  useEffect(() => {
    if (!project) return;
    if (!dirtyTitle) setTitleDraft(project.title);
    if (!dirtyPack) {
      void loadPack(project.id).catch(() => undefined);
    }
  }, [project?.updatedAt, project?.coverPath, project?.assets.video?.renderedAt]);

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
    if (panelRef.current) observer.observe(panelRef.current);
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

  const platformErrorCount = useMemo(() => {
    const counts = new Map<VideoPublishPlatform, number>();
    for (const issue of liveValidation?.issues ?? []) {
      if (issue.level !== 'error' || issue.platform === 'global') continue;
      counts.set(issue.platform, (counts.get(issue.platform) ?? 0) + 1);
    }
    return counts;
  }, [liveValidation]);

  const taskByPlatform = useMemo(() => {
    const map = new Map<VideoPublishPlatform, NonNullable<VideoPublishPackView['episode']>['tasks'][number]>();
    for (const t of packView?.episode?.tasks ?? []) map.set(t.platform, t);
    return map;
  }, [packView?.episode]);

  const activeCopy = copiesDraft?.[activePlatform] ?? null;
  const activeRule = PLATFORM_COPY_RULES[activePlatform];
  const activeFullBody = activeCopy ? composePlatformBody(activeCopy) : '';
  const activeTask = taskByPlatform.get(activePlatform);
  const canGenerateCopy = Boolean(
    neutralCopyDraft.trim() || titleDraft.trim() || project?.script.trim() || project?.topic.trim()
  );

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

  /** 若当前没有选中项目，先自动新建一个直发任务，让用户先传封面或先写中性文案都不丢内容。 */
  const ensureProject = async (): Promise<VideoProject> => {
    if (project) return project;
    const created = await window.sydney.createDirectUploadProject(titleDraft.trim());
    onProjectUpserted(created, true);
    return created;
  };

  const persistAll = async (targetProject?: VideoProject): Promise<{ savedProject: VideoProject; savedPackView: VideoPublishPackView }> => {
    let current = targetProject ?? await ensureProject();
    if (dirtyTitle && titleDraft !== current.title) {
      current = await window.sydney.updateVideoProject(current.id, { title: titleDraft });
      onProjectUpserted(current, false);
      setDirtyTitle(false);
    }
    const savedPackView = await window.sydney.saveVideoPublishPack(current.id, {
      scheduledAt: scheduleDraft,
      neutralCopy: neutralCopyDraft,
      ...(copiesDraft ? { copies: copiesDraft } : {})
    });
    applyPackView(savedPackView);
    return { savedProject: current, savedPackView };
  };

  const attachVideoFile = (filePath: string, createNew: boolean) => void run('upload-video', async () => {
    const targetId = !createNew && project?.options.workflow === 'direct-upload' ? project.id : null;
    const seedTitle = targetId || !project ? titleDraft.trim() : '';
    const res = await window.sydney.attachDirectUploadVideo(targetId, filePath, seedTitle);
    onProjectUpserted(res.project, true);
    setTitleDraft(res.project.title);
    setDirtyTitle(false);
    // 若用户先在空白状态下写了中性文案，随后上传第一个视频，把刚写好的中性文案一并保留下来。
    if (!project && neutralCopyDraft.trim() && !res.packView.pack.neutralCopy.trim()) {
      const savedPack = await window.sydney.saveVideoPublishPack(res.project.id, { neutralCopy: neutralCopyDraft });
      applyPackView(savedPack);
    } else {
      applyPackView(res.packView);
    }
    notify(res.notice || `已上传本地视频「${res.packView.videoMeta?.fileName ?? res.project.title}」`);
  });

  const pickAndAttachVideo = (createNew: boolean) => void run('upload-video', async () => {
    const picked = await window.sydney.pickDirectUploadVideo();
    if (!picked) return;
    const targetId = !createNew && project?.options.workflow === 'direct-upload' ? project.id : null;
    const seedTitle = targetId || !project ? titleDraft.trim() : '';
    const res = await window.sydney.attachDirectUploadVideo(targetId, picked, seedTitle);
    onProjectUpserted(res.project, true);
    setTitleDraft(res.project.title);
    setDirtyTitle(false);
    if (!project && neutralCopyDraft.trim() && !res.packView.pack.neutralCopy.trim()) {
      const savedPack = await window.sydney.saveVideoPublishPack(res.project.id, { neutralCopy: neutralCopyDraft });
      applyPackView(savedPack);
    } else {
      applyPackView(res.packView);
    }
    notify(res.notice || `已上传本地视频「${res.packView.videoMeta?.fileName ?? res.project.title}」`);
  });

  const attachCoverFile = (filePath: string) => void run('upload-cover', async () => {
    const target = await ensureProject();
    const res = await window.sydney.attachDirectUploadCover(target.id, filePath);
    onProjectUpserted(res.project, false);
    applyPackView(res.packView);
    notify('已上传封面图片，发布时将自动生成各平台所需比例封面');
  });

  const pickAndAttachCover = () => void run('upload-cover', async () => {
    const picked = await window.sydney.pickDirectUploadCover();
    if (!picked) return;
    const target = await ensureProject();
    const res = await window.sydney.attachDirectUploadCover(target.id, picked);
    onProjectUpserted(res.project, false);
    applyPackView(res.packView);
    notify('已上传封面图片，发布时将自动生成各平台所需比例封面');
  });

  const importNeutralCopy = (filePath?: string) => void run('import-copy', async () => {
    const imported = await window.sydney.importDirectUploadCopy(filePath);
    if (!imported) return;
    setNeutralCopyDraft(imported.text);
    setDirtyPack(true);
    notify(`已导入中性文案（${charCount(imported.text)} 字）`);
  });

  const handleNeutralCopyDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    setCopyDropActive(false);
    if (busy !== '') return;
    const file = [...event.dataTransfer.files].find(item => hasAllowedExtension(item.name, COPY_EXTS));
    if (!file) {
      notify('仅支持拖入 TXT 或 MD 文案文件');
      return;
    }
    const filePath = window.sydney.filePath(file);
    if (filePath) importNeutralCopy(filePath);
  };

  const handleSlotFileDrop = (
    event: DragEvent<HTMLDivElement>,
    kind: 'video' | 'cover',
    createNewVideo = false
  ) => {
    event.preventDefault();
    if (busy !== '') return;
    const exts = kind === 'video' ? VIDEO_EXTS : COVER_EXTS;
    const file = [...event.dataTransfer.files].find(item => hasAllowedExtension(item.name, exts));
    if (!file) {
      notify(kind === 'video' ? '请拖入 MP4 / MOV / MKV / WebM / M4V 视频文件' : '请拖入 PNG / JPG / WebP 封面图片');
      return;
    }
    const filePath = window.sydney.filePath(file);
    if (!filePath) return;
    if (kind === 'video') attachVideoFile(filePath, createNewVideo);
    else attachCoverFile(filePath);
  };

  const generateAiPack = () => void run('ai-pack', async () => {
    if (!canGenerateCopy) throw new Error('请先输入中性文案或填写基础标题');
    const { savedProject } = await persistAll();
    const next = await window.sydney.generateVideoPublishPack(savedProject.id);
    applyPackView(next);
    // 若直发任务原本没有标题、主进程按生成结果补全了标题，同步回列表。
    const refreshed = (await window.sydney.listVideoProjects()).find(item => item.id === savedProject.id);
    if (refreshed) {
      onProjectUpserted(refreshed, false);
      setTitleDraft(refreshed.title);
      setDirtyTitle(false);
    }
    notify('已按中性文案为抖音、微信视频号、小红书、B 站生成专属文案');
  });

  const deriveCovers = () => void run('variants', async () => {
    if (!project) return;
    const next = await window.sydney.generateVideoCoverVariants(project.id);
    setPackView(next);
    notify(`已生成 ${next.coverVariants.length} 张多比例衍生封面（3:4 / 4:3 / 16:9 / 9:16）`);
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

  const executePublish = async (projectId: number) => {
    setResult(null);
    setProgress(Object.fromEntries(targets.map(platform => [platform, {
      jobId: 'pending',
      projectId,
      platform,
      status: 'pending',
      message: '等待开始',
      at: new Date().toISOString()
    }])) as Partial<Record<VideoPublishPlatform, VideoPublishProgress>>);

    const mode: VideoPublishMode = forceRefill ? 'draft-force' : 'draft';
    const next = await window.sydney.publishVideoToPlatforms(projectId, targets, mode);
    setResult(next);
    await loadPack(projectId);
    setForceRefill(false);

    const lockedCount = next.items.filter(item => item.locked).length;
    const drafts = next.items.filter(item => item.status === 'draft' && !item.locked).length;
    const failed = next.items.filter(item => item.status === 'failed').length;
    notify([
      drafts ? `${drafts} 个平台已自动上传并填好草稿（请核对后手动点发布）` : '',
      lockedCount ? `${lockedCount} 个防重保护跳过` : '',
      failed ? `${failed} 个失败` : ''
    ].filter(Boolean).join('，') || '发布任务已结束');
  };

  const publish = () => void run('publish', async () => {
    if (!project) throw new Error('请先上传或选择一条视频');
    if (!targets.length) throw new Error('请至少勾选一个发布平台');
    if (dirtyPack || dirtyTitle) await persistAll(project);
    await executePublish(project.id);
  });

  /** 一键联动：保存中性文案 → AI 生成四平台专属文案 → 硬校验 → 自动上传视频/封面并填好四平台草稿。 */
  const generateAndPublishAll = () => void run('auto-pipeline', async () => {
    if (!project || !ready) throw new Error('请先上传本地视频或渲染有效成片');
    if (!targets.length) throw new Error('请至少勾选一个发布平台');
    if (!canGenerateCopy) throw new Error('请先填写或导入中性文案');

    const { savedProject } = await persistAll(project);
    notify('正在按中性文案生成四平台专属文案…');
    const generatedView = await window.sydney.generateVideoPublishPack(savedProject.id);
    applyPackView(generatedView);

    const refreshed = (await window.sydney.listVideoProjects()).find(item => item.id === savedProject.id);
    if (refreshed) {
      onProjectUpserted(refreshed, false);
      setTitleDraft(refreshed.title);
      setDirtyTitle(false);
    }

    const check = validateVideoPublishPack(generatedView.pack, {
      targetPlatforms: targets,
      faststart: generatedView.validation.faststart
    });
    if (!check.ok) {
      const firstError = check.issues.find(item => item.level === 'error');
      throw new Error(`四平台文案已生成，但存在硬校验项需处理：${firstError?.message ?? '请查看下方校验提示'}`);
    }

    notify('四平台文案已就绪，开始自动上传视频、封面并填入各平台草稿…');
    await executePublish(savedProject.id);
  });

  const blockingErrors = liveValidation?.issues.filter(i => i.level === 'error') ?? [];
  const warnings = liveValidation?.issues.filter(i => i.level === 'warn') ?? [];

  return <section ref={panelRef} className="publisher-panel" aria-label="上传与多平台视频分发">
    {/* ── Step 1: 上传本地视频 · 封面 · 中性文案 ───────────────────────── */}
    <div className="publisher-direct-card">
      <header className="publisher-pack-head">
        <div>
          <span className="eyebrow">Step 1 · 本地上传与中性文案</span>
          <h4>上传视频、封面与中性文案，自动生成四平台专属文案并分发</h4>
        </div>
        <div className="publisher-pack-actions">
          <button type="button" className="button button-primary button-small" disabled={busy !== ''} onClick={() => pickAndAttachVideo(true)}>
            <Icon name="upload" size={14} />{busy === 'upload-video' ? '处理视频中…' : '上传新视频直发'}
          </button>
          <button
            type="button"
            className="button button-secondary button-small"
            disabled={busy !== ''}
            onClick={() => void run('create-direct', async () => {
              const created = await window.sydney.createDirectUploadProject('');
              onProjectUpserted(created, true);
              notify('已新建空白上传直发任务，可拖入视频、封面并填写中性文案');
            })}
          >
            <Icon name="plus" size={14} />新建空白直发
          </button>
        </div>
      </header>

      <div className="publisher-direct-grid">
        {/* 左栏：视频文件 + 封面图片 */}
        <div className="publisher-media-col">
          <div
            className="publisher-media-slot"
            onDragOver={event => { event.preventDefault(); }}
            onDrop={event => handleSlotFileDrop(event, 'video', !isDirectUpload)}
          >
            <div className="publisher-media-slot-head">
              <strong>1. 上传视频</strong>
              {ready && packView?.videoMeta ? (
                <span className={liveValidation?.faststart === false ? 'badge badge-error' : 'badge badge-on'}>
                  {liveValidation?.faststart === false ? '缺少 faststart' : '成片就绪 · faststart ✓'}
                </span>
              ) : (
                <span className="badge badge-idle">待上传视频</span>
              )}
            </div>

            {ready && packView?.videoMeta && project ? (
              <div className="publisher-video-ready">
                <div className="publisher-video-meta-row">
                  <Icon name="video" size={18} />
                  <div className="publisher-video-meta-text">
                    <strong title={packView.videoMeta.path}>{packView.videoMeta.fileName}</strong>
                    <small>
                      {formatDuration(packView.videoMeta.seconds)} · {formatFileSize(packView.videoMeta.sizeBytes)}
                      {isDirectUpload ? ' · 本地直发视频' : ' · 工作台渲染成片'}
                    </small>
                  </div>
                </div>
                {showVideoPreview && (
                  <div className="publisher-inline-video">
                    <video
                      key={`${project.id}-${project.assets.video?.renderedAt ?? ''}`}
                      controls
                      preload="metadata"
                      src={`sydney-video://project/${project.id}?sig=${encodeURIComponent(project.assets.video?.signature ?? '')}`}
                    />
                  </div>
                )}
                <div className="publisher-media-actions">
                  <button type="button" className="button button-quiet button-small" disabled={busy !== ''} onClick={() => setShowVideoPreview(open => !open)}>
                    <Icon name="play" size={13} />{showVideoPreview ? '收起预览' : '试看视频'}
                  </button>
                  {isDirectUpload ? (
                    <button type="button" className="button button-secondary button-small" disabled={busy !== ''} onClick={() => pickAndAttachVideo(false)}>
                      <Icon name="upload" size={13} />更换视频
                    </button>
                  ) : (
                    <button type="button" className="button button-secondary button-small" disabled={busy !== ''} onClick={() => pickAndAttachVideo(true)}>
                      <Icon name="upload" size={13} />上传新本地视频
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <Dropzone
                extensions={VIDEO_EXTS}
                disabled={busy !== ''}
                title="点击选择或拖入本地视频"
                hint="支持 MP4 / MOV / MKV / WebM / M4V，自动 faststart 封装"
                onBrowse={() => pickAndAttachVideo(!isDirectUpload)}
                onFiles={paths => { if (paths[0]) attachVideoFile(paths[0], !isDirectUpload); }}
              />
            )}
          </div>

          <div
            className="publisher-media-slot"
            onDragOver={event => { event.preventDefault(); }}
            onDrop={event => handleSlotFileDrop(event, 'cover')}
          >
            <div className="publisher-media-slot-head">
              <strong>2. 上传封面</strong>
              <span className={hasCover ? 'badge badge-on' : 'badge badge-idle'}>
                {hasCover ? '已上传主封面' : '可选 · 建议上传'}
              </span>
            </div>

            {hasCover && packView?.coverThumbnail ? (
              <div className="publisher-cover-ready">
                <img src={packView.coverThumbnail} alt="已上传的视频主封面" />
                <div className="publisher-cover-ready-info">
                  <small title={project?.coverPath}>{project?.coverPath.split(/[\\/]/).pop()}</small>
                  <div className="publisher-media-actions">
                    <button type="button" className="button button-secondary button-small" disabled={busy !== ''} onClick={pickAndAttachCover}>
                      <Icon name="image" size={13} />更换封面
                    </button>
                    <button type="button" className="button button-quiet button-small" disabled={busy !== '' || !project} onClick={deriveCovers}>
                      {busy === 'variants' ? '衍生中…' : '生成四比例封面'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <Dropzone
                extensions={COVER_EXTS}
                disabled={busy !== ''}
                title="点击选择或拖入封面图"
                hint="支持 PNG / JPG / WebP，分发时自动衍生 3:4 / 4:3 / 16:9 / 9:16"
                onBrowse={pickAndAttachCover}
                onFiles={paths => { if (paths[0]) attachCoverFile(paths[0]); }}
              />
            )}
          </div>
        </div>

        {/* 右栏：基础标题 + 中性文案 + 一键改写/分发 */}
        <div className="publisher-neutral-col">
          <label className="publisher-field">
            <span>视频基础标题 / 主题（可选，留空由 AI 根据中性文案自动拟定各平台标题）</span>
            <input
              value={titleDraft}
              disabled={busy !== ''}
              onChange={event => { setTitleDraft(event.target.value); setDirtyTitle(true); }}
              placeholder="例如：3 分钟搭好本地 AI 效率工作台"
            />
          </label>

          <div className="publisher-field publisher-neutral-box">
            <div className="publisher-neutral-head">
              <span>3. 中性文案（讲清视频核心内容、卖点与受众，不限平台口吻 · {charCount(neutralCopyDraft)} 字）</span>
              <div className="publisher-neutral-tools">
                <button type="button" className="button button-quiet button-small" disabled={busy !== ''} onClick={() => importNeutralCopy()}>
                  <Icon name="file" size={13} />{busy === 'import-copy' ? '导入中…' : '导入 .txt / .md'}
                </button>
                {project?.script.trim() && !neutralCopyDraft.trim() && (
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    disabled={busy !== ''}
                    onClick={() => { setNeutralCopyDraft(project.script); setDirtyPack(true); }}
                  >
                    填入项目口播稿
                  </button>
                )}
              </div>
            </div>
            <textarea
              rows={7}
              className={copyDropActive ? 'is-drop-active' : ''}
              value={neutralCopyDraft}
              disabled={busy !== ''}
              onChange={event => { setNeutralCopyDraft(event.target.value); setDirtyPack(true); }}
              onDragOver={event => { event.preventDefault(); if (busy === '') setCopyDropActive(true); }}
              onDragLeave={() => setCopyDropActive(false)}
              onDrop={handleNeutralCopyDrop}
              placeholder={'输入、粘贴或拖入 .txt / .md 中性文案。\n\n例如：本期演示了如何用本地工具把一条视频自动整理成抖音、视频号、小红书和 B 站四个平台的原生文案并批量填入草稿。适合自媒体创作者和独立开发者，重点强调省时、不踩引流红线、数据留在本地。'}
            />
          </div>

          <div className="publisher-direct-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy !== '' || !canGenerateCopy}
              onClick={generateAiPack}
            >
              <Icon name="wand" size={14} />{busy === 'ai-pack' ? 'AI 改写四平台文案中…' : 'AI 按中性文案生成四平台文案'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy !== '' || !ready || !targets.length || !canGenerateCopy}
              title={!ready ? '请先在左侧上传视频或选择已有有效成片' : '按中性文案自动写好四平台文案后，直接依次上传视频、封面并填入各平台草稿'}
              onClick={generateAndPublishAll}
            >
              <Icon name="send" size={14} />{busy === 'auto-pipeline' ? '生成并分发中…' : `一键生成文案并分发到 ${targets.length} 个平台`}
            </button>
            {(dirtyPack || dirtyTitle) && project && (
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={busy !== ''}
                onClick={() => void run('save-pack', async () => { await persistAll(project); notify('已保存标题与中性文案'); })}
              >
                {busy === 'save-pack' ? '保存中…' : '保存当前输入'}
              </button>
            )}
          </div>
          <p className="publisher-direct-hint">
            AI 会自动按抖音（短句强钩子）、微信视频号（6–16 字短标题+熟人转发体）、小红书（真诚分享体）、B 站（信息量完整简介）分别改写并规避引流词；分发时自动上传视频与对应比例封面，填好草稿后由你在下方平台窗口人工确认最终发布。
          </p>
        </div>
      </div>
    </div>

    {/* ── Step 2: 四平台差异化发布包 ───────────────────────────────────── */}
    <div className="publisher-platform-tabs" role="tablist" aria-label="查看平台窗口">
      {VIDEO_PUBLISH_PLATFORMS.map(item => {
        const task = taskByPlatform.get(item.value);
        const locked = isOpsStateLocked(task?.state);
        const errCount = platformErrorCount.get(item.value) ?? 0;
        return <button
          key={item.value}
          className={`publisher-platform-tab ${activePlatform === item.value ? 'is-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activePlatform === item.value}
          disabled={(busy === 'publish' || busy === 'auto-pipeline') && activePlatform !== item.value}
          onClick={() => openPlatform(item.value)}
        >
          <span>{item.label}</span>
          <span className="publisher-tab-badges">
            {errCount > 0 && <small className="publish-status publish-status-error" title={`该平台有 ${errCount} 项校验未通过`}>! {errCount}</small>}
            {locked && <small className="publish-lock-pill" title={`防重状态：${OPS_STATE_LABELS[task!.state]}`}>🔒 {OPS_STATE_LABELS[task!.state]}</small>}
            {!locked && progress[item.value] && <small className={`publish-status publish-status-${progress[item.value]!.status}`}>{statusNames[progress[item.value]!.status]}</small>}
          </span>
        </button>;
      })}
    </div>

    {project && activeCopy && <div className="publisher-pack-card">
      <header className="publisher-pack-head">
        <div>
          <span className="eyebrow">Step 2 · 多平台差异化发布包 · {activeMeta.label}</span>
          <h4>专属文案、封面比例与排期门禁</h4>
        </div>
        <div className="publisher-pack-actions">
          <button type="button" className="button button-secondary button-small" disabled={busy !== '' || !canGenerateCopy} onClick={generateAiPack}>
            <Icon name="wand" size={14} />{busy === 'ai-pack' ? 'AI 编写中…' : '重新生成四平台文案'}
          </button>
          <button type="button" className="button button-secondary button-small" disabled={busy !== '' || !hasCover} title={hasCover ? '用高斯模糊补边一次生成 3:4 / 4:3 / 16:9 / 9:16 衍生封面' : '请先在上方上传主封面'} onClick={deriveCovers}>
            <Icon name="image" size={14} />{busy === 'variants' ? '衍生封面中…' : '生成多比例封面'}
          </button>
          <button type="button" className="button button-primary button-small" disabled={busy !== '' || (!dirtyPack && !dirtyTitle)} onClick={() => void run('save-pack', async () => { await persistAll(project); notify('发布包已保存并同步到运营日历'); })}>
            {busy === 'save-pack' ? '保存中…' : (dirtyPack || dirtyTitle) ? '保存修改' : '已保存'}
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
            placeholder="如 2026-11-28 18:00（留空为随时发）"
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

    {/* ── Step 3: 多平台分发控制栏 & 内嵌平台窗口 ──────────────────────── */}
    <div className="publisher-action-card">
      <div className="publisher-project">
        <span className="eyebrow">Step 3 · 多平台自动上传并填草稿</span>
        <strong>{project ? titleDraft || project.title || project.topic || '未命名视频' : '还没有上传或选择视频'}</strong>
        <small>{ready ? `有效成片 · ${project?.assets.video?.path ?? ''}` : '请在上方上传本地视频，或在「视频制作」渲染有效成片'}</small>
      </div>
      <div className="publisher-targets" aria-label="本次发布平台">
        <span>分发到</span>
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
          {busy === 'publish' || busy === 'auto-pipeline' ? '多平台处理中…' : `一键填草稿到 ${targets.length} 个平台`}
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
    <p className="site-privacy">每个平台使用独立登录会话，工作台自动上传成片/衍生封面并填入四平台专属标题与正文（开启防重复上传锁），最后一下「发布」始终交由你手动确认。</p>
  </section>;
}
