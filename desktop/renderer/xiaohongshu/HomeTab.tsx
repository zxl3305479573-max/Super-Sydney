import { useEffect, useState } from 'react';
import type { XhsAnalyticsView, XhsReport, XhsRouterAdvice } from '../../shared';
import { XHS_MONETIZATION_MILESTONES, XHS_MONETIZATION_PATHS, XHS_TAB_LABELS, xhsFunnelLabel, xhsMonetizationLabel } from '../../services/xhs-catalog';
import { readPositioning } from '../../services/xhs-pipeline';
import { Icon, readableError } from '../ui';
import { Section, useBusy, type XhsContext } from './common';

/** 向导（总控）：先看账号现状给规则推荐；用户写一句卡点，再让模型在四条链路里分流。 */

const STATUS_LABEL = { idea: '选题', body: '正文', title: '标题', visual: '视觉', packaged: '已出发布包' } as const;
const CHAINS = [
  { key: 'A', title: '链路 A · 从零起号', flow: '定位 + 变现路径盘点 → 热点选题 → 正文 → 标题 → 封面 + 图文 → 发布' },
  { key: 'B', title: '链路 B · 日常产出', flow: '热点选题（筛高藏赞比）→ 正文 → 标题 → 封面 + 图文 → 发布' },
  { key: 'C', title: '链路 C · 诊断改进', flow: '笔记复盘定位卡点 → 曝光低查账号 / 点击低改标题封面 / 互动低改正文' },
  { key: 'D', title: '链路 D · 商业转化与放量', flow: '核对变现门槛 → 产出商单样片/挂车/副业案例笔记 → 筛高转化种子笔记追投聚光搜索' }
];
const EXAMPLES = ['刚注册，不知道做什么内容', '每天都不知道写什么', '发了十几篇，曝光一直很低', '有曝光但没人点进来', '有几篇数据不错，怎么接商单或挂车变现'];

function readLatestFans(reports: XhsReport[]): number | null {
  const selfReport = reports.find(item => {
    try { return (JSON.parse(item.inputJson) as { target?: string }).target !== 'competitor'; } catch { return false; }
  });
  if (!selfReport) return null;
  try {
    const fans = Number((JSON.parse(selfReport.inputJson) as { fans?: number }).fans);
    return Number.isFinite(fans) ? fans : null;
  } catch { return null; }
}

export function HomeTab({ ctx }: { ctx: XhsContext }) {
  const { account, notes, notify, goTo } = ctx;
  const [advice, setAdvice] = useState<XhsRouterAdvice | null>(null);
  const [analytics, setAnalytics] = useState<XhsAnalyticsView | null>(null);
  const [knownFans, setKnownFans] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const { busy, run } = useBusy(notify);
  const positioning = readPositioning(account);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      window.sydney.recommendXhsRoute(account.id, ''),
      window.sydney.getXhsAnalytics(account.id),
      window.sydney.listXhsReports(account.id, 'audit')
    ])
      .then(([next, view, audits]) => { if (alive) { setAdvice(next); setAnalytics(view); setKnownFans(readLatestFans(audits)); } })
      .catch(error => notify(readableError(error)));
    return () => { alive = false; };
  }, [account.id, account.positioningJson, notes.length, notify]);

  const ask = () => run('route', async () => setAdvice(await window.sydney.recommendXhsRoute(account.id, description)));
  const counts = notes.reduce<Record<string, number>>((total, note) => ({ ...total, [note.status]: (total[note.status] ?? 0) + 1 }), {});

  return <div className="xhs-grid">
    <Section title="账号现状" hint="向导先按这些信息做规则判断。">
      <dl className="xhs-facts">
        <div><dt>定位档案</dt><dd>{positioning ? <>{positioning.track.name} · {positioning.statement}</> : <button className="link-button" onClick={() => goTo('positioning')}>还没有，去定位 →</button>}</dd></div>
        <div><dt>变现主路</dt><dd>{positioning?.monetization ? <>{xhsMonetizationLabel(positioning.monetization.primaryPath)}{positioning.monetization.starterMove ? ` · ${positioning.monetization.starterMove}` : ''}</> : <span className="ww-muted">重生成定位档案可补充变现规划</span>}</dd></div>
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

    <Section title="四条标准链路" hint="单个能力都能单独用，串成链路才是这套方法的价值。">
      <ul className="xhs-chain-list">{CHAINS.map(chain => <li key={chain.key} className={advice?.chain === chain.key ? 'is-active' : ''}><strong>{chain.title}</strong><span>{chain.flow}</span></li>)}</ul>
    </Section>

    <Section title="变现阶段里程碑罗盘" hint={`按当前已沉淀篇数（${Math.max(notes.length, analytics?.rows.length ?? 0)} 篇）${knownFans !== null ? `与最近诊断粉丝数（${knownFans} 粉）` : '（做一次账号诊断可同步粉丝数）'}自动对照平台开通门槛。`}>
      <ol className="xhs-milestones">{XHS_MONETIZATION_MILESTONES.map(item => {
        const postCount = Math.max(notes.length, analytics?.rows.length ?? 0);
        const fansOk = item.minFans === 0 || (knownFans !== null && knownFans >= item.minFans);
        const unlocked = postCount >= item.minNotes && fansOk;
        return <li key={item.key} className={unlocked ? 'is-unlocked' : ''}>
          <div><strong>{item.stage}</strong><span className={`chip ${unlocked ? 'chip-accent' : 'chip-soft'}`}>{unlocked ? '条件已接近/可筹备' : `需 ≥${item.minNotes} 篇${item.minFans ? ` · ≥${item.minFans} 粉` : ''}`}</span></div>
          <small>硬门槛：{item.gate}</small>
          <span>可解锁：{item.unlocks}</span>
        </li>;
      })}</ol>
    </Section>

    <Section title="站内合规变现路径对照" hint="按手头资源选路：严禁水下商单、导流微信或挂站外链接（高危限流封号）；内容未跑通自然转化前切勿盲目投薯条。">
      <ul className="xhs-monetize-grid">{XHS_MONETIZATION_PATHS.map(path => <li key={path.key} className={positioning?.monetization?.primaryPath === path.key ? 'is-active' : ''}>
        <strong>{path.label}</strong>
        <span>适合：{path.fit}</span>
        <small>门槛：{path.threshold}</small>
        <small>起步：{path.starter}</small>
      </li>)}</ul>
    </Section>
  </div>;
}
