import { useEffect, useState } from 'react';
import type { XhsAuditInput, XhsAuditResult, XhsReport } from '../../shared';
import { XHS_AUDIT_DIMENSIONS } from '../../services/xhs-catalog';
import { parseAuditNotes } from '../../services/xhs-stats';
import { Icon, readableError, shortTime } from '../ui';
import { ScoreBar, Section, percent, useBusy, type XhsContext } from './common';

/**
 * 账号诊断：自己或竞品的主页 → 8 个维度打分、定位卡点、可执行改动。
 * 主页数据可以手动填，也可以在「小红书窗口」里打开主页后读取过来。每次诊断存一份快照，可以前后对比。
 */

export type AuditPrefill = { name: string; bio: string; fans: number; follows: number; likesAndCollects: number; notesText: string } | null;

function readResult(report: XhsReport): XhsAuditResult | null {
  try { return JSON.parse(report.resultJson) as XhsAuditResult; } catch { return null; }
}

export function AuditTab({ ctx, prefill, onPrefillUsed }: { ctx: XhsContext; prefill: AuditPrefill; onPrefillUsed: () => void }) {
  const { account, notify, goTo } = ctx;
  const [target, setTarget] = useState<XhsAuditInput['target']>('self');
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [fans, setFans] = useState('');
  const [follows, setFollows] = useState('');
  const [likes, setLikes] = useState('');
  const [notesText, setNotesText] = useState('');
  const [coverNote, setCoverNote] = useState('');
  const [reports, setReports] = useState<XhsReport[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const { busy, run, locked } = useBusy(notify);

  const load = async () => {
    const list = await window.sydney.listXhsReports(account.id, 'audit');
    setReports(list);
    setOpenId(current => current ?? list[0]?.id ?? null);
  };
  useEffect(() => { void load().catch(error => notify(readableError(error))); }, [account.id]);
  useEffect(() => {
    if (!prefill) return;
    setName(prefill.name); setBio(prefill.bio); setFans(String(prefill.fans || '')); setFollows(String(prefill.follows || '')); setLikes(String(prefill.likesAndCollects || ''));
    setNotesText(prefill.notesText);
    onPrefillUsed();
    notify('已从小红书窗口填入主页信息，核对后点「开始诊断」');
  }, [prefill]);

  const parsedNotes = parseAuditNotes(notesText);
  const start = () => run('audit', async () => {
    const report = await window.sydney.runXhsAudit(account.id, {
      target, name, bio, fans: Number(fans) || 0, follows: Number(follows) || 0, likesAndCollects: Number(likes) || 0, coverNote, notes: parsedNotes
    });
    await load();
    setOpenId(report.id);
    notify('诊断完成');
  });
  const remove = (report: XhsReport) => run(`delete:${report.id}`, async () => {
    if (!window.confirm(`删除诊断「${report.title}」？`)) return;
    await window.sydney.deleteXhsReport(ctx.account.id, report.id);
    if (openId === report.id) setOpenId(null);
    await load();
  });

  const opened = reports.find(item => item.id === openId) ?? null;
  const result = opened ? readResult(opened) : null;
  // 同一对象的上一次诊断，用来显示分数变化。
  const previous = opened ? reports.find(item => item.id !== opened.id && item.title === opened.title && item.createdAt < opened.createdAt) : undefined;
  const previousResult = previous ? readResult(previous) : null;
  const isSelf = (() => { try { return opened ? (JSON.parse(opened.inputJson) as { target?: string }).target !== 'competitor' : false; } catch { return false; } })();

  return <div className="xhs-grid xhs-grid-two">
    <Section title="诊断对象" hint="把主页交给它：比你自己翻主页看得更清楚。没有的数据可以留空，对应维度会标「缺数据」。"
      actions={<button className="button button-quiet" onClick={() => goTo('browser')}><Icon name="window" />从小红书窗口读取</button>}>
      <div className="xhs-seg" role="radiogroup" aria-label="诊断对象">
        {(['self', 'competitor'] as const).map(value => <button key={value} role="radio" aria-checked={target === value} className={target === value ? 'is-active' : ''} onClick={() => setTarget(value)}>{value === 'self' ? '自己的账号' : '竞品 / 对标账号'}</button>)}
      </div>
      <div className="native-task-fields">
        <label><span>账号名称</span><input value={name} onChange={event => setName(event.target.value)} /></label>
        <label><span>粉丝数</span><input inputMode="numeric" value={fans} onChange={event => setFans(event.target.value)} /></label>
        <label><span>关注数</span><input inputMode="numeric" value={follows} onChange={event => setFollows(event.target.value)} /></label>
        <label><span>获赞与收藏</span><input inputMode="numeric" value={likes} onChange={event => setLikes(event.target.value)} /></label>
        <label className="native-field-wide"><span>简介</span><input value={bio} onChange={event => setBio(event.target.value)} /></label>
      </div>
      <label className="xhs-field"><span>近期笔记（每行一篇：标题 | 点赞 | 收藏 | 评论 | 日期，已识别 {parsedNotes.length} 篇）</span>
        <textarea className="input xhs-textarea" rows={8} value={notesText} onChange={event => setNotesText(event.target.value)} placeholder={'租房小户型收纳 5 个技巧 | 1200 | 860 | 45 | 2026-10-08\n平价好用的厨房小物 | 300 | 210 | 12 | 2026-10-05'} />
      </label>
      <label className="xhs-field"><span>封面风格描述（可选；模型看不到图，只能据此判断封面统一性）</span>
        <input className="input" value={coverNote} onChange={event => setCoverNote(event.target.value)} placeholder="例如：大多是暖橙底大字，偶尔用实拍图，字体不统一" />
      </label>
      <button className="button button-primary" disabled={locked || (!name.trim() && !parsedNotes.length)} onClick={() => void start()}><Icon name="spark" />{busy === 'audit' ? '诊断中…' : '开始诊断'}</button>
    </Section>

    <Section title="诊断结果" hint={opened ? `${opened.title} · ${shortTime(opened.createdAt)}` : '诊断完成后出现在这里。'}>
      {reports.length > 1 && <div className="xhs-chip-row">{reports.map(report => <button key={report.id} className={`chip ${report.id === openId ? 'chip-accent' : ''}`} onClick={() => setOpenId(report.id)}>{report.title} · {shortTime(report.createdAt)}</button>)}</div>}
      {result ? <div className="xhs-audit">
        <div className="xhs-audit-total"><b>{result.total}</b><small>/10 综合</small>{result.bottleneck && <p><strong>主要卡点：</strong>{result.bottleneck}</p>}</div>
        <dl className="xhs-metrics">
          <div><dt>近期笔记</dt><dd>{result.metrics.noteCount} 篇</dd></div>
          <div><dt>平均互动</dt><dd>{result.metrics.avgInteractions}</dd></div>
          <div><dt>互动率</dt><dd>{percent(result.metrics.interactionRate)}</dd></div>
          <div><dt>爆款率</dt><dd>{percent(result.metrics.hitRate, 0)}</dd></div>
          <div><dt>每周发布</dt><dd>{result.metrics.postsPerWeek ?? '—'}</dd></div>
          <div><dt>最长断更</dt><dd>{result.metrics.longestGapDays === null ? '—' : `${result.metrics.longestGapDays} 天`}</dd></div>
        </dl>
        <ul className="xhs-dims">{result.dimensions.map(dim => {
          const before = previousResult?.dimensions.find(item => item.key === dim.key)?.score;
          const delta = dim.score !== null && before !== null && before !== undefined ? Math.round((dim.score - before) * 10) / 10 : null;
          return <li key={dim.key}>
            <div><strong>{dim.label}</strong><span className="xhs-dim-score">{dim.score === null ? '缺数据' : dim.score}{delta ? <em className={delta > 0 ? 'is-up' : 'is-down'}>{delta > 0 ? `+${delta}` : delta}</em> : null}</span></div>
            <ScoreBar value={dim.score} max={10} />
            <small>{dim.evidence}</small>
          </li>;
        })}</ul>
        {result.actions.length > 0 && <><h4>可执行改动</h4><ol className="xhs-actions">{result.actions.map(item => <li key={item.action}><strong>{item.action}</strong>{item.why && <small>{item.why}</small>}</li>)}</ol></>}
        {result.positioningAdvice && <p className="xhs-hint">{isSelf ? '定位修订建议：' : '可以借鉴：'}{result.positioningAdvice}</p>}
        <div className="flow-inline-actions">
          {isSelf && <button className="button button-quiet" onClick={() => goTo('positioning')}>去调整定位 →</button>}
          {opened && <button className="button button-quiet" disabled={locked} onClick={() => void remove(opened)}>删除这次诊断</button>}
        </div>
        <p className="ww-muted">维度：{XHS_AUDIT_DIMENSIONS.map(item => item.label).join('、')}。指标在本地计算，打分与建议来自模型。</p>
      </div> : <p className="flow-empty">还没有诊断记录。</p>}
    </Section>
  </div>;
}
