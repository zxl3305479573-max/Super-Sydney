import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  OPS_PLATFORM_LABELS,
  OPS_STATE_LABELS,
  VIDEO_PUBLISH_PLATFORMS,
  isOpsStateLocked,
  type FeishuConfigView,
  type OpsEpisodeReview,
  type OpsEpisodeWithTasks,
  type OpsOverviewView,
  type OpsPlatform,
  type OpsSyncResult,
  type OpsTaskState
} from '../shared';
import {
  ConfirmButton,
  EmptyState,
  Icon,
  KeepAlive,
  PartitionBar,
  Sparkline,
  Switch,
  Tabs,
  readableError,
  relativeTime,
  shortTime,
  useVisited
} from './ui';

type OpsTab = 'board' | 'calendar' | 'review' | 'feishu';

const OPS_TABS: Array<{ value: OpsTab; label: string }> = [
  { value: 'board', label: '总览大屏' },
  { value: 'calendar', label: '排期与防重日历' },
  { value: 'review', label: '同龄对比复盘' },
  { value: 'feishu', label: '飞书卡片通知' }
];

const TAB_KEY = 'sydney.ops.tab';

function storedTab(): OpsTab {
  try {
    const saved = localStorage.getItem(TAB_KEY) as OpsTab | null;
    if (saved && OPS_TABS.some(t => t.value === saved)) return saved;
  } catch { /* 默认进入总览大屏 */ }
  return 'board';
}

const PLATFORM_COLORS: Record<OpsPlatform, string> = {
  douyin: 'oklch(0.45 0.14 260)',
  shipinhao: 'oklch(0.55 0.14 150)',
  xiaohongshu: 'oklch(0.58 0.18 22)',
  bilibili: 'oklch(0.58 0.14 230)'
};

const ALL_TASK_STATES: OpsTaskState[] = [
  'planned', 'draft', 'scheduled', 'published', 'not_logged_in', 'failed', 'skipped'
];

function formatSigned(val: number | null | undefined): string {
  if (val == null) return '—';
  return val > 0 ? `+${val}` : String(val);
}

function formatRatio(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  const pct = (ratio * 100).toFixed(1);
  return ratio > 0 ? `+${pct}%` : `${pct}%`;
}

export default function OpsHubPanel({
  notify,
  onNavigate
}: {
  notify: (message: string) => void;
  onNavigate: (view: 'video' | 'xiaohongshu' | 'wewrite') => void;
}) {
  const [tab, setTab] = useState<OpsTab>(storedTab);
  const visited = useVisited(tab);
  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* 忽略存储异常 */ }
  }, [tab]);

  const [overview, setOverview] = useState<OpsOverviewView | null>(null);
  const [feishu, setFeishu] = useState<FeishuConfigView | null>(null);
  const [syncResult, setSyncResult] = useState<OpsSyncResult | null>(null);
  const [busy, setBusy] = useState('');

  // 复盘页状态
  const [reviewEpisodeId, setReviewEpisodeId] = useState<number | null>(null);
  const [reviewAge, setReviewAge] = useState<number | null>(null);
  const [reviewData, setReviewData] = useState<OpsEpisodeReview | null>(null);

  // 日历页新建与任务编辑状态
  const [newTitle, setNewTitle] = useState('');
  const [newSchedule, setNewSchedule] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [editingTask, setEditingTask] = useState<{
    episodeId: number;
    platform: OpsPlatform;
    state: OpsTaskState;
    postUrl: string;
    detail: string;
  } | null>(null);

  // 飞书表单状态
  const [webhookInput, setWebhookInput] = useState('');
  const [secretInput, setSecretInput] = useState('');

  const refresh = useCallback(async () => {
    const [nextOverview, nextFeishu] = await Promise.all([
      window.sydney.getOpsOverview(),
      window.sydney.getFeishuConfig()
    ]);
    setOverview(nextOverview);
    setFeishu(nextFeishu);
    setReviewEpisodeId(current => {
      if (current !== null && nextOverview.episodes.some(ep => ep.id === current)) return current;
      return nextOverview.latestEpisode?.episode.id ?? nextOverview.episodes[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refresh().catch(error => notify(readableError(error)));
    return window.sydney.onOpsChanged(() => void refresh().catch(() => undefined));
  }, [refresh, notify]);

  useEffect(() => {
    if (reviewEpisodeId === null) {
      setReviewData(null);
      return;
    }
    void window.sydney.getOpsEpisodeReview(reviewEpisodeId, reviewAge)
      .then(setReviewData)
      .catch(error => notify(readableError(error)));
  }, [reviewEpisodeId, reviewAge, overview?.recentLogs[0]?.id, notify]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); } catch (error) { notify(readableError(error)); } finally { setBusy(''); }
  };

  const syncAll = (platforms: OpsPlatform[] | null = null) => void run(platforms ? `sync-${platforms[0]}` : 'sync-all', async () => {
    const res = await window.sydney.syncOpsPlatforms(platforms);
    setSyncResult(res);
    await refresh();
    const okCount = res.results.filter(r => r.loginOk && r.followers != null).length;
    const loginMiss = res.results.filter(r => !r.loginOk).map(r => OPS_PLATFORM_LABELS[r.platform]);
    notify([
      `已同步 ${okCount}/${res.results.length} 个平台`,
      loginMiss.length ? `${loginMiss.join('、')}需扫码登录` : '',
      res.notified ? '已同步推送到飞书' : ''
    ].filter(Boolean).join('；'));
  });

  const createPlan = () => void run('create-plan', async () => {
    if (!newTitle.trim()) throw new Error('请输入要排期的内容标题');
    const created = await window.sydney.upsertOpsEpisode({
      sourceType: 'manual',
      title: newTitle.trim(),
      scheduledAt: newSchedule.trim(),
      notes: newNotes.trim()
    });
    setNewTitle('');
    setNewSchedule('');
    setNewNotes('');
    setReviewEpisodeId(created.id);
    await refresh();
    notify(`已登记分发计划《${created.title}》`);
  });

  const saveTaskEdit = () => void run('save-task', async () => {
    if (!editingTask) return;
    await window.sydney.updateOpsTask(
      editingTask.episodeId,
      editingTask.platform,
      editingTask.state,
      { postUrl: editingTask.postUrl, detail: editingTask.detail }
    );
    setEditingTask(null);
    await refresh();
    notify('平台任务状态与链接已更新');
  });

  const calendarGroups = useMemo(() => {
    const episodes = overview?.episodes ?? [];
    const upcoming: OpsEpisodeWithTasks[] = [];
    const activeDrafts: OpsEpisodeWithTasks[] = [];
    const completed: OpsEpisodeWithTasks[] = [];

    for (const ep of episodes) {
      const allDone = ep.tasks.length > 0 && ep.tasks.every(t => t.state === 'published' || t.state === 'skipped');
      const hasDraft = ep.tasks.some(t => t.state === 'draft' || t.state === 'scheduled');
      if (allDone) completed.push(ep);
      else if (hasDraft) activeDrafts.push(ep);
      else upcoming.push(ep);
    }
    return { upcoming, activeDrafts, completed };
  }, [overview?.episodes]);

  if (!overview || !feishu) {
    return <section className="ops-panel native-content"><p className="empty-state"><strong>正在加载运营中控…</strong></p></section>;
  }

  return <section className="ops-panel native-content" aria-label="运营中控">
    <header className="ww-page-header ops-header">
      <div className="ops-header-main">
        <p className="eyebrow">OPERATIONS HUB · 多平台分发中控与数据大屏</p>
        <h1>运营中控</h1>
        <p>汇总抖音、微信视频号、小红书、B 站与公众号表现：排期防重、只读回采粉丝与播放、第 1/3/7 天同龄复盘与飞书卡片推送。</p>
      </div>
      <div className="ops-header-actions">
        <button type="button" className="button button-primary" disabled={busy !== ''} onClick={() => syncAll(null)}>
          <Icon name="refresh" size={15} />{busy === 'sync-all' ? '正在同步创作者后台…' : '一键同步四平台数据'}
        </button>
        <button type="button" className="button button-secondary" disabled={busy !== ''} onClick={() => void run('daily-feishu', async () => { await window.sydney.sendFeishuDailyReport(); notify('跨平台日报卡片已推送至飞书群'); })}>
          <Icon name="send" size={14} />{busy === 'daily-feishu' ? '推送中…' : '推送飞书日报'}
        </button>
      </div>
    </header>

    <nav className="ww-nav-dock" aria-label="运营中控分区">
      <Tabs
        label="运营中控分区"
        value={tab}
        onChange={setTab}
        items={OPS_TABS.map(item => ({
          ...item,
          count: item.value === 'calendar' ? overview.episodes.length : undefined
        }))}
      />
    </nav>

    {syncResult && <div className="ops-sync-banner" role="status">
      <strong>最近一次同步（{shortTime(syncResult.syncedAt)}）：</strong>
      <div className="ops-sync-pills">
        {syncResult.results.map(r => <span key={r.platform} className={`ops-sync-pill ${!r.loginOk ? 'is-warn' : r.error ? 'is-muted' : 'is-ok'}`}>
          <b>{OPS_PLATFORM_LABELS[r.platform]}</b>
          {r.followers != null ? `粉丝 ${r.followers} · 匹配 ${r.matchedPosts} 期` : r.error}
          {r.scheduleWarnings.length > 0 && ` · ⚠️ ${r.scheduleWarnings[0]}`}
        </span>)}
      </div>
    </div>}

    {/* ── 1. 总览大屏 ──────────────────────────────────────────── */}
    {visited.includes('board') && <KeepAlive show={tab === 'board'}>
      <div className="ops-tab-body">
        <div className="ops-kpi-grid">
          <article className="ops-kpi-card">
            <span>四平台总粉丝</span>
            <strong>{overview.totalFollowers.toLocaleString('zh-CN')}</strong>
            <small>自动合并实测与后台历史回填</small>
          </article>
          <article className="ops-kpi-card">
            <span>今日净涨粉</span>
            <strong className={overview.todayNetFollowers > 0 ? 'tone-up' : ''}>{formatSigned(overview.todayNetFollowers)}</strong>
            <small>对比前一日各平台粉丝存量</small>
          </article>
          <article className="ops-kpi-card">
            <span>近 7 日净涨粉</span>
            <strong className={overview.weekNetFollowers > 0 ? 'tone-up' : ''}>{formatSigned(overview.weekNetFollowers)}</strong>
            <small>滚动 7 天全平台净增长</small>
          </article>
          <article className="ops-kpi-card">
            <span>公众号 & 小红书导表汇总</span>
            <strong>{(overview.externalSummary.wechatTotalReads + overview.externalSummary.xhsTotalViews).toLocaleString('zh-CN')}</strong>
            <small>公众号 {overview.externalSummary.wechatArticles} 篇阅读 + 小红书 {overview.externalSummary.xhsNotes} 篇观看</small>
          </article>
        </div>

        <div className="ops-platform-grid">
          {overview.platforms.map(card => <article key={card.platform} className="ops-platform-card">
            <header>
              <div>
                <strong>{card.label}</strong>
                <span>{card.lastCollectedAt ? `更新于 ${relativeTime(card.lastCollectedAt)}` : '尚未同步'}</span>
              </div>
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={busy !== ''}
                onClick={() => syncAll([card.platform])}
              >
                {busy === `sync-${card.platform}` ? '同步中…' : '单独同步'}
              </button>
            </header>
            <div className="ops-platform-num">
              <b>{card.totalFollowers != null ? card.totalFollowers.toLocaleString('zh-CN') : '—'}</b>
              <div>
                <em className={card.todayNet && card.todayNet > 0 ? 'is-pos' : ''}>今日 {formatSigned(card.todayNet)}</em>
                <small>7 日 {formatSigned(card.weekNet)}</small>
              </div>
            </div>
            {card.recentTrend.length >= 2 && <Sparkline values={card.recentTrend.map(t => t.total)} label={`${card.label}粉丝走势`} />}
            <footer>
              <span>已发 {card.publishedCount} 期 · 待发草稿 {card.draftCount} 期</span>
              <button type="button" className="button-link" onClick={() => onNavigate('video')}>去发布窗口 →</button>
            </footer>
          </article>)}
        </div>

        {overview.latestEpisode ? <section className="ops-card">
          <header className="ops-card-head">
            <div>
              <span className="eyebrow">最新作品追踪 · 第 {overview.latestEpisode.ageDays} 天</span>
              <h3>{overview.latestEpisode.episode.title}</h3>
              <p>{overview.latestEpisode.comparisonNote}</p>
            </div>
            <button type="button" className="button button-secondary button-small" onClick={() => { setReviewEpisodeId(overview.latestEpisode!.episode.id); setTab('review'); }}>
              打开完整同龄复盘 →
            </button>
          </header>
          <div className="ops-latest-summary">
            <div><span>全网总播放</span><strong>{overview.latestEpisode.totalViews.toLocaleString('zh-CN')}</strong></div>
            <div><span>较上期同龄</span><strong>{formatRatio(overview.latestEpisode.totalViewsDeltaRatio)}</strong></div>
            <div><span>总互动数</span><strong>{overview.latestEpisode.totalInteractions.toLocaleString('zh-CN')}</strong></div>
            <div><span>综合互动率</span><strong>{overview.latestEpisode.overallEngageRate != null ? `${(overview.latestEpisode.overallEngageRate * 100).toFixed(1)}%` : '—'}</strong></div>
          </div>
        </section> : <EmptyState icon="chart" title="还没有跨平台作品记录">
          在「视频工作台 → 交付」一键填草稿，或在「排期与防重日历」登记一期已发作品，点击上方「一键同步」即可自动采集播放与互动。
        </EmptyState>}

        <section className="ops-card ops-quick-bridges">
          <div>
            <strong>联动内容生产模块</strong>
            <p>公众号与小红书导出的明细表已自动汇总在上方；要继续创作或扫码登录各平台，可直接跳转：</p>
          </div>
          <div className="ops-bridge-buttons">
            <button type="button" className="button button-secondary button-small" onClick={() => onNavigate('video')}><Icon name="video" size={14} />视频工作台</button>
            <button type="button" className="button button-secondary button-small" onClick={() => onNavigate('xiaohongshu')}><Icon name="note" size={14} />小红书工作台</button>
            <button type="button" className="button button-secondary button-small" onClick={() => onNavigate('wewrite')}><Icon name="pen" size={14} />公众号工作台</button>
          </div>
        </section>
      </div>
    </KeepAlive>}

    {/* ── 2. 排期与防重日历 ────────────────────────────────────── */}
    {visited.includes('calendar') && <KeepAlive show={tab === 'calendar'}>
      <div className="ops-tab-body">
        <section className="ops-card">
          <header className="ops-card-head">
            <div>
              <h3>登记分发计划 / 补录已发作品</h3>
              <p>视频工作台填草稿时会自动加入这里；往期已经发过的作品也可以按标题补录，同步后台数据时会自动匹配作品并回抓链接。</p>
            </div>
          </header>
          <div className="ops-plan-form">
            <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="作品标题（与后台发布标题一致以便自动回抓链接）" />
            <input value={newSchedule} onChange={e => setNewSchedule(e.target.value)} placeholder="计划时间，如 2026-11-20 18:00" />
            <input value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="备注（可选）" />
            <button type="button" className="button button-primary" disabled={busy !== '' || !newTitle.trim()} onClick={createPlan}>
              <Icon name="plus" size={14} />加入分发计划
            </button>
          </div>
        </section>

        {[
          { key: 'drafts', title: '待人工点发布 / 已定时（防重锁定中）', list: calendarGroups.activeDrafts },
          { key: 'upcoming', title: '计划中 / 待处理', list: calendarGroups.upcoming },
          { key: 'completed', title: '已全部上线归档', list: calendarGroups.completed }
        ].map(section => section.list.length > 0 && <section key={section.key} className="ops-card">
          <header className="ops-card-head">
            <h3>{section.title}（{section.list.length}）</h3>
          </header>
          <div className="ops-episode-list">
            {section.list.map(ep => <article key={ep.id} className="ops-episode-row">
              <div className="ops-episode-info">
                <div>
                  <strong>{ep.title}</strong>
                  <span className="ops-source-tag">{ep.sourceType === 'video' ? `视频 #${ep.sourceId}` : '手动登记'}</span>
                </div>
                <small>
                  {ep.scheduledAt ? `⏰ 计划排期：${ep.scheduledAt}` : `创建于 ${shortTime(ep.createdAt)}`}
                  {ep.notes ? ` · ${ep.notes}` : ''}
                </small>
              </div>
              <div className="ops-task-pills">
                {VIDEO_PUBLISH_PLATFORMS.map(p => {
                  const task = ep.tasks.find(t => t.platform === p.value);
                  const state: OpsTaskState = task?.state ?? 'planned';
                  const locked = isOpsStateLocked(state);
                  return <button
                    key={p.value}
                    type="button"
                    className={`ops-task-pill state-${state}`}
                    title="点击修改状态、解锁防重或补录线上链接"
                    onClick={() => setEditingTask({
                      episodeId: ep.id,
                      platform: p.value,
                      state,
                      postUrl: task?.postUrl ?? '',
                      detail: task?.detail ?? ''
                    })}
                  >
                    <span>{locked ? '🔒 ' : ''}{p.label}</span>
                    <em>{OPS_STATE_LABELS[state]}</em>
                  </button>;
                })}
              </div>
              <div className="ops-episode-ops">
                <button type="button" className="button button-quiet button-small" onClick={() => { setReviewEpisodeId(ep.id); setTab('review'); }}>复盘</button>
                <ConfirmButton className="button button-quiet button-small" armedLabel="确认删除？" onConfirm={() => void run('del-ep', async () => { await window.sydney.deleteOpsEpisode(ep.id); await refresh(); notify('已删除分发记录'); })}>
                  删除
                </ConfirmButton>
              </div>
            </article>)}
          </div>
        </section>)}

        {overview.episodes.length === 0 && <EmptyState icon="calendar" title="分发日历还是空的">
          上方添加一条计划，或去「视频工作台」把成片一键填草稿到多平台。
        </EmptyState>}

        {editingTask && <section className="ops-card ops-task-editor">
          <header className="ops-card-head">
            <div>
              <span className="eyebrow">编辑平台状态与防重锁</span>
              <h3>{OPS_PLATFORM_LABELS[editingTask.platform]}</h3>
            </div>
            <button type="button" className="button button-quiet button-small" onClick={() => setEditingTask(null)}>取消</button>
          </header>
          <div className="ops-task-editor-grid">
            <label>
              <span>当前状态（设为「计划中」或「异常」即可解除防重锁）</span>
              <select value={editingTask.state} onChange={e => setEditingTask({ ...editingTask, state: e.target.value as OpsTaskState })}>
                {ALL_TASK_STATES.map(s => <option key={s} value={s}>{OPS_STATE_LABELS[s]}{isOpsStateLocked(s) ? '（防重锁定）' : ''}</option>)}
              </select>
            </label>
            <label>
              <span>线上作品链接（支持手动回填）</span>
              <input value={editingTask.postUrl} onChange={e => setEditingTask({ ...editingTask, postUrl: e.target.value })} placeholder="https://..." />
            </label>
            <label className="ops-editor-wide">
              <span>状态说明 / 备注</span>
              <input value={editingTask.detail} onChange={e => setEditingTask({ ...editingTask, detail: e.target.value })} placeholder="备注说明" />
            </label>
          </div>
          <div className="flow-inline-actions">
            <button type="button" className="button button-primary" disabled={busy !== ''} onClick={saveTaskEdit}>保存状态</button>
            {editingTask.postUrl && <button type="button" className="button button-secondary" onClick={() => void window.sydney.openXhsLink(editingTask.postUrl)}>浏览器打开链接</button>}
          </div>
        </section>}
      </div>
    </KeepAlive>}

    {/* ── 3. 同龄对比复盘 ──────────────────────────────────────── */}
    {visited.includes('review') && <KeepAlive show={tab === 'review'}>
      <div className="ops-tab-body">
        {overview.episodes.length ? <>
          <section className="ops-card ops-review-toolbar">
            <label>
              <span>选择作品</span>
              <select value={reviewEpisodeId ?? ''} onChange={e => setReviewEpisodeId(Number(e.target.value) || null)}>
                {overview.episodes.map(ep => <option key={ep.id} value={ep.id}>{ep.title}</option>)}
              </select>
            </label>
            <label>
              <span>同龄复盘口径</span>
              <select value={reviewAge ?? ''} onChange={e => setReviewAge(e.target.value ? Number(e.target.value) : null)}>
                <option value="">最新可用采样</option>
                <option value="1">发布第 1 天对标</option>
                <option value="3">发布第 3 天对标</option>
                <option value="7">发布第 7 天对标</option>
              </select>
            </label>
            <span className="flow-spacer" />
            {reviewData && <button
              type="button"
              className="button button-primary"
              disabled={busy !== ''}
              onClick={() => void run('push-review', async () => {
                await window.sydney.sendFeishuEpisodeReview(reviewData.episode.id, reviewAge);
                notify(`已将《${reviewData.episode.title}》第 ${reviewData.ageDays} 天复盘推送到飞书`);
              })}
            >
              <Icon name="send" size={14} />{busy === 'push-review' ? '推送中…' : '推送复盘卡片到飞书'}
            </button>}
          </section>

          {reviewData && <>
            <div className="ops-kpi-grid">
              <article className="ops-kpi-card">
                <span>第 {reviewData.ageDays} 天全网播放</span>
                <strong>{reviewData.totalViews.toLocaleString('zh-CN')}</strong>
                <small>{reviewData.comparisonNote}</small>
              </article>
              <article className="ops-kpi-card">
                <span>较上期同龄涨跌</span>
                <strong className={reviewData.totalViewsDeltaRatio && reviewData.totalViewsDeltaRatio > 0 ? 'tone-up' : ''}>
                  {formatRatio(reviewData.totalViewsDeltaRatio)}
                </strong>
                <small>{reviewData.prevEpisodeTitle ? `上期：${reviewData.prevEpisodeTitle}` : '首期基准'}</small>
              </article>
              <article className="ops-kpi-card">
                <span>总互动 / 综合互动率</span>
                <strong>
                  {reviewData.totalInteractions.toLocaleString('zh-CN')}
                  {reviewData.overallEngageRate != null ? ` (${(reviewData.overallEngageRate * 100).toFixed(1)}%)` : ''}
                </strong>
                <small>赞 + 评 + 藏 + 转 / 播放</small>
              </article>
              <article className="ops-kpi-card">
                <span>期间全平台净涨粉</span>
                <strong className={reviewData.periodFollowerGain > 0 ? 'tone-up' : ''}>{formatSigned(reviewData.periodFollowerGain)}</strong>
                <small>采样日：{reviewData.reviewDay}</small>
              </article>
            </div>

            <section className="ops-card">
              <header className="ops-card-head">
                <h3>各平台播放贡献占比</h3>
              </header>
              <PartitionBar
                label="各平台播放占比"
                segments={reviewData.platforms.map(p => ({
                  key: p.platform,
                  label: p.label,
                  value: p.views ?? 0,
                  color: PLATFORM_COLORS[p.platform]
                }))}
              />
            </section>

            <section className="ops-card">
              <header className="ops-card-head">
                <h3>单期各平台明细与同龄对比表</h3>
              </header>
              <div className="flow-table-wrap">
                <table className="flow-table stats-table">
                  <thead>
                    <tr>
                      <th>平台</th>
                      <th>状态</th>
                      <th>播放</th>
                      <th>占比</th>
                      <th>点赞</th>
                      <th>评论</th>
                      <th>收藏</th>
                      <th>转发</th>
                      <th>互动率</th>
                      <th>上期同龄播放</th>
                      <th>同龄环比</th>
                      <th>链接</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewData.platforms.map(row => <tr key={row.platform}>
                      <td><strong>{row.label}</strong></td>
                      <td>{OPS_STATE_LABELS[row.state]}</td>
                      <td>{row.views != null ? row.views.toLocaleString('zh-CN') : '—'}</td>
                      <td>{row.viewShare != null ? `${(row.viewShare * 100).toFixed(0)}%` : '—'}</td>
                      <td>{row.likes ?? '—'}</td>
                      <td>{row.comments ?? '—'}</td>
                      <td>{row.favorites ?? '—'}</td>
                      <td>{row.shares ?? '—'}</td>
                      <td>{row.engageRate != null ? `${(row.engageRate * 100).toFixed(1)}%` : '—'}</td>
                      <td>{row.prevSameAgeViews != null ? row.prevSameAgeViews.toLocaleString('zh-CN') : '—'}</td>
                      <td className={row.viewsDeltaRatio && row.viewsDeltaRatio > 0 ? 'tone-up' : ''}>{formatRatio(row.viewsDeltaRatio)}</td>
                      <td>
                        {row.postUrl
                          ? <button type="button" className="button-link" onClick={() => void window.sydney.openXhsLink(row.postUrl)}>打开</button>
                          : '—'}
                      </td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            </section>
          </>}
        </> : <EmptyState icon="chart" title="暂无可复盘的作品">先添加或分发一期作品，同步数据后自动生成第 1 / 3 / 7 天同龄对比。</EmptyState>}
      </div>
    </KeepAlive>}

    {/* ── 4. 飞书卡片通知 ──────────────────────────────────────── */}
    {visited.includes('feishu') && <KeepAlive show={tab === 'feishu'}>
      <div className="ops-tab-body">
        <section className="ops-card">
          <header className="ops-card-head">
            <div>
              <h3>飞书群自定义机器人配置</h3>
              <p>Webhook 地址与加签密钥采用系统安全存储加密保存在本机（`feishu-webhook.bin`），前端只显示掩码。</p>
            </div>
            <span className={`badge ${feishu.webhook.configured ? 'badge-on' : 'badge-off'}`}>
              {feishu.webhook.configured ? `已配置 ${feishu.webhook.masked}` : '未配置'}
            </span>
          </header>

          <div className="ww-grid">
            <label className="ww-input ww-wide">
              <span>飞书机器人 Webhook 地址</span>
              <input
                type="password"
                autoComplete="off"
                value={webhookInput}
                onChange={e => setWebhookInput(e.target.value)}
                placeholder={feishu.webhook.configured ? `已保存 ${feishu.webhook.masked}（留空保持不变）` : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'}
              />
            </label>
            <label className="ww-input ww-wide">
              <span>签名校验密钥（可选，机器人在飞书开启「签名校验」时填写）</span>
              <input
                type="password"
                autoComplete="off"
                value={secretInput}
                onChange={e => setSecretInput(e.target.value)}
                placeholder={feishu.secret.configured ? `已保存 ${feishu.secret.masked}（留空保持不变）` : '未开启加签可留空'}
              />
            </label>
          </div>

          <div className="ops-feishu-switches">
            <div className="ops-switch-row">
              <div><strong>多平台草稿就绪提醒</strong><p>视频四平台草稿填完后推彩色卡片到飞书群，提醒你去勾选原创并点最终发布。</p></div>
              <Switch
                label="多平台草稿就绪提醒"
                checked={feishu.settings.notifyOnDraft}
                onChange={val => void window.sydney.saveFeishuConfig({ settings: { notifyOnDraft: val } }).then(setFeishu)}
              />
            </div>
            <div className="ops-switch-row">
              <div><strong>创作者后台登录失效告警</strong><p>填草稿或同步后台数据时若发现某平台掉登录，推送橙色提醒卡片。</p></div>
              <Switch
                label="创作者后台登录失效告警"
                checked={feishu.settings.notifyOnLoginExpired}
                onChange={val => void window.sydney.saveFeishuConfig({ settings: { notifyOnLoginExpired: val } }).then(setFeishu)}
              />
            </div>
            <div className="ops-switch-row">
              <div><strong>第 1 / 3 / 7 天里程碑自动复盘卡片</strong><p>同步数据时检测到作品恰好满 1、3、7 天且尚未推送过，自动发送同龄对比复盘卡（每期每档只发一次）。</p></div>
              <Switch
                label="里程碑自动复盘"
                checked={feishu.settings.notifyMilestoneReview}
                onChange={val => void window.sydney.saveFeishuConfig({ settings: { notifyMilestoneReview: val } }).then(setFeishu)}
              />
            </div>
          </div>

          <div className="flow-inline-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy !== '' || (!webhookInput.trim() && !secretInput.trim())}
              onClick={() => void run('save-feishu', async () => {
                const next = await window.sydney.saveFeishuConfig({
                  ...(webhookInput.trim() ? { webhookUrl: webhookInput.trim() } : {}),
                  ...(secretInput.trim() ? { signingSecret: secretInput.trim() } : {})
                });
                setFeishu(next);
                setWebhookInput('');
                setSecretInput('');
                notify('飞书机器人凭证已加密保存');
              })}
            >
              保存凭证
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy !== '' || !feishu.webhook.configured}
              onClick={() => void run('test-feishu', async () => {
                await window.sydney.testFeishuWebhook();
                notify('测试卡片已成功发送到飞书群！');
              })}
            >
              {busy === 'test-feishu' ? '发送中…' : '发送测试卡片'}
            </button>
            {feishu.webhook.configured && <ConfirmButton
              className="button button-quiet"
              armedLabel="确认清除凭证？"
              onConfirm={() => void run('clear-feishu', async () => {
                setFeishu(await window.sydney.saveFeishuConfig({ webhookUrl: '', signingSecret: '' }));
                notify('已清除飞书机器人凭证');
              })}
            >
              清除已存凭证
            </ConfirmButton>}
          </div>
        </section>

        <section className="ops-card">
          <header className="ops-card-head">
            <h3>最近中控操作与同步日志</h3>
          </header>
          {overview.recentLogs.length ? <ul className="ops-log-list">
            {overview.recentLogs.map(log => <li key={log.id}>
              <time>{shortTime(log.ts)}</time>
              {log.platform && <span className="ops-source-tag">{OPS_PLATFORM_LABELS[log.platform as OpsPlatform] ?? log.platform}</span>}
              <strong>{log.action}</strong>
              <span>{log.result}</span>
            </li>)}
          </ul> : <p className="flow-empty">暂无操作日志。</p>}
        </section>
      </div>
    </KeepAlive>}
  </section>;
}
