import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentDirection, ContentStage, ContentTask, ContentTaxonomy } from '../shared';
import { ARTICLE_THEMES, DEFAULT_ARTICLE_THEME } from '../services/article-html';
import { PIPELINE_STEPS, autoGeneratePlan, buildPipeline, currentStepKey, isReviewPassed, nextStepKey, pipelineProgress, publishChecklist, reviewOutstanding, type PipelineStepKey } from '../services/content-pipeline';
import ContentSettingsPanel from './ContentSettings';
import { profileDefaultSubdirection, subdirectionsOf, taskScopeLabel } from './content-taxonomy';
import { readableError, shortTime } from './ui';
import { stageLabels, stateNames, statusNames, type Env } from './native-content/format';
import { Board, CoverStep, DraftStep, EvidenceStep, JsonStep, PublishStep, ReviewStep, Stepper, TopicStep, useContentAssets } from './native-content/steps';

/**
 * 创作流水线：只显示当前公众号资料下的文章任务（加上还没归类的老任务），新建任务也归到这份资料。
 * 切换资料时由父组件用 key 重建本组件，所以这里把资料当作常量处理。
 */
export default function NativeContentPanel({ profile, notify, onOpenConfig }: { profile: ContentDirection | null; notify: (message: string) => void; onOpenConfig: () => void }) {
  const directionId = profile?.id ?? null;
  const [allTasks, setTasks] = useState<ContentTask[]>([]);
  const tasks = useMemo(() => allTasks.filter(task => task.directionId === directionId || task.directionId === null), [allTasks, directionId]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [taxonomy, setTaxonomy] = useState<ContentTaxonomy | null>(null);
  const [subdirectionId, setSubdirectionId] = useState<number | null>(null);
  const [topicSeed, setTopicSeed] = useState('');
  const [busy, setBusy] = useState('');
  const [busySince, setBusySince] = useState(0);
  const [busySeconds, setBusySeconds] = useState(0);
  const [env, setEnv] = useState<Env>({ wechatConfigured: false });
  const [mode, setMode] = useState<'pipeline' | 'board'>('pipeline');
  const [step, setStep] = useState<PipelineStepKey>('topic');
  const [dirty, setDirty] = useState(false);
  /** 用户手动选过具体方向后，就不再让默认值覆盖他的选择。 */
  const categoryPicked = useRef(false);
  const selected = tasks.find(item => item.id === selectedId) ?? null;
  const pipeline = useMemo(() => selected ? buildPipeline(selected, env) : [], [selected, env]);
  const assets = useContentAssets(selected?.id ?? 0, selected?.updatedAt ?? '');

  const refresh = useCallback(async () => {
    const next = await window.sydney.listContentTasks();
    setTasks(next);
    const visible = next.filter(task => task.directionId === directionId || task.directionId === null);
    setSelectedId(current => (current && visible.some(task => task.id === current) ? current : visible[0]?.id ?? null));
  }, [directionId]);
  useEffect(() => { void refresh().catch(error => notify(readableError(error))); }, [refresh, notify]);
  /** 具体方向与微信凭证在「环境与配置」里维护，改完要立即反映到新建任务那一行。 */
  const refreshEnvironment = useCallback(async () => {
    const [next, tree] = await Promise.all([window.sydney.getWeWriteEnvironment(), window.sydney.getContentTaxonomy()]);
    setEnv({ wechatConfigured: next.wechatConfigured });
    setTaxonomy(tree);
    if (!categoryPicked.current) setSubdirectionId(profileDefaultSubdirection(tree, directionId));
  }, [directionId]);
  useEffect(() => { void refreshEnvironment().catch(() => undefined); }, [refreshEnvironment]);
  useEffect(() => window.sydney.onWeWriteChanged(() => { void refreshEnvironment().catch(() => undefined); }), [refreshEnvironment]);

  const openTask = (task: ContentTask, target?: PipelineStepKey) => {
    if (dirty && task.id !== selectedId && !window.confirm('当前文章有未保存的修改，切换后这些修改会丢失。继续？')) return;
    if (task.id !== selectedId) setDirty(false);
    setSelectedId(task.id);
    setStep(target ?? currentStepKey(task, env));
    setMode('pipeline');
  };
  // 切换任务后定位到它的当前步骤
  useEffect(() => { if (selected && !dirty) setStep(currentStepKey(selected, env)); }, [selectedId]);

  const replaceTask = (task: ContentTask) => setTasks(current => current.map(item => item.id === task.id ? task : item));
  const persistSelected = async () => {
    if (!selected) throw new Error('请先选择文章任务');
    const task = await window.sydney.updateContentTask(selected.id, { directionId: selected.directionId, subdirectionId: selected.subdirectionId, topic: selected.topic, title: selected.title, draft: selected.draft, sourcesJson: selected.sourcesJson });
    setDirty(false);
    return task;
  };
  const editSelected = (patch: Partial<ContentTask>) => {
    if (!selected) return;
    setDirty(true);
    setTasks(current => current.map(item => item.id === selected.id ? { ...item, ...patch, finalArticle: '', reviewJson: '', status: item.draft || patch.draft ? 'draft' : 'idea' } : item));
  };
  const guarded = async (key: string, run: () => Promise<void>) => {
    setBusy(key); setBusySince(Date.now());
    try { await run(); } catch (error) { notify(readableError(error)); } finally { setBusy(''); }
  };
  /**
   * 生图这张网可能要等几十秒，期间所有按钮都会被锁定（避免并发改同一篇）。
   * 秒数走字 + 取消按钮是为了让「等」和「坏了」能区分开。
   */
  useEffect(() => {
    if (!busy) { setBusySeconds(0); return; }
    const started = busySince || Date.now();
    setBusySeconds(0);
    const timer = window.setInterval(() => setBusySeconds(Math.max(0, Math.round((Date.now() - started) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [busy, busySince]);
  const imageJob = busy === 'cover' || busy === 'images' || busy === 'images-all';
  const cancelImages = async () => {
    if (!selected) return;
    const cancelled = await window.sydney.cancelContentImages(selected.id);
    notify(cancelled ? '已请求取消，等接口返回后即可继续操作' : '当前没有正在进行的生图');
  };

  const create = () => guarded('create', async () => {
    const task = await window.sydney.createContentTask(directionId, subdirectionId, topicSeed);
    setTasks(current => [task, ...current]);
    setSelectedId(task.id);
    setDirty(false);
    setStep('topic');
    setMode('pipeline');
    setTopicSeed('');
    notify('已创建文章任务，从「选题」开始');
  });
  const runStage = (stage: ContentStage, advance = true) => guarded(stage, async () => {
    if (!selected) return;
    await persistSelected();
    const task = await window.sydney.generateContentStage(selected.id, stage);
    replaceTask(task);
    notify(stage === 'revise' ? '正文已按审稿意见更新，请重新审稿' : `${stageLabels[stage]}完成`);
    if (!advance) return;
    if (stage === 'review') setStep(isReviewPassed(task) ? (task.coverPath ? 'publish' : 'cover') : 'review');
    // revise 不是流水线步骤，改完要回到审稿重新过一遍门槛。
    else if (stage === 'revise') setStep('review');
    else if (stage !== 'topics') {
      const current = PIPELINE_STEPS.find(item => item.stage === stage);
      const next = current ? nextStepKey(current.key) : null;
      if (next) setStep(next);
    }
  });
  const save = () => guarded('save', async () => { replaceTask(await persistSelected()); notify('已保存'); });
  const generateCover = () => guarded('cover', async () => {
    if (!selected) return;
    await persistSelected();
    replaceTask(await window.sydney.generateContentCover(selected.id));
    notify('封面图已生成');
  });
  const chooseCover = () => guarded('cover-choose', async () => {
    if (!selected) return;
    const task = await window.sydney.chooseContentCover(selected.id);
    if (task) { replaceTask(task); notify('已关联封面图'); }
  });
  /** 排版主题只影响呈现，不使审稿失效，所以保存后可以立即看到效果。 */
  const changeTheme = (theme: string) => guarded('theme', async () => {
    if (!selected) return;
    setTasks(current => current.map(item => item.id === selected.id ? { ...item, theme } : item));
    replaceTask(await window.sydney.updateContentTask(selected.id, { theme }));
  });
  const generateImages = () => guarded('images', async () => {
    if (!selected) return;
    await persistSelected();
    replaceTask(await window.sydney.generateContentImages(selected.id, 3));
    notify('已生成正文配图并插入正文，改动过正文需要重新审稿');
  });
  /** 封面与正文配图一次出：两条生成并发跑，部分失败时按已生成的结果入库并提示原因。 */
  const generateImagesWithCover = () => guarded('images-all', async () => {
    if (!selected) return;
    await persistSelected();
    const task = await window.sydney.generateContentImagesWithCover(selected.id, 3);
    replaceTask(task);
    notify(task.imageWarning || '封面与正文配图已生成');
  });
  const exportArticle = (allowUnreviewed = false) => guarded('export', async () => {
    if (!selected) return;
    await persistSelected();
    const task = await window.sydney.exportContentTask(selected.id, allowUnreviewed);
    replaceTask(task);
    notify(`成稿已导出：${task.exportPath}`);
  });
  /**
   * 选好标题后一次跑完 任务书 → 证据计划 → 初稿 → AI 审稿。
   * 每步完成即写库，中途失败会停在那一步并保留已完成的结果，不会回滚前面的产物。
   */
  const autoGenerate = () => {
    if (!selected) return;
    const plan = autoGeneratePlan(selected);
    if (!plan.ok) { notify(plan.reason); return; }
    if (selected.draft.trim() && !window.confirm('自动生成会覆盖现有初稿和审稿结论，继续？')) return;
    void guarded('auto', async () => {
      await persistSelected();
      let task: ContentTask = { ...selected };
      for (const stage of plan.stages) {
        const target = PIPELINE_STEPS.find(item => item.stage === stage)?.key;
        if (target) setStep(target);
        setBusy(`auto:${stage}`);
        task = await window.sydney.generateContentStage(selected.id, stage);
        replaceTask(task);
      }
      notify(`自动生成完成：${plan.stages.map(item => stageLabels[item]).join(' → ')}`);
      setStep(isReviewPassed(task) ? (task.coverPath ? 'publish' : 'cover') : 'review');
    });
  };
  /** 审稿未通过时的确认文案：把还挂着的问题列清楚，避免误以为已经过关。 */
  const unreviewedWarning = (action: string) => {
    const outstanding = selected ? reviewOutstanding(selected) : [];
    return `《${selected?.title || '未命名文章'}》还没有通过 AI 审稿，仍要${action}吗？\n\n`
      + `待处理：${outstanding.join('；') || '无'}\n\n`
      + '审稿意见这时只是建议，不会被自动应用；确认后会按当前正文执行。';
  };
  /** 通过审稿时按常规交付；未通过时先二次确认再带上 allowUnreviewed。 */
  const deliver = (action: 'export' | 'publish') => {
    if (!selected) return;
    const allowUnreviewed = !isReviewPassed(selected);
    if (allowUnreviewed && !window.confirm(unreviewedWarning(action === 'export' ? '导出到 Obsidian' : '推送草稿箱'))) return;
    if (action === 'export') void exportArticle(allowUnreviewed);
    else publish(allowUnreviewed);
  };
  /** 直连微信草稿箱：创建草稿但不群发，因此必须先弹确认。 */
  const publish = (allowUnreviewed = false) => {
    if (!selected) return;
    const missing = publishChecklist(selected, env).filter(item => !item.ok);
    if (missing.length) { notify(`还不能推送：${missing.map(item => item.label).join('、')}`); return; }
    const confirmed = window.confirm(
      `把《${selected.title || '未命名文章'}》推送到公众号草稿箱？\n\n`
      + '这是对真实公众号的操作：会创建一篇草稿，不会自动群发。\n'
      + (allowUnreviewed ? '注意：这篇正文没有通过 AI 审稿。\n' : '')
      + `封面：${selected.coverPath}`
    );
    if (!confirmed) return;
    void guarded('publish', async () => {
      await persistSelected();
      replaceTask(await window.sydney.publishContentTask(selected.id, allowUnreviewed));
      notify('已推送到公众号草稿箱');
    });
  };

  const locked = busy !== '';
  const autoStage = busy.startsWith('auto:') ? busy.slice('auto:'.length) as ContentStage : null;
  const autoStageLabel = autoStage ? stageLabels[autoStage] : '准备中';
  const activeStep = pipeline.find(item => item.key === step) ?? pipeline[0];

  return <section className="native-content">
    <ContentSettingsPanel profile={profile} onOpenConfig={onOpenConfig} />
    <div className="native-create">
      <label><span>具体方向</span>
        <select value={subdirectionId ?? ''} onChange={event => { categoryPicked.current = true; setSubdirectionId(Number(event.target.value) || null); }}>
          <option value="">未指定</option>
          {subdirectionsOf(taxonomy?.directions ?? [], directionId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label className="native-topic-seed"><span>已有选题或方向（可选）</span><input value={topicSeed} onChange={event => setTopicSeed(event.target.value)} placeholder="例如：柚子和常用药物的相互作用" /></label>
      <button className="button button-primary" disabled={locked} onClick={() => void create()}>新建文章任务</button>
      <div className="flow-mode" role="tablist" aria-label="视图">
        <button role="tab" aria-selected={mode === 'pipeline'} className={mode === 'pipeline' ? 'is-active' : ''} onClick={() => setMode('pipeline')}>单篇流水线</button>
        <button role="tab" aria-selected={mode === 'board'} className={mode === 'board' ? 'is-active' : ''} onClick={() => setMode('board')}>全局看板</button>
      </div>
    </div>

    {mode === 'board' ? <Board tasks={tasks} env={env} onOpen={openTask} /> : <div className="native-layout">
      <aside className="native-task-list">
        <div className="native-list-head"><h2>文章任务</h2><span>{tasks.length}</span></div>
        {tasks.length ? tasks.map(task => {
          const steps = buildPipeline(task, env);
          const current = steps.find(item => item.key === currentStepKey(task, env));
          return <button key={task.id} className={`native-task ${selectedId === task.id ? 'is-selected' : ''}`} onClick={() => openTask(task)}>
            <strong>{task.title || task.topic || taskScopeLabel(task)}</strong>
            <span>{taskScopeLabel(task)} · {steps.every(item => item.state === 'done') ? '已完成' : `第 ${current?.index} 步 ${current?.label}`}</span>
            <div className="flow-mini" aria-hidden="true">{steps.map(item => <i key={item.key} className={`flow-mini-${item.state}`} />)}</div>
            <small>{shortTime(task.updatedAt)}</small>
          </button>;
        }) : <p className="native-empty">还没有文章任务</p>}
      </aside>

      <div className="native-editor">
        {selected && activeStep ? <>
          <div className="native-editor-head">
            <div><p className="eyebrow">{taskScopeLabel(selected)} · {statusNames[selected.status] ?? selected.status} · 进度 {pipelineProgress(selected, env).done}/{pipeline.length}</p><h2>{selected.title || selected.topic || '新文章'}</h2></div>
            <div className="native-editor-actions">
              {dirty && <span className="flow-dirty">有未保存修改</span>}
              <label className="flow-theme"><span>排版主题</span>
                <select value={selected.theme || DEFAULT_ARTICLE_THEME} disabled={locked} onChange={event => changeTheme(event.target.value)}>
                  {ARTICLE_THEMES.map(theme => <option key={theme.name} value={theme.name}>{theme.label}</option>)}
                </select>
              </label>
              <button className="button button-primary" disabled={locked} title="选好标题后一次跑完 任务书 → 证据计划 → 初稿 → AI 审稿；封面、导出与推送仍由你手动确认" onClick={autoGenerate}>
                {busy.startsWith('auto') ? `自动生成中：${autoStageLabel}…` : '自动生成'}
              </button>
              <button className="button button-secondary" disabled={locked || !dirty} onClick={() => void save()}>{busy === 'save' ? '保存中…' : '保存'}</button>
            </div>
          </div>

          <Stepper steps={pipeline} active={step} onSelect={setStep} />

          <section className={`flow-panel flow-panel-${activeStep.state}`} aria-labelledby="flow-step-title">
            <header className="flow-panel-head">
              <span className="flow-panel-index">{activeStep.index}</span>
              <div><h3 id="flow-step-title">{activeStep.label}</h3><p>{activeStep.hint}</p></div>
              <span className={`flow-badge flow-badge-${activeStep.state}`}>{stateNames[activeStep.state]}</span>
            </header>
            {activeStep.reason && <p className={activeStep.state === 'locked' ? 'flow-locked-note' : 'flow-attention-note'}>{activeStep.reason}</p>}
            {locked && <p className="flow-locked-note">
              {`正在处理中，已等待 ${busySeconds} 秒；完成前这一页的按钮会保持禁用。`}
              {imageJob && <button className="button button-quiet button-small" onClick={() => void cancelImages()}>取消生成</button>}
            </p>}

            {step === 'topic' && <TopicStep task={selected} taxonomy={taxonomy} locked={locked} busy={busy} onEdit={editSelected} onRun={() => void runStage('topics')} />}
            {step === 'brief' && <JsonStep value={selected.briefJson} empty="还没有任务书。任务书会给出目标读者、读者问题、核心主张、章节和边界，初稿严格按它展开。"
              labels={{ target_reader: '目标读者', reader_problem: '读者问题', promise: '文章承诺', core_claim: '核心主张', sections: '章节结构', evidence_needed: '需要的证据', boundaries: '写作边界', framework: '框架' }} />}
            {step === 'evidence' && <EvidenceStep task={selected} locked={locked} onSources={items => editSelected({ sourcesJson: JSON.stringify({ sources: items }) })} />}
            {step === 'draft' && <DraftStep task={selected} assets={assets} locked={locked} busy={busy} busySeconds={busySeconds} onEdit={draft => editSelected({ draft })} onGenerateImages={() => void generateImages()} onGenerateImagesWithCover={() => void generateImagesWithCover()} />}
            {step === 'review' && <ReviewStep task={selected} locked={locked} busy={busy} onRevise={() => void runStage('revise')} />}
            {step === 'cover' && <CoverStep
              task={selected}
              assets={assets}
              locked={locked}
              busy={busy}
              busySeconds={busySeconds}
              onChoose={() => void chooseCover()}
              onGenerateCover={() => void generateCover()}
              onGenerateImages={() => void generateImages()}
              onGenerateImagesWithCover={() => void generateImagesWithCover()}
            />}
            {step === 'publish' && <PublishStep task={selected} env={env} />}

            <footer className="flow-panel-foot">
              {PIPELINE_STEPS.findIndex(item => item.key === step) > 0 && <button className="button button-quiet" onClick={() => setStep(PIPELINE_STEPS[PIPELINE_STEPS.findIndex(item => item.key === step) - 1].key)}>← 上一步</button>}
              <span className="flow-spacer" />
              {activeStep.stage && step !== 'topic' && <button className={`button ${activeStep.state === 'done' ? 'button-secondary' : 'button-primary'}`} disabled={locked || activeStep.state === 'locked'} onClick={() => void runStage(activeStep.stage!)}>
                {busy === activeStep.stage ? '处理中…' : activeStep.state === 'done' || (step === 'review' && selected.reviewJson) ? `重新${stageLabels[activeStep.stage]}` : stageLabels[activeStep.stage]}</button>}
              {step === 'review' && activeStep.state === 'attention' && <button className="button button-secondary" onClick={() => setStep('draft')}>回到初稿修改</button>}
              {step === 'publish' && <>
                <button className="button button-secondary" disabled={locked || !(selected.finalArticle.trim() || selected.draft.trim())} title="未通过审稿也能导出，导出前会二次确认" onClick={() => deliver('export')}>{busy === 'export' ? '导出中…' : '导出到 Obsidian'}</button>
                <button className="button button-primary" disabled={locked || publishChecklist(selected, env).some(item => !item.ok)} title="推送到真实公众号草稿箱；未通过审稿也能推送，推送前会二次确认" onClick={() => deliver('publish')}>{busy === 'publish' ? '推送中…' : '推送草稿箱'}</button>
              </>}
              {nextStepKey(step) && <button className="button button-quiet" onClick={() => setStep(nextStepKey(step)!)}>下一步：{PIPELINE_STEPS.find(item => item.key === nextStepKey(step))?.label} →</button>}
            </footer>
          </section>
        </> : <div className="native-empty native-editor-empty"><strong>先创建一个文章任务</strong><span>选择类别后，按 选题 → 任务书 → 来源与证据 → 初稿 → AI 审稿 → 封面 → 导出与发布 逐步推进。</span></div>}
      </div>
    </div>}
  </section>;
}
