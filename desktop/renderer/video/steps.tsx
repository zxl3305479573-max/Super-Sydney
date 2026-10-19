import { useEffect, useState } from 'react';
import type {
  LlmKeyStatus, VideoAssetBundle, VideoIpCoverInput, VideoPlatform, VideoProject, VideoRenderOptions,
  VideoTopicSearchResult, XhsHotNote, XhsHotspotSource
} from '../../shared';
import {
  VIDEO_PLATFORMS, formatDuration, narrationCoverage, parseVideoShots, videoExportChecklist, videoPlatformLabel,
  type VideoStep, type VideoStepKey
} from '../../services/video-pipeline';
import { shotRoleLabel } from '../../services/video-production';
import { fuzzyCount } from '../../services/xhs-hotspot';
import { Icon, readableError, shortTime } from '../ui';
import { estimatedSeconds, stateNames, type TopicSuggestion } from './format';
import { VideoIpCoverPanel } from './IpCoverPanel';

/** 视频流水线的各步骤面板。只负责展示与收集输入，动作由 VideoPanel 传入。 */

export function Stepper({ steps, active, onSelect }: { steps: VideoStep[]; active: VideoStepKey; onSelect: (key: VideoStepKey) => void }) {
  return <ol className="flow-stepper" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="视频创作流程">
    {steps.map(item => <li key={item.key} className={`flow-node flow-node-${item.state} ${active === item.key ? 'is-active' : ''}`}>
      <button onClick={() => onSelect(item.key)} aria-current={active === item.key ? 'step' : undefined} title={item.reason || item.hint}>
        <span className="flow-dot">{item.state === 'done' ? '✓' : item.state === 'attention' ? '!' : item.index}</span>
        <span className="flow-node-label">{item.label}</span>
        <small>{stateNames[item.state]}</small>
      </button>
    </li>)}
  </ol>;
}

export function TopicStep({ project, suggestions, locked, busy, onEdit, onRun, notify }: {
  project: VideoProject; suggestions: TopicSuggestion[]; locked: boolean; busy: string;
  onEdit: (patch: Partial<VideoProject>) => void; onRun: () => void;
  notify: (message: string) => void;
}) {
  const drift = project.durationSeconds > 0 && project.script.trim() ? estimatedSeconds(project.script) - project.durationSeconds : 0;
  return <div className="flow-body">
    <div className="native-task-fields">
      <label className="native-field-wide"><span>视频标题</span><input disabled={locked} value={project.title} onChange={event => onEdit({ title: event.target.value })} placeholder="观众一眼能看懂的标题" /></label>
      <label><span>发布平台</span><select disabled={locked} value={project.platform} onChange={event => onEdit({ platform: event.target.value as VideoPlatform })}>{VIDEO_PLATFORMS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label><span>目标时长（秒）</span><input disabled={locked} type="number" min={5} value={project.durationSeconds} onChange={event => onEdit({ durationSeconds: Number(event.target.value) })} /></label>
      <label><span>目标受众</span><input disabled={locked} value={project.audience} placeholder="例如：60 岁以上、有高血压的读者" onChange={event => onEdit({ audience: event.target.value })} /></label>
      <label className="native-field-wide"><span>选题方向 / 想解决的问题</span><input disabled={locked} value={project.topic} onChange={event => onEdit({ topic: event.target.value })} placeholder="描述观众的问题或想解决的需求" /></label>
    </div>
    {project.script.trim() && Math.abs(drift) >= 15 && <p className="flow-attention-note">现有脚本约 {formatDuration(estimatedSeconds(project.script))}，与目标 {formatDuration(project.durationSeconds)} 相差 {drift > 0 ? '+' : ''}{drift} 秒，可重新生成脚本或调整目标时长。</p>}
    <TopicResearch project={project} locked={locked} onEdit={onEdit} notify={notify} />
    <div className="flow-inline-actions">
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'topics' ? '生成中…' : suggestions.length ? '换一批 AI 选题' : 'AI 生成 5 个候选选题'}</button>
      <small>点选候选会填入标题与方向；选好标题后点右上角「自动生成」，可一次跑完口播脚本 → 分镜。</small>
    </div>
    {suggestions.length > 0 && <div className="native-topic-options">{suggestions.map(item => <button key={item.title} disabled={locked} className={`native-task ${project.title === item.title ? 'is-selected' : ''}`} onClick={() => onEdit({ title: item.title, topic: item.angle })}>
      <strong>{item.title}</strong>
      {item.hook && <small>开场：{item.hook}</small>}
      {item.angle && <small>{item.angle}</small>}
      {item.why && <small>价值：{item.why}</small>}
      {item.evidence && <small>核实：{item.evidence}</small>}
      {item.risk && <small className="flow-risk">风险提示：{item.risk}</small>}
      <span>{project.title === item.title ? '已采用' : '采用这个选题'}</span>
    </button>)}</div>}
  </div>;
}

const TOPIC_DAY_OPTIONS = [3, 7, 14, 30];
const TOPIC_SIZE_OPTIONS = [10, 20, 50];
const TOPIC_SOURCE_OPTIONS: Array<{ value: XhsHotspotSource; label: string }> = [
  { value: 'auto', label: '自动（红狐优先）' },
  { value: 'redfox', label: '红狐 API' },
  { value: 'web', label: '联网搜索' }
];

function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function TopicSearchRow({ note, adopted, onAdopt, onOpen }: {
  note: XhsHotNote; adopted: boolean; onAdopt: () => void; onOpen: () => void;
}) {
  return <li className="xhs-hot">
    <div className="xhs-hot-main">
      <button className="xhs-hot-title" title="在浏览器中打开" onClick={onOpen}>{note.title}</button>
      <p className="xhs-hot-meta">
        <span>{note.author.nickname}{note.author.fans ? `（${fuzzyCount(note.author.fans)}粉）` : ''}</span>
        {note.createTime && <span>{note.createTime.slice(0, 10)}</span>}
        {note.score && <span title="相关性 / 热度 / 时效">评分 {note.score.total.toFixed(1)}</span>}
      </p>
      {note.desc && <p className="xhs-hot-desc">{note.desc}</p>}
      {note.topics.length > 0 && <div className="xhs-chip-row">{note.topics.slice(0, 4).map(topic => <span key={topic} className="chip chip-soft">#{topic}</span>)}</div>}
    </div>
    <div className="xhs-hot-stats">
      {note.unverified
        ? <><strong>—</strong><small>热度未知</small></>
        : <><strong>{fuzzyCount(note.interactive)}</strong><small>互动</small></>}
    </div>
    <button className="button button-secondary" disabled={adopted} onClick={onAdopt}>{adopted ? '已采用' : <><Icon name="plus" />采用</>}</button>
  </li>;
}

/**
 * 视频选题研究：与小红书共用红狐 / 联网搜索能力。
 * 搜索结果只是选题线索；采用后写入标题与方向，后续脚本仍按视频平台的节奏生成。
 */
function TopicResearch({ project, locked, onEdit, notify }: {
  project: VideoProject; locked: boolean;
  onEdit: (patch: Partial<VideoProject>) => void; notify: (message: string) => void;
}) {
  const [keyword, setKeyword] = useState(project.topic);
  const [days, setDays] = useState(7);
  const [pageSize, setPageSize] = useState(10);
  const [source, setSource] = useState<XhsHotspotSource>('auto');
  const [result, setResult] = useState<VideoTopicSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [keyStatus, setKeyStatus] = useState<LlmKeyStatus | null>(null);
  const platformName = videoPlatformLabel(project.platform);

  useEffect(() => {
    setKeyword(project.topic);
    setResult(null);
  }, [project.id, project.platform]);
  useEffect(() => {
    void window.sydney.getRedfoxKeyStatus().then(setKeyStatus).catch(() => setKeyStatus(null));
  }, []);

  const search = async (word = keyword, refresh = false) => {
    if (searching) return;
    setSearching(true);
    try {
      setKeyword(word);
      setResult(await window.sydney.searchVideoTopics({
        platform: project.platform,
        keyword: word,
        startDate: daysAgo(days),
        pageSize,
        refresh,
        source
      }));
    } catch (error) {
      notify(readableError(error));
    } finally {
      setSearching(false);
    }
  };
  const open = (note: XhsHotNote) => {
    void window.sydney.openXhsLink(note.link).catch(error => notify(readableError(error)));
  };
  const adopt = (note: XhsHotNote) => {
    const context = note.desc.replace(/\s+/g, ' ').trim().slice(0, 320);
    onEdit({ title: note.title.slice(0, 100), topic: context || note.title });
    notify(`已采用「${note.title}」为视频选题`);
  };
  const adopted = result?.notes.some(note => note.title === project.title) ?? false;
  const keyMissing = keyStatus !== null && !keyStatus.configured;
  const redfoxPending = project.platform === 'douyin' || project.platform === 'shipinhao' || project.platform === 'bilibili';
  const placeholder = project.platform === 'xiaohongshu'
    ? '关键词，例如：控糖早餐、膝关节保养；红狐可留空查全站热门'
    : `关键词，例如：控糖早餐、膝关节保养；${platformName}红狐与联网搜索都需要关键词`;
  const sourceOptions = TOPIC_SOURCE_OPTIONS.map(item => item.value === 'redfox' && project.platform !== 'general'
    ? { ...item, label: `红狐 API（${platformName}）` }
    : item);

  return <section className="video-topic-research" aria-labelledby="video-topic-research-title">
    <div className="flow-sub-head">
      <h4 id="video-topic-research-title">从{platformName}热点里找选题<small>自动模式优先使用对应平台红狐数据；接口不可用时改为按{platformName}检索公开网页。</small></h4>
    </div>
    {keyMissing && <p className="xhs-hint"><Icon name="key" size={14} />还没有保存红狐 API Key，当前会自动使用联网搜索。可在「隐私与设置 → 数据服务」里配置。</p>}
    {redfoxPending && <p className="xhs-hint xhs-hint-warn"><Icon name="alert" size={14} />红狐的{platformName}选题接口目前官方标记为「即将上线」。选择自动模式时会先尝试接口，失败后自动改用联网搜索。</p>}
    <form className="xhs-search" onSubmit={event => { event.preventDefault(); void search(); }}>
      <input className="input" placeholder={placeholder} value={keyword} onChange={event => setKeyword(event.target.value)} />
      <select className="input" aria-label="数据源" value={source} onChange={event => setSource(event.target.value as XhsHotspotSource)}>{sourceOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
      <select className="input" aria-label="时间范围" value={days} onChange={event => setDays(Number(event.target.value))}>{TOPIC_DAY_OPTIONS.map(value => <option key={value} value={value}>近 {value} 天</option>)}</select>
      <select className="input" aria-label="选题数量" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{TOPIC_SIZE_OPTIONS.map(value => <option key={value} value={value}>{value} 条</option>)}</select>
      <button className="button button-primary" type="submit" disabled={locked || searching}><Icon name="search" />{searching ? '搜索中…' : '搜索选题'}</button>
    </form>
    {result && <div className="xhs-result">
      {result.notice && <p className="xhs-hint xhs-hint-warn"><Icon name="alert" size={14} />{result.notice}</p>}
      <p className="xhs-result-meta">
        <span className={`chip ${result.source === 'redfox' ? 'chip-accent' : ''}`}>{result.source === 'redfox' ? '红狐 API' : '联网搜索'} · {videoPlatformLabel(result.platform)}</span>
        「{result.keyword || '全站热门'}」共 {result.total} 条，显示 {result.notes.length} 条 · {result.cached ? `缓存于 ${shortTime(result.fetchedAt)}` : `查询于 ${shortTime(result.fetchedAt)}`}
        {result.cached && <button className="button button-quiet" type="button" disabled={locked} onClick={() => void search(result.keyword, true)}><Icon name="refresh" />重新查询</button>}
      </p>
      {result.tips && <p className="xhs-hint">{result.tips}</p>}
      {result.relatedSearches.length > 0 && <div className="xhs-chip-row"><span className="xhs-chip-label">相关搜索</span>{result.relatedSearches.slice(0, 10).map(item => <button key={item.keyword} className="chip" type="button" onClick={() => void search(item.keyword)}>{item.keyword}<small>{item.count}</small></button>)}</div>}
      {result.hotTopics.length > 0 && <div className="xhs-chip-row"><span className="xhs-chip-label">热门话题</span>{result.hotTopics.slice(0, 8).map(item => <button key={item.topic} className="chip chip-soft" type="button" onClick={() => void search(item.topic)}>#{item.topic}</button>)}</div>}
      {result.notes.length
        ? <ul className="xhs-hot-list">{result.notes.map(note => <TopicSearchRow key={note.id} note={note} adopted={adopted && note.title === project.title} onAdopt={() => adopt(note)} onOpen={() => open(note)} />)}</ul>
        : <p className="flow-empty">没有搜到可用内容。换个关键词，或把时间范围放宽。</p>}
    </div>}
  </section>;
}

export function ScriptStep({ project, locked, busy, onEdit, onRun }: {
  project: VideoProject; locked: boolean; busy: string; onEdit: (script: string) => void; onRun: () => void;
}) {
  const estimate = estimatedSeconds(project.script);
  return <div className="flow-body">
    <div className="flow-sub-head">
      <h4>口播脚本<small>约 {project.script.replace(/\s/g, '').length} 字 · 念出来约 {formatDuration(estimate)}（目标 {formatDuration(project.durationSeconds)}）</small></h4>
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'script' ? '生成中…' : project.script.trim() ? '重新生成脚本' : 'AI 写口播脚本'}</button>
    </div>
    <textarea className="flow-draft" disabled={locked} value={project.script} onChange={event => onEdit(event.target.value)}
      placeholder="生成脚本后在这里改；也可以直接写或粘贴自己的口播稿。第一句就是开场，之后一次只讲一件事。" />
    <p className="ww-muted">口播稿是脚本、分镜与字幕的唯一来源：改完这里，分镜与制作包会标成「需要重做」，重新生成即可。</p>
  </div>;
}

export function StoryboardStep({ shots, raw, script, locked, busy, onEdit, onRun }: {
  shots: ReturnType<typeof parseVideoShots>; raw: string; script: string; locked: boolean; busy: string;
  onEdit: (storyboardJson: string) => void; onRun: () => void;
}) {
  const total = shots.reduce((sum, shot) => sum + shot.seconds, 0);
  const coverage = narrationCoverage(script, shots);
  return <div className="flow-body">
    <div className="flow-sub-head">
      <h4>镜头清单<small>{shots.length} 个镜头 · 共 {formatDuration(total)}</small></h4>
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'storyboard' ? '拆解中…' : shots.length ? '重新生成分镜' : 'AI 拆分镜'}</button>
    </div>
    {shots.length > 0 && coverage < 0.8 && <p className="flow-attention-note">分镜口播只覆盖了脚本 {Math.round(coverage * 100)}% 的句子，配音和字幕都从口播来，漏掉的句子成片里不会出现。可以重新拆分镜，或在下方 JSON 里补上。</p>}
    {shots.length ? <table className="flow-table"><thead><tr><th>镜号</th><th>作用</th><th>秒</th><th>画面大字</th><th>口播</th><th>画面 / 配图提示词</th></tr></thead><tbody>
      {shots.map((shot, position) => <tr key={position}>
        <td>{shot.index}</td><td>{shotRoleLabel(shot.role) || '—'}</td><td>{shot.seconds}</td>
        <td>{shot.caption || '—'}</td><td>{shot.narration || '—'}</td>
        <td>{shot.visual || '—'}{shot.imagePrompt && <small className="video-prompt">配图：{shot.imagePrompt}</small>}</td>
      </tr>)}
    </tbody></table> : <p className="flow-empty">还没有分镜。分镜决定每个镜头讲什么、画面上放哪几个大字；配音、字幕和画面都从它推出来。</p>}
    {raw.trim() && <details className="native-json"><summary>直接编辑分镜 JSON（进阶）</summary>
      <textarea className="flow-draft" style={{ minHeight: 220 }} disabled={locked} value={raw} onChange={event => onEdit(event.target.value)} />
      <p className="ww-muted">字段：shots 数组，每项含 index、seconds、role、caption（画面大字）、visual、narration、imagePrompt。保存时会按时长与编号归一化；JSON 无效会拒绝保存。</p>
    </details>}
  </div>;
}

export function CoverStep({ project, assets, locked, busy, onChoose, onGenerate, onOptions, onIpCover }: {
  project: VideoProject; assets: VideoAssetBundle | null; locked: boolean; busy: string; onChoose: () => void; onGenerate: () => void;
  onOptions: (patch: Partial<VideoRenderOptions>) => void; onIpCover: (input: VideoIpCoverInput) => void;
}) {
  return <div className="flow-body">
    <div className="flow-cover">
      <figure className="flow-cover-figure video-cover-figure">
        {assets?.cover?.thumbnail ? <img src={assets.cover.thumbnail} alt="封面预览" /> : <div className="flow-image-missing">还没有封面图</div>}
        <figcaption>{project.coverPath ? project.coverPath.split(/[\\/]/).pop() : '未选择封面（可跳过）'}</figcaption>
      </figure>
      <div className="flow-cover-actions">
        <button className="button button-secondary" disabled={locked} onClick={onChoose}>选择本地图片</button>
        <button className="button button-primary" disabled={locked} onClick={onGenerate}>{busy === 'cover' ? '生成中…' : 'AI 生成竖版封面'}</button>
        <small>竖版 9:16，导出时连同成片、脚本、分镜表、字幕一起拷进制作包。封面不是导出的硬门槛，但发布到平台时基本都要。</small>
      </div>
    </div>
    <VideoIpCoverPanel project={project} locked={locked} busy={busy === 'ip-cover'} onOptions={onOptions} onRender={onIpCover} />
  </div>;
}

export function ExportStep({ project, locked, busy, onExport, onOpen }: {
  project: VideoProject; locked: boolean; busy: string; onExport: () => void; onOpen: () => void;
}) {
  const checklist = videoExportChecklist(project);
  const ready = checklist.filter(item => !item.optional).every(item => item.ok);
  return <div className="flow-body">
    <ul className="flow-checklist">{checklist.map(item => <li key={item.label} className={item.ok ? 'is-ok' : 'is-missing'}>
      <span aria-hidden="true">{item.ok ? '✓' : '○'}</span>
      <div><strong>{item.label}{item.optional && '（可选）'}</strong><small>{item.detail}</small></div>
    </li>)}</ul>
    <div className="flow-inline-actions">
      <button className="button button-primary" disabled={locked || !ready} onClick={onExport}>{busy === 'export' ? '导出中…' : '导出制作包'}</button>
      {project.exportPath && <button className="button button-secondary" disabled={locked} onClick={onOpen}>打开制作包目录</button>}
    </div>
    {project.exportPath && <p className="native-export-path">最近导出：{project.exportPath}</p>}
    <p className="ww-muted">制作包里是 制作包.md（脚本 + 分镜表）、shotlist.csv、captions.srt、成片 video.mp4（渲染过且没过期时）与封面图。本模块不上传、不发布到任何平台。</p>
  </div>;
}

/** 封面缩略图由主进程生成（渲染进程读不到本地文件），项目变动后自动重新拉取。 */
export function useVideoAssets(projectId: number, revision: string): VideoAssetBundle | null {
  const [assets, setAssets] = useState<VideoAssetBundle | null>(null);
  useEffect(() => {
    if (!projectId) { setAssets(null); return; }
    let alive = true;
    void window.sydney.getVideoAssets(projectId)
      .then(next => { if (alive) setAssets(next); })
      .catch(() => { if (alive) setAssets(null); });
    return () => { alive = false; };
  }, [projectId, revision]);
  return assets;
}
