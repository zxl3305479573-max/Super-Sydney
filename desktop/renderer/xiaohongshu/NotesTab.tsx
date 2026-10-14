import { useEffect, useMemo, useState } from 'react';
import type { XhsBasis, XhsGenerateStage, XhsNote, XhsStepKey } from '../../shared';
import { xhsNoteTypeLabel } from '../../services/xhs-catalog';
import { XHS_STEPS, buildXhsPipeline, currentXhsStepKey, readTags, xhsPipelineProgress, xhsStale } from '../../services/xhs-pipeline';
import { shortTime } from '../ui';
import { useBusy, type XhsContext } from './common';
import { BodyStep, ChecksStep, PackageStep, Stepper, TitleStep, TopicStep, VisualStep, stateNames, useXhsAssets } from './note-steps';

/**
 * 笔记创作流水线：选题 → 正文 → 标题 → 视觉 → 发布前检测 → 发布包。
 * 编辑先落在本地草稿上，生成、导出之前自动保存；上游改动让下游「需处理」靠内容指纹判断（见 xhs-pipeline）。
 */

const EDITABLE: Array<keyof XhsNote> = ['topic', 'noteType', 'material', 'title', 'body', 'tagsJson', 'cardsJson'];
const STAGE_DONE: Record<XhsGenerateStage, string> = { body: '正文已生成', revise: '已按检测意见回改正文', titles: '标题候选已生成', checks: '检测完成', cards: '图文卡片已拆好分页' };

export function NotesTab({ ctx, target, onDirtyChange }: {
  ctx: XhsContext; target: { id: number; step?: XhsStepKey; nonce: number } | null;
  /** 告诉外层有没有未保存的修改：切换账号前要先确认。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { account, notes, notify } = ctx;
  const [selectedId, setSelectedId] = useState<number | null>(target?.id ?? notes[0]?.id ?? null);
  const [draft, setDraft] = useState<XhsNote | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const [step, setStep] = useState<XhsStepKey>('topic');
  const [newTopic, setNewTopic] = useState('');
  const { busy, run, locked } = useBusy(notify);

  // 外部跳转（定位、复盘、热点里点进来）指定了笔记与步骤。
  useEffect(() => {
    if (!target) return;
    setSelectedId(target.id);
    setDirty(false);
    const note = notes.find(item => item.id === target.id);
    if (note) setStep(target.step ?? currentXhsStepKey(note));
  }, [target?.nonce]);
  // 列表刷新时同步草稿；有未保存修改时不覆盖。
  useEffect(() => {
    const fresh = notes.find(item => item.id === selectedId) ?? null;
    if (!fresh) { if (selectedId !== null && !notes.length) setSelectedId(null); setDraft(null); return; }
    if (!dirty) setDraft(fresh);
  }, [notes, selectedId, dirty]);
  useEffect(() => { if (selectedId === null && notes[0]) setSelectedId(notes[0].id); }, [notes, selectedId]);

  const note = draft;
  const pipeline = useMemo(() => (note ? buildXhsPipeline(note) : []), [note]);
  const assets = useXhsAssets(note?.id ?? 0, note?.updatedAt ?? '');
  const activeStep = pipeline.find(item => item.key === step) ?? pipeline[0];

  const select = (item: XhsNote) => {
    if (dirty && item.id !== selectedId && !window.confirm('当前笔记有未保存的修改，切换后会丢失。继续？')) return;
    setDirty(false);
    setSelectedId(item.id);
    setDraft(item);
    setStep(currentXhsStepKey(item));
  };
  const edit = (patch: Partial<XhsNote>) => {
    if (!note) return;
    setDirty(true);
    setDraft({ ...note, ...patch });
  };
  const persist = async (): Promise<XhsNote> => {
    if (!note) throw new Error('请先选择笔记');
    if (!dirty) return note;
    const patch = Object.fromEntries(EDITABLE.map(key => [key, note[key]])) as Partial<XhsNote>;
    const saved = await window.sydney.updateXhsNote(note.id, patch);
    setDraft(saved);
    setDirty(false);
    return saved;
  };
  const apply = (saved: XhsNote) => { setDraft(saved); setDirty(false); };

  const create = () => run('create', async () => {
    const created = await window.sydney.createXhsNote(account.id, newTopic.trim(), null);
    setNewTopic('');
    setSelectedId(created.id);
    setDraft(created);
    setDirty(false);
    setStep('topic');
  });
  const remove = () => run('delete', async () => {
    if (!note || !window.confirm(`删除笔记「${note.topic || note.title || '未命名'}」？已导出的发布包不受影响。`)) return;
    await window.sydney.deleteXhsNote(note.id);
    setSelectedId(null);
    setDraft(null);
    setDirty(false);
  });
  const save = () => run('save', async () => { await persist(); notify('已保存'); });
  const generate = (stage: XhsGenerateStage, options?: { pageCount?: number; style?: string }, next?: XhsStepKey) => run(stage, async () => {
    if (!note) return;
    await persist();
    apply(await window.sydney.generateXhsNote(note.id, stage, options));
    notify(STAGE_DONE[stage]);
    if (next) setStep(next);
  });
  const confirmBasis = (key: keyof XhsBasis) => run('confirm', async () => { if (note) { await persist(); apply(await window.sydney.confirmXhsBasis(note.id, key)); } });
  const cover = (brief: string) => run('cover', async () => { if (note) { await persist(); apply(await window.sydney.generateXhsCover(note.id, brief)); notify('封面已生成'); } });
  const chooseCover = () => run('cover-choose', async () => { if (note) { await persist(); const saved = await window.sydney.chooseXhsCover(note.id); if (saved) apply(saved); } });
  const renderCards = () => run('render', async () => { if (note) { await persist(); apply(await window.sydney.renderXhsCards(note.id)); notify('卡片图已导出到图组'); } });
  const info = (mode: 'single' | 'pages') => run(`info-${mode}`, async () => {
    if (!note) return;
    await persist();
    try { apply(await window.sydney.generateXhsInfoImages(note.id, mode)); notify('信息图已加入图组'); }
    finally { await ctx.refresh(); }
  });
  const cancel = () => void window.sydney.cancelXhsImages(note?.id ?? 0).then(stopped => notify(stopped ? '已取消生成' : '没有进行中的生图'));
  const addLocal = () => run('add-local', async () => { if (note) { await persist(); const saved = await window.sydney.addXhsLocalImages(note.id); if (saved) apply(saved); } });
  const arrange = (paths: string[]) => run('arrange', async () => { if (note) { await persist(); apply(await window.sydney.arrangeXhsImages(note.id, paths)); } });
  const pickCover = (file: string) => run('arrange', async () => { if (note) { await persist(); apply(await window.sydney.useXhsCandidateAsCover(note.id, file)); notify('已换成这张封面'); } });
  const removeCandidate = (file: string) => run('arrange', async () => { if (note) { await persist(); apply(await window.sydney.removeXhsCandidate(note.id, file)); } });
  const exportPackage = () => run('export', async () => { if (note) { await persist(); const saved = await window.sydney.exportXhsNote(note.id); apply(saved); notify(`发布包已导出：${saved.exportPath}`); } });
  const openPackage = () => run('open', async () => { if (note) { const error = await window.sydney.openXhsPackage(note.id); if (error) notify(error); } });
  const copy = (kind: 'title' | 'body') => run('copy', async () => {
    if (!note) return;
    const tags = readTags(note).map(tag => `#${tag}`).join(' ');
    await navigator.clipboard.writeText(kind === 'title' ? note.title : `${note.body.trim()}${tags ? `\n\n${tags}` : ''}`);
    notify(kind === 'title' ? '标题已复制' : '正文与标签已复制');
  });

  const index = XHS_STEPS.findIndex(item => item.key === step);
  const next = XHS_STEPS[index + 1]?.key;
  const progress = note ? xhsPipelineProgress(note) : null;

  return <div className="native-layout">
    <aside className="native-task-list">
      <div className="native-list-head"><h2>笔记</h2><span>{notes.length}</span></div>
      <form className="xhs-new-note" onSubmit={event => { event.preventDefault(); void create(); }}>
        <input className="input" disabled={locked} value={newTopic} onChange={event => setNewTopic(event.target.value)} placeholder="新选题（可留空）" />
        <button className="button button-primary" type="submit" disabled={locked}>{busy === 'create' ? '…' : '新建'}</button>
      </form>
      {notes.length ? notes.map(item => {
        const steps = buildXhsPipeline(item);
        const current = steps.find(entry => entry.key === currentXhsStepKey(item));
        const done = steps.every(entry => entry.state === 'done');
        return <button key={item.id} className={`native-task ${selectedId === item.id ? 'is-selected' : ''}`} onClick={() => select(item)}>
          <strong>{item.title || item.topic || '未命名笔记'}</strong>
          <span>{xhsNoteTypeLabel(item.noteType)} · {done ? '已出发布包' : `第 ${current?.index} 步 ${current?.label}${current?.state === 'attention' ? '（需处理）' : ''}`}</span>
          <div className="flow-mini" aria-hidden="true">{steps.map(entry => <i key={entry.key} className={`flow-mini-${entry.state}`} />)}</div>
          <small>{shortTime(item.updatedAt)}</small>
        </button>;
      }) : <p className="native-empty">还没有笔记。从「热点选题」或「账号定位」转选题，或在上面直接新建。</p>}
    </aside>

    <div className="native-editor">
      {note && activeStep ? <>
        <div className="native-editor-head">
          <div>
            <p className="eyebrow">{xhsNoteTypeLabel(note.noteType)} · 进度 {progress?.done}/{progress?.total}</p>
            <h2>{note.title || note.topic || '新笔记'}</h2>
          </div>
          <div className="native-editor-actions">
            {dirty && <span className="flow-dirty">有未保存修改</span>}
            <button className="button button-secondary" disabled={locked || !dirty} onClick={() => void save()}>{busy === 'save' ? '保存中…' : '保存'}</button>
            <button className="button button-quiet" disabled={locked} onClick={() => void remove()}>删除</button>
          </div>
        </div>

        <Stepper steps={pipeline} active={step} onSelect={setStep} />

        <section className={`flow-panel flow-panel-${activeStep.state}`} aria-labelledby="xhs-step-title">
          <header className="flow-panel-head">
            <span className="flow-panel-index">{activeStep.index}</span>
            <div><h3 id="xhs-step-title">{activeStep.label}</h3><p>{activeStep.hint}</p></div>
            <span className={`flow-badge flow-badge-${activeStep.state}`}>{stateNames[activeStep.state]}</span>
          </header>
          {activeStep.reason && activeStep.state === 'locked' && <p className="flow-locked-note">{activeStep.reason}</p>}
          {locked && <p className="flow-locked-note">正在处理中；完成前这一页的按钮会保持禁用。</p>}

          {step === 'topic' && <TopicStep note={note} locked={locked} busy={busy} onEdit={edit} />}
          {step === 'body' && <BodyStep note={note} locked={locked} busy={busy} stale={xhsStale(note, 'body')} onEdit={edit} onConfirm={confirmBasis} onRun={() => void generate('body', undefined)} />}
          {step === 'title' && <TitleStep note={note} locked={locked} busy={busy} stale={xhsStale(note, 'title')} onEdit={edit} onConfirm={confirmBasis} onRun={() => void generate('titles')} />}
          {step === 'visual' && <VisualStep note={note} locked={locked} busy={busy} assets={assets} coverStale={xhsStale(note, 'cover')} cardsStale={xhsStale(note, 'cards')}
            onEdit={edit} onCover={brief => void cover(brief)} onChooseCover={() => void chooseCover()} onCards={(pageCount, style) => void generate('cards', { pageCount, style })}
            onRenderCards={() => void renderCards()} onInfo={mode => void info(mode)} onCancel={cancel} onAddLocal={() => void addLocal()} onArrange={paths => void arrange(paths)} onUseCover={file => void pickCover(file)} onRemoveCandidate={file => void removeCandidate(file)} onConfirm={confirmBasis} />}
          {step === 'checks' && <ChecksStep note={note} locked={locked} busy={busy} stale={xhsStale(note, 'checks')} onRun={() => void generate('checks')} onRevise={() => void generate('revise', undefined, 'body')} />}
          {step === 'package' && <PackageStep note={note} locked={locked} busy={busy} assets={assets} onEdit={() => setStep('visual')} onExport={() => void exportPackage()} onOpen={() => void openPackage()} onCopy={kind => void copy(kind)} onPublishPage={ctx.openPublish} />}

          <footer className="flow-panel-foot">
            {index > 0 && <button className="button button-quiet" disabled={locked} onClick={() => setStep(XHS_STEPS[index - 1].key)}>← 上一步</button>}
            <span className="flow-spacer" />
            {next && <button className="button button-quiet" disabled={locked} onClick={() => setStep(next)}>下一步：{XHS_STEPS[index + 1].label} →</button>}
          </footer>
        </section>
      </> : <div className="native-empty native-editor-empty"><strong>还没有选中笔记</strong><span>按 选题 → 正文 → 标题 → 视觉 → 发布前检测 → 发布包 推进。标题放在正文之后：要基于写成的正文做搜索词覆盖与收藏动机。</span></div>}
    </div>
  </div>;
}

