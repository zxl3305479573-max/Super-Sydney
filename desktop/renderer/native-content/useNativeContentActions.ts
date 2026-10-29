import type { ContentStage, ContentTask, WechatIpCoverInput } from '../../shared';
import {
  autoGeneratePlan,
  currentStepKey,
  isReviewPassed,
  publishChecklist,
  reviewOutstanding,
  type PipelineStepKey,
  PIPELINE_STEPS,
} from '../../services/content-pipeline';
import { readableError } from '../ui';
import { stageLabels } from './format';
import { BOTH_LANES, laneSlot, type Lane, type useNativeContentState } from './useNativeContentState';

type State = ReturnType<typeof useNativeContentState>;

/** Imperative actions remain verbatim in behaviour; view components only receive these callbacks. */
export function useNativeContentActions(state: State, notify: (message: string) => void, onOpenBackend: () => void) {
  const {
    directionId,
    subdirectionId,
    topicSeed,
    setTopicSeed,
    tasks,
    selected,
    selectedId,
    selectedRef,
    setSelectedId,
    setTasks,
    setDirty,
    setStep,
    setMode,
    env,
    dirty,
    busy,
    candidateCount,
    setCandidateSheet,
    setJob,
    onTask,
    setJobs,
  } = state;
  const replaceTask = (task: ContentTask) =>
    setTasks((current) => current.map((item) => (item.id === task.id ? task : item)));
  const replaceCover = (task: ContentTask) =>
    setTasks((current) =>
      current.map((item) =>
        item.id === task.id ? { ...item, coverPath: task.coverPath, updatedAt: task.updatedAt } : item,
      ),
    );
  const persistSelected = async () => {
    if (!selected) throw new Error('请先选择文章任务');
    const task = await window.sydney.updateContentTask(selected.id, {
      directionId: selected.directionId,
      subdirectionId: selected.subdirectionId,
      topic: selected.topic,
      title: selected.title,
      draft: selected.draft,
      sourcesJson: selected.sourcesJson,
    });
    setDirty(false);
    return task;
  };
  const editSelected = (patch: Partial<ContentTask>) => {
    if (!selected) return;
    setDirty(true);
    setTasks((current) =>
      current.map((item) =>
        item.id === selected.id
          ? {
              ...item,
              ...patch,
              finalArticle: '',
              reviewJson: '',
              status: item.draft || patch.draft ? 'draft' : 'idea',
            }
          : item,
      ),
    );
  };
  const guarded = async (
    key: string,
    run: (say: (message: string) => void, here: () => boolean) => Promise<void>,
    lanes: Lane[] = ['main'],
  ) => {
    const id = key === 'create' ? -1 : selectedRef.current;
    if (id === null) return;
    const owner = tasks.find((item) => item.id === id);
    const title = owner?.title || owner?.topic || '新文章';
    setJobs((current) => {
      const next = { ...current };
      for (const lane of lanes) next[laneSlot(id, lane)] = { key, since: Date.now() };
      return next;
    });
    const scoped = (message: string) => notify(id === -1 || onTask(id) ? message : `《${title}》${message}`);
    try {
      await run(scoped, () => onTask(id));
    } catch (error) {
      scoped(readableError(error));
    } finally {
      setJob(id, '', lanes);
    }
  };
  const openTask = (task: ContentTask, target?: PipelineStepKey) => {
    if (dirty && task.id !== selectedId && !window.confirm('当前文章有未保存的修改，切换后这些修改会丢失。继续？'))
      return;
    if (task.id !== selectedId) setDirty(false);
    setSelectedId(task.id);
    setStep(target ?? currentStepKey(task, env));
    setMode('pipeline');
  };
  const create = () =>
    guarded('create', async (say) => {
      const task = await window.sydney.createContentTask(directionId, subdirectionId, topicSeed);
      setTasks((current) => [task, ...current]);
      setSelectedId(task.id);
      setDirty(false);
      setStep('topic');
      setMode('pipeline');
      setTopicSeed('');
      say('已创建文章任务，从「选题」开始');
    });
  const remove = () =>
    guarded(
      'delete',
      async (say) => {
        if (!selected) return;
        const id = selected.id;
        const name = selected.title || selected.topic || '新文章';
        await window.sydney.deleteContentTask(id);
        setDirty(false);
        setTasks((current) => current.filter((item) => item.id !== id));
        setCandidateSheet(id, null);
        say(`已删除《${name}》；已导出到知识库的文件不受影响`);
      },
      BOTH_LANES,
    );
  const runStage = (stage: ContentStage, advance = true) =>
    guarded(stage, async (say, here) => {
      if (!selected) return;
      const saved = await persistSelected();
      const task = await window.sydney.generateContentStage(saved.id, stage);
      replaceTask(task);
      say(stage === 'revise' ? '正文已按审稿意见更新，请重新审稿' : `${stageLabels[stage]}完成`);
      if (!advance || !here()) return;
      if (stage === 'review') setStep(isReviewPassed(task) ? (task.coverPath ? 'publish' : 'cover') : 'review');
      else if (stage === 'revise') setStep('review');
      else if (stage !== 'topics') {
        const current = PIPELINE_STEPS.find((item) => item.stage === stage);
        const next = current ? PIPELINE_STEPS[PIPELINE_STEPS.indexOf(current) + 1]?.key : null;
        if (next) setStep(next);
      }
    });
  const save = () =>
    guarded('save', async (say) => {
      replaceTask(await persistSelected());
      say('已保存');
    });
  const openBackend = () => {
    if (!dirty) {
      onOpenBackend();
      return;
    }
    void guarded('save', async () => {
      replaceTask(await persistSelected());
      onOpenBackend();
    });
  };
  const wantCandidates = candidateCount > 1;
  const generateCover = () =>
    guarded(
      'cover',
      async (say) => {
        if (!selected) return;
        if (wantCandidates) {
          await persistSelected();
          setCandidateSheet(
            selected.id,
            await window.sydney.generateContentImageCandidates(selected.id, 'cover', 3, candidateCount),
          );
          say(`已生成 ${candidateCount} 张封面候选，挑一张再采用`);
          return;
        }
        if (dirty && !busy) await persistSelected();
        replaceCover(await window.sydney.generateContentCover(selected.id));
        say('封面图已生成');
      },
      wantCandidates ? BOTH_LANES : ['cover'],
    );
  const ipCover = (input: WechatIpCoverInput) =>
    new Promise<{ path: string; thumbnail: string } | null>((resolve) => {
      void guarded(
        'ip-cover',
        async (say) => {
          if (!selected) return;
          const result = await window.sydney.renderContentIpCover(selected.id, input);
          replaceCover(result.task);
          say('IP 封面与 1:1 分享图已生成');
          resolve(result.share);
        },
        ['cover'],
      ).then(() => resolve(null));
    });
  const chooseCover = () =>
    guarded(
      'cover-choose',
      async (say) => {
        if (!selected) return;
        const task = await window.sydney.chooseContentCover(selected.id);
        if (task) {
          replaceCover(task);
          say('已关联封面图');
        }
      },
      ['cover'],
    );
  const changeTheme = (theme: string) =>
    guarded('theme', async () => {
      if (!selected) return;
      setTasks((current) => current.map((item) => (item.id === selected.id ? { ...item, theme } : item)));
      replaceTask(await window.sydney.updateContentTask(selected.id, { theme }));
    });
  const generateImages = () =>
    guarded(
      'images',
      async (say) => {
        if (!selected) return;
        await persistSelected();
        if (wantCandidates) {
          setCandidateSheet(
            selected.id,
            await window.sydney.generateContentImageCandidates(selected.id, 'inline', 3, candidateCount),
          );
          say(`已生成正文配图候选（每处 ${candidateCount} 张），挑好再插入`);
          return;
        }
        replaceTask(await window.sydney.generateContentImages(selected.id, 3));
        say('已生成正文配图并插入正文，改动过正文需要重新审稿');
      },
      wantCandidates ? BOTH_LANES : ['main'],
    );
  const generateImagesWithCover = () =>
    guarded(
      'images-all',
      async (say) => {
        if (!selected) return;
        await persistSelected();
        if (wantCandidates) {
          setCandidateSheet(
            selected.id,
            await window.sydney.generateContentImageCandidates(selected.id, 'both', 3, candidateCount),
          );
          say(`已生成封面与配图候选（每处 ${candidateCount} 张），挑好再采用`);
          return;
        }
        const task = await window.sydney.generateContentImagesWithCover(selected.id, 3);
        replaceTask(task);
        say(task.imageWarning || '封面与正文配图已生成');
      },
      BOTH_LANES,
    );
  const applyCandidates = (picks: Array<{ key: string; path: string }>) =>
    guarded(
      'images-apply',
      async (say) => {
        if (!selected) return;
        try {
          replaceTask(await window.sydney.applyContentImageCandidates(selected.id, picks));
          setCandidateSheet(selected.id, null);
          say('已采用挑好的图，改动过正文需要重新审稿');
        } catch (error) {
          setCandidateSheet(selected.id, null);
          throw error;
        }
      },
      BOTH_LANES,
    );
  const discardCandidates = () =>
    guarded('images-discard', async () => {
      if (!selected) return;
      setCandidateSheet(selected.id, null);
      await window.sydney.discardContentImageCandidates(selected.id);
    });
  const openImageLibrary = (scope: 'cover' | 'inline' | 'both') =>
    guarded(
      'images-library',
      async (say) => {
        if (!selected) return;
        const bundle = await window.sydney.openContentImageLibrary(selected.id, scope);
        setCandidateSheet(selected.id, bundle);
        say(bundle.warning || '从以前生成的图里挑一张');
      },
      BOTH_LANES,
    );
  const swapImage = (index: number, target: string, expected: string) =>
    guarded('images-swap', async (say) => {
      if (!selected) return;
      await persistSelected();
      replaceTask(await window.sydney.swapContentImage(selected.id, index, target, expected));
      say(`已换掉第 ${index + 1} 张配图，改动过正文需要重新审稿`);
    });
  const exportArticle = (allowUnreviewed = false) =>
    guarded('export', async (say) => {
      if (!selected) return;
      await persistSelected();
      const task = await window.sydney.exportContentTask(selected.id, allowUnreviewed);
      replaceTask(task);
      say(`成稿已导出：${task.exportPath}`);
    });
  const autoGenerate = () => {
    if (!selected) return;
    const plan = autoGeneratePlan(selected);
    if (!plan.ok) {
      notify(plan.reason);
      return;
    }
    if (selected.draft.trim() && !window.confirm('自动生成会覆盖现有初稿和审稿结论，继续？')) return;
    void guarded('auto', async (say, here) => {
      await persistSelected();
      let task: ContentTask = { ...selected };
      for (const stage of plan.stages) {
        const target = PIPELINE_STEPS.find((item) => item.stage === stage)?.key;
        if (target && here()) setStep(target);
        setJob(selected.id, `auto:${stage}`);
        task = await window.sydney.generateContentStage(selected.id, stage);
        replaceTask(task);
      }
      say(`自动生成完成：${plan.stages.map((item) => stageLabels[item]).join(' → ')}`);
      if (here()) setStep(isReviewPassed(task) ? (task.coverPath ? 'publish' : 'cover') : 'review');
    });
  };
  const publish = (allowUnreviewed = false) => {
    if (!selected) return;
    const missing = publishChecklist(selected, env).filter((item) => !item.ok);
    if (missing.length) {
      notify(`还不能推送：${missing.map((item) => item.label).join('、')}`);
      return;
    }
    const confirmed = window.confirm(
      `把《${selected.title || '未命名文章'}》推送到公众号草稿箱？\n\n这是对真实公众号的操作：会创建一篇草稿，不会自动群发。\n${allowUnreviewed ? '注意：这篇正文没有通过 AI 审稿。\n' : ''}封面：${selected.coverPath}`,
    );
    if (!confirmed) return;
    void guarded(
      'publish',
      async (say) => {
        await persistSelected();
        replaceTask(await window.sydney.publishContentTask(selected.id, allowUnreviewed));
        say('已推送到公众号草稿箱');
      },
      BOTH_LANES,
    );
  };
  const deliver = (action: 'export' | 'publish') => {
    if (!selected) return;
    const allowUnreviewed = !isReviewPassed(selected);
    const outstanding = reviewOutstanding(selected);
    const warning = `《${selected.title || '未命名文章'}》还没有通过 AI 审稿，仍要${action === 'export' ? '导出到 Obsidian' : '推送草稿箱'}吗？\n\n待处理：${outstanding.join('；') || '无'}\n\n审稿意见这时只是建议，不会被自动应用；确认后会按当前正文执行。`;
    if (allowUnreviewed && !window.confirm(warning)) return;
    if (action === 'export') void exportArticle(allowUnreviewed);
    else publish(allowUnreviewed);
  };
  const cancelImages = async () => {
    if (!selected) return;
    const cancelled = await window.sydney.cancelContentImages(selected.id);
    notify(cancelled ? '已请求取消，等接口返回后即可继续操作' : '当前没有正在进行的生图');
  };
  return {
    openTask,
    create,
    remove,
    runStage,
    save,
    openBackend,
    editSelected,
    autoGenerate,
    changeTheme,
    generateCover,
    ipCover,
    chooseCover,
    generateImages,
    generateImagesWithCover,
    applyCandidates,
    discardCandidates,
    openImageLibrary,
    swapImage,
    deliver,
    cancelImages,
  };
}
