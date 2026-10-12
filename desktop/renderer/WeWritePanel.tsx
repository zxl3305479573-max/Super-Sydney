import { useCallback, useEffect, useState } from 'react';
import type { WeWriteActionResult, WeWriteEnvironment, WeWriteRunDetail, WeWriteRunSummary } from '../shared';
import WeWriteOverviewPanel from './WeWriteOverview';
import NativeContentPanel from './NativeContentPanel';

type PanelResult = { title: string; text: string };

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '').trim();
  return message || '操作失败，请稍后重试';
}

function shortTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value.slice(0, 16).replace('T', ' ')
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const RUN_STATUS_TEXT: Record<string, string> = { active: '进行中', failed: '失败', completed: '已封存' };
const STEP_STATUS_TEXT: Record<string, string> = {
  pending: '未开始', in_progress: '进行中', completed: '完成', failed: '失败', skipped: '跳过'
};

export default function WeWritePanel({ notify }: { notify: (message: string) => void }) {
  const [environment, setEnvironment] = useState<WeWriteEnvironment | null>(null);
  const [runs, setRuns] = useState<WeWriteRunSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<WeWriteRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<PanelResult | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewTheme, setPreviewTheme] = useState('');
  const [query, setQuery] = useState('中老年 饮食');
  const [coverPath, setCoverPath] = useState('');
  const [tab, setTab] = useState<'native' | 'config' | 'legacy'>('native');

  const loadRuns = useCallback(async () => {
    const [nextEnvironment, nextRuns] = await Promise.all([
      window.sydney.getWeWriteEnvironment(),
      window.sydney.listWeWriteRuns(true)
    ]);
    setEnvironment(nextEnvironment);
    setRuns(nextRuns);
    setPreviewTheme(current => current || nextEnvironment.theme);
    return nextRuns;
  }, []);

  useEffect(() => {
    let alive = true;
    const loadEnvironment = () => window.sydney.getWeWriteEnvironment().then(next => {
      if (alive) { setEnvironment(next); setPreviewTheme(current => current || next.theme); }
    }).catch(() => undefined);
    void loadEnvironment();
    const off = window.sydney.onWeWriteChanged(() => { void loadEnvironment(); });
    return () => { alive = false; off(); };
  }, []);

  useEffect(() => {
    if (tab !== 'legacy') return;
    setLoading(true);
    let alive = true;
    void (async () => {
      try {
        const nextRuns = await loadRuns();
        if (alive && nextRuns.length) setSelectedId(current => current || nextRuns[0].id);
      } catch (error) {
        if (alive) notify(readableError(error));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    const off = window.sydney.onWeWriteChanged(() => { void loadRuns().catch(() => undefined); });
    return () => { alive = false; off(); };
  }, [loadRuns, notify, tab]);

  useEffect(() => {
    if (tab !== 'legacy' || !selectedId) { setDetail(null); return; }
    let alive = true;
    setCoverPath('');
    void window.sydney.getWeWriteRun(selectedId)
      .then(next => { if (alive) setDetail(next); })
      .catch(() => { if (alive) setDetail(null); });
    void window.sydney.getWeWriteCover(selectedId)
      .then(outcome => { if (alive && outcome.ok) setCoverPath(outcome.output); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [selectedId, tab]);

  const action = async (key: string, label: string, run: () => Promise<WeWriteActionResult>) => {
    setBusy(key);
    setResult(null);
    try {
      const outcome = await run();
      if (!outcome.ok) { notify(outcome.error); setResult({ title: `${label}失败`, text: outcome.detail || outcome.error }); return; }
      if (outcome.html !== undefined) setPreviewHtml(outcome.html);
      const text = outcome.output || outcome.target || '完成';
      setResult({ title: label, text });
      notify(`${label}完成`);
    } catch (error) {
      notify(readableError(error));
    } finally {
      setBusy('');
    }
  };

  const pickCover = async () => {
    const files = await window.sydney.chooseFiles();
    if (files.length) setCoverPath(files[0]);
  };

  /** 对真实公众号创建草稿（不群发），因此必须先弹确认。 */
  const publish = async () => {
    if (!detail) return;
    let cover = coverPath;
    if (!cover) {
      const files = await window.sydney.chooseFiles();
      if (!files.length) return;
      cover = files[0];
      setCoverPath(cover);
    }
    const confirmed = window.confirm(
      `把《${detail.title}》推送到公众号草稿箱？\n\n`
      + '这是对真实公众号的操作：会创建一篇草稿，不会自动群发。\n'
      + `封面：${cover}`
    );
    if (!confirmed) return;
    await action('publish', '推送草稿箱', () => window.sydney.publishWeWriteDraft(detail.id, previewTheme, cover));
  };

  if (loading && tab === 'legacy') return <section className="wewrite"><div className="ww-tabs"><button className="ww-tab" onClick={() => setTab('native')}>返回桌面端创作</button><button className="ww-tab" onClick={() => setTab('config')}>环境与配置</button></div><p>正在读取可选 WeWrite 兼容任务…</p></section>;

  const cliMissing = environment !== null && !environment.cliAvailable;

  return <section className="wewrite">
    <header className="ww-page-header">
      <div>
        <p className="eyebrow">内容工作区</p>
        <h1>公众号</h1>
        <p>选题 → 任务书 → 来源与证据 → 初稿 → AI 审稿 → 封面 → 导出与发布，每一步状态都在界面上可见。</p>
      </div>
      <div className="ww-page-header-note"><strong>中老年健康科普</strong><span>{environment?.theme || '—'} · {environment?.persona || '未设置'}</span></div>
    </header>
    <div className="ww-tabs">
      <button className={`ww-tab ${tab === 'native' ? 'is-active' : ''}`} onClick={() => setTab('native')}>创作流水线</button>
      <button className={`ww-tab ${tab === 'config' ? 'is-active' : ''}`} onClick={() => setTab('config')}>环境与配置</button>
      <button className={`ww-tab ${tab === 'legacy' ? 'is-active' : ''}`} onClick={() => setTab('legacy')}>WeWrite 兼容</button>
    </div>
    {tab === 'native' ? <NativeContentPanel notify={notify} /> : tab === 'config' ? <WeWriteOverviewPanel notify={notify} /> : <>
    <div className="ww-status">
      <span className={`adapter-state ${cliMissing ? 'adapter-error' : environment?.styleFound ? 'adapter-listening' : 'adapter-stopped'}`}>
        {cliMissing ? 'CLI 不可用' : environment?.styleFound ? '已就绪' : '待配置风格'}
      </span>
      <span><b>状态目录</b>{environment?.home || '—'}</span>
      <span><b>主题</b>{previewTheme || '—'}</span>
      <span><b>人格</b>{environment?.persona || '未设置'}</span>
      <span><b>微信凭证</b>{environment?.wechatConfigured ? '已配置' : '未配置'}</span>
      <span><b>图片服务</b>{environment?.imageConfigured ? '已配置' : '未配置'}</span>
      <button className="button button-secondary" onClick={() => void loadRuns().catch(error => notify(readableError(error)))}>刷新</button>
    </div>

    {cliMissing && <p className="ww-warning">未找到 wewrite 命令：{environment?.cliError}。请先安装 CLI，然后重开应用。</p>}

    <div className="ww-layout">
      <div className="ww-runs">
        <div className="section-heading"><div><h2>文章任务</h2><p>选题、写作与审稿在对话里完成，这里查看进度与产物。</p></div></div>
        {runs.length === 0
          ? <div className="empty-state"><strong>还没有公众号任务</strong><span>在对话里说「写一篇公众号文章」，任务会自动出现在这里。</span></div>
          : runs.map(run => <button key={run.id} className={`ww-run ${selectedId === run.id ? 'is-selected' : ''}`} onClick={() => setSelectedId(run.id)}>
              <div className="ww-run-head">
                <strong>{run.title}</strong>
                <span className={`status status-${run.status === 'completed' ? 'approved' : run.status === 'failed' ? 'rejected' : 'pending'}`}>{RUN_STATUS_TEXT[run.status] ?? run.status}</span>
              </div>
              <div className="ww-run-meta">
                <span>{run.mode}</span>
                <span>步骤 {run.completedSteps}/{run.totalSteps}</span>
                <span>来源 {run.sourceCount}{run.verifiedSourceCount ? `（已核实 ${run.verifiedSourceCount}）` : ''}</span>
                <span>{shortTime(run.updatedAt)}</span>
              </div>
              <div className="ww-progress">{Object.entries(run.steps).map(([name, status]) =>
                <span key={name} className={`ww-dot ww-dot-${status}`} title={`${name}: ${status}`} />)}</div>
            </button>)}
      </div>

      <div className="ww-detail">
        {detail ? <>
          <div className="section-heading"><div><h2>{detail.title}</h2><p>{detail.id} · {detail.mode} · 更新于 {shortTime(detail.updatedAt)}</p></div></div>

          <ol className="ww-steps">{detail.stepList.map(step =>
            <li key={step.name} className={`ww-step ww-step-${step.status}`}>
              <span className="ww-step-name">{step.label}</span>
              <span className="ww-step-status">{STEP_STATUS_TEXT[step.status] ?? step.status}</span>
            </li>)}</ol>

          {detail.lastError && <p className="ww-warning">最近错误：{detail.lastError}</p>}

          <div className="ww-facts">
            <span><b>框架</b>{detail.framework || '—'}</span>
            <span><b>字数</b>{detail.wordCount || '—'}</span>
            <span><b>增强策略</b>{detail.enhanceStrategy || '—'}</span>
            <span><b>发布授权</b>{detail.publishAllowed ? '已授权' : '未授权（每次推送需单独确认）'}</span>
            <span><b>封面</b>{coverPath || '未选择'}</span>
          </div>
          {detail.keywords.length > 0 && <p className="ww-keywords">关键词：{detail.keywords.join('、')}</p>}

          <div className="ww-actions">
            <button className="button button-primary" disabled={busy !== '' || !detail.hasArticle}
              onClick={() => void action('preview', '排版预览', () => window.sydney.renderWeWritePreview(detail.id, previewTheme))}>
              {busy === 'preview' ? '排版中…' : '排版预览'}
            </button>
            <button className="button button-secondary" disabled={busy !== '' || !detail.hasArticle}
              onClick={() => void action('validate', '兼容校验', () => window.sydney.validateWeWritePreview(detail.id))}>微信兼容校验</button>
            <button className="button button-secondary" disabled={busy !== '' || !detail.hasArticle}
              onClick={() => void action('score', '质量评分', () => window.sydney.scoreWeWriteArticle(detail.id))}>质量评分</button>
            <button className="button button-quiet" onClick={() => void action('open', '打开目录', () => window.sydney.openWeWriteRunDirectory(detail.id))}>打开任务目录</button>
            <button className="button button-quiet" disabled={busy !== ''} onClick={() => void pickCover()}>选择封面</button>
            <button className="button button-secondary" disabled={busy !== '' || !detail.hasArticle || !environment?.wechatConfigured}
              title={environment?.wechatConfigured ? '推送到真实公众号草稿箱，推送前会二次确认' : '需先在 ~/.wewrite/config.yaml 填写 wechat.appid 与 wechat.secret'}
              onClick={() => void publish()}>
              {busy === 'publish' ? '推送中…' : '推送草稿箱'}
            </button>
            {environment && environment.themes.length > 0 && <label className="ww-theme-picker">主题
              <select value={previewTheme} onChange={event => setPreviewTheme(event.target.value)}>
                {environment.themes.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
              </select>
            </label>}
          </div>

          {Object.keys(detail.artifacts).length > 0 && <details className="ww-artifacts"><summary>产物文件（{Object.keys(detail.artifacts).length}）</summary>
            <ul>{Object.entries(detail.artifacts).map(([key, value]) => <li key={key}><span>{key}</span><code>{value}</code></li>)}</ul>
          </details>}

          {previewHtml && <div className="ww-preview">
            <div className="ww-preview-head"><span>排版预览（{previewTheme}）</span>
              <button className="button button-quiet" onClick={() => setPreviewHtml('')}>收起</button></div>
            <iframe className="ww-preview-frame" title="排版预览" sandbox="" srcDoc={previewHtml} />
          </div>}
        </> : <div className="empty-state"><strong>选择一个任务</strong><span>左侧任务可查看步骤、产物与排版预览。</span></div>}
      </div>
    </div>

    <div className="ww-topics">
      <div className="section-heading"><div><h2>选题辅助</h2><p>确定性命令；选题判断与成稿仍在对话里完成。</p></div></div>
      <div className="ww-topic-actions">
        <button className="button button-secondary" disabled={busy !== ''}
          onClick={() => void action('hotspots', '抓取热点', () => window.sydney.fetchWeWriteHotspots(30))}>抓取热点</button>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="垂类关键词，如：中老年 饮食" />
        <button className="button button-secondary" disabled={busy !== '' || !query.trim()}
          onClick={() => void action('search', '搜索微信垂类', () => window.sydney.searchWeChatArticles(query, 2))}>搜索微信垂类（近一周）</button>
      </div>
      {result && <details className="ww-result" open>
        <summary>{result.title}</summary>
        <pre>{result.text}</pre>
      </details>}
    </div>
    </>}
  </section>;
}
