import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentDirection, ContentStage, ContentTask, ContentTaxonomy, ImageCandidateBundle, WechatIpCoverInput } from '../shared';
import { ARTICLE_THEMES, DEFAULT_ARTICLE_THEME } from '../services/article-html';
import { PIPELINE_STEPS, autoGeneratePlan, buildPipeline, currentStepKey, isReviewPassed, nextStepKey, pipelineProgress, publishChecklist, reviewOutstanding, type PipelineStepKey } from '../services/content-pipeline';
import ContentSettingsPanel from './ContentSettings';
import { profileDefaultSubdirection, subdirectionsOf, taskScopeLabel } from './content-taxonomy';
import { ConfirmButton, readableError, shortTime, useWorkflowStepScroll } from './ui';
import { stageLabels, stateNames, statusNames, type Env } from './native-content/format';
import { Board, CoverStep, DraftStep, EvidenceStep, ImageCandidatePicker, JsonStep, PublishStep, ReviewStep, Stepper, TopicStep, useContentAssets } from './native-content/steps';

/** 同一篇文章的两条通道：正文（以及一切会改正文的操作）与封面，和主进程的两把锁一一对应。 */
type Lane = 'main' | 'cover';
const BOTH_LANES: Lane[] = ['main', 'cover'];
const laneSlot = (id: number, lane: Lane) => lane === 'main' ? String(id) : `${id}:cover`;

/** 从 since 起已经过去几秒；since 为 0 表示没在跑。秒数走字是为了让「等」和「坏了」能区分开。 */
function useElapsed(since: number): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!since) return;
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - since) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return seconds;
}

/**
 * 创作流水线：只显示当前公众号资料下的文章任务（加上还没归类的老任务），新建任务也归到这份资料。
 * 切换资料时由父组件用 key 重建本组件，所以这里把资料当作常量处理。
 */
export default function NativeContentPanel({ profile, notify, onOpenConfig, onOpenBackend }: { profile: ContentDirection | null; notify: (message: string) => void; onOpenConfig: () => void; onOpenBackend: () => void }) {
  const directionId = profile?.id ?? null;
  const [allTasks, setTasks] = useState<ContentTask[]>([]);
  const tasks = useMemo(() => allTasks.filter(task => task.directionId === directionId || task.directionId === null), [allTasks, directionId]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [taxonomy, setTaxonomy] = useState<ContentTaxonomy | null>(null);
  const [subdirectionId, setSubdirectionId] = useState<number | null>(null);
  const [topicSeed, setTopicSeed] = useState('');
  /**
   * 进行中的长操作按「文章 + 通道」记：一篇在生图时，可以切到另一篇继续写或同时生图；
   * 同一篇里封面单独一条通道（和后端的两把锁对应），所以生成封面时还能同时生成正文配图。
   */
  const [jobs, setJobs] = useState<Record<string, { key: string; since: number }>>({});
  const [env, setEnv] = useState<Env>({ wechatConfigured: false });
  const [mode, setMode] = useState<'pipeline' | 'board'>('pipeline');
  const [step, setStep] = useState<PipelineStepKey>('topic');
  const [dirty, setDirty] = useState(false);
  /** 每处生成几张：1 张＝生成即插入，2–3 张先生成候选再由用户在面板里挑。 */
  const [candidateCount, setCandidateCount] = useState(1);
  /** 待挑的候选图按文章存：后台那篇出完候选，切回去还能接着挑。 */
  const [candidateSheets, setCandidateSheets] = useState<Record<number, ImageCandidateBundle>>({});
  /** 用户手动选过具体方向后，就不再让默认值覆盖他的选择。 */
  const categoryPicked = useRef(false);
  const selected = tasks.find(item => item.id === selectedId) ?? null;
  /** 异步操作完成时用它判断用户是否还停在那篇文章上，别把别的文章的界面跳走。 */
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedId;
  const busy = selectedId !== null ? jobs[laneSlot(selectedId, 'main')]?.key ?? '' : '';
  const coverBusy = selectedId !== null ? jobs[laneSlot(selectedId, 'cover')]?.key ?? '' : '';
  const busySeconds = useElapsed(selectedId !== null ? jobs[laneSlot(selectedId, 'main')]?.since ?? 0 : 0);
  const coverSeconds = useElapsed(selectedId !== null ? jobs[laneSlot(selectedId, 'cover')]?.since ?? 0 : 0);
  const candidateSheet = selectedId !== null ? candidateSheets[selectedId] ?? null : null;
  const setCandidateSheet = (id: number, bundle: ImageCandidateBundle | null) => setCandidateSheets(current => {
    const next = { ...current };
    if (bundle) next[id] = bundle; else delete next[id];
    return next;
  });
  const setJob = (id: number, key: string, lanes: Lane[] = ['main']) => setJobs(current => {
    const next = { ...current };
    for (const lane of lanes) {
      const slot = laneSlot(id, lane);
      if (key) next[slot] = { key, since: current[slot]?.since ?? Date.now() }; else delete next[slot];
    }
    return next;
  });
  const onTask = (id: number) => selectedRef.current === id;
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
  /** 封面通道只改封面：只合并 coverPath，免得把封面生成期间没保存的正文改动冲掉。 */
  const replaceCover = (task: ContentTask) => setTasks(current => current.map(item => item.id === task.id ? { ...item, coverPath: task.coverPath, updatedAt: task.updatedAt } : item));
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
  /** 新建任务不属于任何一篇文章，单独占一个槽位。 */
  const CREATE_SLOT = -1;
  /**
   * 长操作只锁发起它的那篇文章的对应通道；结束后的提示若不在当前文章，就带上标题以免看不出是哪篇。
   * lanes 默认只占正文通道；只改封面的操作占封面通道，同时动两边的两条都占。
   */
  const guarded = async (key: string, run: (say: (message: string) => void, here: () => boolean) => Promise<void>, lanes: Lane[] = ['main']) => {
    const id = key === 'create' ? CREATE_SLOT : selectedRef.current;
    if (id === null) return;
    const owner = tasks.find(item => item.id === id);
    const title = owner?.title || owner?.topic || '新文章';
    setJobs(current => {
      const next = { ...current };
      for (const lane of lanes) next[laneSlot(id, lane)] = { key, since: Date.now() };
      return next;
    });
    const scoped = (message: string) => notify(id === CREATE_SLOT || onTask(id) ? message : `《${title}》${message}`);
    try { await run(scoped, () => onTask(id)); } catch (error) { scoped(readableError(error)); } finally { setJob(id, '', lanes); }
  };
  const imageJob = [busy, coverBusy].some(key => key === 'cover' || key === 'images' || key === 'images-all');
  const cancelImages = async () => {
    if (!selected) return;
    const cancelled = await window.sydney.cancelContentImages(selected.id);
    notify(cancelled ? '已请求取消，等接口返回后即可继续操作' : '当前没有正在进行的生图');
  };

  const create = () => guarded('create', async say => {
    const task = await window.sydney.createContentTask(directionId, subdirectionId, topicSeed);
    setTasks(current => [task, ...current]);
    setSelectedId(task.id);
    setDirty(false);
    setStep('topic');
    setMode('pipeline');
    setTopicSeed('');
    say('已创建文章任务，从「选题」开始');
  });
  /** 删除当前文章：未保存的修改一并丢弃；列表刷新后自动选中下一篇。 */
  const remove = () => guarded('delete', async say => {
    if (!selected) return;
    const id = selected.id;
    const name = selected.title || selected.topic || '新文章';
    await window.sydney.deleteContentTask(id);
    setDirty(false);
    setTasks(current => current.filter(item => item.id !== id));
    setCandidateSheet(id, null);
    say(`已删除《${name}》；已导出到知识库的文件不受影响`);
  }, BOTH_LANES);
  const runStage = (stage: ContentStage, advance = true) => guarded(stage, async (say, here) => {
    if (!selected) return;
    await persistSelected();
    const task = await window.sydney.generateContentStage(selected.id, stage);
    replaceTask(task);
    say(stage === 'revise' ? '正文已按审稿意见更新，请重新审稿' : `${stageLabels[stage]}完成`);
    // 用户已经切到别的文章时不要把界面跳走。
    if (!advance || !here()) return;
    if (stage === 'review') setStep(isReviewPassed(task) ? (task.coverPath ? 'publish' : 'cover') : 'review');
    // revise 不是流水线步骤，改完要回到审稿重新过一遍门槛。
    else if (stage === 'revise') setStep('review');
    else if (stage !== 'topics') {
      const current = PIPELINE_STEPS.find(item => item.stage === stage);
      const next = current ? nextStepKey(current.key) : null;
      if (next) setStep(next);
    }
  });
  const save = () => guarded('save', async say => { replaceTask(await persistSelected()); say('已保存'); });
  /** 切到「公众号后台」页签会卸载本面板，先把未保存的修改存下来。 */
  const openBackend = () => {
    if (!dirty) { onOpenBackend(); return; }
    void guarded('save', async () => { replaceTask(await persistSelected()); onOpenBackend(); });
  };
  /** 候选张数 > 1 时先生成候选（不落库），交给候选面板挑；候选面板只有一个，所以出候选要两条通道都占。 */
  const wantCandidates = candidateCount > 1;
  const generateCover = () => guarded('cover', async say => {
    if (!selected) return;
    if (wantCandidates) {
      await persistSelected();
      setCandidateSheet(selected.id, await window.sydney.generateContentImageCandidates(selected.id, 'cover', 3, candidateCount));
      say(`已生成 ${candidateCount} 张封面候选，挑一张再采用`);
      return;
    }
    // 正文通道忙时后端不让保存；那时正文输入框是禁用的，不会有新的未保存修改。
    if (dirty && !busy) await persistSelected();
    replaceCover(await window.sydney.generateContentCover(selected.id));
    say('封面图已生成');
  }, wantCandidates ? BOTH_LANES : ['cover']);
  /** IP 模板出封面：成功后返回另存的 1:1 分享图，失败（已提示）返回 null。 */
  const ipCover = (input: WechatIpCoverInput) => new Promise<{ path: string; thumbnail: string } | null>(resolve => {
    void guarded('ip-cover', async say => {
      if (!selected) return;
      const result = await window.sydney.renderContentIpCover(selected.id, input);
      replaceCover(result.task);
      say('IP 封面与 1:1 分享图已生成');
      resolve(result.share);
    }, ['cover']).then(() => resolve(null));
  });
  const chooseCover = () => guarded('cover-choose', async say => {
    if (!selected) return;
    const task = await window.sydney.chooseContentCover(selected.id);
    if (task) { replaceCover(task); say('已关联封面图'); }
  }, ['cover']);
  /** 排版主题只影响呈现，不使审稿失效，所以保存后可以立即看到效果。 */
  const changeTheme = (theme: string) => guarded('theme', async () => {
    if (!selected) return;
    setTasks(current => current.map(item => item.id === selected.id ? { ...item, theme } : item));
    replaceTask(await window.sydney.updateContentTask(selected.id, { theme }));
  });
  const generateImages = () => guarded('images', async say => {
    if (!selected) return;
    await persistSelected();
    if (wantCandidates) {
      setCandidateSheet(selected.id, await window.sydney.generateContentImageCandidates(selected.id, 'inline', 3, candidateCount));
      say(`已生成正文配图候选（每处 ${candidateCount} 张），挑好再插入`);
      return;
    }
    replaceTask(await window.sydney.generateContentImages(selected.id, 3));
    say('已生成正文配图并插入正文，改动过正文需要重新审稿');
  }, wantCandidates ? BOTH_LANES : ['main']);
  /** 封面与正文配图一次出：两条生成并发跑，部分失败时按已生成的结果入库并提示原因。 */
  const generateImagesWithCover = () => guarded('images-all', async say => {
    if (!selected) return;
    await persistSelected();
    if (wantCandidates) {
      setCandidateSheet(selected.id, await window.sydney.generateContentImageCandidates(selected.id, 'both', 3, candidateCount));
      say(`已生成封面与配图候选（每处 ${candidateCount} 张），挑好再采用`);
      return;
    }
    const task = await window.sydney.generateContentImagesWithCover(selected.id, 3);
    replaceTask(task);
    say(task.imageWarning || '封面与正文配图已生成');
  }, BOTH_LANES);
  const applyCandidates = (picks: Array<{ key: string; path: string }>) => guarded('images-apply', async say => {
    if (!selected) return;
    try {
      replaceTask(await window.sydney.applyContentImageCandidates(selected.id, picks));
      setCandidateSheet(selected.id, null);
      say('已采用挑好的图，改动过正文需要重新审稿');
    } catch (error) {
      // 正文改过等失败情形下候选已经不可用，别让面板停在点不动的状态。
      setCandidateSheet(selected.id, null);
      throw error;
    }
  }, BOTH_LANES);
  const discardCandidates = () => guarded('images-discard', async () => {
    if (!selected) return;
    setCandidateSheet(selected.id, null);
    await window.sydney.discardContentImageCandidates(selected.id);
  });
  /** 以前的图也能挑：不重新生成，直接把这篇任务已经出过的图列出来换上去。 */
  const openImageLibrary = (scope: 'cover' | 'inline' | 'both') => guarded('images-library', async say => {
    if (!selected) return;
    const bundle = await window.sydney.openContentImageLibrary(selected.id, scope);
    setCandidateSheet(selected.id, bundle);
    say(bundle.warning || '从以前生成的图里挑一张');
  }, BOTH_LANES);
  /** 「文章配图」里逐张换图：只换那一张，用的是这篇文章生成过的图。 */
  const swapImage = (index: number, target: string, expected: string) => guarded('images-swap', async say => {
    if (!selected) return;
    await persistSelected();
    replaceTask(await window.sydney.swapContentImage(selected.id, index, target, expected));
    say(`已换掉第 ${index + 1} 张配图，改动过正文需要重新审稿`);
  });
  const exportArticle = (allowUnreviewed = false) => guarded('export', async say => {
    if (!selected) return;
    await persistSelected();
    const task = await window.sydney.exportContentTask(selected.id, allowUnreviewed);
    replaceTask(task);
    say(`成稿已导出：${task.exportPath}`);
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
    void guarded('auto', async (say, here) => {
      await persistSelected();
      let task: ContentTask = { ...selected };
      for (const stage of plan.stages) {
        const target = PIPELINE_STEPS.find(item => item.stage === stage)?.key;
        if (target && here()) setStep(target);
        setJob(selected.id, `auto:${stage}`);
        task = await window.sydney.generateContentStage(selected.id, stage);
        replaceTask(task);
      }
      say(`自动生成完成：${plan.stages.map(item => stageLabels[item]).join(' → ')}`);
      if (here()) setStep(isReviewPassed(task) ? (task.coverPath ? 'publish' : 'cover') : 'review');
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
    void guarded('publish', async say => {
      await persistSelected();
      replaceTask(await window.sydney.publishContentTask(selected.id, allowUnreviewed));
      say('已推送到公众号草稿箱');
    }, BOTH_LANES);
  };

  const locked = busy !== '';
  const coverLocked = coverBusy !== '';
  const creating = Boolean(jobs[laneSlot(CREATE_SLOT, 'main')]);
  const autoStage = busy.startsWith('auto:') ? busy.slice('auto:'.length) as ContentStage : null;
  const autoStageLabel = autoStage ? stageLabels[autoStage] : '准备中';
  const activeStep = pipeline.find(item => item.key === step) ?? pipeline[0];
  const flowRef = useWorkflowStepScroll(`${selectedId ?? 0}:${step}`);

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
      <button className="button button-primary" disabled={creating} onClick={() => void create()}>新建文章任务</button>
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
            <small>{jobs[laneSlot(task.id, 'main')] || jobs[laneSlot(task.id, 'cover')] ? '处理中…' : shortTime(task.updatedAt)}</small>
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
              {!locked && !coverLocked && <ConfirmButton className="button button-danger-quiet" armedLabel="确认删除" title="删除这篇文章和它的配图；已导出到知识库的文件不受影响" onConfirm={() => void remove()}>删除</ConfirmButton>}
            </div>
          </div>

          <Stepper steps={pipeline} active={step} onSelect={setStep} />

          <section ref={flowRef} className={`flow-panel flow-panel-${activeStep.state}`} aria-labelledby="flow-step-title">
            <header className="flow-panel-head">
              <span className="flow-panel-index">{activeStep.index}</span>
              <div><h3 id="flow-step-title">{activeStep.label}</h3><p>{activeStep.hint}</p></div>
              <span className={`flow-badge flow-badge-${activeStep.state}`}>{stateNames[activeStep.state]}</span>
            </header>
            <div className="flow-panel-toolbar">
              <span className="flow-panel-progress">第 {activeStep.index} / {pipeline.length} 步</span>
              {PIPELINE_STEPS.findIndex(item => item.key === step) > 0 && <button className="button button-quiet button-small" onClick={() => setStep(PIPELINE_STEPS[PIPELINE_STEPS.findIndex(item => item.key === step) - 1].key)}>← 上一步</button>}
              <span className="flow-spacer" />
              {activeStep.stage && step !== 'topic' && <button className={`button ${activeStep.state === 'done' ? 'button-secondary' : 'button-primary'}`} disabled={locked || activeStep.state === 'locked'} onClick={() => void runStage(activeStep.stage!)}>
                {busy === activeStep.stage ? '处理中…' : activeStep.state === 'done' || (step === 'review' && selected.reviewJson) ? `重新${stageLabels[activeStep.stage]}` : stageLabels[activeStep.stage]}</button>}
              {step === 'review' && activeStep.state === 'attention' && <button className="button button-secondary" disabled={locked} onClick={() => setStep('draft')}>回到初稿修改</button>}
              {step === 'publish' && <>
                <button className="button button-secondary" disabled={locked || !(selected.finalArticle.trim() || selected.draft.trim())} title="未通过审稿也能导出，导出前会二次确认" onClick={() => deliver('export')}>{busy === 'export' ? '导出中…' : '导出到 Obsidian'}</button>
                <button className="button button-primary" disabled={locked || publishChecklist(selected, env).some(item => !item.ok)} title="推送到真实公众号草稿箱；未通过审稿也能推送，推送前会二次确认" onClick={() => deliver('publish')}>{busy === 'publish' ? '推送中…' : '推送草稿箱'}</button>
                <button className="button button-secondary" disabled={locked} title="切到「公众号后台」页签，在应用里打开微信公众平台，到草稿箱检查排版并手动发表" onClick={openBackend}>打开公众号后台</button>
              </>}
              {nextStepKey(step) && <button className="button button-quiet" onClick={() => setStep(nextStepKey(step)!)}>下一步：{PIPELINE_STEPS.find(item => item.key === nextStepKey(step))?.label} →</button>}
            </div>
            {activeStep.reason && <p className={activeStep.state === 'locked' ? 'flow-locked-note' : 'flow-attention-note'}>{activeStep.reason}</p>}
            {(locked || coverLocked) && <p className="flow-locked-note">
              {locked
                ? `正在处理中，已等待 ${busySeconds} 秒；完成前会改动正文的按钮保持禁用${coverLocked ? '' : '，封面仍可同时生成'}。`
                : `封面生成中，已等待 ${coverSeconds} 秒；正文、正文配图可以同时操作。`}
              {imageJob && <button className="button button-quiet button-small" onClick={() => void cancelImages()}>取消生成</button>}
            </p>}

            {step === 'topic' && <TopicStep task={selected} taxonomy={taxonomy} locked={locked} busy={busy} onEdit={editSelected} onRun={() => void runStage('topics')} notify={notify} />}
            {step === 'brief' && <JsonStep value={selected.briefJson} empty="还没有任务书。任务书会给出目标读者、读者问题、核心主张、章节和边界，初稿严格按它展开。"
              labels={{ target_reader: '目标读者', reader_problem: '读者问题', promise: '文章承诺', core_claim: '核心主张', sections: '章节结构', evidence_needed: '需要的证据', boundaries: '写作边界', framework: '框架' }} />}
            {step === 'evidence' && <EvidenceStep task={selected} locked={locked} onSources={items => editSelected({ sourcesJson: JSON.stringify({ sources: items }) })} />}
            {step === 'draft' && <DraftStep task={selected} assets={assets} locked={locked} coverLocked={coverLocked} busy={busy} busySeconds={busySeconds}
              candidateCount={candidateCount} onCandidateCount={setCandidateCount}
              onEdit={draft => editSelected({ draft })} onTheme={theme => void changeTheme(theme)} onGenerateImages={() => void generateImages()} onGenerateImagesWithCover={() => void generateImagesWithCover()}
              onPickFromLibrary={() => void openImageLibrary('inline')} onSwapImage={(index, target, expected) => void swapImage(index, target, expected)} />}
            {step === 'review' && <ReviewStep task={selected} locked={locked} busy={busy} onRevise={() => void runStage('revise')} />}
            {step === 'cover' && <CoverStep
              task={selected}
              assets={assets}
              locked={locked}
              busy={busy}
              busySeconds={busySeconds}
              coverBusy={coverBusy}
              coverSeconds={coverSeconds}
              candidateCount={candidateCount}
              onCandidateCount={setCandidateCount}
              onChoose={() => void chooseCover()}
              onGenerateCover={() => void generateCover()}
              onGenerateImages={() => void generateImages()}
              onGenerateImagesWithCover={() => void generateImagesWithCover()}
              onPickFromLibrary={() => void openImageLibrary('both')}
              onSwapImage={(index, target, expected) => void swapImage(index, target, expected)}
              onIpCover={ipCover}
            />}
            {step === 'publish' && <PublishStep task={selected} env={env} />}

            {candidateSheet && candidateSheet.taskId === selected.id && <ImageCandidatePicker bundle={candidateSheet} busy={busy || coverBusy} onApply={picks => void applyCandidates(picks)} onDiscard={() => void discardCandidates()} />}
          </section>
        </> : <div className="native-empty native-editor-empty"><strong>先创建一个文章任务</strong><span>选择类别后，按 选题 → 任务书 → 来源与证据 → 初稿 → AI 审稿 → 封面 → 导出与发布 逐步推进。</span></div>}
      </div>
    </div>}
  </section>;
}
