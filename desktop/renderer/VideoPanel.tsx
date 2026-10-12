import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VideoAssetBundle, VideoPlatform, VideoProject, VideoStage } from '../shared';
import {
  AUTO_VIDEO_STAGES, VIDEO_PLATFORMS, VIDEO_STEPS, autoVideoPlan, buildSrt, buildVideoPipeline, currentVideoStepKey,
  formatDuration, nextVideoStepKey, parseVideoShots, videoExportChecklist, videoPipelineProgress, videoPlatformLabel,
  type VideoStep, type VideoStepKey
} from '../services/video-pipeline';

const stageLabels: Record<VideoStage, string> = { topics: 'AI 生成候选选题', script: 'AI 写口播脚本', storyboard: 'AI 拆分镜' };
const statusNames: Record<string, string> = { idea: '选题', script: '已定脚本', storyboard: '已定分镜', exported: '已导出制作包' };
const stateNames: Record<VideoStep['state'], string> = { done: '已完成', current: '当前步骤', attention: '需处理', ready: '可进行', locked: '未解锁' };

type TopicSuggestion = { title: string; hook: string; angle: string; risk: string };

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '').trim() || '操作失败';
}

function readTopics(value: string): TopicSuggestion[] {
  try {
    const parsed = JSON.parse(value) as { topics?: Array<Record<string, unknown>> };
    return (parsed.topics ?? []).filter(item => typeof item?.title === 'string').map(item => ({
      title: String(item.title),
      hook: String(item.hook ?? ''),
      angle: String(item.angle ?? ''),
      risk: String(item.risk_note ?? item.risk ?? '')
    }));
  } catch { return []; }
}

function shortTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 16).replace('T', ' ') : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 口播字数 → 估算秒数（中文口播约每秒 4 字），用来判断脚本是否撑得起目标时长。 */
function estimatedSeconds(script: string): number {
  return Math.round(script.replace(/\s/g, '').length / 4);
}

export default function VideoPanel({ notify }: { notify: (message: string) => void }) {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [platform, setPlatform] = useState<VideoPlatform>('douyin');
  const [topicSeed, setTopicSeed] = useState('');
  const [step, setStep] = useState<VideoStepKey>('topic');
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState(false);

  const selected = projects.find(item => item.id === selectedId) ?? null;
  const pipeline = useMemo(() => (selected ? buildVideoPipeline(selected) : []), [selected]);
  const assets = useVideoAssets(selected?.id ?? 0, selected?.updatedAt ?? '');
  const shots = useMemo(() => parseVideoShots(selected?.storyboardJson ?? ''), [selected?.storyboardJson]);
  const srt = useMemo(() => buildSrt(shots), [shots]);

  const refresh = useCallback(async () => {
    const next = await window.sydney.listVideoProjects();
    setProjects(next);
    setSelectedId(current => current ?? next[0]?.id ?? null);
  }, []);
  useEffect(() => { void refresh().catch(error => notify(readableError(error))); }, [refresh, notify]);

  const openProject = (project: VideoProject, target?: VideoStepKey) => {
    if (dirty && project.id !== selectedId && !window.confirm('当前视频有未保存的修改，切换后这些修改会丢失。继续？')) return;
    if (project.id !== selectedId) setDirty(false);
    setSelectedId(project.id);
    setStep(target ?? currentVideoStepKey(project));
  };
  // 切换任务后定位到它的当前步骤，省得每次手动点。
  useEffect(() => { if (selected && !dirty) setStep(currentVideoStepKey(selected)); }, [selectedId]);

  const replaceProject = (project: VideoProject) => setProjects(current => current.map(item => item.id === project.id ? project : item));
  const editSelected = (patch: Partial<VideoProject>) => {
    if (!selected) return;
    setDirty(true);
    setProjects(current => current.map(item => {
      if (item.id !== selected.id) return item;
      const next = { ...item, ...patch };
      // 本地先按同一套规则推进状态，界面上的步骤条即时反映改动影响。
      if (patch.script !== undefined) next.status = patch.script.trim() ? 'script' : 'idea';
      if (patch.storyboardJson !== undefined) next.status = parseVideoShots(patch.storyboardJson).length ? 'storyboard' : 'script';
      return next;
    }));
  };
  const persistSelected = async () => {
    if (!selected) throw new Error('请先选择视频任务');
    const saved = await window.sydney.updateVideoProject(selected.id, {
      platform: selected.platform, topic: selected.topic, title: selected.title, audience: selected.audience,
      durationSeconds: selected.durationSeconds, script: selected.script, storyboardJson: selected.storyboardJson, coverPath: selected.coverPath
    });
    setDirty(false);
    replaceProject(saved);
    return saved;
  };

  const guarded = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    try { await run(); } catch (error) { notify(readableError(error)); } finally { setBusy(''); }
  };

  const create = () => guarded('create', async () => {
    const project = await window.sydney.createVideoProject(platform, topicSeed);
    setProjects(current => [project, ...current]);
    setSelectedId(project.id);
    setDirty(false);
    setStep('topic');
    setTopicSeed('');
    notify('已创建视频任务，从「选题」开始');
  });
  const save = () => guarded('save', async () => { await persistSelected(); notify('已保存'); });
  const runStage = (stage: VideoStage, advance = true) => guarded(stage, async () => {
    if (!selected) return;
    await persistSelected();
    const project = await window.sydney.generateVideoStage(selected.id, stage);
    replaceProject(project);
    notify(`${stageLabels[stage]}完成`);
    if (!advance) return;
    const current = VIDEO_STEPS.find(item => item.stage === stage);
    const next = current ? nextVideoStepKey(current.key) : null;
    if (next) setStep(next);
  });
  /** 脚本 → 分镜一次跑完；封面和导出要花钱或写知识库，仍由人点。 */
  const autoGenerate = () => {
    if (!selected) return;
    const plan = autoVideoPlan(selected);
    if (!plan.ok) { notify(plan.reason); return; }
    if ((selected.script.trim() || selected.storyboardJson.trim()) && !window.confirm('自动生成会覆盖现有口播脚本和分镜，继续？')) return;
    void guarded('auto', async () => {
      await persistSelected();
      let project = selected;
      for (const stage of plan.stages) {
        const target = VIDEO_STEPS.find(item => item.stage === stage)?.key;
        if (target) setStep(target);
        setBusy(`auto:${stage}`);
        project = await window.sydney.generateVideoStage(selected.id, stage);
        replaceProject(project);
      }
      notify(`自动生成完成：${AUTO_VIDEO_STAGES.map(item => stageLabels[item]).join(' → ')}`);
      setStep('cover');
    });
  };
  const chooseCover = () => guarded('cover-choose', async () => {
    if (!selected) return;
    const project = await window.sydney.chooseVideoCover(selected.id);
    if (project) { replaceProject(project); notify('已关联封面图'); }
  });
  const generateCover = () => guarded('cover', async () => {
    if (!selected) return;
    await persistSelected();
    replaceProject(await window.sydney.generateVideoCover(selected.id));
    notify('竖版封面已生成');
  });
  const exportPackage = () => guarded('export', async () => {
    if (!selected) return;
    await persistSelected();
    const project = await window.sydney.exportVideoProject(selected.id);
    replaceProject(project);
    notify(`制作包已导出：${project.exportPath}`);
  });
  const openPackage = () => guarded('open', async () => {
    if (!selected) return;
    const error = await window.sydney.openVideoPackage(selected.id);
    if (error) notify(error);
  });
  const copySrt = () => guarded('copy', async () => {
    await navigator.clipboard.writeText(srt);
    notify('字幕已复制到剪贴板');
  });

  const locked = busy !== '';
  const autoStage = busy.startsWith('auto:') ? busy.slice(5) as VideoStage : null;
  const activeStep = pipeline.find(item => item.key === step) ?? pipeline[0];

  return <section className="native-content video-panel">
    <header className="ww-page-header">
      <div>
        <p className="eyebrow">内容工作区</p>
        <h1>视频</h1>
        <p>选题 → 口播脚本 → 分镜 → 字幕 → 封面 → 制作包。模型只写脚本和分镜，字幕与成片交付物在本地生成。</p>
      </div>
      <div className="ww-page-header-note"><strong>中老年健康科普</strong><span>{projects.length} 条视频任务 · 只交付制作包，不代发布</span></div>
    </header>

    <div className="native-create">
      <label><span>发布平台</span><select value={platform} disabled={locked} onChange={event => setPlatform(event.target.value as VideoPlatform)}>{VIDEO_PLATFORMS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="native-topic-seed"><span>已有选题或方向（可选）</span><input value={topicSeed} disabled={locked} onChange={event => setTopicSeed(event.target.value)} placeholder="例如：柚子和常用药的相互作用" /></label>
      <button className="button button-primary" disabled={locked} onClick={() => void create()}>{busy === 'create' ? '创建中…' : '新建视频任务'}</button>
    </div>

    <div className="native-layout">
      <aside className="native-task-list">
        <div className="native-list-head"><h2>视频任务</h2><span>{projects.length}</span></div>
        {projects.length ? projects.map(project => {
          const steps = buildVideoPipeline(project);
          const current = steps.find(item => item.key === currentVideoStepKey(project));
          return <button key={project.id} className={`native-task ${selectedId === project.id ? 'is-selected' : ''}`} onClick={() => openProject(project)}>
            <strong>{project.title || project.topic || '未命名视频'}</strong>
            <span>{videoPlatformLabel(project.platform)} · {steps.every(item => item.state === 'done') ? '已完成' : `第 ${current?.index} 步 ${current?.label}`}</span>
            <div className="flow-mini" aria-hidden="true">{steps.map(item => <i key={item.key} className={`flow-mini-${item.state}`} />)}</div>
            <small>{shortTime(project.updatedAt)}</small>
          </button>;
        }) : <p className="native-empty">还没有视频任务</p>}
      </aside>

      <div className="native-editor">
        {selected && activeStep ? <>
          <div className="native-editor-head">
            <div>
              <p className="eyebrow">{videoPlatformLabel(selected.platform)} · {statusNames[selected.status] ?? selected.status} · 进度 {videoPipelineProgress(selected).done}/{videoPipelineProgress(selected).total}</p>
              <h2>{selected.title || selected.topic || '新视频'}</h2>
            </div>
            <div className="native-editor-actions">
              {dirty && <span className="flow-dirty">有未保存修改</span>}
              <button className="button button-primary" disabled={locked} title="按标题一次跑完 口播脚本 → 分镜；封面与导出仍由你手动确认" onClick={autoGenerate}>
                {autoStage ? `自动生成中：${stageLabels[autoStage]}…` : '自动生成'}
              </button>
              <button className="button button-secondary" disabled={locked || !dirty} onClick={() => void save()}>{busy === 'save' ? '保存中…' : '保存'}</button>
            </div>
          </div>

          <Stepper steps={pipeline} active={step} onSelect={setStep} />

          <section className={`flow-panel flow-panel-${activeStep.state}`} aria-labelledby="video-step-title">
            <header className="flow-panel-head">
              <span className="flow-panel-index">{activeStep.index}</span>
              <div><h3 id="video-step-title">{activeStep.label}</h3><p>{activeStep.hint}</p></div>
              <span className={`flow-badge flow-badge-${activeStep.state}`}>{stateNames[activeStep.state]}</span>
            </header>
            {activeStep.reason && <p className={activeStep.state === 'locked' ? 'flow-locked-note' : 'flow-attention-note'}>{activeStep.reason}</p>}
            {locked && <p className="flow-locked-note">正在处理中；完成前这一页的按钮会保持禁用。</p>}

            {step === 'topic' && <TopicStep project={selected} suggestions={readTopics(selected.topicsJson)} locked={locked} busy={busy}
              onEdit={editSelected} onRun={() => void runStage('topics')} />}
            {step === 'script' && <ScriptStep project={selected} locked={locked} busy={busy}
              onEdit={script => editSelected({ script })} onRun={() => void runStage('script')} />}
            {step === 'storyboard' && <StoryboardStep shots={shots} raw={selected.storyboardJson} locked={locked} busy={busy}
              onEdit={storyboardJson => editSelected({ storyboardJson })} onRun={() => void runStage('storyboard')} />}
            {step === 'captions' && <CaptionsStep shots={shots.length} srt={srt} locked={locked} onCopy={() => void copySrt()} />}
            {step === 'cover' && <CoverStep project={selected} assets={assets} locked={locked} busy={busy}
              onChoose={() => void chooseCover()} onGenerate={() => void generateCover()} />}
            {step === 'export' && <ExportStep project={selected} locked={locked} busy={busy}
              onExport={() => void exportPackage()} onOpen={() => void openPackage()} />}

            <footer className="flow-panel-foot">
              {VIDEO_STEPS.findIndex(item => item.key === step) > 0 && <button className="button button-quiet" disabled={locked} onClick={() => setStep(VIDEO_STEPS[VIDEO_STEPS.findIndex(item => item.key === step) - 1].key)}>← 上一步</button>}
              <span className="flow-spacer" />
              {activeStep.stage && step !== 'topic' && <button className={`button ${activeStep.state === 'done' ? 'button-secondary' : 'button-primary'}`} disabled={locked || activeStep.state === 'locked'} onClick={() => void runStage(activeStep.stage!)}>
                {busy === activeStep.stage ? '处理中…' : activeStep.state === 'done' ? `重新${stageLabels[activeStep.stage]}` : stageLabels[activeStep.stage]}
              </button>}
              {nextVideoStepKey(step) && <button className="button button-quiet" disabled={locked} onClick={() => setStep(nextVideoStepKey(step)!)}>下一步：{VIDEO_STEPS.find(item => item.key === nextVideoStepKey(step))?.label} →</button>}
            </footer>
          </section>
        </> : <div className="native-empty native-editor-empty"><strong>还没有视频任务</strong><span>选好平台后新建一条，按 选题 → 口播脚本 → 分镜 → 字幕 → 封面 → 制作包 推进；字幕由分镜自动排出。</span></div>}
      </div>
    </div>
  </section>;
}

function Stepper({ steps, active, onSelect }: { steps: VideoStep[]; active: VideoStepKey; onSelect: (key: VideoStepKey) => void }) {
  return <ol className="flow-stepper" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="视频创作流程">
    {steps.map(item => <li key={item.key} className={`flow-node flow-node-${item.state} ${active === item.key ? 'is-active' : ''}`}>
      <button onClick={() => onSelect(item.key)} aria-current={active === item.key ? 'step' : undefined} title={item.reason || item.hint}>
        <span className="flow-dot">{item.state === 'done' ? '✓' : item.state === 'attention' ? '!' : item.index}</span>
        <span className="flow-node-label">{item.label}</span>
        <small>{stateNames[item.state]}</small>
      </button>
    </li>)}
  </ol>;
}

function TopicStep({ project, suggestions, locked, busy, onEdit, onRun }: {
  project: VideoProject; suggestions: TopicSuggestion[]; locked: boolean; busy: string;
  onEdit: (patch: Partial<VideoProject>) => void; onRun: () => void;
}) {
  const drift = project.durationSeconds > 0 && project.script.trim() ? estimatedSeconds(project.script) - project.durationSeconds : 0;
  return <div className="flow-body">
    <div className="native-task-fields">
      <label className="native-field-wide"><span>视频标题</span><input disabled={locked} value={project.title} onChange={event => onEdit({ title: event.target.value })} placeholder="观众一眼能看懂的标题" /></label>
      <label><span>发布平台</span><select disabled={locked} value={project.platform} onChange={event => onEdit({ platform: event.target.value as VideoPlatform })}>{VIDEO_PLATFORMS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label><span>目标时长（秒）</span><input disabled={locked} type="number" min={5} value={project.durationSeconds} onChange={event => onEdit({ durationSeconds: Number(event.target.value) })} /></label>
      <label><span>目标受众</span><input disabled={locked} value={project.audience} placeholder="例如：60 岁以上、有高血压的读者" onChange={event => onEdit({ audience: event.target.value })} /></label>
      <label className="native-field-wide"><span>选题方向 / 想解决的问题</span><input disabled={locked} value={project.topic} onChange={event => onEdit({ topic: event.target.value })} placeholder="描述观众的问题或想解决的需求" /></label>
    </div>
    {project.script.trim() && Math.abs(drift) >= 15 && <p className="flow-attention-note">现有脚本约 {formatDuration(estimatedSeconds(project.script))}，与目标 {formatDuration(project.durationSeconds)} 相差 {drift > 0 ? '+' : ''}{drift} 秒，可重新生成脚本或调整目标时长。</p>}
    <div className="flow-inline-actions">
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'topics' ? '生成中…' : suggestions.length ? '换一批 AI 选题' : 'AI 生成 5 个候选选题'}</button>
      <small>点选候选会填入标题与方向；选好标题后点右上角「自动生成」，可一次跑完口播脚本 → 分镜。</small>
    </div>
    {suggestions.length > 0 && <div className="native-topic-options">{suggestions.map(item => <button key={item.title} disabled={locked} className={`native-task ${project.title === item.title ? 'is-selected' : ''}`} onClick={() => onEdit({ title: item.title, topic: item.angle })}>
      <strong>{item.title}</strong>
      {item.hook && <small>开场：{item.hook}</small>}
      {item.angle && <small>{item.angle}</small>}
      {item.risk && <small className="flow-risk">风险提示：{item.risk}</small>}
      <span>{project.title === item.title ? '已采用' : '采用这个选题'}</span>
    </button>)}</div>}
  </div>;
}

function ScriptStep({ project, locked, busy, onEdit, onRun }: {
  project: VideoProject; locked: boolean; busy: string; onEdit: (script: string) => void; onRun: () => void;
}) {
  const estimate = estimatedSeconds(project.script);
  return <div className="flow-body">
    <div className="flow-sub-head">
      <h4>口播脚本<small>约 {project.script.replace(/\s/g, '').length} 字 · 念出来约 {formatDuration(estimate)}（目标 {formatDuration(project.durationSeconds)}）</small></h4>
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'script' ? '生成中…' : project.script.trim() ? '重新生成脚本' : 'AI 写口播脚本'}</button>
    </div>
    <textarea className="flow-draft" disabled={locked} value={project.script} onChange={event => onEdit(event.target.value)}
      placeholder="生成脚本后在这里改；也可以直接写或粘贴自己的口播稿。第一句就是开场，之后一次只讲一件事。" />
    <p className="ww-muted">口播稿是脚本、分镜与字幕的唯一来源：改完这里，分镜与制作包会标成「需要重做」，重新生成即可。</p>
  </div>;
}

function StoryboardStep({ shots, raw, locked, busy, onEdit, onRun }: {
  shots: ReturnType<typeof parseVideoShots>; raw: string; locked: boolean; busy: string;
  onEdit: (storyboardJson: string) => void; onRun: () => void;
}) {
  const total = shots.reduce((sum, shot) => sum + shot.seconds, 0);
  return <div className="flow-body">
    <div className="flow-sub-head">
      <h4>镜头清单<small>{shots.length} 个镜头 · 共 {formatDuration(total)}</small></h4>
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'storyboard' ? '拆解中…' : shots.length ? '重新生成分镜' : 'AI 拆分镜'}</button>
    </div>
    {shots.length ? <table className="flow-table"><thead><tr><th>镜号</th><th>秒</th><th>画面</th><th>口播</th><th>字幕</th></tr></thead><tbody>
      {shots.map((shot, position) => <tr key={position}>
        <td>{shot.index}</td><td>{shot.seconds}</td>
        <td>{shot.visual || '—'}</td><td>{shot.narration || '—'}</td><td>{shot.caption || '（同口播）'}</td>
      </tr>)}
    </tbody></table> : <p className="flow-empty">还没有分镜。分镜决定每个镜头拍什么、说多久，字幕和制作包都从它推出来。</p>}
    {raw.trim() && <details className="native-json"><summary>直接编辑分镜 JSON（进阶）</summary>
      <textarea className="flow-draft" style={{ minHeight: 220 }} disabled={locked} value={raw} onChange={event => onEdit(event.target.value)} />
      <p className="ww-muted">字段：shots 数组，每项含 index、seconds、visual、narration、caption。保存时会按时长与编号归一化；JSON 无效会拒绝保存。</p>
    </details>}
  </div>;
}

function CaptionsStep({ shots, srt, locked, onCopy }: { shots: number; srt: string; locked: boolean; onCopy: () => void }) {
  return <div className="flow-body">
    <div className="flow-sub-head">
      <h4>字幕（SRT）<small>{shots} 条 · 由分镜时长累加</small></h4>
      <button className="button button-secondary" disabled={locked || !srt} onClick={onCopy}>复制字幕</button>
    </div>
    {srt ? <pre className="video-srt">{srt}</pre> : <p className="flow-empty">先生成分镜，字幕会自动排好时间轴。</p>}
    <p className="ww-muted">时间轴直接由分镜秒数算出，不回模型、不额外花钱。导出制作包时会写入 captions.srt；改分镜后这里同步变化，需要重新导出。</p>
  </div>;
}

function CoverStep({ project, assets, locked, busy, onChoose, onGenerate }: {
  project: VideoProject; assets: VideoAssetBundle | null; locked: boolean; busy: string; onChoose: () => void; onGenerate: () => void;
}) {
  return <div className="flow-body">
    <div className="flow-cover">
      <figure className="flow-cover-figure video-cover-figure">
        {assets?.cover?.thumbnail ? <img src={assets.cover.thumbnail} alt="封面预览" /> : <div className="flow-image-missing">还没有封面图</div>}
        <figcaption>{project.coverPath ? project.coverPath.split(/[\\/]/).pop() : '未选择封面（可跳过）'}</figcaption>
      </figure>
      <div className="flow-cover-actions">
        <button className="button button-secondary" disabled={locked} onClick={onChoose}>选择本地图片</button>
        <button className="button button-primary" disabled={locked} onClick={onGenerate}>{busy === 'cover' ? '生成中…' : 'AI 生成竖版封面'}</button>
        <small>竖版 9:16，导出时连同脚本、分镜表、字幕一起拷进制作包。封面不是导出的硬门槛，但发布到平台时基本都要。</small>
      </div>
    </div>
  </div>;
}

function ExportStep({ project, locked, busy, onExport, onOpen }: {
  project: VideoProject; locked: boolean; busy: string; onExport: () => void; onOpen: () => void;
}) {
  const checklist = videoExportChecklist(project);
  const ready = checklist.filter(item => !item.optional).every(item => item.ok);
  return <div className="flow-body">
    <ul className="flow-checklist">{checklist.map(item => <li key={item.label} className={item.ok ? 'is-ok' : 'is-missing'}>
      <span aria-hidden="true">{item.ok ? '✓' : '○'}</span>
      <div><strong>{item.label}{item.optional && '（可选）'}</strong><small>{item.detail}</small></div>
    </li>)}</ul>
    <div className="flow-inline-actions">
      <button className="button button-primary" disabled={locked || !ready} onClick={onExport}>{busy === 'export' ? '导出中…' : '导出制作包'}</button>
      {project.exportPath && <button className="button button-secondary" disabled={locked} onClick={onOpen}>打开制作包目录</button>}
    </div>
    {project.exportPath && <p className="native-export-path">最近导出：{project.exportPath}</p>}
    <p className="ww-muted">制作包里是 制作包.md（脚本 + 分镜表）、shotlist.csv、captions.srt 与封面图。成片需要人工剪辑合成；本模块不上传、不发布到任何平台。</p>
  </div>;
}

/** 封面缩略图由主进程生成（渲染进程读不到本地文件），项目变动后自动重新拉取。 */
function useVideoAssets(projectId: number, revision: string): VideoAssetBundle | null {
  const [assets, setAssets] = useState<VideoAssetBundle | null>(null);
  useEffect(() => {
    if (!projectId) { setAssets(null); return; }
    let alive = true;
    void window.sydney.getVideoAssets(projectId)
      .then(next => { if (alive) setAssets(next); })
      .catch(() => { if (alive) setAssets(null); });
    return () => { alive = false; };
  }, [projectId, revision]);
  return assets;
}
