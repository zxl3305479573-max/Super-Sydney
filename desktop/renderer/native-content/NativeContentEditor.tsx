import type { ContentStage } from '../../shared';
import { ARTICLE_THEMES, DEFAULT_ARTICLE_THEME } from '../../services/article-html';
import { PIPELINE_STEPS, nextStepKey, pipelineProgress, publishChecklist } from '../../services/content-pipeline';
import { taskScopeLabel } from '../content-taxonomy';
import { ConfirmButton, useWorkflowStepScroll } from '../ui';
import { stageLabels, stateNames, statusNames } from './format';
import {
  CoverStep,
  DraftStep,
  EvidenceStep,
  ImageCandidatePicker,
  JsonStep,
  PublishStep,
  ReviewStep,
  Stepper,
  TopicStep,
} from './steps';
import type { useNativeContentActions } from './useNativeContentActions';
import type { useNativeContentState } from './useNativeContentState';

type State = ReturnType<typeof useNativeContentState>;
type Actions = ReturnType<typeof useNativeContentActions>;

export function NativeContentEditor({
  state,
  actions,
  notify,
}: {
  state: State;
  actions: Actions;
  notify: (message: string) => void;
}) {
  const {
    selected,
    pipeline,
    step,
    setStep,
    dirty,
    busy,
    coverBusy,
    busySeconds,
    coverSeconds,
    assets,
    candidateCount,
    setCandidateCount,
    candidateSheet,
    taxonomy,
    env,
  } = state;
  const {
    editSelected,
    autoGenerate,
    save,
    remove,
    runStage,
    deliver,
    openBackend,
    changeTheme,
    generateImages,
    generateImagesWithCover,
    openImageLibrary,
    swapImage,
    chooseCover,
    generateCover,
    ipCover,
    applyCandidates,
    discardCandidates,
    cancelImages,
  } = actions;
  const locked = busy !== '';
  const coverLocked = coverBusy !== '';
  const autoStage = busy.startsWith('auto:') ? (busy.slice('auto:'.length) as ContentStage) : null;
  const activeStep = pipeline.find((item) => item.key === step) ?? pipeline[0];
  const flowRef = useWorkflowStepScroll(`${selected?.id ?? 0}:${step}`);
  const imageJob = [busy, coverBusy].some((key) => key === 'cover' || key === 'images' || key === 'images-all');
  if (!selected || !activeStep)
    return (
      <div className="native-empty native-editor native-editor-empty">
        <strong>先创建一个文章任务</strong>
        <span>选择类别后，按 选题 → 任务书 → 来源与证据 → 初稿 → AI 审稿 → 封面 → 导出与发布 逐步推进。</span>
      </div>
    );
  const prior = PIPELINE_STEPS.findIndex((item) => item.key === step);
  return (
    <div className="native-editor">
      <div className="native-editor-head">
        <div>
          <p className="eyebrow">
            {taskScopeLabel(selected)} · {statusNames[selected.status] ?? selected.status} · 进度{' '}
            {pipelineProgress(selected, env).done}/{pipeline.length}
          </p>
          <h2>{selected.title || selected.topic || '新文章'}</h2>
        </div>
        <div className="native-editor-actions">
          {dirty && <span className="flow-dirty">有未保存修改</span>}
          <label className="flow-theme">
            <span>排版主题</span>
            <select
              value={selected.theme || DEFAULT_ARTICLE_THEME}
              disabled={locked}
              onChange={(event) => changeTheme(event.target.value)}
            >
              {ARTICLE_THEMES.map((theme) => (
                <option key={theme.name} value={theme.name}>
                  {theme.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button button-primary"
            disabled={locked}
            title="选好标题后一次跑完 任务书 → 证据计划 → 初稿 → AI 审稿；封面、导出与推送仍由你手动确认"
            onClick={autoGenerate}
          >
            {busy.startsWith('auto') ? `自动生成中：${autoStage ? stageLabels[autoStage] : '准备中'}…` : '自动生成'}
          </button>
          <button className="button button-secondary" disabled={locked || !dirty} onClick={() => void save()}>
            {busy === 'save' ? '保存中…' : '保存'}
          </button>
          {!locked && !coverLocked && (
            <ConfirmButton
              className="button button-danger-quiet"
              armedLabel="确认删除"
              title="删除这篇文章和它的配图；已导出到知识库的文件不受影响"
              onConfirm={() => void remove()}
            >
              删除
            </ConfirmButton>
          )}
        </div>
      </div>
      <Stepper steps={pipeline} active={step} onSelect={setStep} />
      <section ref={flowRef} className={`flow-panel flow-panel-${activeStep.state}`} aria-labelledby="flow-step-title">
        <header className="flow-panel-head">
          <span className="flow-panel-index">{activeStep.index}</span>
          <div>
            <h3 id="flow-step-title">{activeStep.label}</h3>
            <p>{activeStep.hint}</p>
          </div>
          <span className={`flow-badge flow-badge-${activeStep.state}`}>{stateNames[activeStep.state]}</span>
        </header>
        <div className="flow-panel-toolbar">
          <span className="flow-panel-progress">
            第 {activeStep.index} / {pipeline.length} 步
          </span>
          {prior > 0 && (
            <button className="button button-quiet button-small" onClick={() => setStep(PIPELINE_STEPS[prior - 1].key)}>
              ← 上一步
            </button>
          )}
          <span className="flow-spacer" />
          {activeStep.stage && step !== 'topic' && (
            <button
              className={`button ${activeStep.state === 'done' ? 'button-secondary' : 'button-primary'}`}
              disabled={locked || activeStep.state === 'locked'}
              onClick={() => void runStage(activeStep.stage!)}
            >
              {busy === activeStep.stage
                ? '处理中…'
                : activeStep.state === 'done' || (step === 'review' && selected.reviewJson)
                  ? `重新${stageLabels[activeStep.stage]}`
                  : stageLabels[activeStep.stage]}
            </button>
          )}
          {step === 'review' && activeStep.state === 'attention' && (
            <button className="button button-secondary" disabled={locked} onClick={() => setStep('draft')}>
              回到初稿修改
            </button>
          )}
          {step === 'publish' && (
            <>
              <button
                className="button button-secondary"
                disabled={locked || !(selected.finalArticle.trim() || selected.draft.trim())}
                title="未通过审稿也能导出，导出前会二次确认"
                onClick={() => deliver('export')}
              >
                {busy === 'export' ? '导出中…' : '导出到 Obsidian'}
              </button>
              <button
                className="button button-primary"
                disabled={locked || publishChecklist(selected, env).some((item) => !item.ok)}
                title="推送到真实公众号草稿箱；未通过审稿也能推送，推送前会二次确认"
                onClick={() => deliver('publish')}
              >
                {busy === 'publish' ? '推送中…' : '推送草稿箱'}
              </button>
              <button
                className="button button-secondary"
                disabled={locked}
                title="切到「公众号后台」页签，在应用里打开微信公众平台，到草稿箱检查排版并手动发表"
                onClick={openBackend}
              >
                打开公众号后台
              </button>
            </>
          )}
          {nextStepKey(step) && (
            <button className="button button-quiet" onClick={() => setStep(nextStepKey(step)!)}>
              下一步：{PIPELINE_STEPS.find((item) => item.key === nextStepKey(step))?.label} →
            </button>
          )}
        </div>
        {activeStep.reason && (
          <p className={activeStep.state === 'locked' ? 'flow-locked-note' : 'flow-attention-note'}>
            {activeStep.reason}
          </p>
        )}
        {(locked || coverLocked) && (
          <p className="flow-locked-note">
            {locked
              ? `正在处理中，已等待 ${busySeconds} 秒；完成前会改动正文的按钮保持禁用${coverLocked ? '' : '，封面仍可同时生成'}。`
              : `封面生成中，已等待 ${coverSeconds} 秒；正文、正文配图可以同时操作。`}
            {imageJob && (
              <button className="button button-quiet button-small" onClick={() => void cancelImages()}>
                取消生成
              </button>
            )}
          </p>
        )}
        {step === 'topic' && (
          <TopicStep
            task={selected}
            taxonomy={taxonomy}
            locked={locked}
            busy={busy}
            onEdit={editSelected}
            onRun={() => void runStage('topics')}
            notify={notify}
          />
        )}
        {step === 'brief' && (
          <JsonStep
            value={selected.briefJson}
            empty="还没有任务书。任务书会给出目标读者、读者问题、核心主张、章节和边界，初稿严格按它展开。"
            labels={{
              target_reader: '目标读者',
              reader_problem: '读者问题',
              promise: '文章承诺',
              core_claim: '核心主张',
              sections: '章节结构',
              evidence_needed: '需要的证据',
              boundaries: '写作边界',
              framework: '框架',
            }}
          />
        )}
        {step === 'evidence' && (
          <EvidenceStep
            task={selected}
            locked={locked}
            onSources={(items) => editSelected({ sourcesJson: JSON.stringify({ sources: items }) })}
          />
        )}
        {step === 'draft' && (
          <DraftStep
            task={selected}
            assets={assets}
            locked={locked}
            coverLocked={coverLocked}
            busy={busy}
            busySeconds={busySeconds}
            candidateCount={candidateCount}
            onCandidateCount={setCandidateCount}
            onEdit={(draft) => editSelected({ draft })}
            onTheme={(theme) => void changeTheme(theme)}
            onGenerateImages={() => void generateImages()}
            onGenerateImagesWithCover={() => void generateImagesWithCover()}
            onPickFromLibrary={() => void openImageLibrary('inline')}
            onSwapImage={(index, target, expected) => void swapImage(index, target, expected)}
          />
        )}
        {step === 'review' && (
          <ReviewStep task={selected} locked={locked} busy={busy} onRevise={() => void runStage('revise')} />
        )}
        {step === 'cover' && (
          <CoverStep
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
          />
        )}
        {step === 'publish' && <PublishStep task={selected} env={env} />}
        {candidateSheet && candidateSheet.taskId === selected.id && (
          <ImageCandidatePicker
            bundle={candidateSheet}
            busy={busy || coverBusy}
            onApply={(picks) => void applyCandidates(picks)}
            onDiscard={() => void discardCandidates()}
          />
        )}
      </section>
    </div>
  );
}
