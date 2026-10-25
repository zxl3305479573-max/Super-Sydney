import { useEffect, useState } from 'react';
import type { XhsAnalyticsInterpretation, XhsAnalyticsView, XhsFunnelLayer } from '../../shared';
import { XHS_FUNNEL_LAYERS, xhsFunnelLabel } from '../../services/xhs-catalog';
import { WEAK_RATIO } from '../../services/xhs-stats';
import { Icon, readableError, shortTime } from '../ui';
import { Section, layerValue, useBusy, type XhsContext } from './common';

/**
 * 笔记复盘：导入创作者中心的笔记数据，按六层漏斗（曝光 → 点击 → 阅读深度 → 互动 → 收藏转发 → 涨粉）
 * 找每篇卡在哪一层，再让模型把数字翻译成「为什么卡、下一条改什么」。结论驱动向导的链路 C。
 */

const TARGET_TAB = { title: 'notes', cover: 'notes', writer: 'notes', audit: 'audit', positioning: 'positioning' } as const;
const TARGET_LABEL = { title: '改标题', cover: '改封面', writer: '改正文', audit: '账号诊断', positioning: '调整定位' } as const;

function readInterpretation(view: XhsAnalyticsView | null): XhsAnalyticsInterpretation | null {
  if (!view?.latestReport) return null;
  try { return JSON.parse(view.latestReport.resultJson) as XhsAnalyticsInterpretation; } catch { return null; }
}

export function AnalyticsTab({ ctx }: { ctx: XhsContext }) {
  const { account, notes, notify, goTo, openNote } = ctx;
  const [view, setView] = useState<XhsAnalyticsView | null>(null);
  const { busy, run, locked } = useBusy(notify);
  useEffect(() => { void window.sydney.getXhsAnalytics(account.id).then(setView).catch(error => notify(readableError(error))); }, [account.id, notify]);

  const importFile = () => run('import', async () => {
    const result = await window.sydney.importXhsStats(account.id);
    if (!result) return;
    setView(result.view);
    notify(`已导入 ${result.file}：新增 ${result.added} 篇，更新 ${result.updated} 篇`);
  });
  const interpret = () => run('interpret', async () => { setView(await window.sydney.interpretXhsAnalytics(account.id)); notify('复盘解读完成'); });
  const remove = (id: number) => run(`delete:${id}`, async () => setView(await window.sydney.deleteXhsStat(ctx.account.id, id)));
  const jump = (layer: XhsFunnelLayer | '', noteId: number | null) => {
    const target = XHS_FUNNEL_LAYERS.find(item => item.key === layer);
    if (!target) return;
    if (target.tab === 'notes' && noteId) openNote(noteId, target.step);
    else goTo(target.tab);
  };

  const interpretation = readInterpretation(view);
  const dominant = XHS_FUNNEL_LAYERS.find(item => item.key === view?.dominant);
  const maxCount = Math.max(1, ...Object.values(view?.layerCounts ?? {}));

  return <div className="xhs-grid">
    <Section title="笔记数据" hint="在创作者中心「数据中心 → 笔记数据」导出明细（xlsx / csv），导入后按标题自动关联到这里的笔记。同一篇再次导入会更新数据。"
      actions={<button className="button button-primary" disabled={locked} onClick={() => void importFile()}><Icon name="folder" />{busy === 'import' ? '导入中…' : '导入数据表'}</button>}>
      {view?.rows.length ? <>
        <div className="xhs-funnel">{XHS_FUNNEL_LAYERS.map(layer => <div key={layer.key} className={view.dominant === layer.key ? 'is-dominant' : ''}>
          <strong>{layer.label}</strong>
          <span>中位数 {layerValue(layer.key, view.medians[layer.key])}</span>
          <i style={{ width: `${(view.layerCounts[layer.key] / maxCount) * 100}%` }} />
          <small>{view.layerCounts[layer.key]} 篇卡在这层</small>
        </div>)}</div>
        {dominant ? <p className="xhs-hint xhs-hint-warn"><Icon name="alert" size={14} />多数笔记卡在「{dominant.label}」：{dominant.remedy}<button className="button button-quiet" onClick={() => jump(dominant.key, null)}>去处理 →</button></p>
          : <p className="xhs-hint">没有集中的卡点{view.rows.length < 3 ? '（至少 3 篇才做横向对比）' : ''}。下面每篇单独看。</p>}
        <div className="xhs-table-wrap"><table className="flow-table xhs-stat-table"><thead><tr><th>笔记</th>{XHS_FUNNEL_LAYERS.map(layer => <th key={layer.key} title={layer.metric}>{layer.label}</th>)}<th>卡点</th><th /></tr></thead><tbody>
          {view.rows.map(row => {
            const linked = notes.find(note => note.id === row.stat.noteId);
            return <tr key={row.stat.id}>
              <td><strong>{row.stat.title}</strong><small>{row.stat.publishDate || '日期未知'}{linked ? ' · 已关联笔记' : ''}</small></td>
              {XHS_FUNNEL_LAYERS.map(layer => {
                const ratio = row.ratios[layer.key];
                return <td key={layer.key} className={ratio === null ? '' : ratio < WEAK_RATIO ? 'is-weak' : ratio > 1.5 ? 'is-strong' : ''}>
                  {layerValue(layer.key, row.values[layer.key])}{ratio !== null && <small>{ratio.toFixed(2)}x</small>}
                </td>;
              })}
              <td>{row.weakest ? <button className="chip chip-accent" title="去对症处理" onClick={() => jump(row.weakest, row.stat.noteId)}>{xhsFunnelLabel(row.weakest)}</button> : <small className="ww-muted">—</small>}</td>
              <td><button className="icon-button" title="删除这条数据" disabled={locked} onClick={() => void remove(row.stat.id)}><Icon name="trash" /></button></td>
            </tr>;
          })}
        </tbody></table></div>
        <p className="ww-muted">倍数 = 这篇 ÷ 账号中位数；低于 {WEAK_RATIO} 倍标红，按漏斗从上到下第一个偏弱的层就是卡点（上层卡住时下层数据本来就少）。这是和你自己比，不是行业基准。</p>
      </> : <p className="flow-empty">还没有数据。导出表里至少要有「笔记标题」和曝光、观看、点赞、收藏等任一数据列。</p>}
    </Section>

    <Section title="复盘解读" hint={view?.latestReport ? `解读于 ${shortTime(view.latestReport.createdAt)}（${view.latestReport.title}）` : '把这堆数字翻译成「卡在哪一层、为什么卡、下一条改什么」。'}
      actions={<button className="button button-secondary" disabled={locked || (view?.rows.length ?? 0) < 3} onClick={() => void interpret()}><Icon name="spark" />{busy === 'interpret' ? '解读中…' : interpretation ? '重新解读' : '让模型解读'}</button>}>
      {interpretation ? <div className="xhs-interpret">
        <p className="xhs-advice-reason">{interpretation.summary}</p>
        {interpretation.findings.length > 0 && <ul className="xhs-findings">{interpretation.findings.map(item => <li key={item.finding}>
          {item.layer && <span className="chip chip-soft">{xhsFunnelLabel(item.layer)}</span>}<strong>{item.finding}</strong>{item.evidence && <small>{item.evidence}</small>}
        </li>)}</ul>}
        {interpretation.next.length > 0 && <><h4>下一条改什么</h4><ol className="xhs-actions">{interpretation.next.map(item => <li key={item.action}>
          <strong>{item.action}</strong><button className="button button-quiet" onClick={() => goTo(TARGET_TAB[item.target])}>{TARGET_LABEL[item.target]} →</button>
        </li>)}</ol></>}
        {interpretation.patterns.length > 0 && <><h4>横向规律</h4><ul className="xhs-patterns">{interpretation.patterns.map(item => <li key={item}>{item}</li>)}</ul></>}
      </div> : <p className="flow-empty">{(view?.rows.length ?? 0) < 3 ? '至少导入 3 篇笔记的数据后才能解读。' : '点右上角让模型解读。'}</p>}
    </Section>
  </div>;
}
