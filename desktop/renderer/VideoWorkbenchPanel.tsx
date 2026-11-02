import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  VIDEO_BGM_STYLES, resolveVideoBgmStyle,
  type VideoAssetBundle, type VideoBgmMode, type VideoBgmStyle, type VideoPlatform, type VideoProgress, type VideoProject, type VideoQualityReport, type VideoShot,
  type VideoShotRole, type VideoStage, type VideoWorkflow
} from '../shared';
import { videoFrameSpec } from '../services/video-frame-spec';
import { isQualityFresh, isRenderFresh, parseVideoShots, serializeVideoShots } from '../services/video-pipeline';
import { VIDEO_SHOT_ROLES } from '../services/video-production';
import { EmptyState, Stepper, TaskList, readableError, type StepState } from './ui';

type WorkStep = 'brief' | 'script' | 'storyboard' | 'voice' | 'visuals' | 'render' | 'cover' | 'deliver';
type WorkflowCard = { value: VideoWorkflow; label: string; description: string; engine: string; detail: string };

const WORKFLOWS: WorkflowCard[] = [
  { value: 'script-to-video', label: '脚本 → 成片', description: '从主题、脚本和分镜生成完整短视频。', engine: '本地逐帧画面 + TTS + FFmpeg', detail: '适合知识视频、口播、清单和 Shorts。' },
  { value: 'footage-edit', label: '已有素材剪辑', description: '把已有视频整理成节奏清晰的短片。', engine: 'video-use + FFmpeg', detail: '适合访谈、课程、Vlog 和 Podcast。' },
  { value: 'product-demo', label: '产品宣传片', description: '只给官网和 Logo，自动抓取公开素材并生成产品视频。', engine: 'Website Capture + TTS + FFmpeg', detail: '适合 SaaS、AI 工具和独立开发者。' },
  { value: 'browser-demo', label: '网页操作演示', description: '录制点击、滚动、缩放和产品流程。', engine: 'Browser Recording + FFmpeg', detail: '适合教程、产品 Walkthrough 和发布页。' },
  { value: 'localize', label: '字幕与多语言', description: '转录、翻译、压制字幕并导出多语言版本。', engine: 'Fusion ASR + Subtitle Translator', detail: '适合出海内容和多语言账号。' }
];

const STEPS: Array<{ value: WorkStep; label: string; hint: string }> = [
  { value: 'brief', label: '项目简报', hint: '目标、平台和素材说明' },
  { value: 'script', label: '脚本', hint: '生成或粘贴口播稿' },
  { value: 'storyboard', label: '分镜', hint: '逐镜画面与口播' },
  { value: 'voice', label: '声音字幕', hint: '配音与时间轴' },
  { value: 'visuals', label: '画面素材', hint: '模板、配图和预览' },
  { value: 'render', label: '成片', hint: '渲染和质量检查' },
  { value: 'cover', label: '封面', hint: '生成或选择平台封面' },
  { value: 'deliver', label: '交付', hint: '导出 MP4 和制作包' }
];

const PLATFORMS: Array<{ value: VideoPlatform; label: string }> = [
  { value: 'douyin', label: '抖音' }, { value: 'shipinhao', label: '视频号' },
  { value: 'xiaohongshu', label: '小红书' }, { value: 'bilibili', label: 'B 站' }, { value: 'general', label: '通用' }
];

const PROGRESS_TASK_LABELS: Record<VideoProgress['task'], string> = {
  voice: '生成配音',
  images: '生成配图',
  preview: '生成预览',
  render: '渲染成片'
};

export default function VideoWorkbenchPanel({ notify }: { notify: (message: string) => void }) {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [workflow, setWorkflow] = useState<VideoWorkflow>('script-to-video');
  const [platform, setPlatform] = useState<VideoPlatform>('douyin');
  const [topicSeed, setTopicSeed] = useState('');
  const [step, setStep] = useState<WorkStep>('brief');
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState<Partial<VideoProject>>({});
  const [storyboardDraft, setStoryboardDraft] = useState<string | null>(null);
  const [progress, setProgress] = useState<VideoProgress | null>(null);
  const [assetBundle, setAssetBundle] = useState<VideoAssetBundle | null>(null);
  const [qualityReport, setQualityReport] = useState<VideoQualityReport | null>(null);
  const [sourcePath, setSourcePath] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState('简体中文');
  const [targetCode, setTargetCode] = useState('zh');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [logoPath, setLogoPath] = useState('');
  const [bgmMode, setBgmMode] = useState<VideoBgmMode>('none');
  const [bgmVolume, setBgmVolume] = useState(12);
  const [bgmStyle, setBgmStyle] = useState<VideoBgmStyle>('auto');
  const [bgmDucking, setBgmDucking] = useState(true);
  const [bgmFadeIn, setBgmFadeIn] = useState(0.6);
  const [bgmFadeOut, setBgmFadeOut] = useState(2);

  const selected = projects.find(project => project.id === selectedId) ?? null;
  const shots = useMemo(
    () => parseVideoShots(storyboardDraft ?? selected?.storyboardJson ?? ''),
    [selected?.storyboardJson, storyboardDraft]
  );
  const profile = WORKFLOWS.find(item => item.value === workflow) ?? WORKFLOWS[0];
  const resolvedBgmStyle = resolveVideoBgmStyle(
    { workflow, bgmStyle },
    `${String(draft.title ?? selected?.title ?? '')} ${String(draft.topic ?? selected?.topic ?? '')} ${String(draft.audience ?? selected?.audience ?? '')} ${String(draft.script ?? selected?.script ?? '')} ${selected?.options.productResearch ?? ''}`
  );
  const resolvedBgmStyleLabel = VIDEO_BGM_STYLES.find(item => item.value === resolvedBgmStyle)?.label ?? '明亮成长';
  const progressPercent = progress?.total ? Math.min(100, Math.max(0, progress.done / progress.total * 100)) : 0;
  const qualityWarnings = qualityReport?.checks.filter(check => check.status === 'warn').length ?? 0;
  const qualityErrors = qualityReport?.checks.filter(check => check.status === 'error').length ?? 0;
  const currentStepIndex = Math.max(0, STEPS.findIndex(item => item.value === step));
  const outputSpec = videoFrameSpec(platform);
  const stepStates = useMemo((): Record<WorkStep, StepState> => {
    if (!selected) return Object.fromEntries(STEPS.map(item => [item.value, 'pending'])) as Record<WorkStep, StepState>;
    const savedShots = parseVideoShots(selected.storyboardJson).length;
    const video = selected.assets.video;
    const visualsReady = selected.options.workflow === 'product-demo'
      ? selected.options.productScreenshots.length > 0
      : savedShots > 0 && selected.assets.images.length >= savedShots;
    return {
      brief: (selected.title || selected.topic).trim() ? 'done' : 'pending',
      script: selected.script.trim() ? 'done' : 'pending',
      storyboard: savedShots ? 'done' : 'pending',
      voice: savedShots && selected.assets.audio.length >= savedShots ? 'done' : 'pending',
      visuals: visualsReady ? 'done' : 'pending',
      render: !video ? 'pending' : !isRenderFresh(selected) || qualityErrors ? 'attention' : 'done',
      cover: assetBundle?.cover ? 'done' : 'pending',
      deliver: selected.exportPath ? 'done' : 'pending'
    };
  }, [selected, assetBundle?.cover, qualityErrors]);
  const progressTasks = progress?.labels?.length ? progress.labels.map((label, index) => ({
    key: `${index}-${label}`,
    label,
    state: index < progress.done ? 'done' as const : index === progress.done ? busy ? 'running' as const : 'failed' as const : 'pending' as const
  })) : null;

  const refresh = useCallback(async () => {
    const next = await window.sydney.listVideoProjects();
    setProjects(next);
    setSelectedId(current => current !== null && next.some(item => item.id === current) ? current : next[0]?.id ?? null);
  }, []);
  useEffect(() => { void refresh().catch(error => notify(readableError(error))); }, [refresh, notify]);
  useEffect(() => {
    if (!selected) return;
    setWorkflow(selected.options.workflow ?? 'script-to-video');
    setSourcePath(selected.options.sourcePath ?? '');
    setSourceLanguage(selected.options.sourceLanguage ?? 'auto');
    setTargetLanguage(selected.options.targetLanguage ?? '简体中文');
    setTargetCode(selected.options.targetCode ?? 'zh');
    setWebsiteUrl(selected.options.websiteUrl ?? '');
    setLogoPath(selected.options.logoPath ?? '');
    setPlatform(selected.platform);
    setDraft({ title: selected.title, topic: selected.topic, audience: selected.audience, durationSeconds: selected.durationSeconds, script: selected.script, storyboardJson: selected.storyboardJson });
  }, [selectedId]);
  useEffect(() => {
    setStoryboardDraft(null);
    setProgress(null);
    setAssetBundle(null);
    setQualityReport(selected && isQualityFresh(selected) ? selected.assets.quality : null);
    if (selectedId === null) return;
    void window.sydney.getVideoAssets(selectedId).then(setAssetBundle).catch(error => notify(readableError(error)));
    return window.sydney.onVideoProgress(event => {
      if (event.id === selectedId) setProgress(event);
    });
  }, [selectedId]);
  useEffect(() => {
    if (!selected) return;
    setBgmMode(selected.options.bgmMode ?? 'none');
    setBgmVolume(selected.options.bgmVolume);
    setBgmStyle(selected.options.bgmStyle ?? 'auto');
    setBgmDucking(selected.options.bgmDucking ?? true);
    setBgmFadeIn(selected.options.bgmFadeIn ?? 0.6);
    setBgmFadeOut(selected.options.bgmFadeOut ?? 2);
  }, [
    selectedId, selected?.options.bgmMode, selected?.options.bgmVolume, selected?.options.bgmStyle,
    selected?.options.bgmDucking, selected?.options.bgmFadeIn, selected?.options.bgmFadeOut
  ]);

  const replace = (next: VideoProject) => setProjects(items => items.map(item => item.id === next.id ? next : item));
  const run = async (name: string, action: () => Promise<VideoProject | void>) => {
    setBusy(name);
    setProgress(null);
    if (name !== 'quality' && name !== 'open-video') setQualityReport(null);
    try {
      const result = await action();
      if (result) {
        replace(result);
        setQualityReport(isQualityFresh(result) ? result.assets.quality : null);
        const assets = await window.sydney.getVideoAssets(result.id);
        setAssetBundle(assets);
      }
    } catch (error) { notify(readableError(error)); } finally { setBusy(''); }
  };
  const videoOptions = (project: VideoProject) => ({
    ...project.options, workflow, sourcePath, websiteUrl, logoPath,
    sourceLanguage, targetLanguage, targetCode,
    skillInputSignature: sourcePath === project.options.sourcePath && workflow === project.options.workflow
      ? project.options.skillInputSignature
      : '',
    bgmMode, bgmVolume, bgmStyle, bgmDucking, bgmFadeIn, bgmFadeOut
  });
  const persistDraft = async () => {
    if (!selected) throw new Error('请先选择项目');
    const next = await window.sydney.updateVideoProject(selected.id, { ...draft, platform, options: videoOptions(selected) });
    setStoryboardDraft(null);
    replace(next);
    return next;
  };
  const create = () => void run('create', async () => {
    const project = await window.sydney.createVideoProject(platform, topicSeed);
    const saved = await window.sydney.updateVideoProject(project.id, { options: videoOptions(project) });
    setProjects(items => [saved, ...items]); setSelectedId(saved.id); setStep('brief'); setTopicSeed('');
    notify('已创建视频工作台项目'); return saved;
  });
  const save = () => void run('save', async () => {
    const next = await persistDraft();
    notify('项目已保存'); return next;
  });
  const generate = (stage: VideoStage) => void run(stage, async () => {
    if (!selected) return;
    await persistDraft();
    const next = await window.sydney.generateVideoStage(selected.id, stage);
    replace(next); setStep(stage === 'topics' ? 'brief' : stage); notify(`${stage === 'topics' ? '选题' : stage === 'script' ? '脚本' : '分镜'}已生成`); return next;
  });
  const production = (name: string, action: () => Promise<VideoProject>) => void run(name, action);
  const productionWithSavedDraft = (name: string, action: (project: VideoProject) => Promise<VideoProject>) => production(name, async () => {
    const project = await persistDraft();
    return action(project);
  });

  const patchDraft = (patch: Partial<VideoProject>) => setDraft(current => ({ ...current, ...patch }));
  const editShot = (position: number, patch: Partial<VideoShot>) => {
    const next = shots.map((shot, index) => index === position ? { ...shot, ...patch } : shot);
    const storyboardJson = serializeVideoShots(next);
    setStoryboardDraft(storyboardJson);
    patchDraft({ storyboardJson });
  };
  const renderAction = () => productionWithSavedDraft('render', async project => {
    const next = await window.sydney.renderVideo(project.id);
    setStep('render');
    const report = next.assets.quality;
    const warnings = report?.checks.filter(check => check.status === 'warn').length ?? 0;
    notify(!report
      ? '成片已渲染，质量检查未完成，请手动检查'
      : !report.ok
        ? '成片已渲染，但质量检查发现必须处理的问题'
        : warnings ? `成片已渲染并通过检查，有 ${warnings} 项警告` : '成片已渲染并通过质量检查');
    return next;
  });
  const generateCover = () => productionWithSavedDraft('cover', project => window.sydney.generateVideoCover(project.id));
  const chooseCover = () => productionWithSavedDraft('cover', project => window.sydney.chooseVideoCover(project.id).then(next => next ?? project));
  const inspectQuality = () => void run('quality', async () => {
    if (!selected) throw new Error('请先选择项目');
    const report = await window.sydney.inspectVideoQuality(selected.id);
    setQualityReport(report);
    const warnings = report.checks.filter(check => check.status === 'warn').length;
    notify(report.ok ? warnings ? `成片检查通过，有 ${warnings} 项警告` : '成片检查通过' : '成片检查发现需要处理的问题');
  });
  const chooseLogo = () => void run('logo', async () => {
    const file = await window.sydney.chooseProductLogo();
    if (file) setLogoPath(file);
  });
  const captureProductAssets = () => void run('capture', async () => {
    if (!selected) throw new Error('请先选择项目');
    await persistDraft();
    const result = await window.sydney.runVideoWorkflow(selected.id);
    notify(result.message);
    if (result.status === 'blocked') throw new Error(result.message);
    const next = (await window.sydney.listVideoProjects()).find(project => project.id === selected.id);
    if (!next) throw new Error('抓取完成后找不到当前项目');
    replace(next);
    return next;
  });
  const analyzeProduct = () => void run('topics', async () => {
    if (!selected) throw new Error('请先选择项目');
    await persistDraft();
    const result = await window.sydney.runVideoWorkflow(selected.id);
    notify(result.message);
    if (result.status === 'blocked') throw new Error(result.message);
    const researched = (await window.sydney.listVideoProjects()).find(project => project.id === selected.id);
    if (!researched) throw new Error('抓取完成后找不到当前项目');
    replace(researched);
    const next = await window.sydney.generateVideoStage(selected.id, 'topics');
    replace(next);
    setStep('brief');
    notify('已根据官网公开资料生成产品内容方向');
    return next;
  });
  const runSkillWorkflow = () => void run('workflow', async () => {
    if (!selected) throw new Error('请先选择项目');
    await persistDraft();
    if (workflow === 'product-demo') {
      const result = await window.sydney.runVideoWorkflow(selected.id);
      notify(result.message);
      if (result.status === 'blocked') throw new Error(result.message);
      const researched = (await window.sydney.listVideoProjects()).find(project => project.id === selected.id);
      if (!researched) throw new Error('抓取完成后找不到当前项目');
      replace(researched);
      let current = await window.sydney.generateVideoStage(selected.id, 'script');
      replace(current);
      current = await window.sydney.generateVideoStage(selected.id, 'storyboard');
      replace(current);
      current = await window.sydney.generateVideoVoice(selected.id, false);
      replace(current);
      current = await window.sydney.renderVideoPreview(selected.id);
      replace(current);
      current = await window.sydney.renderVideo(current.id);
      replace(current);
      current = await window.sydney.exportVideoProject(current.id);
      replace(current);
      setStep('deliver'); notify('产品宣传片已生成并导出制作包'); return current;
    }
    if (workflow !== 'script-to-video') {
      const result = await window.sydney.runVideoWorkflow(selected.id);
      if (result.status === 'blocked') throw new Error(result.message);
      const refreshed = (await window.sydney.listVideoProjects()).find(project => project.id === selected.id);
      if (!refreshed) throw new Error('工作流完成后找不到当前项目');
      replace(refreshed);
      const exported = await window.sydney.exportVideoProject(refreshed.id);
      replace(exported);
      setStep('deliver');
      notify([result.message, ...(result.diagnostics ?? []), '制作包已自动导出'].join(' '));
      return exported;
    }
    let current = await window.sydney.generateVideoStage(selected.id, 'script');
    replace(current);
    current = await window.sydney.generateVideoStage(selected.id, 'storyboard');
    replace(current);
    current = await window.sydney.generateVideoVoice(selected.id, false);
    replace(current);
    current = await window.sydney.generateVideoImages(selected.id, false);
    replace(current);
    current = await window.sydney.renderVideoPreview(selected.id);
    replace(current);
    current = await window.sydney.renderVideo(current.id);
    replace(current);
    current = await window.sydney.exportVideoProject(current.id);
    replace(current);
    setStep('deliver'); notify('脚本成片工作流已完成并导出制作包'); return current;
  });

  return <section className="native-content video-panel video-workbench-panel video-studio">
    <header className="video-studio-header">
      <div className="video-studio-header-main">
        <p className="video-studio-kicker">VIDEO STUDIO / LOCAL PIPELINE</p>
        <h1>视频工作台</h1>
        <p>把脚本、声音、画面和成片放进同一条制作轨道，按镜头推进，最后交付一个可检查的文件。</p>
      </div>
      <div className="video-studio-header-meta">
        <span><i />本机制作</span>
        <strong>不代发布</strong>
        <small>导出前由你确认每个版本</small>
      </div>
    </header>

    <section className="video-studio-intake">
      <div className="video-intake-head"><div><span className="video-section-label">01 / START A PROJECT</span><h2>选择一条制作路线</h2><p>路线决定输入方式和自动化程度，项目创建后仍可以逐步手动调整。</p></div><span className="video-route-count">5 ROUTES</span></div>
      <div className="video-workflow-grid video-workflow-deck">{WORKFLOWS.map((item, index) => <button key={item.value} type="button" className={`video-workflow-card video-route-card ${workflow === item.value ? 'is-active' : ''}`} onClick={() => setWorkflow(item.value)}>
        <b>{String(index + 1).padStart(2, '0')}</b><strong>{item.label}</strong><span>{item.description}</span><small>{item.engine}</small><em>{item.detail}</em>
      </button>)}</div>
      <div className={`video-workbench-create-row video-intake-form ${workflow === 'product-demo' ? 'is-product-demo' : ''}`}>
        <label><span>输出平台</span><select value={platform} onChange={event => setPlatform(event.target.value as VideoPlatform)} disabled={Boolean(busy)}>{PLATFORMS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        {workflow === 'product-demo' ? <>
          <label className="video-create-field"><span>产品官网 URL</span><input value={websiteUrl} onChange={event => setWebsiteUrl(event.target.value)} disabled={Boolean(busy)} placeholder="https://example.com" /></label>
          <label className="video-create-field"><span>品牌 Logo</span><input value={logoPath} onChange={event => setLogoPath(event.target.value)} disabled={Boolean(busy)} placeholder="选择 PNG、JPG、WebP 或 SVG" /></label>
          <button className="button button-secondary video-create-action" type="button" disabled={Boolean(busy)} onClick={chooseLogo}>选择 Logo</button>
        </> : <label className="native-topic-seed"><span>项目入口（主题、素材说明或语言需求）</span><input value={topicSeed} onChange={event => setTopicSeed(event.target.value)} disabled={Boolean(busy)} placeholder="例如：把这个主题做成 40 秒短视频" /></label>}
        <button className="button button-primary video-create-project" disabled={Boolean(busy)} onClick={create}>{busy === 'create' ? '创建中…' : '新建工作台项目'}</button>
      </div>
    </section>

    <div className="video-studio-layout">
      <aside className="native-task-list video-project-rail"><div className="video-rail-head"><div><span className="video-section-label">PROJECTS</span><h2>项目库</h2></div><span>{projects.length}</span></div>{projects.length ? projects.map(project => <button type="button" key={project.id} className={`native-task video-project-card ${project.id === selectedId ? 'is-selected' : ''}`} onClick={() => { setSelectedId(project.id); setStep('brief'); }}><i>{project.id === selectedId ? '●' : '○'}</i><strong>{project.title || project.topic || '未命名项目'}</strong><span>{WORKFLOWS.find(item => item.value === project.options.workflow)?.label ?? '脚本 → 成片'} · {project.platform}</span><small>{project.status === 'exported' ? '已交付' : project.status === 'storyboard' ? '已有分镜' : project.status === 'script' ? '已有脚本' : '待开始'}</small></button>) : <EmptyState compact icon="video" title="还没有项目">在上方选一条制作路线，再点「新建工作台项目」。</EmptyState>}<div className="video-rail-note"><span>工作方式</span><strong>逐镜生产</strong><small>生成的配音、画面和渲染结果会按内容哈希复用，修改一镜只重做一镜。</small></div></aside>

      <main className="native-editor video-editor-deck">{selected ? <>
        <div className="native-editor-head video-editor-header"><div><p className="video-studio-kicker">{profile.label} / {profile.engine}</p><h2>{selected.title || selected.topic || '未命名项目'}</h2><p>{profile.description}</p></div><div className="native-editor-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={runSkillWorkflow}>{busy === 'workflow' ? '工作流执行中…' : workflow === 'product-demo' ? '官网 + Logo 一键成片' : '运行当前 Skill 工作流'}</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? '保存中…' : '保存项目'}</button></div></div>
        <Stepper label="视频工作流步骤" active={step} onSelect={setStep} steps={STEPS.map(item => ({ ...item, state: stepStates[item.value] }))} />
        {progress && progressTasks && <TaskList title={PROGRESS_TASK_LABELS[progress.task]} summary={progress.message} items={progressTasks} />}
        {progress && !progressTasks && <div className="video-render-progress" role="status" aria-live="polite">
          <div><span>{PROGRESS_TASK_LABELS[progress.task]}</span><strong>{progress.message}</strong><em>{progress.done}/{progress.total}</em></div>
          <div className="video-render-progress-track"><i style={{ width: `${progressPercent}%` }} /></div>
        </div>}

        {step === 'brief' && <section className="flow-panel">
          <header className="flow-panel-head"><div><h3>项目简报</h3><p>{workflow === 'product-demo' ? '只需要产品官网和品牌 Logo；工作台会抓取公开页面、整理事实并自动生成产品片。' : '把目标、受众和素材入口写清楚，后续每个技能都从这里读取。'}</p></div></header>
          <div className="native-task-fields">
            <label><span>项目标题</span><input value={String(draft.title ?? '')} onChange={event => patchDraft({ title: event.target.value })} placeholder={workflow === 'product-demo' ? '留空时自动使用官网标题' : ''} /></label>
            <label><span>目标时长（秒）</span><input type="number" min={5} value={Number(draft.durationSeconds ?? selected.durationSeconds)} onChange={event => patchDraft({ durationSeconds: Number(event.target.value) })} /></label>
            <label><span>目标受众</span><input value={String(draft.audience ?? '')} onChange={event => patchDraft({ audience: event.target.value })} placeholder={workflow === 'product-demo' ? '第一次了解这个产品的人' : '例如：第一次接触这个主题的人'} /></label>
            <label className="native-field-wide"><span>{workflow === 'product-demo' ? '补充要求（可选）' : '主题 / 素材说明 / 语言需求'}</span><textarea value={String(draft.topic ?? '')} onChange={event => patchDraft({ topic: event.target.value })} placeholder={workflow === 'product-demo' ? '例如：突出团队协作和移动端体验；不要写价格' : ''} /></label>
            {workflow === 'product-demo' ? <>
              <label className="native-field-wide"><span>产品官网 URL</span><input value={websiteUrl} onChange={event => setWebsiteUrl(event.target.value)} placeholder="https://example.com" /></label>
              <label className="native-field-wide"><span>品牌 Logo</span><input value={logoPath} onChange={event => setLogoPath(event.target.value)} placeholder="选择 PNG、JPG、WebP 或 SVG" /></label>
              <div className="video-logo-picker"><button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={chooseLogo}>{busy === 'logo' ? '选择中…' : '选择 Logo 文件'}</button><span>{logoPath ? logoPath : 'Logo 会在每镜右上角展示'}</span></div>
            </> : <>
              <label className="native-field-wide"><span>Skill 输入路径（视频文件、浏览器配置或字幕/音频文件）</span><input value={sourcePath} onChange={event => setSourcePath(event.target.value)} placeholder="例如：D:\\Videos\\raw.mp4 或 browser-demo.json" /></label>
              {workflow === 'localize' && <>
                <label><span>源语言</span><input value={sourceLanguage} onChange={event => setSourceLanguage(event.target.value)} placeholder="auto 或 zh、en、ja" /></label>
                <label><span>目标语言</span><input value={targetLanguage} onChange={event => setTargetLanguage(event.target.value)} placeholder="简体中文" /></label>
                <label><span>目标语言代码</span><input value={targetCode} onChange={event => setTargetCode(event.target.value)} placeholder="zh" /></label>
              </>}
            </>}
          </div>
          {workflow === 'product-demo' && <div className="workbench-status-grid">
            <div><strong>{selected.options.productScreenshots.length}</strong><span>已保存官网截图</span></div>
            <div><strong>{selected.options.productResearch ? '已抓取' : '待抓取'}</strong><span>官网公开资料</span></div>
            <div><strong>{selected.options.brandColors.length}</strong><span>品牌色候选</span></div>
          </div>}
          <div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={workflow === 'product-demo' ? analyzeProduct : () => generate('topics')}>{busy === 'topics' ? '生成中…' : workflow === 'product-demo' ? '抓取官网并生成方向' : '生成方向与选题建议'}</button><button className="button button-quiet" onClick={() => setStep('script')}>直接进入脚本 →</button></div>
        </section>}
        {step === 'script' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>脚本工作区</h3><p>可以让模型写，也可以直接粘贴已有脚本；保存后再生成分镜。</p></div></header><textarea className="flow-draft" value={String(draft.script ?? selected.script)} onChange={event => patchDraft({ script: event.target.value })} placeholder="在这里写口播、旁白或视频脚本…" /><div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={() => generate('script')}>{busy === 'script' ? '生成中…' : 'AI 生成脚本'}</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={save}>保存脚本</button></div></section>}
        {step === 'storyboard' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>分镜工作区</h3><p>逐镜修改作用、时长、画面大字、口播、画面说明和配图提示词；保存后配音、配图和成片会按新内容重新校验。</p></div></header>{shots.length ? <div className="flow-table-wrap"><table className="flow-table video-storyboard-table" aria-label="可编辑分镜表"><thead><tr><th>镜号</th><th>作用</th><th>预计秒数</th><th>画面大字</th><th>口播</th><th>画面说明</th><th>配图提示词</th></tr></thead><tbody>{shots.map((shot, position) => <tr key={`${shot.index}-${position}`}>
          <td>{shot.index}</td>
          <td><select className="flow-table-control" value={shot.role ?? ''} onChange={event => editShot(position, { role: event.target.value as VideoShotRole | '' })}><option value="">未分类</option>{VIDEO_SHOT_ROLES.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></td>
          <td><input className="flow-table-control video-shot-seconds" type="number" min={1} max={60} value={shot.seconds} onChange={event => editShot(position, { seconds: Math.min(60, Math.max(1, Number(event.target.value) || 1)) })} /></td>
          <td><input className="flow-table-control" value={shot.caption} onChange={event => editShot(position, { caption: event.target.value })} placeholder="画面大字" /></td>
          <td><textarea className="flow-table-control" rows={3} value={shot.narration} onChange={event => editShot(position, { narration: event.target.value })} placeholder="这一镜的口播" /></td>
          <td><textarea className="flow-table-control" rows={3} value={shot.visual} onChange={event => editShot(position, { visual: event.target.value })} placeholder="拍什么、用什么素材" /></td>
          <td><textarea className="flow-table-control" rows={3} value={shot.imagePrompt ?? ''} onChange={event => editShot(position, { imagePrompt: event.target.value })} placeholder="留空时使用画面说明" /></td>
        </tr>)}</tbody></table></div> : <p className="flow-empty">还没有分镜。</p>}<div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={() => generate('storyboard')}>{busy === 'storyboard' ? '生成中…' : '生成 / 重做分镜'}</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? '保存中…' : '保存分镜'}</button></div></section>}
        {step === 'voice' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>声音与字幕</h3><p>配音后以真实音频时长生成字幕时间轴；BGM 会循环、按口播自动闪避，并做片头片尾淡变。</p></div></header><div className="workbench-status-grid"><div><strong>{selected.assets.audio.length}</strong><span>已有配音片段</span></div><div><strong>{shots.length}</strong><span>镜头</span></div><div><strong>{bgmMode === 'auto' ? resolvedBgmStyleLabel : bgmMode === 'custom' ? '本地音乐' : '关闭'}</strong><span>{bgmMode === 'auto' ? `自动原创 · ${bgmStyle === 'auto' ? '跟随内容' : '指定风格'}` : '背景音乐'}</span></div></div>
          <div className="video-audio-options">
            <label><span>BGM 来源</span><select value={bgmMode} onChange={event => setBgmMode(event.target.value as VideoBgmMode)} disabled={Boolean(busy)}><option value="auto">自动原创（本地生成）</option><option value="custom">本地音乐</option><option value="none">关闭 BGM</option></select></label>
            <label><span>BGM 风格</span><select value={bgmStyle} onChange={event => setBgmStyle(event.target.value as VideoBgmStyle)} disabled={Boolean(busy) || bgmMode !== 'auto'}>{VIDEO_BGM_STYLES.map(item => <option key={item.value} value={item.value}>{item.label} · {item.hint}</option>)}</select></label>
            <label><span>BGM 音量（%）</span><input type="number" min={0} max={100} value={bgmVolume} onChange={event => setBgmVolume(Math.min(100, Math.max(0, Number(event.target.value) || 0)))} disabled={Boolean(busy) || bgmMode === 'none'} /></label>
            <label><span>淡入（秒）</span><input type="number" min={0} max={10} step={0.1} value={bgmFadeIn} onChange={event => setBgmFadeIn(Math.min(10, Math.max(0, Number(event.target.value) || 0)))} disabled={Boolean(busy) || bgmMode === 'none'} /></label>
            <label><span>淡出（秒）</span><input type="number" min={0} max={10} step={0.1} value={bgmFadeOut} onChange={event => setBgmFadeOut(Math.min(10, Math.max(0, Number(event.target.value) || 0)))} disabled={Boolean(busy) || bgmMode === 'none'} /></label>
            <label className="video-checkbox-field"><input type="checkbox" checked={bgmDucking} onChange={event => setBgmDucking(event.target.checked)} disabled={Boolean(busy) || bgmMode === 'none'} /><span>旁白出现时自动压低 BGM</span></label>
            <div className="video-bgm-picker"><button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => void run('bgm', async () => { const next = await window.sydney.chooseVideoBgm(selected.id); if (!next) return; replace(next); setBgmMode('custom'); setBgmVolume(next.options.bgmVolume); notify('已选择本地背景音乐'); return next; })}>{busy === 'bgm' ? '选择中…' : '选择本地音乐'}</button><span>{bgmMode === 'auto' ? `首次渲染时离线生成 16 秒原创循环音乐；当前匹配「${resolvedBgmStyleLabel}」` : bgmMode === 'custom' ? selected.options.bgmPath || '尚未选择音乐文件' : '成片只保留配音和环境声'}</span></div>
          </div>
          <div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={() => productionWithSavedDraft('voice', project => window.sydney.generateVideoVoice(project.id, false))}>{busy === 'voice' ? '处理中…' : '生成 / 补齐配音'}</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? '保存中…' : '保存声音设置'}</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={() => setStep('visuals')}>进入画面 →</button></div>
        </section>}
        {step === 'visuals' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>画面素材</h3><p>{workflow === 'product-demo' ? '官网截图会按镜头循环使用，Logo 和品牌色叠加到统一画面模板。' : '选择模板、生成逐镜配图，并先生成关键帧预览。'}</p></div></header><div className="workbench-status-grid"><div><strong>{workflow === 'product-demo' ? selected.options.productScreenshots.length : `${selected.assets.images.length}/${shots.length}`}</strong><span>{workflow === 'product-demo' ? '官网截图' : '配图覆盖'}</span></div><div><strong>{assetBundle?.preview.length ?? 0}</strong><span>关键帧预览</span></div><div><strong>{workflow === 'product-demo' ? selected.options.brandColors.length : selected.options.template}</strong><span>{workflow === 'product-demo' ? '品牌色候选' : '当前模板'}</span></div></div><div className="flow-inline-actions">{workflow === 'product-demo' ? <button className="button button-primary" disabled={Boolean(busy)} onClick={captureProductAssets}>{busy === 'capture' ? '抓取中…' : '重新抓取官网素材'}</button> : <button className="button button-primary" disabled={Boolean(busy)} onClick={() => productionWithSavedDraft('images', project => window.sydney.generateVideoImages(project.id, false))}>{busy === 'images' ? '生成中…' : '生成缺失配图'}</button>}<button className="button button-secondary" disabled={Boolean(busy) || !shots.length} onClick={() => productionWithSavedDraft('preview', project => window.sydney.renderVideoPreview(project.id))}>{busy === 'preview' ? '预览中…' : '生成关键帧预览'}</button></div>{assetBundle?.preview.length ? <div className="video-frame-grid video-workbench-preview-grid">{assetBundle.preview.map((thumbnail, index) => <figure key={`${index}-${thumbnail.slice(-16)}`}><img src={thumbnail} alt={`第 ${index + 1} 个关键帧`} /><figcaption>关键帧 {index + 1}</figcaption></figure>)}</div> : <p className="flow-empty">还没有关键帧预览，先生成预览再检查版式。</p>}</section>}
        {step === 'render' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>成片与质量检查</h3><p>渲染完成后自动检查平台规格、黑帧、静音、音画时间轴、安全区和封面；硬错误会阻止导出。</p></div></header><div className="workbench-status-grid"><div><strong>{selected.assets.video ? isRenderFresh(selected) ? '有效' : '已过期' : '未生成'}</strong><span>成片</span></div><div><strong>{selected.assets.video ? `${Math.round(selected.assets.video.seconds)} 秒` : videoFrameSpec(platform).label}</strong><span>{selected.assets.video ? videoFrameSpec(platform).label : '输出规格'}</span></div><div><strong>{qualityReport ? qualityReport.ok ? qualityWarnings ? `${qualityWarnings} 项警告` : '全部通过' : `${qualityErrors} 项错误` : assetBundle?.videoPath ? '待检查' : '未生成'}</strong><span>质量验收</span></div></div><div className="video-render-output"><span>输出文件</span><code>{assetBundle?.videoPath || '渲染后会显示 MP4 路径'}</code></div><div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={workflow === 'script-to-video' || workflow === 'product-demo' ? renderAction : runSkillWorkflow}>{busy === 'render' || busy === 'workflow' ? '处理中…' : workflow === 'script-to-video' || workflow === 'product-demo' ? '渲染成片' : '运行 Skill 成片'}</button><button className="button button-secondary" disabled={Boolean(busy) || !selected.assets.video} onClick={inspectQuality}>{busy === 'quality' ? '检查中…' : '检查成片'}</button>{selected.assets.video && <button className="button button-secondary" disabled={Boolean(busy)} onClick={() => production('open-video', () => window.sydney.openVideoFile(selected.id).then(() => selected))}>打开成片</button>}</div>{qualityReport && <div className="video-quality-report"><div className={`video-quality-summary ${!qualityReport.ok ? 'is-error' : qualityWarnings ? 'is-warn' : 'is-ok'}`}><strong>{qualityReport.ok ? qualityWarnings ? `检查通过，有 ${qualityWarnings} 项警告` : '检查通过' : `存在 ${qualityErrors} 项必须处理的问题`}</strong><span>{qualityReport.width}×{qualityReport.height} · {qualityReport.seconds.toFixed(2)} 秒 · {qualityReport.hasAudio ? '含音频' : '无音频'} · 检查于 {new Date(qualityReport.inspectedAt).toLocaleString()}</span></div><ul>{qualityReport.checks.map(check => <li key={check.key} className={`is-${check.status}`}><strong>{check.label}</strong><span>{check.detail}</span></li>)}</ul></div>}</section>}
        {step === 'cover' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>封面工作区</h3><p>封面是可选交付物，可以用 AI 根据标题生成，也可以选择本地图片；生成后会自动带入制作包。</p></div></header>{assetBundle?.cover?.thumbnail ? <figure className="video-cover-preview"><img src={assetBundle.cover.thumbnail} alt="当前视频封面" /><figcaption>{assetBundle.cover.path}</figcaption></figure> : <p className="flow-empty">还没有封面。</p>}<div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy) || !(selected.title || selected.topic).trim()} onClick={generateCover}>{busy === 'cover' ? '处理中…' : 'AI 生成封面'}</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={chooseCover}>{busy === 'cover' ? '处理中…' : '选择本地封面'}</button></div></section>}
        {step === 'deliver' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>交付</h3><p>导出 MP4 或制作包；有硬错误时会先要求修复，警告会随制作包留档。工作台不会自动上传到抖音等平台。</p></div></header><div className="flow-checklist"><div className={selected.script.trim() ? 'is-ok' : 'is-missing'}>脚本 {selected.script.trim() ? '✓' : '○'}</div><div className={shots.length ? 'is-ok' : 'is-missing'}>分镜 {shots.length ? '✓' : '○'}</div><div className={selected.assets.video && isRenderFresh(selected) ? 'is-ok' : 'is-missing'}>成片 {selected.assets.video ? isRenderFresh(selected) ? '✓' : '已过期' : '○'}</div><div className={selected.assets.video && qualityReport?.ok ? 'is-ok' : 'is-missing'}>质量 {qualityReport ? qualityReport.ok ? qualityWarnings ? `通过 · ${qualityWarnings} 项警告` : '通过' : `${qualityErrors} 项错误` : selected.assets.video ? '待检查' : '○'}</div></div><div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy) || !selected.assets.video || !isRenderFresh(selected)} onClick={() => production('save-mp4', async () => { await window.sydney.saveVideoMp4(selected.id); notify('已导出 MP4'); return selected; })}>另存 MP4</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={() => production('export', async () => { const next = await window.sydney.exportVideoProject(selected.id); notify('制作包已导出'); return next; })}>导出制作包</button><button className="button button-secondary" disabled={Boolean(busy) || !selected.assets.video} onClick={inspectQuality}>{busy === 'quality' ? '检查中…' : '重新检查成片'}</button>{selected.exportPath && <button className="button button-quiet" onClick={() => void window.sydney.openVideoPackage(selected.id)}>打开制作包</button>}</div></section>}
      </> : <EmptyState icon="video" title="创建第一个视频工作台项目">选择生产路径，输入主题或素材说明，然后开始。</EmptyState>}</main>

      <aside className="video-inspector-rail">
        {selected ? <>
          <div className="video-inspector-head"><span className="video-section-label">INSPECTOR</span><span className="video-live-dot">LIVE</span></div>
          <div className="video-inspector-title"><strong>{selected.title || selected.topic || '未命名项目'}</strong><span>{platform.toUpperCase()} · {outputSpec.label}</span></div>
          <div className="video-inspector-metrics">
            <div><strong>{currentStepIndex + 1}<small> / {STEPS.length}</small></strong><span>当前步骤</span></div>
            <div><strong>{shots.length || '—'}</strong><span>镜头</span></div>
            <div><strong>{selected.assets.audio.length || '—'}</strong><span>音频片段</span></div>
            <div><strong>{selected.assets.images.length || '—'}</strong><span>画面素材</span></div>
          </div>
          <div className="video-inspector-section"><span className="video-section-label">DELIVERY CHECK</span><div className="video-check-row"><i className={selected.script.trim() ? 'is-ready' : ''} />脚本<span>{selected.script.trim() ? 'READY' : 'EMPTY'}</span></div><div className="video-check-row"><i className={shots.length ? 'is-ready' : ''} />分镜<span>{shots.length ? 'READY' : 'EMPTY'}</span></div><div className="video-check-row"><i className={selected.assets.video && isRenderFresh(selected) ? 'is-ready' : ''} />成片<span>{selected.assets.video && isRenderFresh(selected) ? 'READY' : 'PENDING'}</span></div><div className="video-check-row"><i className={qualityReport?.ok ? 'is-ready' : ''} />质量<span>{qualityReport?.ok ? 'PASSED' : 'CHECK'}</span></div></div>
          <div className="video-inspector-section video-inspector-next"><span className="video-section-label">NEXT MOVE</span><strong>{STEPS[currentStepIndex]?.label}</strong><p>{STEPS[currentStepIndex]?.hint}</p><button type="button" className="video-next-button" onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, currentStepIndex + 1)].value)} disabled={currentStepIndex === STEPS.length - 1}>继续下一步 <span>→</span></button></div>
        </> : <EmptyState compact icon="layers" title="等待项目">创建一个项目后，这里会显示交付状态、素材数量和下一步动作。</EmptyState>}
      </aside>
    </div>
  </section>;
}
