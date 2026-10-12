import { useCallback, useEffect, useState } from 'react';
import type { AiReviewResult, EvolutionState, RuleCandidateView, RulePatchPreview } from '../shared';
import { EmptyState, Icon, Segmented, readableError } from './ui';

const STATUS_TEXT: Record<RuleCandidateView['status'], string> = { proposed: '待确认', applied: '已写入', rejected: '已驳回' };
type Run = (key: string, action: () => Promise<void>) => Promise<void>;

export default function EvolutionPanel({ notify }: { notify: (message: string) => void }) {
  const [state, setState] = useState<EvolutionState>({ rules: [], pendingCardEvents: 0, llmEnabled: false });
  const [reviewDays, setReviewDays] = useState<'7' | '14' | '30'>('7');
  const [cardDays, setCardDays] = useState<'30' | '90' | '180'>('30');
  const [busy, setBusy] = useState('');
  const [review, setReview] = useState<AiReviewResult | null>(null);
  const [cardLine, setCardLine] = useState('');
  const [ruleFilter, setRuleFilter] = useState<'open' | 'applied' | 'rejected'>('open');

  const refresh = useCallback(async () => setState(await window.sydney.getEvolutionState()), []);
  useEffect(() => { void refresh(); return window.sydney.onChanged(() => void refresh()); }, [refresh]);

  const run: Run = async (key, action) => {
    setBusy(key);
    try { await action(); } catch (error) { notify(readableError(error)); } finally { setBusy(''); await refresh(); }
  };

  const generateReview = () => run('review', async () => {
    const result = await window.sydney.generateAiReview(Number(reviewDays));
    setReview(result);
    notify(`复盘已写入 ${result.target}`);
  });
  const weekly = () => run('weekly', async () => notify(`周报已更新：${await window.sydney.generateWeeklySummary()}`));
  const cards = () => run('cards', async () => {
    const result = await window.sydney.extractExperienceCards(Number(cardDays));
    setCardLine(result.considered ? `处理了 ${result.considered} 条已确认对话：新增 ${result.created.length} 张卡片，补充 ${result.updated.length} 张。` : '没有新的已确认 AI 对话可以提炼。');
    notify(`经验卡片索引已更新：${result.index}`);
  });

  const counts = {
    open: state.rules.filter(rule => rule.status === 'proposed').length,
    applied: state.rules.filter(rule => rule.status === 'applied').length,
    rejected: state.rules.filter(rule => rule.status === 'rejected').length
  };
  const visible = state.rules.filter(rule => (ruleFilter === 'open' ? rule.status === 'proposed' : rule.status === ruleFilter));

  return <div className="view evolve">
    <ol className="evolve-flow" aria-label="进化流程">
      <li><span>1</span>复盘 AI 协作</li><Icon name="arrowRight" size={14} />
      <li><span>2</span>确认项目规则</li><Icon name="arrowRight" size={14} />
      <li><span>3</span>提炼经验卡片</li><Icon name="arrowRight" size={14} />
      <li><span>4</span>周报回顾</li>
    </ol>

    <section className="panel">
      <header className="panel-head">
        <div className="panel-title"><h2><span className="step-no">1</span>AI 协作复盘</h2><p>统计 Codex / Claude 对话里的重复请求、返工、热点文件和知识库复用，写入 03-进化记录。</p></div>
        <div className="btn-group">
          <Segmented label="复盘范围" value={reviewDays} onChange={setReviewDays} options={[{ value: '7', label: '7 天' }, { value: '14', label: '14 天' }, { value: '30', label: '30 天' }]} />
          <button className="button button-primary" disabled={Boolean(busy)} onClick={() => void generateReview()}><Icon name="chart" />{busy === 'review' ? '生成中…' : '生成复盘'}</button>
        </div>
      </header>
      {review ? <div className="stat-grid">
        <Stat label="AI 对话" value={review.turns} unit="轮" />
        <Stat label="重复请求" value={review.repeats} unit="组" hint="可做成 skill / 命令" tone={review.repeats ? 'accent' : undefined} />
        <Stat label="返工信号" value={review.friction} unit="次" hint="纠正与打断" tone={review.friction ? 'warn' : undefined} />
        <Stat label="待确认规则" value={review.rules} unit="条" tone={review.rules ? 'warn' : undefined} />
        <Stat label="被用到的笔记" value={review.notesUsed} unit="篇" />
        <Stat label="候选归档" value={review.staleNotes} unit="篇" hint="60 天未用" />
      </div> : <p className="panel-note">生成后在这里显示统计，详细内容写在 Obsidian 的复盘笔记里。</p>}
      <footer className="panel-foot">
        <small>周报会自动引用本周复盘：重复问题、可自动化的工作、学习方向和选题。</small>
        <button className="button button-secondary" disabled={Boolean(busy)} onClick={() => void weekly()}><Icon name="calendar" />{busy === 'weekly' ? '更新中…' : '用复盘更新周报'}</button>
      </footer>
    </section>

    <section className="panel">
      <header className="panel-head">
        <div className="panel-title"><h2><span className="step-no">2</span>项目规则</h2><p>同一项目出现 2 次以上纠正或打断时生成候选。预览确认后才写入 AGENTS.md / CLAUDE.md，写入后可撤销。</p></div>
        <Segmented label="规则状态" value={ruleFilter} onChange={setRuleFilter} options={[{ value: 'open', label: '待确认', count: counts.open }, { value: 'applied', label: '已写入', count: counts.applied }, { value: 'rejected', label: '已驳回', count: counts.rejected }]} />
      </header>
      <div className="rule-list">
        {visible.length ? visible.map(rule => <RuleCard key={rule.id} rule={rule} llmEnabled={state.llmEnabled} busy={busy} run={run} notify={notify} />)
          : <EmptyState icon="shield" title={ruleFilter === 'open' ? '暂无待确认的规则' : ruleFilter === 'applied' ? '还没有写入过规则' : '没有驳回的规则'}>{ruleFilter === 'open' ? '先生成一次复盘；返工达到阈值的项目会出现在这里。' : undefined}</EmptyState>}
      </div>
    </section>

    <section className="panel">
      <header className="panel-head">
        <div className="panel-title"><h2><span className="step-no">3</span>经验卡片</h2><p>把已确认的 AI 对话提炼成「坑 → 解法」卡片，按主题放进 04-工作流/经验卡片。每条对话只提炼一次，单次最多 20 条。</p></div>
        <div className="btn-group">
          <Segmented label="提炼范围" value={cardDays} onChange={setCardDays} options={[{ value: '30', label: '30 天' }, { value: '90', label: '90 天' }, { value: '180', label: '180 天' }]} />
          <button className="button button-primary" disabled={Boolean(busy) || !state.llmEnabled || !state.pendingCardEvents} title={state.llmEnabled ? '' : '需要在设置中开启允许发送到 DeepSeek'} onClick={() => void cards()}><Icon name="layers" />{busy === 'cards' ? '提炼中…' : '提炼经验卡片'}</button>
        </div>
      </header>
      <div className="card-status">
        <div className="big-number"><strong>{state.pendingCardEvents}</strong><span>条已确认的 AI 对话待提炼（近 90 天）</span></div>
        <p>{state.llmEnabled ? '只发送这些对话的提示词和最终答复摘要；卡片以「待审核」状态写入。' : <><Icon name="alert" size={14} />需要先在「隐私与设置 → AI 服务」开启允许发送到 DeepSeek。</>}</p>
      </div>
      {cardLine && <p className="panel-note is-result"><Icon name="check" size={14} />{cardLine}</p>}
    </section>
  </div>;
}

function Stat({ label, value, unit, hint, tone }: { label: string; value: number; unit: string; hint?: string; tone?: 'warn' | 'accent' }) {
  return <div className={`stat ${tone ? `stat-${tone}` : ''}`}><span>{label}</span><strong>{value}<small>{unit}</small></strong>{hint && <em>{hint}</em>}</div>;
}

function RuleCard({ rule, llmEnabled, busy, run, notify }: { rule: RuleCandidateView; llmEnabled: boolean; busy: string; run: Run; notify: (message: string) => void }) {
  const [text, setText] = useState(rule.ruleText);
  const [preview, setPreview] = useState<RulePatchPreview[] | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [showEvidence, setShowEvidence] = useState(false);
  useEffect(() => { setText(rule.ruleText); }, [rule.ruleText]);
  useEffect(() => { setPreview(null); }, [rule.status]);
  const key = (name: string) => `${name}-${rule.id}`;
  const editable = rule.status === 'proposed';
  const locked = Boolean(busy);

  const save = async () => { if (text !== rule.ruleText) await window.sydney.updateRule(rule.id, text); };
  const draft = () => run(key('draft'), async () => { await window.sydney.draftRule(rule.id); notify('已生成规则草稿，可以继续修改'); });
  const showPreview = () => run(key('preview'), async () => {
    await save();
    const files = await window.sydney.previewRule(rule.id);
    setPreview(files);
    setTargets(files.filter(file => file.added.length).map(file => file.path));
  });
  const apply = () => run(key('apply'), async () => { await window.sydney.applyRule(rule.id, targets); setPreview(null); notify(`规则已写入 ${targets.length} 个文件`); });
  const undo = () => run(key('undo'), async () => {
    const result = await window.sydney.undoRule(rule.id);
    notify(`已撤销 ${result.restored.length} 个文件${result.skipped.length ? `；${result.skipped.length} 个文件已被手动修改，未改动` : ''}`);
  });
  const reject = () => run(key('reject'), async () => { await window.sydney.rejectRule(rule.id); });

  return <article className={`rule rule-${rule.status}`}>
    <header className="rule-head">
      <span className="rule-icon"><Icon name="folder" size={16} /></span>
      <div><strong>{rule.project}</strong><code>{rule.cwd}</code></div>
      <span className={`pill pill-${rule.status === 'applied' ? 'approved' : rule.status === 'rejected' ? 'rejected' : 'pending'}`}>{STATUS_TEXT[rule.status]}</span>
    </header>

    <button className="evidence-toggle" aria-expanded={showEvidence} onClick={() => setShowEvidence(value => !value)}>
      <Icon name="alert" size={13} />{rule.evidence.length} 次纠正 / 打断{rule.rationale && <span> · {rule.rationale}</span>}<em>{showEvidence ? '收起依据' : '查看依据'}</em>
    </button>
    {showEvidence && <ul className="evidence">{rule.evidence.map(item => <li key={item.eventId}>
      <span className="chip chip-soft">{item.reason}</span><p>「{item.prompt}」</p>{item.previousPrompt && <small>被纠正的上一轮：{item.previousPrompt}</small>}
    </li>)}</ul>}

    <label className="field"><span>规则（每行一条，写入后 Codex / Claude 会在这个项目里遵守）</span>
      <textarea className="input rule-text" rows={Math.min(6, Math.max(2, text.split('\n').length + 1))} value={text} disabled={!editable}
        placeholder="- 例如：修改 desktop/main.ts 后先运行 npm test" onChange={event => setText(event.target.value)} onBlur={() => void save()} />
    </label>

    {rule.status === 'applied' && <p className="panel-note is-result"><Icon name="check" size={14} />已写入：{rule.applied.map(item => item.path).join('、')}</p>}

    {preview && <div className="patch">
      <p className="patch-title"><Icon name="file" size={14} />补丁预览 · 勾选要写入的文件</p>
      {preview.map(file => <label key={file.path} className={`patch-file ${file.added.length ? '' : 'is-noop'}`}>
        <input type="checkbox" disabled={!file.added.length} checked={targets.includes(file.path)} onChange={event => setTargets(event.target.checked ? [...targets, file.path] : targets.filter(item => item !== file.path))} />
        <div><strong>{file.path}{!file.exists && <em>新建</em>}</strong>
          {file.added.length ? <pre>{file.added.map(line => `+ ${line.replace(/^- /, '')}`).join('\n')}</pre> : <small>规则已存在，无需写入</small>}</div>
      </label>)}
    </div>}

    <footer className="rule-actions">
      {editable && <button className="button button-quiet" disabled={locked} onClick={() => void reject()}>驳回</button>}
      <span className="grow" />
      {editable && <button className="button button-secondary" disabled={locked || !llmEnabled} title={llmEnabled ? '根据依据让 DeepSeek 起草' : '需要开启允许发送到 DeepSeek'} onClick={() => void draft()}><Icon name="wand" />{busy === key('draft') ? '生成中…' : 'AI 生成规则'}</button>}
      {editable && !preview && <button className="button button-primary" disabled={locked || !text.trim()} onClick={() => void showPreview()}><Icon name="eye" />预览补丁</button>}
      {editable && preview && <>
        <button className="button button-secondary" disabled={locked} onClick={() => setPreview(null)}>取消</button>
        <button className="button button-primary" disabled={locked || !targets.length} onClick={() => void apply()}><Icon name="check" />确认写入</button>
      </>}
      {rule.status === 'applied' && <button className="button button-secondary" disabled={locked} onClick={() => void undo()}><Icon name="undo" />撤销写入</button>}
    </footer>
  </article>;
}
