import { useEffect, useState } from 'react';
import type { XhsAnalyticsView, XhsRouterAdvice } from '../../shared';
import { XHS_TAB_LABELS, xhsFunnelLabel } from '../../services/xhs-catalog';
import { readPositioning } from '../../services/xhs-pipeline';
import { Icon, readableError } from '../ui';
import { Section, useBusy, type XhsContext } from './common';

/** 向导（总控）：先看账号现状给规则推荐；用户写一句卡点，再让模型在三条链路里分流。 */

const STATUS_LABEL = { idea: '选题', body: '正文', title: '标题', visual: '视觉', packaged: '已出发布包' } as const;
const CHAINS = [
  { key: 'A', title: '链路 A · 从零起号', flow: '定位 → 热点选题 → 正文 → 标题 → 封面 + 图文 → 发布' },
  { key: 'B', title: '链路 B · 日常产出', flow: '热点选题 → 正文 → 标题 → 封面 + 图文 → 发布' },
  { key: 'C', title: '链路 C · 诊断改进', flow: '笔记复盘定位卡点 → 曝光低查账号 / 点击低改标题封面 / 互动低改正文' }
];
const EXAMPLES = ['刚注册，不知道做什么内容', '每天都不知道写什么', '发了十几篇，曝光一直很低', '有曝光但没人点进来', '笔记有人看，但不涨粉'];

export function HomeTab({ ctx }: { ctx: XhsContext }) {
  const { account, notes, notify, goTo } = ctx;
  const [advice, setAdvice] = useState<XhsRouterAdvice | null>(null);
  const [analytics, setAnalytics] = useState<XhsAnalyticsView | null>(null);
  const [description, setDescription] = useState('');
  const { busy, run } = useBusy(notify);
  const positioning = readPositioning(account);

  useEffect(() => {
    let alive = true;
    void Promise.all([window.sydney.recommendXhsRoute(account.id, ''), window.sydney.getXhsAnalytics(account.id)])
      .then(([next, view]) => { if (alive) { setAdvice(next); setAnalytics(view); } })
      .catch(error => notify(readableError(error)));
    return () => { alive = false; };
  }, [account.id, account.positioningJson, notes.length, notify]);

  const ask = () => run('route', async () => setAdvice(await window.sydney.recommendXhsRoute(account.id, description)));
  const counts = notes.reduce<Record<string, number>>((total, note) => ({ ...total, [note.status]: (total[note.status] ?? 0) + 1 }), {});

  return <div className="xhs-grid">
    <Section title="账号现状" hint="向导先按这些信息做规则判断。">
      <dl className="xhs-facts">
        <div><dt>定位档案</dt><dd>{positioning ? <>{positioning.track.name} · {positioning.statement}</> : <button className="link-button" onClick={() => goTo('positioning')}>还没有，去定位 →</button>}</dd></div>
        <div><dt>内容支柱</dt><dd>{positioning?.pillars.map(item => item.name).join('、') || '—'}</dd></div>
        <div><dt>笔记任务</dt><dd>{notes.length ? Object.entries(STATUS_LABEL).filter(([key]) => counts[key]).map(([key, label]) => `${label} ${counts[key]}`).join(' · ') : '还没有'}</dd></div>
        <div><dt>笔记数据</dt><dd>{analytics?.rows.length ? `${analytics.rows.length} 篇${analytics.dominant ? ` · 主要卡在「${xhsFunnelLabel(analytics.dominant)}」` : ' · 没有集中的卡点'}` : '还没导入'}</dd></div>
      </dl>
    </Section>

    <Section title="你现在卡在哪？" hint="说一句你的情况，向导会选一条链路并告诉你下一步做什么。不写也行，下面是按现状的规则推荐。">
      <textarea className="input xhs-textarea" rows={3} value={description} placeholder="例如：发了十几篇，曝光一直很低" onChange={event => setDescription(event.target.value)} />
      <div className="xhs-chip-row">{EXAMPLES.map(item => <button key={item} className="chip" onClick={() => setDescription(item)}>{item}</button>)}</div>
      <div className="flow-inline-actions">
        <button className="button button-primary" disabled={busy !== '' || !description.trim()} onClick={() => void ask()}><Icon name="spark" />{busy === 'route' ? '分析中…' : '帮我判断'}</button>
        {description.trim() && <button className="button button-quiet" onClick={() => { setDescription(''); void run('route', async () => setAdvice(await window.sydney.recommendXhsRoute(account.id, ''))); }}>只看规则推荐</button>}
      </div>
    </Section>

    {advice && <Section title={advice.title} hint={advice.source === 'model' ? '根据你的描述判断' : '根据账号现状的规则推荐'} className="xhs-advice">
      <p className="xhs-advice-reason">{advice.reason}{advice.layer && <span className="chip chip-accent">卡点：{xhsFunnelLabel(advice.layer)}</span>}</p>
      <ol className="xhs-advice-steps">{advice.steps.map((step, index) => <li key={`${step.tab}-${index}`}>
        <span>{index + 1}</span><strong>{step.label}</strong>
        <button className="button button-secondary" onClick={() => goTo(step.tab)}>去「{XHS_TAB_LABELS[step.tab]}」<Icon name="arrowRight" /></button>
      </li>)}</ol>
    </Section>}

    <Section title="三条标准链路" hint="单个能力都能单独用，串成链路才是这套方法的价值。">
      <ul className="xhs-chain-list">{CHAINS.map(chain => <li key={chain.key} className={advice?.chain === chain.key ? 'is-active' : ''}><strong>{chain.title}</strong><span>{chain.flow}</span></li>)}</ul>
    </Section>
  </div>;
}
