import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VideoIpCoverInput, VideoPlatform, VideoProgress, VideoProject, VideoRenderOptions, VideoStage } from '../shared';
import { ConfirmButton, readableError, shortTime } from './ui';
import {
  AUTO_VIDEO_STAGES, VIDEO_PLATFORMS, VIDEO_STEPS, autoVideoPlan, buildVideoPipeline, currentVideoStepKey,
  nextVideoStepKey, parseVideoShots, videoPipelineProgress, videoPlatformLabel,
  type VideoStepKey
} from '../services/video-pipeline';
import { readTopics, stageLabels, stateNames, statusNames } from './video/format';
import { CoverStep, ExportStep, ScriptStep, Stepper, StoryboardStep, TopicStep, useVideoAssets } from './video/steps';
import { RenderStep, VisualsStep, VoiceStep } from './video/production';

export default function VideoPanel({ notify }: { notify: (message: string) => void }) {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [platform, setPlatform] = useState<VideoPlatform>('douyin');
  const [topicSeed, setTopicSeed] = useState('');
  const [step, setStep] = useState<VideoStepKey>('topic');
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState(false);
  const [progress, setProgress] = useState<VideoProgress | null>(null);

  const selected = projects.find(item => item.id === selectedId) ?? null;
  const pipeline = useMemo(() => (selected ? buildVideoPipeline(selected) : []), [selected]);
  const assets = useVideoAssets(selected?.id ?? 0, selected?.updatedAt ?? '');
  const shots = useMemo(() => parseVideoShots(selected?.storyboardJson ?? ''), [selected?.storyboardJson]);
  // 配音、配图、渲染都是长操作：主进程逐步推进度，这里只保留当前选中视频的那一条。
  useEffect(() => window.sydney.onVideoProgress(next => { if (next.id === selectedId) setProgress(next); }), [selectedId]);

  const refresh = useCallback(async () => {
    const next = await window.sydney.listVideoProjects();
    setProjects(next);
    setSelectedId(current => (current !== null && next.some(item => item.id === current) ? current : next[0]?.id ?? null));
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
      durationSeconds: selected.durationSeconds, script: selected.script, storyboardJson: selected.storyboardJson, coverPath: selected.coverPath,
      options: selected.options
    });
    setDirty(false);
    replaceProject(saved);
    return saved;
  };

  const guarded = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    setProgress(null);
    try { await run(); } catch (error) { notify(readableError(error)); } finally { setBusy(''); setProgress(null); }
  };
  const editOptions = (patch: Partial<VideoRenderOptions>) => { if (selected) editSelected({ options: { ...selected.options, ...patch } }); };

  /** 删除当前视频：未保存的修改一并丢弃，自动选中列表里的下一条。 */
  const remove = () => guarded('delete', async () => {
    if (!selected) return;
    const id = selected.id;
    const name = selected.title || selected.topic || '新视频';
    await window.sydney.deleteVideoProject(id);
    setDirty(false);
    const rest = projects.filter(item => item.id !== id);
    setProjects(rest);
    setSelectedId(rest[0]?.id ?? null);
    notify(`已删除「${name}」；已导出的发布包不受影响`);
  });

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
  const ipCover = (input: VideoIpCoverInput) => guarded('ip-cover', async () => {
    if (!selected) return;
    await persistSelected();
    replaceProject(await window.sydney.renderVideoIpCover(selected.id, input));
    notify('IP 竖版封面已生成');
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
  const copySrt = (srt: string) => guarded('copy', async () => {
    await navigator.clipboard.writeText(srt);
    notify('字幕已复制到剪贴板');
  });
  /** 配音：默认只补缺失或口播改过的镜头；force 时按当前配音设置全部重配。 */
  const generateVoice = (force: boolean) => {
    if (force && !window.confirm('按当前配音设置重新合成全部镜头？已有的配音会被替换。')) return;
    void guarded('voice', async () => {
      if (!selected) return;
      await persistSelected();
      replaceProject(await window.sydney.generateVideoVoice(selected.id, force));
      notify('配音完成，镜头时长已换成真实音频长度');
    });
  };
  const generateImages = (force: boolean) => {
    if (force && !window.confirm('全部重新生成配图会按张重新计费，继续？')) return;
    void guarded('images', async () => {
      if (!selected) return;
      await persistSelected();
      replaceProject(await window.sydney.generateVideoImages(selected.id, force));
      notify('配图已生成');
    });
  };
  const renderPreview = () => guarded('preview', async () => {
    if (!selected) return;
    await persistSelected();
    replaceProject(await window.sydney.renderVideoPreview(selected.id));
  });
  const renderVideo = () => guarded('render', async () => {
    if (!selected) return;
    await persistSelected();
    const project = await window.sydney.renderVideo(selected.id);
    replaceProject(project);
    notify(`成片已渲染：${project.assets.video?.path ?? ''}`);
  });
  const chooseBgm = () => guarded('bgm', async () => {
    if (!selected) return;
    // 先存下未保存的修改：选曲返回的是库里的版本，不先存会把界面上的改动冲掉。
    await persistSelected();
    const project = await window.sydney.chooseVideoBgm(selected.id);
    if (project) { replaceProject(project); notify('已选择背景音乐'); }
  });
  const openVideo = () => guarded('open-video', async () => {
    if (!selected) return;
    const error = await window.sydney.openVideoFile(selected.id);
    if (error) notify(error);
  });

  const locked = busy !== '';
  const autoStage = busy.startsWith('auto:') ? busy.slice(5) as VideoStage : null;
  const activeStep = pipeline.find(item => item.key === step) ?? pipeline[0];

  return <section className="native-content video-panel">
    <header className="ww-page-header">
      <div>
        <p className="eyebrow">内容工作区</p>
        <h1>视频</h1>
        <p>选题 → 口播脚本 → 分镜 → 配音与字幕 → 画面 → 成片 → 封面 → 制作包。模型写脚本和分镜，配音按镜头合成，字幕、画面与成片在本地生成。</p>
      </div>
      <div className="ww-page-header-note"><strong>中老年健康科普</strong><span>{projects.length} 条视频任务 · 出成片与制作包，不代发布</span></div>
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
              {!locked && <ConfirmButton className="button button-danger-quiet" armedLabel="确认删除" title="删除这条视频任务和它的封面；已导出的发布包不受影响" onConfirm={() => void remove()}>删除</ConfirmButton>}
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
            {step === 'storyboard' && <StoryboardStep shots={shots} raw={selected.storyboardJson} script={selected.script} locked={locked} busy={busy}
              onEdit={storyboardJson => editSelected({ storyboardJson })} onRun={() => void runStage('storyboard')} />}
            {step === 'voice' && <VoiceStep project={selected} shots={shots} locked={locked} busy={busy} progress={progress} notify={notify}
              onOptions={editOptions} onGenerate={generateVoice} onCopySrt={srt => void copySrt(srt)} />}
            {step === 'visuals' && <VisualsStep project={selected} shots={shots} assets={assets} locked={locked} busy={busy} progress={progress}
              onOptions={editOptions} onImages={generateImages} onPreview={() => void renderPreview()} />}
            {step === 'render' && <RenderStep project={selected} shots={shots} assets={assets} locked={locked} busy={busy} progress={progress}
              onOptions={editOptions} onChooseBgm={() => void chooseBgm()} onRender={() => void renderVideo()} onOpen={() => void openVideo()} />}
            {step === 'cover' && <CoverStep project={selected} assets={assets} locked={locked} busy={busy}
              onChoose={() => void chooseCover()} onGenerate={() => void generateCover()} onOptions={editOptions} onIpCover={input => void ipCover(input)} />}
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
        </> : <div className="native-empty native-editor-empty"><strong>还没有视频任务</strong><span>选好平台后新建一条，按 选题 → 口播脚本 → 分镜 → 配音与字幕 → 画面 → 成片 → 封面 → 制作包 推进；字幕按配音自动排好时间轴。</span></div>}
      </div>
    </div>
  </section>;
}
