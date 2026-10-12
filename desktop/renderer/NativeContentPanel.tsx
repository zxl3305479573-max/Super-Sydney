import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentAssetBundle, ContentAssetView, ContentStage, ContentTask, ContentTaxonomy } from '../shared';
import { ARTICLE_THEMES, DEFAULT_ARTICLE_THEME } from '../services/article-html';
import { countInlineImages } from '../services/content-images';
import { PIPELINE_STEPS, autoGeneratePlan, buildPipeline, currentStepKey, isReviewPassed, nextStepKey, pipelineProgress, publishChecklist, reviewOutstanding, type PipelineStep, type PipelineStepKey } from '../services/content-pipeline';
import ContentSettingsPanel from './ContentSettings';
import { defaultSelection, subdirectionsOf, taskScopeLabel } from './content-taxonomy';

const stageLabels: Record<ContentStage, string> = { topics: '生成选题', brief: '生成任务书', claims: '生成证据计划', draft: '生成初稿', review: 'AI 审稿', revise: '按审稿意见修改' };
const statusNames: Record<string, string> = { idea: '选题', brief: '任务书', draft: '初稿', review: '待修改', ready: '已通过', published: '已推送草稿' };
const stateNames: Record<PipelineStep['state'], string> = { done: '已完成', current: '当前步骤', attention: '需处理', ready: '可进行', locked: '未解锁' };

type Source = { title: string; url: string; excerpt: string; status: 'user_provided' };
type Env = { wechatConfigured: boolean };

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '').trim() || '操作失败';
}
/** 预览正文由主进程渲染：只有它能读本地配图并转成 data URI。 */
function wrapPreviewHtml(body: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="max-width:720px;margin:0 auto;padding:24px">${body}</body></html>`;
}
function parseObject(value: string): Record<string, unknown> | null {
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; }
}
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const primary = record.title ?? record.heading ?? record.name ?? record.claim ?? record.issue ?? record.change;
    const rest = Object.entries(record).filter(([key]) => !['title', 'heading', 'name', 'claim', 'issue', 'change'].includes(key)).map(([, item]) => text(item)).filter(Boolean).join('；');
    return [primary ? text(primary) : '', rest].filter(Boolean).join(' — ');
  }
  return '';
}
function list(value: unknown): string[] { return Array.isArray(value) ? value.map(text).filter(Boolean) : value ? [text(value)] : []; }
function topicSuggestions(value: string): Array<{ title: string; angle: string; risk: string }> {
  const parsed = parseObject(value) as { topics?: Array<{ title?: string; angle?: string; risk_note?: string }> } | null;
  return (parsed?.topics || []).filter(item => typeof item.title === 'string').map(item => ({ title: item.title!, angle: item.angle || '', risk: item.risk_note || '' }));
}
function readSources(value: string): Source[] {
  const data = parseObject(value || '{}') as { sources?: Array<{ title?: string; url?: string; excerpt?: string }> } | null;
  return (data?.sources || []).map(item => ({ title: item.title || '', url: item.url || '', excerpt: item.excerpt || '', status: 'user_provided' }));
}
function countChars(value: string): number { return value.replace(/[#>*_`\-\s]/g, '').length; }
function shortTime(value: string): string { return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }

export default function NativeContentPanel({ notify }: { notify: (message: string) => void }) {
  const [tasks, setTasks] = useState<ContentTask[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [taxonomy, setTaxonomy] = useState<ContentTaxonomy | null>(null);
  const [directionId, setDirectionId] = useState<number | null>(null);
  const [subdirectionId, setSubdirectionId] = useState<number | null>(null);
  const [topicSeed, setTopicSeed] = useState('');
  const [busy, setBusy] = useState('');
  const [busySince, setBusySince] = useState(0);
  const [busySeconds, setBusySeconds] = useState(0);
  const [env, setEnv] = useState<Env>({ wechatConfigured: false });
  const [mode, setMode] = useState<'pipeline' | 'board'>('pipeline');
  const [step, setStep] = useState<PipelineStepKey>('topic');
  const [dirty, setDirty] = useState(false);
  /** 用户手动选过方向后，就不再让默认方向覆盖他的选择。 */
  const categoryPicked = useRef(false);
  const selected = tasks.find(item => item.id === selectedId) ?? null;
  const pipeline = useMemo(() => selected ? buildPipeline(selected, env) : [], [selected, env]);
  const assets = useContentAssets(selected?.id ?? 0, selected?.updatedAt ?? '');

  const refresh = useCallback(async () => {
    const next = await window.sydney.listContentTasks();
    setTasks(next);
    setSelectedId(current => current ?? next[0]?.id ?? null);
  }, []);
  useEffect(() => { void refresh().catch(error => notify(readableError(error))); }, [refresh, notify]);
  /** 创作设置里的默认类别与微信凭证都来自 ~/.wewrite，保存后要立即反映到新建任务那一行。 */
  const refreshEnvironment = useCallback(async () => {
    const [next, tree] = await Promise.all([window.sydney.getWeWriteEnvironment(), window.sydney.getContentTaxonomy()]);
    setEnv({ wechatConfigured: next.wechatConfigured });
    setTaxonomy(tree);
    if (!categoryPicked.current) {
      const preferred = defaultSelection(tree);
      setDirectionId(preferred.directionId);
      setSubdirectionId(preferred.subdirectionId);
    }
  }, []);
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
    <ContentSettingsPanel
      notify={notify}
      onSaved={() => { categoryPicked.current = false; void refreshEnvironment().catch(() => undefined); }}
    />
    <div className="native-create">
      <label><span>内容方向</span>
        <select value={directionId ?? ''} onChange={event => {
          categoryPicked.current = true;
          const next = Number(event.target.value) || null;
          setDirectionId(next);
          // 换一级方向时把具体方向落到它的第一个可选项，避免出现"方向A + 方向B的具体方向"。
          setSubdirectionId(subdirectionsOf(taxonomy?.directions ?? [], next)[0]?.id ?? null);
        }}>
          {(taxonomy?.directions ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
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

function Stepper({ steps, active, onSelect }: { steps: PipelineStep[]; active: PipelineStepKey; onSelect: (key: PipelineStepKey) => void }) {
  return <ol className="flow-stepper" aria-label="创作流程">
    {steps.map(item => <li key={item.key} className={`flow-node flow-node-${item.state} ${active === item.key ? 'is-active' : ''}`}>
      <button onClick={() => onSelect(item.key)} aria-current={active === item.key ? 'step' : undefined} title={item.reason || item.hint}>
        <span className="flow-dot">{item.state === 'done' ? '✓' : item.state === 'attention' ? '!' : item.index}</span>
        <span className="flow-node-label">{item.label}</span>
        <small>{stateNames[item.state]}</small>
      </button>
    </li>)}
  </ol>;
}

function Board({ tasks, env, onOpen }: { tasks: ContentTask[]; env: Env; onOpen: (task: ContentTask, step?: PipelineStepKey) => void }) {
  const columns = [...PIPELINE_STEPS.map(item => ({ key: item.key as string, label: item.label })), { key: 'finished', label: '已完成' }];
  const placed = tasks.map(task => {
    const steps = buildPipeline(task, env);
    const finished = steps.find(item => item.key === 'publish')?.state === 'done';
    return { task, column: finished ? 'finished' : currentStepKey(task, env), steps };
  });
  return <div className="flow-board">{columns.map(column => {
    const items = placed.filter(item => item.column === column.key);
    return <section key={column.key} className="flow-column"><header><strong>{column.label}</strong><span>{items.length}</span></header>
      {items.length ? items.map(({ task, steps }) => {
        const attention = steps.find(item => item.state === 'attention');
        return <button key={task.id} className="flow-card" onClick={() => onOpen(task, column.key === 'finished' ? 'publish' : column.key as PipelineStepKey)}>
          <strong>{task.title || task.topic || '未命名选题'}</strong>
          <small>{taskScopeLabel(task)}</small>
          {attention && <em>{attention.reason}</em>}
          <div className="flow-mini" aria-hidden="true">{steps.map(item => <i key={item.key} className={`flow-mini-${item.state}`} />)}</div>
        </button>;
      }) : <p className="flow-column-empty">—</p>}
    </section>;
  })}</div>;
}

function TopicStep({ task, taxonomy, locked, busy, onEdit, onRun }: { task: ContentTask; taxonomy: ContentTaxonomy | null; locked: boolean; busy: string; onEdit: (patch: Partial<ContentTask>) => void; onRun: () => void }) {
  const suggestions = topicSuggestions(task.topicsJson);
  const directions = taxonomy?.directions ?? [];
  // 分类只在选题这一步可改：换了方向就等于换了一篇要写的东西，后续步骤跟着走。
  const changeDirection = (next: number | null) => onEdit({ directionId: next, subdirectionId: subdirectionsOf(directions, next)[0]?.id ?? null });
  return <div className="flow-body">
    <div className="native-task-fields">
      <label><span>选题标题</span><input disabled={locked} value={task.title} onChange={event => onEdit({ title: event.target.value })} placeholder="选题标题" /></label>
      <label><span>内容方向</span>
        <select disabled={locked} value={task.directionId ?? ''} onChange={event => changeDirection(Number(event.target.value) || null)}>
          {directions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label><span>具体方向</span>
        <select disabled={locked} value={task.subdirectionId ?? ''} onChange={event => onEdit({ subdirectionId: Number(event.target.value) || null })}>
          <option value="">未指定</option>
          {subdirectionsOf(directions, task.directionId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label className="native-field-wide"><span>选题方向 / 读者问题</span><input disabled={locked} value={task.topic} onChange={event => onEdit({ topic: event.target.value })} placeholder="描述读者的问题或想解决的需求" /></label>
    </div>
    <div className="flow-inline-actions"><button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'topics' ? '生成中…' : suggestions.length ? '换一批 AI 选题' : 'AI 生成 5 个候选选题'}</button><small>点选候选会填入标题和方向；选好标题后点右上角「自动生成」，可一次跑完任务书 → 证据计划 → 初稿 → AI 审稿。</small></div>
    {suggestions.length > 0 && <div className="native-topic-options">{suggestions.map(item => <button key={item.title} disabled={locked} className={`native-task ${task.title === item.title ? 'is-selected' : ''}`} onClick={() => onEdit({ title: item.title, topic: item.angle })}>
      <strong>{item.title}</strong><small>{item.angle}</small>{item.risk && <small className="flow-risk">风险提示：{item.risk}</small>}<span>{task.title === item.title ? '已采用' : '采用这个选题'}</span></button>)}</div>}
  </div>;
}

function JsonStep({ value, empty, labels }: { value: string; empty: string; labels: Record<string, string> }) {
  const data = parseObject(value);
  if (!value.trim()) return <p className="flow-empty">{empty}</p>;
  if (!data) return <pre className="flow-pre">{value}</pre>;
  const keys = [...Object.keys(labels).filter(key => key in data), ...Object.keys(data).filter(key => !(key in labels))];
  return <dl className="flow-fields">{keys.map(key => {
    const items = list(data[key]);
    return <div key={key}><dt>{labels[key] ?? key}</dt><dd>{Array.isArray(data[key]) ? <ol>{items.map((item, index) => <li key={index}>{item}</li>)}</ol> : items[0] || '—'}</dd></div>;
  })}</dl>;
}

function EvidenceStep({ task, locked, onSources }: { task: ContentTask; locked: boolean; onSources: (items: Source[]) => void }) {
  const sources = readSources(task.sourcesJson);
  const claims = (parseObject(task.claimsJson)?.claims as Array<Record<string, unknown>> | undefined) ?? [];
  return <div className="flow-body">
    <div className="flow-sub-head"><h4>来源资料（{sources.length}）</h4><button className="button button-secondary" disabled={locked} onClick={() => onSources([...sources, { title: '', url: '', excerpt: '', status: 'user_provided' }])}>添加来源</button></div>
    <p className="ww-muted">填写原文链接、发布方/标题和支持主张的摘录。这里只保存你提供的材料，不会自动联网核实；资料变更后需要重新审稿。</p>
    {sources.map((source, index) => <div className="native-source" key={index}>
      <div className="native-task-fields">
        <label><span>来源标题 / 发布方</span><input disabled={locked} value={source.title} onChange={event => onSources(sources.map((item, i) => i === index ? { ...item, title: event.target.value } : item))} /></label>
        <label><span>原文链接</span><input disabled={locked} value={source.url} placeholder="https://" onChange={event => onSources(sources.map((item, i) => i === index ? { ...item, url: event.target.value } : item))} /></label>
      </div>
      <label className="ww-input"><span>与本文主张相关的摘录</span><textarea disabled={locked} value={source.excerpt} onChange={event => onSources(sources.map((item, i) => i === index ? { ...item, excerpt: event.target.value } : item))} /></label>
      <button className="button button-quiet" disabled={locked} onClick={() => onSources(sources.filter((_item, i) => i !== index))}>移除此来源</button>
    </div>)}
    <div className="flow-sub-head"><h4>待核实主张（{claims.length}）</h4></div>
    {claims.length ? <table className="flow-table"><thead><tr><th>主张</th><th>需要的证据</th><th>检索词</th><th>风险</th><th>状态</th></tr></thead><tbody>
      {claims.map((claim, index) => <tr key={index}><td>{text(claim.claim)}</td><td>{text(claim.evidence_needed)}</td><td>{list(claim.search_queries).join('、')}</td><td>{text(claim.risk)}</td><td><span className="status status-pending">待核实</span></td></tr>)}
    </tbody></table> : <p className="flow-empty">还没有证据计划。生成后，模型列出的每条主张都标为「待核实」，需要你对照来源确认。</p>}
  </div>;
}

function DraftStep({ task, assets, locked, busy, busySeconds, onEdit, onGenerateImages, onGenerateImagesWithCover }: { task: ContentTask; assets: ContentAssetBundle | null; locked: boolean; busy: string; busySeconds: number; onEdit: (draft: string) => void; onGenerateImages: () => void; onGenerateImagesWithCover: () => void }) {
  const [preview, setPreview] = useState(false);
  const images = countInlineImages(task.draft);
  return <div className="flow-body">
    <div className="flow-sub-head"><h4>{preview ? '正文预览（公众号排版）' : '文章正文（Markdown）'}<small>约 {countChars(task.draft)} 字</small></h4>
      <div className="flow-mode"><button className={!preview ? 'is-active' : ''} onClick={() => setPreview(false)}>编辑</button><button className={preview ? 'is-active' : ''} onClick={() => setPreview(true)}>预览</button></div></div>
    <div className="flow-inline-actions">
      <button className="button button-secondary" disabled={locked} onClick={onGenerateImages}>{busy === 'images' ? `配图中… ${busySeconds}s` : images ? `重新生成正文配图（现有 ${images} 张）` : 'AI 生成正文配图'}</button>
      <button className="button button-secondary" disabled={locked} title="封面与 3 张正文配图一次生成；正文为空时只出封面" onClick={onGenerateImagesWithCover}>{busy === 'images-all' ? `封面与配图生成中… ${busySeconds}s` : 'AI 生成封面 + 正文配图'}</button>
      <small>按小标题自动挑位置插入配图；导出时图片一起复制到知识库，推送时自动上传到微信。插入配图会改动正文，需要重新审稿。</small>
    </div>
    <InlineImageGallery images={assets?.images ?? []} />
    {preview ? <ArticlePreview taskId={task.id} source="draft" revision={task.updatedAt} title="文章预览" />
      : <textarea className="flow-draft" disabled={locked} value={task.draft} onChange={event => onEdit(event.target.value)} placeholder="生成初稿后在这里编辑；也可以直接粘贴自己写的正文。改动正文会使之前的审稿结论失效。" />}
  </div>;
}

function CoverStep({ task, assets, locked, busy, busySeconds, onChoose, onGenerateCover, onGenerateImages, onGenerateImagesWithCover }: {
  task: ContentTask; assets: ContentAssetBundle | null; locked: boolean; busy: string; busySeconds: number;
  onChoose: () => void; onGenerateCover: () => void; onGenerateImages: () => void; onGenerateImagesWithCover: () => void;
}) {
  return <div className="flow-body">
    <div className="flow-cover">
      <figure className="flow-cover-figure">
        {assets?.cover?.thumbnail
          ? <img src={assets.cover.thumbnail} alt="封面预览" />
          : <div className="flow-image-missing">还没有封面图</div>}
        <figcaption>{task.coverPath ? task.coverPath.split(/[\\/]/).pop() : '未选择封面'}</figcaption>
      </figure>
      <div className="flow-cover-actions">
        <button className="button button-secondary" disabled={locked} onClick={onChoose}>选择本地图片</button>
        <button className="button button-secondary" disabled={locked} onClick={onGenerateCover}>{busy === 'cover' ? `生成中… ${busySeconds}s` : 'AI 生成封面'}</button>
        <button className="button button-primary" disabled={locked} title="封面与 3 张正文配图一次生成；正文为空时只出封面" onClick={onGenerateImagesWithCover}>{busy === 'images-all' ? `封面与配图生成中… ${busySeconds}s` : 'AI 生成封面 + 正文配图'}</button>
        <button className="button button-secondary" disabled={locked} onClick={onGenerateImages}>{busy === 'images' ? `配图中… ${busySeconds}s` : '只生成正文配图'}</button>
        <small>封面是微信草稿的缩略图；正文配图按小标题插进正文，推送时会自动上传到微信。一次生成会同时消耗封面与配图的费用。</small>
      </div>
    </div>
    <InlineImageGallery images={assets?.images ?? []} />
  </div>;
}

/** 正文配图的缩略图墙：生成后立刻能看到效果，不用去正文里找路径。 */
function InlineImageGallery({ images }: { images: ContentAssetView[] }) {
  if (!images.length) return null;
  return <div className="flow-gallery">
    {images.map((image, index) => <figure key={`${image.path}-${index}`}>
      {image.thumbnail
        ? <img src={image.thumbnail} alt={image.caption || `正文配图 ${index + 1}`} />
        : <div className="flow-image-missing">图片不可用</div>}
      <figcaption>{image.caption || `正文配图 ${index + 1}`}</figcaption>
    </figure>)}
  </div>;
}

/** 封面和配图都由主进程生成缩略图，任务或内容变动后自动重新拉取。 */
function useContentAssets(taskId: number, revision: string): ContentAssetBundle | null {
  const [assets, setAssets] = useState<ContentAssetBundle | null>(null);
  useEffect(() => {
    if (!taskId) { setAssets(null); return; }
    let alive = true;
    void window.sydney.getContentAssets(taskId)
      .then(next => { if (alive) setAssets(next); })
      .catch(() => { if (alive) setAssets(null); });
    return () => { alive = false; };
  }, [taskId, revision]);
  return assets;
}

/** 预览必须由主进程渲染：渲染进程读不到本地配图文件。 */
function ArticlePreview({ taskId, source, revision, title }: { taskId: number; source: 'draft' | 'final'; revision: string; title: string }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void window.sydney.renderContentPreview(taskId, source)
      .then(result => { if (alive) { setHtml(result.html); setError(''); } })
      .catch(issue => { if (alive) setError(readableError(issue)); });
    return () => { alive = false; };
  }, [taskId, source, revision]);
  if (error) return <p className="flow-empty">{error}</p>;
  return <iframe className="flow-preview" title={title} sandbox="" srcDoc={wrapPreviewHtml(html)} />;
}

function ReviewStep({ task, locked, busy, onRevise }: { task: ContentTask; locked: boolean; busy: string; onRevise: () => void }) {
  const review = parseObject(task.reviewJson);
  if (!review) return <p className="flow-empty">还没有审稿结论。审稿检查表达、逻辑和健康风险；存在待核实的关键健康主张时不会给出「通过」。</p>;
  const decision = String(review.decision ?? '');
  const decisionText: Record<string, string> = { pass: '通过', revise: '需修改', reject: '不通过' };
  const scores = [['准确性', review.accuracy_score], ['实用性', review.usefulness_score], ['可读性', review.readability_score]] as const;
  const groups = [['必须修改', review.required_changes], ['健康风险', review.health_risks], ['缺乏依据的主张', review.unsupported_claims]] as const;
  return <div className="flow-body">
    <div className="flow-review-head">
      <span className={`flow-decision flow-decision-${decision}`}>{decisionText[decision] ?? (decision || '未知')}</span>
      {scores.map(([label, value]) => <span key={label} className="flow-score"><b>{text(value) || '—'}</b>{label}</span>)}
      <span className="flow-spacer" />
      <button className="button button-primary" disabled={locked || decision === 'pass'} title="把上面的审稿意见逐条交给内容 API，让它改出一版新初稿；改完需要重新审稿" onClick={onRevise}>{busy === 'revise' ? '修改中…' : '按审稿意见修改正文'}</button>
    </div>
    {review.summary !== undefined && <p className="flow-summary">{text(review.summary)}</p>}
    {groups.map(([label, value]) => { const items = list(value); return items.length ? <div key={label} className="flow-issue-group"><h4>{label}（{items.length}）</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null; })}
    {decision !== 'pass' && <p className="ww-muted">点「按审稿意见修改正文」会在初稿基础上按上面三条意见重写一版并替换初稿；新初稿需要重新审稿。若你已经手动改好，也可以直接去「来源与证据」之后的发布步骤导出或推送草稿箱。</p>}
  </div>;
}

function PublishStep({ task, env }: { task: ContentTask; env: Env }) {
  const checklist = publishChecklist(task, env);
  return <div className="flow-body">
    <ul className="flow-checklist">{checklist.map(item => <li key={item.label} className={item.ok ? 'is-ok' : 'is-missing'}><span aria-hidden="true">{item.ok ? '✓' : '○'}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></li>)}</ul>
    <p className="ww-muted">只要正文存在就可以导出或推送草稿箱，不必先通过审稿；未通过审稿时会弹窗列出待处理的问题让你确认。推送只创建草稿、不会群发，仍需封面与公众号凭证。</p>
    {task.exportPath && <p className="native-export-path">最近导出：{task.exportPath}</p>}
    {task.publishJson && <details className="native-json"><summary>草稿推送记录</summary><pre>{task.publishJson}</pre></details>}
    {(task.finalArticle.trim() || task.draft.trim()) && <ArticlePreview taskId={task.id} source="final" revision={task.updatedAt} title="成稿预览" />}
  </div>;
}
