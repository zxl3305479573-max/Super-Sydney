import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  VIDEO_BGM_STYLES,
  resolveVideoBgmStyle,
  type VideoAssetBundle,
  type VideoPlatform,
  type VideoProgress,
  type VideoProject,
  type VideoQualityReport,
  type VideoRenderOptions,
  type VideoShot,
  type VideoStage,
  type VideoWorkflow
} from '../shared';
import { videoFrameSpec } from '../services/video-frame-spec';
import type { VideoLocalCoverInput } from '../services/video-local-cover';
import {
  isQualityFresh,
  isRenderFresh,
  parseVideoShots,
  serializeVideoShots,
  videoPlatformLabel
} from '../services/video-pipeline';
import {
  VIDEO_RENDER_DEFAULTS,
  imageCoverage,
  isImageReady,
  isVoiceReady,
  voiceCoverage
} from '../services/video-production';
import {
  ConfirmButton,
  EmptyState,
  Icon,
  KeepAlive,
  Stepper,
  Tabs,
  TaskList,
  readableError,
  shortTime,
  useVisited,
  useWorkflowStepScroll,
  type StepState
} from './ui';
import { BriefStep } from './video/BriefStep';
import {
  ALL_WORK_STEPS,
  PLATFORMS,
  WORKFLOWS,
  isDirectUploadWorkflow,
  isExternalSkillWorkflow,
  stepsForWorkflow,
  type WorkStep
} from './video/format';
import { PublisherTab } from './video/PublisherTab';
import { CoverStep, DeliverStep, RenderStep } from './video/RenderCoverDeliverSteps';
import { ScriptStep, StoryboardStep } from './video/StoryboardStep';
import { VisualsStep } from './video/VisualsStep';
import { VoiceStep } from './video/VoiceStep';

type VideoTab = 'produce' | 'publish';

const VIDEO_TABS: Array<{ value: VideoTab; label: string }> = [
  { value: 'produce', label: '视频制作' },
  { value: 'publish', label: '上传与多平台分发' }
];

const TAB_STORAGE_KEY = 'sydney.video.tab';
const PROJECT_STORAGE_KEY = 'sydney.video.projectId';

function storedVideoTab(): VideoTab {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (saved === 'produce' || saved === 'publish') return saved;
  } catch { /* 默认进入制作页 */ }
  return 'produce';
}

function storedProjectId(): number | null {
  try {
    const id = Number(localStorage.getItem(PROJECT_STORAGE_KEY));
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

const PROGRESS_TASK_LABELS: Record<VideoProgress['task'], string> = {
  voice: '生成配音',
  images: '生成配图',
  preview: '生成关键帧预览',
  render: '合成成片'
};

type ProjectDraftFields = Pick<
  VideoProject,
  'platform' | 'title' | 'topic' | 'audience' | 'durationSeconds' | 'script' | 'storyboardJson'
>;

function draftFromProject(project: VideoProject): ProjectDraftFields {
  return {
    platform: project.platform,
    title: project.title,
    topic: project.topic,
    audience: project.audience,
    durationSeconds: project.durationSeconds,
    script: project.script,
    storyboardJson: project.storyboardJson
  };
}

export default function VideoWorkbenchPanel({
  notify,
  overlay = false
}: {
  notify: (message: string) => void;
  overlay?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<VideoTab>(storedVideoTab);
  const visitedTabs = useVisited(activeTab);
  useEffect(() => {
    try { localStorage.setItem(TAB_STORAGE_KEY, activeTab); } catch { /* 忽略存储异常 */ }
  }, [activeTab]);

  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(storedProjectId);

  // 独立的新建栏状态，绝不污染当前正在编辑的项目
  const [createWorkflow, setCreateWorkflow] = useState<VideoWorkflow>('script-to-video');
  const [showMoreRoutes, setShowMoreRoutes] = useState(false);
  const [createPlatform, setCreatePlatform] = useState<VideoPlatform>('douyin');
  const [createSeed, setCreateSeed] = useState('');
  const [createWebsiteUrl, setCreateWebsiteUrl] = useState('');
  const [createLogoPath, setCreateLogoPath] = useState('');
  const [createSourcePath, setCreateSourcePath] = useState('');

  // 当前选中项目的编辑态
  const [step, setStep] = useState<WorkStep>('brief');
  const [busy, setBusy] = useState('');
  const [draftProjectId, setDraftProjectId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Partial<ProjectDraftFields>>({});
  const [optionsDraft, setOptionsDraft] = useState<VideoRenderOptions>({ ...VIDEO_RENDER_DEFAULTS });
  const [rawStoryboardJson, setRawStoryboardJson] = useState<string | null>(null);
  const [progress, setProgress] = useState<VideoProgress | null>(null);
  const [assetBundle, setAssetBundle] = useState<VideoAssetBundle | null>(null);
  const [qualityReport, setQualityReport] = useState<VideoQualityReport | null>(null);

  const selected = useMemo(
    () => projects.find(item => item.id === selectedId) ?? null,
    [projects, selectedId]
  );

  useEffect(() => {
    if (selectedId !== null) {
      try { localStorage.setItem(PROJECT_STORAGE_KEY, String(selectedId)); } catch { /* 忽略 */ }
    }
  }, [selectedId]);

  const hydrateEditor = useCallback((project: VideoProject) => {
    setDraftProjectId(project.id);
    setDraft(draftFromProject(project));
    setOptionsDraft({ ...project.options });
    setRawStoryboardJson(null);
  }, []);

  const syncSavedProject = useCallback((next: VideoProject) => {
    setProjects(items => items.map(item => (item.id === next.id ? next : item)));
    if (next.id === selectedId) {
      hydrateEditor(next);
      setQualityReport(isQualityFresh(next) ? next.assets.quality : null);
    }
  }, [selectedId, hydrateEditor]);

  const refreshProjects = useCallback(async () => {
    const list = await window.sydney.listVideoProjects();
    setProjects(list);
    setSelectedId(current => {
      if (current !== null && list.some(item => item.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refreshProjects().catch(error => notify(readableError(error)));
  }, [refreshProjects, notify]);

  // 选中项目切换（或首次加载列表命中项目）时同步表单草稿与素材预览
  useEffect(() => {
    if (!selected) {
      setDraftProjectId(null);
      setDraft({});
      setRawStoryboardJson(null);
      setAssetBundle(null);
      setQualityReport(null);
      return;
    }
    if (draftProjectId !== selected.id) {
      hydrateEditor(selected);
    }
  }, [selected, draftProjectId, hydrateEditor]);

  useEffect(() => {
    setProgress(null);
    setAssetBundle(null);
    setQualityReport(selected && isQualityFresh(selected) ? selected.assets.quality : null);
    if (selectedId === null) return;
    void window.sydney.getVideoAssets(selectedId).then(setAssetBundle).catch(error => notify(readableError(error)));
    return window.sydney.onVideoProgress(event => {
      if (event.id === selectedId) setProgress(event);
    });
  }, [selectedId, notify]);

  const activeWorkflow: VideoWorkflow = selected
    ? (draftProjectId === selected.id ? optionsDraft.workflow : selected.options.workflow)
    : 'script-to-video';
  const activePlatform: VideoPlatform = selected
    ? ((draftProjectId === selected.id ? draft.platform : selected.platform) ?? selected.platform)
    : createPlatform;

  const visibleSteps = useMemo(() => stepsForWorkflow(activeWorkflow), [activeWorkflow]);
  const effectiveStep: WorkStep = visibleSteps.some(item => item.value === step) ? step : 'brief';
  const stepScrollRef = useWorkflowStepScroll(`${selectedId ?? 'none'}:${effectiveStep}`);

  const activeStoryboardJson = selected
    ? (draftProjectId === selected.id ? (draft.storyboardJson ?? selected.storyboardJson) : selected.storyboardJson)
    : '';
  const shots = useMemo(() => parseVideoShots(activeStoryboardJson), [activeStoryboardJson]);

  const dirty = useMemo(() => {
    if (!selected || draftProjectId !== selected.id) return false;
    if (rawStoryboardJson !== null && rawStoryboardJson !== selected.storyboardJson) return true;
    if ((draft.platform ?? selected.platform) !== selected.platform) return true;
    if ((draft.title ?? selected.title) !== selected.title) return true;
    if ((draft.topic ?? selected.topic) !== selected.topic) return true;
    if ((draft.audience ?? selected.audience) !== selected.audience) return true;
    if ((draft.durationSeconds ?? selected.durationSeconds) !== selected.durationSeconds) return true;
    if ((draft.script ?? selected.script) !== selected.script) return true;
    if ((draft.storyboardJson ?? selected.storyboardJson) !== selected.storyboardJson) return true;
    return JSON.stringify(optionsDraft) !== JSON.stringify(selected.options);
  }, [selected, draftProjectId, rawStoryboardJson, draft, optionsDraft]);

  const resolvedBgmStyle = resolveVideoBgmStyle(
    { workflow: activeWorkflow, bgmStyle: optionsDraft.bgmStyle },
    `${String(draft.title ?? selected?.title ?? '')} ${String(draft.topic ?? selected?.topic ?? '')} ${String(draft.audience ?? selected?.audience ?? '')} ${String(draft.script ?? selected?.script ?? '')} ${selected?.options.productResearch ?? ''}`
  );
  const resolvedBgmStyleLabel = VIDEO_BGM_STYLES.find(item => item.value === resolvedBgmStyle)?.label ?? '明亮成长';

  const qualityErrors = qualityReport?.checks.filter(check => check.status === 'error').length ?? 0;

  const stepStates = useMemo((): Record<WorkStep, StepState> => {
    if (!selected) {
      return Object.fromEntries(ALL_WORK_STEPS.map(item => [item.value, 'pending'])) as Record<WorkStep, StepState>;
    }
    const wf = selected.options.workflow;
    const external = isExternalSkillWorkflow(wf);
    const savedShots = parseVideoShots(selected.storyboardJson);
    const video = selected.assets.video;

    const briefReady = external
      ? Boolean(selected.options.sourcePath.trim())
      : wf === 'product-demo'
        ? Boolean(selected.options.websiteUrl.trim() && (selected.title || selected.topic).trim())
        : Boolean((selected.title || selected.topic).trim());

    const voiceState: StepState = external
      ? (selected.options.bgmMode !== 'custom' || Boolean(selected.options.bgmPath.trim()) ? 'done' : 'attention')
      : !savedShots.length
        ? 'pending'
        : isVoiceReady(selected, savedShots)
          ? 'done'
          : voiceCoverage(selected, savedShots).stale > 0 ? 'attention' : 'pending';

    const visualsState: StepState = wf === 'product-demo'
      ? (selected.options.productScreenshots.length > 0 ? 'done' : 'pending')
      : !savedShots.length
        ? 'pending'
        : isImageReady(selected, savedShots)
          ? 'done'
          : imageCoverage(selected, savedShots).stale > 0 ? 'attention' : 'pending';

    return {
      brief: briefReady ? 'done' : 'pending',
      script: selected.script.trim() ? 'done' : 'pending',
      storyboard: savedShots.length > 0 ? 'done' : 'pending',
      voice: voiceState,
      visuals: visualsState,
      render: !video ? 'pending' : (!isRenderFresh(selected) || qualityErrors > 0) ? 'attention' : 'done',
      cover: assetBundle?.cover ? 'done' : 'pending',
      deliver: selected.exportPath ? 'done' : 'pending'
    };
  }, [selected, assetBundle?.cover, qualityErrors]);

  const progressPercent = progress?.total ? Math.min(100, Math.max(0, (progress.done / progress.total) * 100)) : 0;
  const progressTasks = progress?.labels?.length ? progress.labels.map((label, index) => ({
    key: `${index}-${label}`,
    label,
    state: index < progress.done ? 'done' as const : index === progress.done ? (busy ? 'running' as const : 'failed' as const) : 'pending' as const
  })) : null;

  const patchDraft = (patch: Partial<ProjectDraftFields>) => setDraft(current => ({ ...current, ...patch }));
  const patchOptions = (patch: Partial<VideoRenderOptions>) => setOptionsDraft(current => ({ ...current, ...patch }));

  const replaceShots = (nextShots: VideoShot[]) => {
    const json = serializeVideoShots(nextShots);
    setRawStoryboardJson(null);
    patchDraft({ storyboardJson: json });
  };

  const handleRawJsonChange = (raw: string) => {
    setRawStoryboardJson(raw);
    if (!raw.trim()) {
      patchDraft({ storyboardJson: '' });
      return;
    }
    const parsed = parseVideoShots(raw);
    if (parsed.length > 0) {
      patchDraft({ storyboardJson: serializeVideoShots(parsed) });
    }
  };

  const switchProject = (targetId: number) => {
    if (targetId === selectedId) return;
    if (dirty && !window.confirm('当前视频有未保存的修改，切换项目后这些修改会丢失。继续？')) return;
    const target = projects.find(item => item.id === targetId);
    setSelectedId(targetId);
    if (target) hydrateEditor(target);
    setStep('brief');
  };

  const run = async (name: string, action: () => Promise<VideoProject | void>) => {
    setBusy(name);
    setProgress(null);
    if (name !== 'quality' && name !== 'open-video' && name !== 'save-mp4') setQualityReport(null);
    try {
      const result = await action();
      if (result) {
        syncSavedProject(result);
        const assets = await window.sydney.getVideoAssets(result.id);
        setAssetBundle(assets);
      }
    } catch (error) {
      notify(readableError(error));
    } finally {
      setBusy('');
    }
  };

  const persistDraft = async (optionsOverride?: Partial<VideoRenderOptions>): Promise<VideoProject> => {
    if (!selected) throw new Error('请先选择视频项目');
    if (rawStoryboardJson !== null && rawStoryboardJson.trim() && parseVideoShots(rawStoryboardJson).length === 0) {
      throw new Error('进阶分镜 JSON 格式无效或没有有效镜头，请修正后再保存');
    }
    const mergedOptions: VideoRenderOptions = {
      ...selected.options,
      ...optionsDraft,
      ...optionsOverride
    };
    if (
      mergedOptions.sourcePath !== selected.options.sourcePath ||
      mergedOptions.workflow !== selected.options.workflow
    ) {
      mergedOptions.skillInputSignature = '';
    }
    const next = await window.sydney.updateVideoProject(selected.id, {
      ...draft,
      platform: activePlatform,
      options: mergedOptions
    });
    syncSavedProject(next);
    return next;
  };

  const createProject = () => void run('create', async () => {
    if (dirty && !window.confirm('当前视频有未保存的修改，新建并切换后这些修改会丢失。继续？')) return;
    const created = await window.sydney.createVideoProject(createPlatform, createSeed);
    const initialOptions: VideoRenderOptions = {
      ...created.options,
      workflow: createWorkflow,
      websiteUrl: createWorkflow === 'product-demo' ? createWebsiteUrl.trim() : '',
      logoPath: createWorkflow === 'product-demo' ? createLogoPath.trim() : '',
      sourcePath: isExternalSkillWorkflow(createWorkflow) ? createSourcePath.trim() : ''
    };
    const saved = await window.sydney.updateVideoProject(created.id, { options: initialOptions });
    setProjects(items => [saved, ...items]);
    setSelectedId(saved.id);
    hydrateEditor(saved);
    setStep('brief');
    setCreateSeed('');
    notify('已创建新视频项目');
    return saved;
  });

  const removeProject = () => {
    if (!selected) return;
    const removing = selected;
    void run('delete', async () => {
      await window.sydney.deleteVideoProject(removing.id);
      const rest = projects.filter(item => item.id !== removing.id);
      setProjects(rest);
      const next = rest[0] ?? null;
      setSelectedId(next?.id ?? null);
      if (next) hydrateEditor(next);
      setStep('brief');
      notify(`已删除视频「${removing.title || removing.topic || `#${removing.id}`}」`);
    });
  };

  const saveProject = () => void run('save', async () => {
    const next = await persistDraft();
    notify('项目设置已保存');
    return next;
  });

  const generateStage = (stage: VideoStage) => void run(stage, async () => {
    if (!selected) return;
    if (stage === 'script' && (draft.script ?? selected.script).trim()) {
      if (!window.confirm('重新生成口播脚本会覆盖当前脚本内容。继续？')) return;
    }
    if (stage === 'storyboard' && shots.length > 0) {
      if (!window.confirm('重新拆解分镜会覆盖当前分镜表。继续？')) return;
    }
    const saved = await persistDraft();
    const next = await window.sydney.generateVideoStage(saved.id, stage);
    syncSavedProject(next);
    setStep(stage === 'topics' ? 'brief' : stage);
    notify(`${stage === 'topics' ? '5 个候选选题' : stage === 'script' ? '口播脚本' : '分镜表'}已生成`);
    return next;
  });

  const autoScriptAndStoryboard = () => void run('auto-text', async () => {
    if (!selected) throw new Error('请先选择视频项目');
    if ((draft.script ?? selected.script).trim() || shots.length > 0) {
      if (!window.confirm('这将连续重新生成口播脚本与分镜表，覆盖现有内容（不触发付费生图）。继续？')) return;
    }
    const saved = await persistDraft();
    const scripted = await window.sydney.generateVideoStage(saved.id, 'script');
    syncSavedProject(scripted);
    const boarded = await window.sydney.generateVideoStage(scripted.id, 'storyboard');
    syncSavedProject(boarded);
    setStep('storyboard');
    notify('口播脚本与分镜已连续生成，请核对后进入声音字幕');
    return boarded;
  });

  const productionWithSavedDraft = (
    name: string,
    action: (project: VideoProject) => Promise<VideoProject>,
    optionsOverride?: Partial<VideoRenderOptions>
  ) => void run(name, async () => {
    const saved = await persistDraft(optionsOverride);
    return action(saved);
  });

  const renderVideoAction = () => productionWithSavedDraft('render', async project => {
    const next = await window.sydney.renderVideo(project.id);
    setStep('render');
    const report = next.assets.quality;
    const warnings = report?.checks.filter(check => check.status === 'warn').length ?? 0;
    notify(!report
      ? '成片已合成，请手动点「重新质检」核对'
      : !report.ok
        ? '成片已合成，但质量验收发现硬错误，请查看下方清单'
        : warnings ? `成片已合成并通过验收（含 ${warnings} 项温和提醒）` : '成片已合成并通过全部 11 项质量验收');
    return next;
  });

  const inspectQualityAction = () => void run('quality', async () => {
    if (!selected) throw new Error('请先选择视频项目');
    const report = await window.sydney.inspectVideoQuality(selected.id);
    setQualityReport(report);
    const warnings = report.checks.filter(check => check.status === 'warn').length;
    notify(report.ok ? (warnings ? `质量验收通过（含 ${warnings} 项提醒）` : '11 项质量验收全部通过') : '质量验收发现需要修复的硬错误');
  });

  const chooseCreateLogo = async () => {
    try {
      const file = await window.sydney.chooseProductLogo();
      if (file) setCreateLogoPath(file);
    } catch (error) {
      notify(readableError(error));
    }
  };

  const chooseCreateSource = async () => {
    try {
      const file = await window.sydney.chooseVideoSource(createWorkflow);
      if (file) setCreateSourcePath(file);
    } catch (error) {
      notify(readableError(error));
    }
  };

  const chooseProjectLogo = () => void run('logo', async () => {
    const file = await window.sydney.chooseProductLogo();
    if (file) patchOptions({ logoPath: file });
  });

  const chooseProjectSource = () => void run('source', async () => {
    const file = await window.sydney.chooseVideoSource(activeWorkflow);
    if (file) patchOptions({ sourcePath: file, skillInputSignature: '' });
  });

  const chooseProjectBgm = () => void run('bgm', async () => {
    const saved = await persistDraft();
    const next = await window.sydney.chooseVideoBgm(saved.id);
    if (!next) return;
    notify('已关联本地背景音乐');
    return next;
  });

  const captureProductAssets = () => void run('capture', async () => {
    const saved = await persistDraft();
    const result = await window.sydney.runVideoWorkflow(saved.id);
    notify(result.message);
    if (result.status === 'blocked') throw new Error(result.message);
    const refreshed = (await window.sydney.listVideoProjects()).find(item => item.id === saved.id);
    if (!refreshed) throw new Error('官网抓取完成后未找到当前项目');
    return refreshed;
  });

  const analyzeProduct = () => void run('topics', async () => {
    const saved = await persistDraft();
    const result = await window.sydney.runVideoWorkflow(saved.id);
    if (result.status === 'blocked') throw new Error(result.message);
    const next = await window.sydney.generateVideoStage(saved.id, 'topics');
    setStep('brief');
    notify('已提取官网公开资料并生成 5 个产品切入方向');
    return next;
  });

  const runProductDemoOneClick = () => void run('workflow', async () => {
    if (!selected) throw new Error('请先选择视频项目');
    if ((draft.script ?? selected.script).trim() && !window.confirm('将按官网公开页面重新生成脚本、分镜、配音并合成产品片，覆盖现有脚本与分镜。继续？')) {
      return;
    }
    const saved = await persistDraft();
    const result = await window.sydney.runVideoWorkflow(saved.id);
    if (result.status === 'blocked') throw new Error(result.message);
    let current = await window.sydney.generateVideoStage(saved.id, 'script');
    syncSavedProject(current);
    current = await window.sydney.generateVideoStage(saved.id, 'storyboard');
    syncSavedProject(current);
    current = await window.sydney.generateVideoVoice(saved.id, false);
    syncSavedProject(current);
    current = await window.sydney.renderVideoPreview(saved.id);
    syncSavedProject(current);
    current = await window.sydney.renderVideo(saved.id);
    setStep('render');
    notify('产品宣传片已合成完成，请试看成片并配置封面');
    return current;
  });

  const runExternalSkillWorkflow = () => void run('workflow', async () => {
    const saved = await persistDraft();
    const result = await window.sydney.runVideoWorkflow(saved.id);
    if (result.status === 'blocked') throw new Error(result.message);
    const refreshed = (await window.sydney.listVideoProjects()).find(item => item.id === saved.id);
    if (!refreshed) throw new Error('工作流执行完成后未找到当前项目');
    setStep('render');
    notify([result.message, ...(result.diagnostics ?? [])].filter(Boolean).join(' · '));
    return refreshed;
  });

  const renderLocalCover = (input: VideoLocalCoverInput) => productionWithSavedDraft('cover-local', async project => {
    const next = await window.sydney.renderVideoLocalCover(project.id, input);
    notify('已按本地模板生成并关联主封面');
    return next;
  });

  const generateAiCover = () => productionWithSavedDraft('cover-ai', async project => {
    const next = await window.sydney.generateVideoCover(project.id);
    notify('AI 主封面已生成');
    return next;
  });

  const chooseLocalCover = () => productionWithSavedDraft('cover-choose', async project => {
    const next = await window.sydney.chooseVideoCover(project.id);
    if (next) notify('已选择本地封面图片');
    return next ?? project;
  });

  const saveMp4 = () => void run('save-mp4', async () => {
    if (!selected) return;
    const savedPath = await window.sydney.saveVideoMp4(selected.id);
    if (savedPath) notify(`已另存 MP4：${savedPath}`);
    return selected;
  });

  const exportPackage = () => productionWithSavedDraft('export', async project => {
    const next = await window.sydney.exportVideoProject(project.id);
    notify('制作包已导出到 Obsidian 知识库');
    return next;
  });

  const upsertProjectInState = useCallback((next: VideoProject, select = false) => {
    setProjects(items => {
      const exists = items.some(item => item.id === next.id);
      return exists ? items.map(item => (item.id === next.id ? next : item)) : [next, ...items];
    });
    if (select) {
      setSelectedId(next.id);
      hydrateEditor(next);
      setQualityReport(isQualityFresh(next) ? next.assets.quality : null);
    } else if (next.id === selectedId) {
      hydrateEditor(next);
      setQualityReport(isQualityFresh(next) ? next.assets.quality : null);
    }
  }, [selectedId, hydrateEditor]);

  const primaryWorkflows = WORKFLOWS.filter(item => item.primary);
  const secondaryWorkflows = WORKFLOWS.filter(item => !item.primary && !isDirectUploadWorkflow(item.value));
  const activeProfile = WORKFLOWS.find(item => item.value === activeWorkflow) ?? WORKFLOWS[0];
  const createProfile = WORKFLOWS.find(item => item.value === createWorkflow) ?? WORKFLOWS[0];
  const readyVideosCount = projects.filter(item => item.assets.video && isRenderFresh(item)).length;
  const outputSpec = videoFrameSpec(activePlatform);

  return (
    <section className="native-content video-panel video-workbench-panel video-studio" aria-label="视频工作台">
      <header className="ww-page-header">
        <div>
          <p className="eyebrow">内容工作区</p>
          <h1>视频工作台</h1>
          <p>支持脚本制作成片，也支持直接上传本地视频、封面与中性文案，AI 自动按各平台调性写好文案并一键分发（只填草稿、人工确认最终发布）。</p>
        </div>
        <div className="video-header-summary">
          <span>共 <strong>{projects.length}</strong> 个视频项目</span>
          <span><strong>{readyVideosCount}</strong> 条有效成片可分发</span>
          {activeTab === 'produce' && (
            <button type="button" className="button button-primary button-small" onClick={() => setActiveTab('publish')}>
              <Icon name="upload" size={14} />上传视频直发
            </button>
          )}
        </div>
      </header>

      <nav className="ww-nav-dock" aria-label="视频工作台分区">
        <Tabs
          label="视频工作台分区"
          value={activeTab}
          onChange={setActiveTab}
          items={VIDEO_TABS.map(item => ({
            value: item.value,
            label: item.label,
            count: item.value === 'produce' ? projects.length : readyVideosCount || undefined
          }))}
        />
      </nav>

      {visitedTabs.includes('produce') && (
        <KeepAlive show={activeTab === 'produce'}>
          <section className="video-create-panel" aria-label="新建视频项目">
            <div className="video-create-head">
              <div className="video-route-pills" role="radiogroup" aria-label="选择制作路线">
                {primaryWorkflows.map(item => (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={createWorkflow === item.value}
                    disabled={Boolean(busy)}
                    className={`video-route-pill ${createWorkflow === item.value ? 'is-active' : ''}`}
                    onClick={() => setCreateWorkflow(item.value)}
                  >
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </button>
                ))}
                <button
                  type="button"
                  className={`video-route-more-toggle ${showMoreRoutes || !createProfile.primary ? 'is-open' : ''}`}
                  onClick={() => setShowMoreRoutes(open => !open)}
                >
                  {showMoreRoutes || !createProfile.primary ? '收起进阶路线' : '更多路线（剪辑 / 录屏 / 多语言）'}
                </button>
              </div>
            </div>

            {(showMoreRoutes || !createProfile.primary) && (
              <div className="video-route-pills is-secondary" role="radiogroup" aria-label="进阶制作路线">
                {secondaryWorkflows.map(item => (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={createWorkflow === item.value}
                    disabled={Boolean(busy)}
                    className={`video-route-pill ${createWorkflow === item.value ? 'is-active' : ''}`}
                    onClick={() => setCreateWorkflow(item.value)}
                  >
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </button>
                ))}
              </div>
            )}

            <div className="video-create-bar">
              <label className="video-create-platform">
                <span>目标平台</span>
                <select
                  value={createPlatform}
                  disabled={Boolean(busy)}
                  onChange={event => setCreatePlatform(event.target.value as VideoPlatform)}
                >
                  {PLATFORMS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>

              {createWorkflow === 'product-demo' ? (
                <>
                  <label className="video-create-grow">
                    <span>产品官网 URL</span>
                    <input
                      value={createWebsiteUrl}
                      disabled={Boolean(busy)}
                      onChange={event => setCreateWebsiteUrl(event.target.value)}
                      placeholder="https://example.com"
                    />
                  </label>
                  <div className="video-file-picker-row video-create-grow">
                    <label>
                      <span>品牌 Logo（可选）</span>
                      <input
                        value={createLogoPath}
                        disabled={Boolean(busy)}
                        onChange={event => setCreateLogoPath(event.target.value)}
                        placeholder="PNG / JPG / WebP / SVG"
                      />
                    </label>
                    <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => void chooseCreateLogo()}>
                      选 Logo
                    </button>
                  </div>
                </>
              ) : isExternalSkillWorkflow(createWorkflow) ? (
                <>
                  <div className="video-file-picker-row video-create-grow">
                    <label>
                      <span>{createWorkflow === 'browser-demo' ? '浏览器录制配置 JSON' : '源视频文件'}</span>
                      <input
                        value={createSourcePath}
                        disabled={Boolean(busy)}
                        onChange={event => setCreateSourcePath(event.target.value)}
                        placeholder={createWorkflow === 'browser-demo' ? '选择录制配置 JSON' : '选择本机 MP4 / MOV / MKV'}
                      />
                    </label>
                    <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => void chooseCreateSource()}>
                      选文件
                    </button>
                  </div>
                  <label className="video-create-grow">
                    <span>项目标题 / 备注</span>
                    <input
                      value={createSeed}
                      disabled={Boolean(busy)}
                      onChange={event => setCreateSeed(event.target.value)}
                      placeholder="例如：课程精华竖屏切片"
                    />
                  </label>
                </>
              ) : (
                <label className="video-create-grow">
                  <span>初始选题或一句话想法（可留空后在简报里搜热点）</span>
                  <input
                    value={createSeed}
                    disabled={Boolean(busy)}
                    onChange={event => setCreateSeed(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') createProject(); }}
                    placeholder="例如：为什么早餐不吃主食反而中午更犯困（做成 45 秒科普）"
                  />
                </label>
              )}

              <button type="button" className="button button-primary video-create-submit" disabled={Boolean(busy)} onClick={createProject}>
                <Icon name="plus" size={15} />{busy === 'create' ? '新建中…' : '新建视频'}
              </button>
            </div>
          </section>

          <div className="video-studio-layout">
            <aside className="native-task-list video-project-rail" aria-label="视频项目列表">
              <div className="video-rail-head">
                <h2>视频项目</h2>
                <span className="chip">{projects.length}</span>
              </div>
              {projects.length ? (
                <div className="video-project-items">
                  {projects.map(item => {
                    const isSelected = item.id === selectedId;
                    const direct = isDirectUploadWorkflow(item.options.workflow);
                    const wfLabel = WORKFLOWS.find(w => w.value === item.options.workflow)?.label ?? '脚本 → 成片';
                    const freshMp4 = Boolean(item.assets.video && isRenderFresh(item));
                    const stateText = item.exportPath
                      ? '已导出制作包'
                      : freshMp4
                        ? '✓ 成片就绪'
                        : direct
                          ? '待上传视频'
                          : item.assets.video
                            ? '成片待重渲染'
                            : item.status === 'storyboard'
                              ? '已拆分镜'
                              : item.status === 'script'
                                ? '已有脚本'
                                : '草稿';
                    return (
                      <button
                        type="button"
                        key={item.id}
                        className={`native-task video-project-card ${isSelected ? 'is-selected' : ''}`}
                        onClick={() => switchProject(item.id)}
                      >
                        <div className="video-project-card-top">
                          <strong>{item.title || item.topic || '未命名视频'}</strong>
                          {isSelected && dirty && <span className="video-dirty-dot" title="有未保存修改" />}
                        </div>
                        <span>{direct ? wfLabel : `${videoPlatformLabel(item.platform)} · ${wfLabel}`}</span>
                        <small>{stateText} · {shortTime(item.updatedAt)}</small>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <EmptyState compact icon="video" title="还没有视频项目">
                  在上方选一条制作路线，点「新建视频」即可开始。
                </EmptyState>
              )}
            </aside>

            <main className="native-editor video-editor-deck" ref={stepScrollRef}>
              {selected ? (
                <>
                  <header className="native-editor-head video-editor-header">
                    <div>
                      <p className="eyebrow">
                        {activeProfile.label} · {videoPlatformLabel(activePlatform)}（{outputSpec.label}）
                        {dirty ? ' · 未保存修改' : ''}
                      </p>
                      <h2>{String(draft.title ?? selected.title) || String(draft.topic ?? selected.topic) || '未命名视频'}</h2>
                    </div>
                    <div className="native-editor-actions">
                      {activeWorkflow === 'product-demo' && (
                        <button type="button" className="button button-primary" disabled={Boolean(busy)} onClick={runProductDemoOneClick}>
                          {busy === 'workflow' ? '执行中…' : '官网 + Logo 一键成片'}
                        </button>
                      )}
                      {isExternalSkillWorkflow(activeWorkflow) && (
                        <button type="button" className="button button-primary" disabled={Boolean(busy)} onClick={runExternalSkillWorkflow}>
                          {busy === 'workflow' ? '处理中…' : '运行工作流生成成片'}
                        </button>
                      )}
                      <button type="button" className="button button-secondary" disabled={Boolean(busy) || !dirty} onClick={saveProject}>
                        {busy === 'save' ? '保存中…' : dirty ? '保存修改' : '已保存'}
                      </button>
                      {selected.assets.video && isRenderFresh(selected) && (
                        <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => setActiveTab('publish')}>
                          <Icon name="send" size={14} />去分发
                        </button>
                      )}
                      <ConfirmButton
                        className="button button-danger-quiet"
                        armedLabel="确认删除"
                        disabled={Boolean(busy)}
                        onConfirm={removeProject}
                      >
                        删除
                      </ConfirmButton>
                    </div>
                  </header>

                  {isDirectUploadWorkflow(activeWorkflow) ? (
                    <section className="flow-panel video-direct-summary-card">
                      <header className="flow-panel-head">
                        <div>
                          <h3>本地成片直发任务</h3>
                          <p>该任务来自本地上传成片，无需编写脚本与分镜。请在「上传与多平台分发」页签管理视频、封面、中性文案及四平台专属文案并一键分发。</p>
                        </div>
                      </header>
                      <div className="workbench-status-grid">
                        <div>
                          <strong>{selected.assets.video && isRenderFresh(selected) ? '✓ 已上传视频' : '待上传视频'}</strong>
                          <span>{selected.assets.video?.path || '尚未选择本地视频文件'}</span>
                        </div>
                        <div>
                          <strong>{selected.coverPath ? '✓ 已上传封面' : '未上传封面'}</strong>
                          <span>{selected.coverPath || '可在分发页拖入或选择封面图片'}</span>
                        </div>
                      </div>
                      {assetBundle?.videoPath && selected.assets.video && (
                        <div className="video-player-card">
                          <div className="video-player-frame is-landscape">
                            <video
                              key={`${selected.assets.video.signature}-${selected.assets.video.renderedAt}`}
                              controls
                              preload="metadata"
                              src={`sydney-video://project/${selected.id}?sig=${encodeURIComponent(selected.assets.video.signature)}`}
                            />
                          </div>
                        </div>
                      )}
                      <div className="flow-inline-actions">
                        <button type="button" className="button button-primary" onClick={() => setActiveTab('publish')}>
                          <Icon name="send" size={14} />前往「上传与多平台分发」继续编辑与发布 →
                        </button>
                      </div>
                    </section>
                  ) : (
                  <>
                  <Stepper
                    label="视频制作步骤"
                    active={effectiveStep}
                    onSelect={setStep}
                    steps={visibleSteps.map(item => ({ ...item, state: stepStates[item.value] }))}
                  />

                  {progress && progressTasks && (
                    <TaskList title={PROGRESS_TASK_LABELS[progress.task]} summary={progress.message} items={progressTasks} />
                  )}
                  {progress && !progressTasks && (
                    <div className="video-render-progress" role="status" aria-live="polite">
                      <div>
                        <span>{PROGRESS_TASK_LABELS[progress.task]}</span>
                        <strong>{progress.message}</strong>
                        <em>{progress.done}/{progress.total}</em>
                      </div>
                      <div className="video-render-progress-track"><i style={{ width: `${progressPercent}%` }} /></div>
                    </div>
                  )}

                  {effectiveStep === 'brief' && (
                    <BriefStep
                      project={selected}
                      draft={draft}
                      platform={activePlatform}
                      workflow={activeWorkflow}
                      websiteUrl={optionsDraft.websiteUrl}
                      logoPath={optionsDraft.logoPath}
                      sourcePath={optionsDraft.sourcePath}
                      sourceLanguage={optionsDraft.sourceLanguage}
                      targetLanguage={optionsDraft.targetLanguage}
                      targetCode={optionsDraft.targetCode}
                      contentStructure={optionsDraft.contentStructure}
                      contentBrief={optionsDraft.contentBrief}
                      busy={busy}
                      onPatchDraft={patchDraft}
                      onWebsiteUrl={value => patchOptions({ websiteUrl: value })}
                      onLogoPath={value => patchOptions({ logoPath: value })}
                      onChooseLogo={chooseProjectLogo}
                      onSourcePath={value => patchOptions({ sourcePath: value, skillInputSignature: '' })}
                      onChooseSource={chooseProjectSource}
                      onSourceLanguage={value => patchOptions({ sourceLanguage: value })}
                      onTargetLanguage={value => patchOptions({ targetLanguage: value })}
                      onTargetCode={value => patchOptions({ targetCode: value })}
                      onContentStructure={value => patchOptions({ contentStructure: value })}
                      onContentBrief={value => patchOptions({ contentBrief: value })}
                      onGenerateTopics={() => generateStage('topics')}
                      onAnalyzeProduct={analyzeProduct}
                      onSave={saveProject}
                      onNextStep={() => setStep(isExternalSkillWorkflow(activeWorkflow) ? 'voice' : 'script')}
                      notify={notify}
                    />
                  )}

                  {effectiveStep === 'script' && (
                    <ScriptStep
                      project={{ ...selected, ...draft }}
                      script={String(draft.script ?? selected.script)}
                      targetDuration={Number(draft.durationSeconds ?? selected.durationSeconds)}
                      busy={busy}
                      onChange={value => patchDraft({ script: value })}
                      onGenerate={() => generateStage('script')}
                      onAutoScriptAndStoryboard={autoScriptAndStoryboard}
                      onSave={saveProject}
                      onNextStep={() => setStep('storyboard')}
                    />
                  )}

                  {effectiveStep === 'storyboard' && (
                    <StoryboardStep
                      projectId={selected.id}
                      shots={shots}
                      rawJson={rawStoryboardJson ?? activeStoryboardJson}
                      script={String(draft.script ?? selected.script)}
                      busy={busy}
                      onReplaceShots={replaceShots}
                      onRawJsonChange={handleRawJsonChange}
                      onGenerate={() => generateStage('storyboard')}
                      onSave={saveProject}
                      onNextStep={() => setStep('voice')}
                      notify={notify}
                    />
                  )}

                  {effectiveStep === 'voice' && (
                    <VoiceStep
                      project={selected}
                      shots={shots}
                      workflow={activeWorkflow}
                      voiceMode={optionsDraft.voiceMode}
                      bgmMode={optionsDraft.bgmMode}
                      bgmStyle={optionsDraft.bgmStyle}
                      resolvedBgmStyleLabel={resolvedBgmStyleLabel}
                      bgmVolume={optionsDraft.bgmVolume}
                      bgmDucking={optionsDraft.bgmDucking}
                      bgmFadeIn={optionsDraft.bgmFadeIn}
                      bgmFadeOut={optionsDraft.bgmFadeOut}
                      busy={busy}
                      onVoiceMode={voiceMode => patchOptions({ voiceMode })}
                      onBgmMode={bgmMode => patchOptions({ bgmMode })}
                      onBgmStyle={bgmStyle => patchOptions({ bgmStyle })}
                      onBgmVolume={bgmVolume => patchOptions({ bgmVolume })}
                      onBgmDucking={bgmDucking => patchOptions({ bgmDucking })}
                      onBgmFadeIn={bgmFadeIn => patchOptions({ bgmFadeIn })}
                      onBgmFadeOut={bgmFadeOut => patchOptions({ bgmFadeOut })}
                      onChooseBgm={chooseProjectBgm}
                      onGenerateVoice={force => productionWithSavedDraft('voice', project => window.sydney.generateVideoVoice(project.id, force), { voiceMode: 'tts' })}
                      onSave={saveProject}
                      onNextStep={() => setStep(isExternalSkillWorkflow(activeWorkflow) ? 'render' : 'visuals')}
                      notify={notify}
                    />
                  )}

                  {effectiveStep === 'visuals' && (
                    <VisualsStep
                      project={selected}
                      shots={shots}
                      workflow={activeWorkflow}
                      template={optionsDraft.template}
                      imageMode={optionsDraft.imageMode}
                      footer={optionsDraft.footer}
                      storyboardImagePromptRule={optionsDraft.storyboardImagePromptRule}
                      shotImagePromptTemplate={optionsDraft.shotImagePromptTemplate}
                      coverImagePromptTemplate={optionsDraft.coverImagePromptTemplate}
                      assetBundle={assetBundle}
                      busy={busy}
                      onTemplate={template => patchOptions({ template })}
                      onImageMode={imageMode => patchOptions({ imageMode })}
                      onFooter={footer => patchOptions({ footer })}
                      onPromptTemplates={patch => patchOptions(patch)}
                      onCaptureProduct={captureProductAssets}
                      onGenerateImages={force => productionWithSavedDraft('images', project => window.sydney.generateVideoImages(project.id, force), { imageMode: 'ai' })}
                      onRenderPreview={() => productionWithSavedDraft('preview', project => window.sydney.renderVideoPreview(project.id))}
                      onSave={saveProject}
                      onNextStep={() => setStep('render')}
                    />
                  )}

                  {effectiveStep === 'render' && (
                    <RenderStep
                      project={{ ...selected, platform: activePlatform, options: { ...selected.options, ...optionsDraft } }}
                      shots={shots}
                      platform={activePlatform}
                      workflow={activeWorkflow}
                      assetBundle={assetBundle}
                      qualityReport={qualityReport}
                      busy={busy}
                      onRender={isExternalSkillWorkflow(activeWorkflow) ? runExternalSkillWorkflow : renderVideoAction}
                      onInspectQuality={inspectQualityAction}
                      onSaveMp4={saveMp4}
                      onOpenExternalPlayer={() => void window.sydney.openVideoFile(selected.id).catch(err => notify(readableError(err)))}
                      onNextStep={() => setStep('cover')}
                    />
                  )}

                  {effectiveStep === 'cover' && (
                    <CoverStep
                      project={selected}
                      platform={activePlatform}
                      assetBundle={assetBundle}
                      busy={busy}
                      onGenerateAiCover={generateAiCover}
                      onChooseLocalCover={chooseLocalCover}
                      onRenderTemplateCover={renderLocalCover}
                      onNextStep={() => setStep('deliver')}
                    />
                  )}

                  {effectiveStep === 'deliver' && (
                    <DeliverStep
                      project={selected}
                      qualityReport={qualityReport}
                      busy={busy}
                      onSaveMp4={saveMp4}
                      onExportPackage={exportPackage}
                      onInspectQuality={inspectQualityAction}
                      onOpenPackage={() => void window.sydney.openVideoPackage(selected.id).catch(err => notify(readableError(err)))}
                      onJumpToPublish={() => setActiveTab('publish')}
                    />
                  )}
                  </>
                  )}
                </>
              ) : (
                <EmptyState icon="video" title="创建或选择一条视频">
                  在上方选择制作路线并点「新建视频」，即可从选题简报一路做到可分发成片。
                </EmptyState>
              )}
            </main>
          </div>
        </KeepAlive>
      )}

      {visitedTabs.includes('publish') && (
        <KeepAlive show={activeTab === 'publish'}>
          <div className="video-publish-tab-wrap">
            <div className="video-publish-project-bar">
              <label>
                <span>当前分发视频</span>
                <select
                  className="input"
                  value={selected?.id ?? ''}
                  disabled={!projects.length}
                  onChange={event => switchProject(Number(event.target.value))}
                >
                  {!projects.length && <option value="">暂无视频项目</option>}
                  {projects.map(item => {
                    const fresh = Boolean(item.assets.video && isRenderFresh(item));
                    const direct = isDirectUploadWorkflow(item.options.workflow);
                    return (
                      <option key={item.id} value={item.id}>
                        {item.title || item.topic || `未命名 #${item.id}`} · {direct ? '上传直发' : videoPlatformLabel(item.platform)} · {fresh ? '成片就绪' : direct ? '待传视频' : '待合成成片'}
                      </option>
                    );
                  })}
                </select>
              </label>
              <div className="video-publish-project-meta">
                {selected ? (
                  <>
                    <span className={selected.assets.video && isRenderFresh(selected) ? 'badge badge-on' : 'badge badge-idle'}>
                      {selected.assets.video && isRenderFresh(selected) ? '有效成片' : '成片未就绪'}
                    </span>
                    <span className={selected.coverPath ? 'badge badge-on' : 'badge badge-idle'}>
                      {selected.coverPath ? '已有主封面' : '未设主封面'}
                    </span>
                    <ConfirmButton
                      className="button button-danger-quiet button-small"
                      armedLabel="确认删除"
                      disabled={Boolean(busy)}
                      onConfirm={removeProject}
                    >
                      删除任务
                    </ConfirmButton>
                    {!isDirectUploadWorkflow(selected.options.workflow) && (
                      <button type="button" className="button button-quiet button-small" onClick={() => setActiveTab('produce')}>
                        ← 返回视频制作编辑
                      </button>
                    )}
                  </>
                ) : (
                  <span className="badge badge-idle">在下方上传本地视频即可开始</span>
                )}
              </div>
            </div>

            <PublisherTab
              project={selected}
              overlay={overlay || activeTab !== 'publish'}
              notify={notify}
              onProjectUpserted={upsertProjectInState}
            />
          </div>
        </KeepAlive>
      )}
    </section>
  );
}
