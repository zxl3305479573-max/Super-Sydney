import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  VIDEO_BGM_STYLES, resolveVideoBgmStyle,
  type VideoBgmMode, type VideoBgmStyle, type VideoPlatform, type VideoProject, type VideoStage, type VideoWorkflow
} from '../shared';
import { isRenderFresh, parseVideoShots } from '../services/video-pipeline';
import { readableError } from './ui';

type WorkStep = 'brief' | 'script' | 'storyboard' | 'voice' | 'visuals' | 'render' | 'deliver';
type WorkflowCard = { value: VideoWorkflow; label: string; description: string; engine: string; detail: string };

const WORKFLOWS: WorkflowCard[] = [
  { value: 'script-to-video', label: '脚本 → 成片', description: '从主题、脚本和分镜生成完整短视频。', engine: 'HyperFrames + TTS + FFmpeg', detail: '适合知识视频、口播、清单和 Shorts。' },
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
  { value: 'deliver', label: '交付', hint: '导出 MP4 和制作包' }
];

const PLATFORMS: Array<{ value: VideoPlatform; label: string }> = [
  { value: 'douyin', label: '抖音' }, { value: 'shipinhao', label: '视频号' },
  { value: 'xiaohongshu', label: '小红书' }, { value: 'bilibili', label: 'B 站' }, { value: 'general', label: '通用' }
];

export default function VideoWorkbenchPanel({ notify }: { notify: (message: string) => void }) {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [workflow, setWorkflow] = useState<VideoWorkflow>('script-to-video');
  const [platform, setPlatform] = useState<VideoPlatform>('douyin');
  const [topicSeed, setTopicSeed] = useState('');
  const [step, setStep] = useState<WorkStep>('brief');
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState<Partial<VideoProject>>({});
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
  const shots = useMemo(() => parseVideoShots(selected?.storyboardJson ?? ''), [selected?.storyboardJson]);
  const profile = WORKFLOWS.find(item => item.value === workflow) ?? WORKFLOWS[0];
  const resolvedBgmStyle = resolveVideoBgmStyle(
    { workflow, bgmStyle },
    `${String(draft.title ?? selected?.title ?? '')} ${String(draft.topic ?? selected?.topic ?? '')} ${String(draft.audience ?? selected?.audience ?? '')} ${String(draft.script ?? selected?.script ?? '')} ${selected?.options.productResearch ?? ''}`
  );
  const resolvedBgmStyleLabel = VIDEO_BGM_STYLES.find(item => item.value === resolvedBgmStyle)?.label ?? '明亮成长';

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
    try { const result = await action(); if (result) replace(result); } catch (error) { notify(readableError(error)); } finally { setBusy(''); }
  };
  const videoOptions = (project: VideoProject) => ({
    ...project.options, workflow, sourcePath, websiteUrl, logoPath,
    sourceLanguage, targetLanguage, targetCode,
    skillInputSignature: sourcePath === project.options.sourcePath && workflow === project.options.workflow
      ? project.options.skillInputSignature
      : '',
    bgmMode, bgmVolume, bgmStyle, bgmDucking, bgmFadeIn, bgmFadeOut
  });
  const create = () => void run('create', async () => {
    const project = await window.sydney.createVideoProject(platform, topicSeed);
    const saved = await window.sydney.updateVideoProject(project.id, { options: videoOptions(project) });
    setProjects(items => [saved, ...items]); setSelectedId(saved.id); setStep('brief'); setTopicSeed('');
    notify('已创建视频工作台项目'); return saved;
  });
  const save = () => void run('save', async () => {
    if (!selected) return;
    const next = await window.sydney.updateVideoProject(selected.id, { ...draft, platform, options: videoOptions(selected) });
    replace(next); notify('项目已保存'); return next;
  });
  const generate = (stage: VideoStage) => void run(stage, async () => {
    if (!selected) return;
    await window.sydney.updateVideoProject(selected.id, { ...draft, platform, options: videoOptions(selected) });
    const next = await window.sydney.generateVideoStage(selected.id, stage);
    replace(next); setStep(stage === 'topics' ? 'brief' : stage); notify(`${stage === 'topics' ? '选题' : stage === 'script' ? '脚本' : '分镜'}已生成`); return next;
  });
  const production = (name: string, action: () => Promise<VideoProject>) => void run(name, action);

  const patchDraft = (patch: Partial<VideoProject>) => setDraft(current => ({ ...current, ...patch }));
  const renderAction = () => production('render', async () => { if (!selected) throw new Error('请先选择项目'); await window.sydney.updateVideoProject(selected.id, { ...draft, options: videoOptions(selected) }); const next = await window.sydney.renderVideo(selected.id); setStep('render'); notify('成片已渲染'); return next; });
  const chooseLogo = () => void run('logo', async () => {
    const file = await window.sydney.chooseProductLogo();
    if (file) setLogoPath(file);
  });
  const captureProductAssets = () => void run('capture', async () => {
    if (!selected) throw new Error('请先选择项目');
    await window.sydney.updateVideoProject(selected.id, { ...draft, options: videoOptions(selected) });
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
    await window.sydney.updateVideoProject(selected.id, { ...draft, options: videoOptions(selected) });
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
    await window.sydney.updateVideoProject(selected.id, { ...draft, options: videoOptions(selected) });
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

  return <section className="native-content video-panel video-workbench-panel">
    <header className="ww-page-header">
      <div><p className="eyebrow">统一视频生产工作台</p><h1>视频工作台</h1><p>从创意、素材、脚本到成片和交付，在同一个项目里编排 HyperFrames、Remotion、video-use、字幕、配音与 FFmpeg。</p></div>
      <div className="ww-page-header-note"><strong>不代发布</strong><span>所有素材保存在本机，导出前由你确认</span></div>
    </header>

    <section className="video-workbench-create">
      <div className="video-workbench-section-head"><div><h2>选择生产路径</h2><p>先选你要做什么，工作台会保留同一套项目、预览和交付流程。</p></div><span className="chip chip-accent">5 条工作流</span></div>
      <div className="video-workflow-grid">{WORKFLOWS.map(item => <button key={item.value} type="button" className={`video-workflow-card ${workflow === item.value ? 'is-active' : ''}`} onClick={() => setWorkflow(item.value)}>
        <strong>{item.label}</strong><span>{item.description}</span><small>{item.engine}</small><em>{item.detail}</em>
      </button>)}</div>
      <div className="video-workbench-create-row">
        <label><span>输出平台</span><select value={platform} onChange={event => setPlatform(event.target.value as VideoPlatform)} disabled={Boolean(busy)}>{PLATFORMS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        {workflow === 'product-demo' ? <>
          <label className="native-topic-seed"><span>产品官网 URL</span><input value={websiteUrl} onChange={event => setWebsiteUrl(event.target.value)} disabled={Boolean(busy)} placeholder="https://example.com" /></label>
          <label className="native-topic-seed"><span>品牌 Logo</span><input value={logoPath} onChange={event => setLogoPath(event.target.value)} disabled={Boolean(busy)} placeholder="选择 PNG、JPG、WebP 或 SVG" /></label>
          <button className="button button-secondary" type="button" disabled={Boolean(busy)} onClick={chooseLogo}>选择 Logo</button>
        </> : <label className="native-topic-seed"><span>项目入口（主题、素材说明或语言需求）</span><input value={topicSeed} onChange={event => setTopicSeed(event.target.value)} disabled={Boolean(busy)} placeholder="例如：把这个主题做成 40 秒短视频" /></label>}
        <button className="button button-primary" disabled={Boolean(busy)} onClick={create}>{busy === 'create' ? '创建中…' : '新建工作台项目'}</button>
      </div>
    </section>

    <div className="native-layout video-workbench-layout">
      <aside className="native-task-list"><div className="native-list-head"><h2>项目</h2><span>{projects.length}</span></div>{projects.length ? projects.map(project => <button type="button" key={project.id} className={`native-task ${project.id === selectedId ? 'is-selected' : ''}`} onClick={() => { setSelectedId(project.id); setStep('brief'); }}><strong>{project.title || project.topic || '未命名项目'}</strong><span>{WORKFLOWS.find(item => item.value === project.options.workflow)?.label ?? '脚本 → 成片'} · {project.platform}</span><small>{project.status === 'exported' ? '已交付' : project.status === 'storyboard' ? '已有分镜' : project.status === 'script' ? '已有脚本' : '待开始'}</small></button>) : <p className="native-empty">还没有项目</p>}</aside>

      <main className="native-editor">{selected ? <>
        <div className="native-editor-head"><div><p className="eyebrow">{profile.label} · {profile.engine}</p><h2>{selected.title || selected.topic || '未命名项目'}</h2><p>{profile.description}</p></div><div className="native-editor-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={runSkillWorkflow}>{busy === 'workflow' ? '工作流执行中…' : workflow === 'product-demo' ? '官网 + Logo 一键成片' : '运行当前 Skill 工作流'}</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? '保存中…' : '保存项目'}</button></div></div>
        <nav className="video-workbench-stepper" aria-label="视频工作流步骤">{STEPS.map(item => <button type="button" key={item.value} className={step === item.value ? 'is-active' : ''} onClick={() => setStep(item.value)}><b>{STEPS.findIndex(value => value.value === item.value) + 1}</b><span>{item.label}<small>{item.hint}</small></span></button>)}</nav>

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
        {step === 'storyboard' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>分镜工作区</h3><p>每个镜头包含画面、旁白、字幕和配图提示词。</p></div></header>{shots.length ? <div className="flow-table-wrap"><table className="flow-table"><thead><tr><th>镜头</th><th>作用</th><th>画面大字</th><th>旁白</th><th>画面</th></tr></thead><tbody>{shots.map(shot => <tr key={shot.index}><td>{shot.index}</td><td>{shot.role || '—'}</td><td>{shot.caption || '—'}</td><td>{shot.narration || '—'}</td><td>{shot.visual || '—'}</td></tr>)}</tbody></table></div> : <p className="flow-empty">还没有分镜。</p>}<div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={() => generate('storyboard')}>{busy === 'storyboard' ? '生成中…' : '生成 / 重做分镜'}</button></div></section>}
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
          <div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={() => production('voice', () => window.sydney.generateVideoVoice(selected.id, false))}>{busy === 'voice' ? '处理中…' : '生成 / 补齐配音'}</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? '保存中…' : '保存声音设置'}</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={() => setStep('visuals')}>进入画面 →</button></div>
        </section>}
        {step === 'visuals' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>画面素材</h3><p>{workflow === 'product-demo' ? '官网截图会按镜头循环使用，Logo 和品牌色叠加到统一画面模板。' : '选择模板、生成逐镜配图，并先生成关键帧预览。'}</p></div></header><div className="workbench-status-grid"><div><strong>{workflow === 'product-demo' ? selected.options.productScreenshots.length : `${selected.assets.images.length}/${shots.length}`}</strong><span>{workflow === 'product-demo' ? '官网截图' : '配图覆盖'}</span></div><div><strong>{selected.assets.preview ? '可查看' : '未生成'}</strong><span>关键帧预览</span></div><div><strong>{workflow === 'product-demo' ? selected.options.brandColors.length : selected.options.template}</strong><span>{workflow === 'product-demo' ? '品牌色候选' : '当前模板'}</span></div></div><div className="flow-inline-actions">{workflow === 'product-demo' ? <button className="button button-primary" disabled={Boolean(busy)} onClick={captureProductAssets}>{busy === 'capture' ? '抓取中…' : '重新抓取官网素材'}</button> : <button className="button button-primary" disabled={Boolean(busy)} onClick={() => production('images', () => window.sydney.generateVideoImages(selected.id, false))}>{busy === 'images' ? '生成中…' : '生成缺失配图'}</button>}<button className="button button-secondary" disabled={Boolean(busy) || !shots.length} onClick={() => production('preview', () => window.sydney.renderVideoPreview(selected.id))}>{busy === 'preview' ? '预览中…' : '生成关键帧预览'}</button></div></section>}
        {step === 'render' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>成片与质量检查</h3><p>生成 MP4 后校验时长、画面和音频；外部 Skill 路径会保留原始素材快照。</p></div></header><div className="workbench-status-grid"><div><strong>{selected.assets.video ? isRenderFresh(selected) ? '有效' : '已过期' : '未生成'}</strong><span>成片</span></div><div><strong>{selected.assets.video ? `${Math.round(selected.assets.video.seconds)} 秒` : workflow === 'browser-demo' ? '4:3 → 平台规格' : '按平台'}</strong><span>输出规格</span></div><div><strong>FFmpeg</strong><span>本地校验</span></div></div><div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy)} onClick={workflow === 'script-to-video' || workflow === 'product-demo' ? renderAction : runSkillWorkflow}>{busy === 'render' || busy === 'workflow' ? '处理中…' : workflow === 'script-to-video' || workflow === 'product-demo' ? '渲染成片' : '运行 Skill 成片'}</button>{selected.assets.video && <button className="button button-secondary" disabled={Boolean(busy)} onClick={() => production('open-video', () => window.sydney.openVideoFile(selected.id).then(() => selected))}>打开成片</button>}</div></section>}
        {step === 'deliver' && <section className="flow-panel"><header className="flow-panel-head"><div><h3>交付</h3><p>导出 MP4 或制作包；工作台不会自动上传到抖音等平台。</p></div></header><div className="flow-checklist"><div className={selected.script.trim() ? 'is-ok' : 'is-missing'}>脚本 {selected.script.trim() ? '✓' : '○'}</div><div className={shots.length ? 'is-ok' : 'is-missing'}>分镜 {shots.length ? '✓' : '○'}</div><div className={selected.assets.video && isRenderFresh(selected) ? 'is-ok' : 'is-missing'}>成片 {selected.assets.video ? isRenderFresh(selected) ? '✓' : '已过期' : '○'}</div></div><div className="flow-inline-actions"><button className="button button-primary" disabled={Boolean(busy) || !selected.assets.video || !isRenderFresh(selected)} onClick={() => production('save-mp4', async () => { await window.sydney.saveVideoMp4(selected.id); notify('已导出 MP4'); return selected; })}>另存 MP4</button><button className="button button-secondary" disabled={Boolean(busy)} onClick={() => production('export', async () => { const next = await window.sydney.exportVideoProject(selected.id); notify('制作包已导出'); return next; })}>导出制作包</button>{selected.exportPath && <button className="button button-quiet" onClick={() => void window.sydney.openVideoPackage(selected.id)}>打开制作包</button>}</div></section>}
      </> : <div className="native-empty native-editor-empty"><strong>创建第一个视频工作台项目</strong><span>选择生产路径，输入主题或素材说明，然后开始。</span></div>}</main>
    </div>
  </section>;
}
