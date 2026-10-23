import { useEffect, useState } from 'react';
import type { ContentAssetBundle, ContentAssetView, ContentTask, ContentTaxonomy, ImageCandidateBundle, ImageCandidateGroup, ImageCandidateOption, LlmKeyStatus, WechatIpCoverInput, XhsHotNote, XhsHotspotResult, XhsHotspotSource } from '../../shared';
import { ARTICLE_THEMES, DEFAULT_ARTICLE_THEME } from '../../services/article-html';
import { countInlineImages } from '../../services/content-images';
import { renderEvidenceSection } from '../../services/evidence-section';
import { FEATURED_SOURCE_LIMIT, pickFeaturedSources } from '../../services/content-sources';
import { PIPELINE_STEPS, buildPipeline, currentStepKey, publishChecklist, type PipelineStep, type PipelineStepKey } from '../../services/content-pipeline';
import { fuzzyCount } from '../../services/xhs-hotspot';
import { findDirectionById, findSubdirectionById, subdirectionsOf, taskScopeLabel } from '../content-taxonomy';
import { Icon, readableError, shortTime } from '../ui';
import { WechatIpCoverPanel } from './IpCoverPanel';
import { countChars, list, parseObject, readSources, stateNames, text, topicResearchMeta, topicSuggestions, wrapPreviewHtml, type Env, type Source } from './format';

/** 公众号创作流水线的各步骤面板。只负责展示与收集输入，动作由 NativeContentPanel 传入。 */

export function Stepper({ steps, active, onSelect }: { steps: PipelineStep[]; active: PipelineStepKey; onSelect: (key: PipelineStepKey) => void }) {
  return <ol className="flow-stepper" aria-label="创作流程">
    {steps.map(item => <li key={item.key} className={`flow-node flow-node-${item.state} ${active === item.key ? 'is-active' : ''}`}>
      <button onClick={() => onSelect(item.key)} aria-current={active === item.key ? 'step' : undefined} title={item.reason || item.hint}>
        <span className="flow-dot">{item.state === 'done' ? '✓' : item.state === 'attention' ? '!' : item.index}</span>
        <span className="flow-node-label">{item.label}</span>
        <small>{stateNames[item.state]}</small>
      </button>
    </li>)}
  </ol>;
}

export function Board({ tasks, env, onOpen }: { tasks: ContentTask[]; env: Env; onOpen: (task: ContentTask, step?: PipelineStepKey) => void }) {
  const columns = [...PIPELINE_STEPS.map(item => ({ key: item.key as string, label: item.label })), { key: 'finished', label: '已完成' }];
  const placed = tasks.map(task => {
    const steps = buildPipeline(task, env);
    const finished = steps.find(item => item.key === 'publish')?.state === 'done';
    return { task, column: finished ? 'finished' : currentStepKey(task, env), steps };
  });
  return <div className="flow-board">{columns.map(column => {
    const items = placed.filter(item => item.column === column.key);
    return <section key={column.key} className="flow-column"><header><strong>{column.label}</strong><span>{items.length}</span></header>
      {items.length ? items.map(({ task, steps }) => {
        const attention = steps.find(item => item.state === 'attention');
        return <button key={task.id} className="flow-card" onClick={() => onOpen(task, column.key === 'finished' ? 'publish' : column.key as PipelineStepKey)}>
          <strong>{task.title || task.topic || '未命名选题'}</strong>
          <small>{taskScopeLabel(task)}</small>
          {attention && <em>{attention.reason}</em>}
          <div className="flow-mini" aria-hidden="true">{steps.map(item => <i key={item.key} className={`flow-mini-${item.state}`} />)}</div>
        </button>;
      }) : <p className="flow-column-empty">—</p>}
    </section>;
  })}</div>;
}

const CONTENT_TOPIC_DAYS = [3, 7, 14, 30];
const CONTENT_TOPIC_SIZES = [10, 20];
const CONTENT_TOPIC_SOURCES: Array<{ value: XhsHotspotSource; label: string }> = [
  { value: 'auto', label: '自动（红狐优先）' },
  { value: 'redfox', label: '只用红狐' },
  { value: 'web', label: '只用联网搜索' }
];

function contentDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function WechatTopicSearchRow({ note, adopted, onAdopt, onOpen }: {
  note: XhsHotNote; adopted: boolean; onAdopt: () => void; onOpen: () => void;
}) {
  const heat = note.readCount ? { value: note.readCount, label: '阅读' } : { value: note.interactive, label: '互动' };
  return <li className="xhs-hot">
    <div className="xhs-hot-main">
      <button className="xhs-hot-title" title="在浏览器中打开原文" disabled={!note.link} onClick={onOpen}>{note.title}</button>
      <p className="xhs-hot-meta">
        <span>{note.author.nickname}{note.author.fans ? `（${fuzzyCount(note.author.fans)}粉）` : ''}</span>
        {note.createTime && <span>{note.createTime.slice(0, 10)}</span>}
        {note.topics.length > 0 && <span>{note.topics.slice(0, 2).join(' · ')}</span>}
      </p>
      {note.desc && <p className="xhs-hot-desc">{note.desc}</p>}
    </div>
    <div className="xhs-hot-stats">
      <strong>{note.unverified && !note.readCount ? '—' : fuzzyCount(heat.value)}</strong>
      <small>{note.unverified && !note.readCount ? '热度未知' : heat.label}</small>
    </div>
    <button className="button button-secondary" disabled={adopted} onClick={onAdopt}>{adopted ? '已采用' : <><Icon name="plus" />采用</>}</button>
  </li>;
}

/**
 * 公众号选题研究：优先红狐公众号作品库，失败后按关键词联网搜索。
 * 采用热点只填标题和选题方向；后续任务书与正文仍必须重新核实事实。
 */
function WechatTopicResearch({ task, profile, subdirection, locked, onEdit, notify }: {
  task: ContentTask;
  profile: { id: number; name: string; audience: string } | null;
  subdirection: { id: number; name: string } | null;
  locked: boolean;
  onEdit: (patch: Partial<ContentTask>) => void;
  notify: (message: string) => void;
}) {
  const suggested = task.topic.trim() || subdirection?.name || profile?.name || '';
  const [keyword, setKeyword] = useState(suggested);
  const [days, setDays] = useState(7);
  const [pageSize, setPageSize] = useState(20);
  const [source, setSource] = useState<XhsHotspotSource>('auto');
  const [result, setResult] = useState<XhsHotspotResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [keyStatus, setKeyStatus] = useState<LlmKeyStatus | null>(null);

  useEffect(() => {
    setKeyword(suggested);
    setResult(null);
  }, [task.id, profile?.id ?? 0, subdirection?.id ?? 0]);
  useEffect(() => {
    void window.sydney.getRedfoxKeyStatus().then(setKeyStatus).catch(() => setKeyStatus(null));
  }, []);

  const search = async (word = keyword, refresh = false) => {
    if (!word.trim()) {
      notify('先填写选题方向、具体方向或搜索关键词');
      return;
    }
    if (searching) return;
    setSearching(true);
    try {
      setKeyword(word.trim());
      setResult(await window.sydney.searchContentTopics({
        keyword: word.trim(),
        startDate: contentDaysAgo(days),
        pageSize,
        source,
        refresh
      }));
    } catch (error) {
      notify(readableError(error));
    } finally {
      setSearching(false);
    }
  };
  const adopt = (note: XhsHotNote) => {
    const context = note.desc.replace(/\s+/g, ' ').trim().slice(0, 500) || note.title;
    onEdit({ title: note.title.slice(0, 100), topic: context });
    notify(`已采用「${note.title}」为公众号选题`);
  };
  const open = (note: XhsHotNote) => {
    if (!note.link) return;
    void window.sydney.openXhsLink(note.link).catch(error => notify(readableError(error)));
  };
  const adopted = Boolean(result?.notes.some(note => note.title === task.title));
  const keyMissing = keyStatus !== null && !keyStatus.configured;

  return <section className="content-topic-research" aria-label="公众号热点选题">
    <div className="flow-sub-head">
      <h4>从公众号热点里找选题<small>优质库 → 广域库 → 联网搜索；红狐数据为 T+1，按阅读数优先。</small></h4>
    </div>
    {keyMissing && <p className="xhs-hint"><Icon name="key" size={14} />还没有保存红狐 API Key，当前自动改用联网搜索。可在「隐私与设置 → 数据服务」里配置。</p>}
    <form className="xhs-search" onSubmit={event => { event.preventDefault(); void search(); }}>
      <input className="input" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="公众号选题关键词，例如：中老年早餐、控糖误区" />
      <select className="input" aria-label="数据源" value={source} onChange={event => setSource(event.target.value as XhsHotspotSource)}>
        {CONTENT_TOPIC_SOURCES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <select className="input" aria-label="时间范围" value={days} onChange={event => setDays(Number(event.target.value))}>
        {CONTENT_TOPIC_DAYS.map(value => <option key={value} value={value}>近 {value} 天</option>)}
      </select>
      <select className="input" aria-label="选题数量" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>
        {CONTENT_TOPIC_SIZES.map(value => <option key={value} value={value}>{value} 条</option>)}
      </select>
      <button className="button button-primary" type="submit" disabled={locked || searching}><Icon name="search" />{searching ? '搜索中…' : '搜索热点'}</button>
    </form>
    {result && <div className="xhs-result">
      {result.notice && <p className="xhs-hint xhs-hint-warn"><Icon name="alert" size={14} />{result.notice}</p>}
      <p className="xhs-result-meta">
        <span className={`chip ${result.source === 'redfox' ? 'chip-accent' : ''}`}>{result.source === 'redfox' ? '红狐公众号' : '联网搜索'}</span>
        「{result.keyword}」共 {result.total} 条，显示 {result.notes.length} 条 · {result.cached ? `缓存于 ${shortTime(result.fetchedAt)}` : `查询于 ${shortTime(result.fetchedAt)}`}
        {result.cached && <button className="button button-quiet" type="button" disabled={locked || searching} onClick={() => void search(result.keyword, true)}><Icon name="refresh" />重新查询</button>}
      </p>
      {result.tips && <p className="xhs-hint">{result.tips}</p>}
      {result.notes.length
        ? <ul className="xhs-hot-list">{result.notes.map(note => <WechatTopicSearchRow key={note.id} note={note} adopted={adopted && note.title === task.title} onAdopt={() => adopt(note)} onOpen={() => open(note)} />)}</ul>
        : <p className="flow-empty">没有搜到可用文章。换个关键词，或把时间范围放宽。</p>}
    </div>}
  </section>;
}

export function TopicStep({ task, taxonomy, locked, busy, onEdit, onRun, notify }: {
  task: ContentTask; taxonomy: ContentTaxonomy | null; locked: boolean; busy: string;
  onEdit: (patch: Partial<ContentTask>) => void; onRun: () => void; notify: (message: string) => void;
}) {
  const suggestions = topicSuggestions(task.topicsJson);
  const research = topicResearchMeta(task.topicsJson);
  const directions = taxonomy?.directions ?? [];
  // 分类只在选题这一步可改：换了方向就等于换了一篇要写的东西，后续步骤跟着走。
  const changeDirection = (next: number | null) => onEdit({ directionId: next, subdirectionId: subdirectionsOf(directions, next)[0]?.id ?? null });
  const profile = findDirectionById(directions, task.directionId);
  const subdirection = findSubdirectionById(directions, task.subdirectionId)?.subdirection ?? null;
  return <div className="flow-body">
    <div className="native-task-fields">
      <label><span>选题标题</span><input disabled={locked} value={task.title} onChange={event => onEdit({ title: event.target.value })} placeholder="选题标题" /></label>
      <label><span>内容方向</span>
        <select disabled={locked} value={task.directionId ?? ''} onChange={event => changeDirection(Number(event.target.value) || null)}>
          {directions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label><span>具体方向</span>
        <select disabled={locked} value={task.subdirectionId ?? ''} onChange={event => onEdit({ subdirectionId: Number(event.target.value) || null })}>
          <option value="">未指定</option>
          {subdirectionsOf(directions, task.directionId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label className="native-field-wide"><span>选题方向 / 读者问题</span><input disabled={locked} value={task.topic} onChange={event => onEdit({ topic: event.target.value })} placeholder="描述读者的问题或想解决的需求" /></label>
    </div>
    {!profile || !subdirection
      ? <p className="flow-attention-note">这篇文章还没归到内容方向：先在上面选好「内容方向 / 具体方向」再生成，否则读者定位、语气与禁忌都用不上你改过的资料。</p>
      : <p className="ww-muted">{`将使用「${profile.name}」的资料：读者定位 ${profile.audience || '未填'}｜语气 ${profile.tone || '未填'}｜具体方向 ${subdirection.name}`}</p>}
    <WechatTopicResearch task={task} profile={profile} subdirection={subdirection} locked={locked} onEdit={onEdit} notify={notify} />
    <div className="flow-inline-actions">
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'topics' ? '生成中…' : suggestions.length ? '换一批 AI 选题' : 'AI 结合热点生成 5 个候选选题'}</button>
      <small>生成时会自动检索红狐公众号数据；点选候选会填入标题和方向，之后仍需人工核实事实与来源。</small>
    </div>
    {research && <p className={`xhs-hint ${research.source === 'none' ? 'xhs-hint-warn' : ''}`}>
      <Icon name={research.source === 'redfox' ? 'check' : 'alert'} size={14} />
      {research.source === 'redfox'
        ? `这批候选参考了红狐公众号「${research.keyword}」的 ${research.count} 篇文章${research.cached ? '（本地缓存）' : ''}`
        : research.source === 'web'
          ? `这批候选参考了联网搜索「${research.keyword}」的 ${research.count} 条结果，未使用公众号阅读数据`
          : `这批候选没有拿到实时热点数据${research.notice ? `：${research.notice}` : ''}`}
    </p>}
    {suggestions.length > 0 && <div className="native-topic-options">{suggestions.map(item => <button key={item.title} disabled={locked} className={`native-task ${task.title === item.title ? 'is-selected' : ''}`} onClick={() => onEdit({ title: item.title, topic: item.angle })}>
      <strong>{item.title}</strong><small>{item.angle}</small>{item.risk && <small className="flow-risk">风险提示：{item.risk}</small>}<span>{task.title === item.title ? '已采用' : '采用这个选题'}</span></button>)}</div>}
  </div>;
}

export function JsonStep({ value, empty, labels }: { value: string; empty: string; labels: Record<string, string> }) {
  const data = parseObject(value);
  if (!value.trim()) return <p className="flow-empty">{empty}</p>;
  if (!data) return <pre className="flow-pre">{value}</pre>;
  const keys = [...Object.keys(labels).filter(key => key in data), ...Object.keys(data).filter(key => !(key in labels))];
  return <dl className="flow-fields">{keys.map(key => {
    const items = list(data[key]);
    return <div key={key}><dt>{labels[key] ?? key}</dt><dd>{Array.isArray(data[key]) ? <ol>{items.map((item, index) => <li key={index}>{item}</li>)}</ol> : items[0] || '—'}</dd></div>;
  })}</dl>;
}

export function EvidenceStep({ task, locked, onSources }: { task: ContentTask; locked: boolean; onSources: (items: Source[]) => void }) {
  const sources = readSources(task.sourcesJson);
  const claims = (parseObject(task.claimsJson)?.claims as Array<Record<string, unknown>> | undefined) ?? [];
  const appended = renderEvidenceSection(task);
  const markedCount = sources.filter(source => source.featured).length;
  const featured = new Set(pickFeaturedSources(sources));
  return <div className="flow-body">
    <div className="flow-sub-head"><h4>来源资料（{sources.length}）</h4><button className="button button-quiet" disabled={locked} onClick={() => onSources([...sources, { title: '', url: '', excerpt: '', status: 'user_provided', featured: false }])}>手动补充来源</button></div>
    <p className="ww-muted">生成证据计划时会<b>自动推荐来源</b>（权威机构的指南、共识或科普文件，标「AI 推荐」，不带链接、未联网核实，建议发布前扫一眼），一般不需要手动添加；有更可靠的资料也可以手动补充，重新生成时手动录入的来源会保留。资料变更后需要重新审稿。正文末尾的「来源与证据」只列<b>{FEATURED_SOURCE_LIMIT} 条</b>：勾选「列入正文末尾」来指定，勾选不足 {FEATURED_SOURCE_LIMIT} 条时自动用有链接、有摘录的来源补齐；它会在预览、推送草稿箱时<b>自动追加到正文末尾</b>，不需要手写进正文。导出到知识库的笔记保留全部来源。</p>
    {sources.map((source, index) => <div className="native-source" key={index}>
      <label className="native-source-feature">
        <input type="checkbox" disabled={locked || (!source.featured && markedCount >= FEATURED_SOURCE_LIMIT)} checked={source.featured} onChange={event => onSources(sources.map((item, i) => i === index ? { ...item, featured: event.target.checked } : item))} />
        {source.status === 'ai_suggested' && <span className="status status-pending">AI 推荐</span>}
        <span>列入正文末尾{source.featured ? '' : featured.has(source) ? '（自动补齐）' : markedCount >= FEATURED_SOURCE_LIMIT ? `（已选满 ${FEATURED_SOURCE_LIMIT} 条）` : ''}</span>
      </label>
      <div className="native-task-fields">
        <label><span>来源标题 / 发布方</span><input disabled={locked} value={source.title} onChange={event => onSources(sources.map((item, i) => i === index ? { ...item, title: event.target.value } : item))} /></label>
        <label><span>原文链接</span><input disabled={locked} value={source.url} placeholder="https://" onChange={event => onSources(sources.map((item, i) => i === index ? { ...item, url: event.target.value } : item))} /></label>
      </div>
      <label className="ww-input"><span>与本文主张相关的摘录</span><textarea disabled={locked} value={source.excerpt} onChange={event => onSources(sources.map((item, i) => i === index ? { ...item, excerpt: event.target.value } : item))} /></label>
      <button className="button button-quiet" disabled={locked} onClick={() => onSources(sources.filter((_item, i) => i !== index))}>移除此来源</button>
    </div>)}
    <div className="flow-sub-head"><h4>待核实主张（{claims.length}）</h4></div>
    {claims.length ? <table className="flow-table"><thead><tr><th>主张</th><th>需要的证据</th><th>检索词</th><th>风险</th><th>状态</th></tr></thead><tbody>
      {claims.map((claim, index) => <tr key={index}><td>{text(claim.claim)}</td><td>{text(claim.evidence_needed)}</td><td>{list(claim.search_queries).join('、')}</td><td>{text(claim.risk)}</td><td><span className="status status-pending">待核实</span></td></tr>)}
    </tbody></table> : <p className="flow-empty">还没有证据计划。生成后，模型列出的每条主张都标为「待核实」，需要你对照来源确认。</p>}
    <details className="ww-artifacts"><summary>预览正文末尾的「来源与证据」（{appended ? '已生成' : '暂无内容'}）</summary>
      <pre>{appended || '还没有来源资料：生成证据计划后会自动推荐，这一段目前不会出现在正文末尾。'}</pre>
      <p className="ww-muted">上面是读者会看到的部分；「待核实主张」只在导出到知识库的笔记里保留，不会随文章发出去。</p>
    </details>
  </div>;
}

export function DraftStep({ task, assets, locked, coverLocked, busy, busySeconds, candidateCount, onCandidateCount, onEdit, onTheme, onGenerateImages, onGenerateImagesWithCover, onPickFromLibrary, onSwapImage }: {
  task: ContentTask; assets: ContentAssetBundle | null; locked: boolean; coverLocked: boolean; busy: string; busySeconds: number;
  candidateCount: number; onCandidateCount: (count: number) => void;
  onEdit: (draft: string) => void; onTheme: (theme: string) => void; onGenerateImages: () => void; onGenerateImagesWithCover: () => void;
  onPickFromLibrary: () => void; onSwapImage: (index: number, path: string, expected: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const images = countInlineImages(task.draft);
  const candidates = candidateCount > 1;
  return <div className="flow-body">
    <div className="flow-sub-head"><h4>{preview ? '正文预览（公众号排版）' : '文章正文（Markdown）'}<small>约 {countChars(task.draft)} 字</small></h4>
      <div className="flow-mode"><button className={!preview ? 'is-active' : ''} onClick={() => setPreview(false)}>编辑</button><button className={preview ? 'is-active' : ''} onClick={() => setPreview(true)}>预览</button></div></div>
    {preview ? <ArticlePreview taskId={task.id} source="draft" revision={task.updatedAt} title="文章预览" />
      : <textarea className="flow-draft" disabled={locked} value={task.draft} onChange={event => onEdit(event.target.value)} placeholder="生成初稿后在这里编辑；也可以直接粘贴自己写的正文。改动正文会使之前的审稿结论失效。" />}
    <details className="flow-secondary-tools">
      <summary>排版与配图<small>可选 · 当前 {images} 张正文配图 · 切换排版，或生成 / 替换配图</small></summary>
      <ThemePicker value={task.theme} locked={locked} onPick={theme => { onTheme(theme); setPreview(true); }} />
      <div className="flow-image-toolbar">
        <button className="button button-secondary" disabled={locked || (candidates && coverLocked)} onClick={onGenerateImages}>{busy === 'images' ? `配图中… ${busySeconds}s` : images ? `重新生成正文配图（现有 ${images} 张）` : 'AI 生成正文配图'}</button>
        <button className="button button-quiet" disabled={locked || coverLocked} title="封面与 3 张正文配图一次生成；正文为空时只出封面" onClick={onGenerateImagesWithCover}>{busy === 'images-all' ? `封面与配图生成中… ${busySeconds}s` : '封面 + 正文配图一起生成'}</button>
        <span className="flow-image-toolbar-side">
          <button className="button button-quiet button-small" disabled={locked || coverLocked} title="不打接口、不花钱：把这篇正文以前生成过的配图列出来，挑一张插到对应的小节" onClick={onPickFromLibrary}>从已生成的图里挑</button>
          <CandidateCountField locked={locked || coverLocked} value={candidateCount} onChange={onCandidateCount} />
        </span>
      </div>
      <small className="flow-image-note">按小标题自动挑位置插入配图；导出时图片一起复制到知识库，推送时自动上传到微信。插入配图会改动正文，需要重新审稿。</small>
      <InlineImageGallery taskId={task.id} images={assets?.images ?? []} locked={locked} onSwap={onSwapImage} />
    </details>
  </div>;
}

/** 主题卡片上的色点：取小标题的主色，让人不打开预览也能分清几套排版。 */
function themeAccent(style: string): string {
  return /(?:^|;)color:(#[0-9a-f]{3,8})/i.exec(style)?.[1] ?? '#1a1a1a';
}

/**
 * 公众号排版：选中即保存并切到预览看效果。
 * 排版只影响呈现，不使审稿失效；推送与导出都按这篇文章选的主题渲染。
 */
function ThemePicker({ value, locked, onPick }: { value: string; locked: boolean; onPick: (theme: string) => void }) {
  const current = value || DEFAULT_ARTICLE_THEME;
  return <div className="flow-theme-picker" role="radiogroup" aria-label="公众号排版">
    <span className="flow-theme-picker-label">公众号排版</span>
    {ARTICLE_THEMES.map(theme => <button key={theme.name} type="button" role="radio" aria-checked={theme.name === current}
      className={theme.name === current ? 'is-active' : ''} disabled={locked} title={theme.description}
      onClick={() => { if (theme.name !== current) onPick(theme.name); }}>
      <i style={{ background: themeAccent(theme.h2) }} aria-hidden="true" />
      <strong>{theme.label}</strong>
      <small>{theme.description}</small>
    </button>)}
  </div>;
}

/**
 * 封面与正文配图并排成两张卡片，各管各的按钮：封面走自己的通道，生成封面时正文配图照样能点。
 * 一次生成两种、从图库挑和候选张数会同时动封面和正文，放在下面的工具条里。
 */
export function CoverStep({ task, assets, locked, busy, busySeconds, coverBusy, coverSeconds, candidateCount, onCandidateCount, onChoose, onGenerateCover, onGenerateImages, onGenerateImagesWithCover, onPickFromLibrary, onSwapImage, onIpCover }: {
  task: ContentTask; assets: ContentAssetBundle | null; locked: boolean; busy: string; busySeconds: number;
  coverBusy: string; coverSeconds: number;
  candidateCount: number; onCandidateCount: (count: number) => void;
  onChoose: () => void; onGenerateCover: () => void; onGenerateImages: () => void; onGenerateImagesWithCover: () => void;
  onPickFromLibrary: () => void; onSwapImage: (index: number, path: string, expected: string) => void;
  onIpCover: (input: WechatIpCoverInput) => Promise<{ path: string; thumbnail: string } | null>;
}) {
  const coverLocked = coverBusy !== '';
  const candidates = candidateCount > 1;
  const images = countInlineImages(task.draft);
  const coverRunning = coverBusy === 'cover' || coverBusy === 'images-all';
  const inlineRunning = busy === 'images' || busy === 'images-all';
  return <div className="flow-body">
    <div className="flow-image-board">
      <section className="flow-image-card">
        <header><h4>封面</h4><small>微信草稿的缩略图，横版 2.35:1</small></header>
        <figure className={`flow-image-card-preview ${coverRunning ? 'is-running' : ''}`}>
          {assets?.cover?.thumbnail
            ? <img src={assets.cover.thumbnail} alt="封面预览" />
            : <div className="flow-image-missing">还没有封面图</div>}
          {coverRunning && <span className="flow-image-card-busy">封面生成中… {coverBusy === 'images-all' ? busySeconds : coverSeconds}s</span>}
        </figure>
        <small className="flow-image-card-file" title={task.coverPath}>{task.coverPath ? task.coverPath.split(/[\\/]/).pop() : '未选择封面'}</small>
        <div className="flow-image-card-actions">
          <button className="button button-primary" disabled={coverLocked || (candidates && locked)} onClick={onGenerateCover}>{coverBusy === 'cover' ? `生成中… ${coverSeconds}s` : task.coverPath ? '重新生成封面' : 'AI 生成封面'}</button>
          <button className="button button-secondary" disabled={coverLocked} onClick={onChoose}>选择本地图片</button>
        </div>
      </section>
      <section className="flow-image-card">
        <header><h4>正文配图</h4><small>当前 {images} 张 · 按小标题插进正文，推送时自动上传</small></header>
        <div className={`flow-image-card-preview flow-image-card-strip ${inlineRunning ? 'is-running' : ''}`}>
          {assets?.images.length
            ? assets.images.slice(0, 3).map((image, index) => image.thumbnail
              ? <img key={`${image.path}-${index}`} src={image.thumbnail} alt={image.caption || `正文配图 ${index + 1}`} />
              : <div key={`${image.path}-${index}`} className="flow-image-missing">图片不可用</div>)
            : <div className="flow-image-missing">{task.draft.trim() ? '还没有正文配图' : '先写好正文，再生成配图'}</div>}
          {inlineRunning && <span className="flow-image-card-busy">配图生成中… {busySeconds}s</span>}
        </div>
        <small className="flow-image-card-file">插入配图会改动正文，需要重新审稿</small>
        <div className="flow-image-card-actions">
          <button className="button button-primary" disabled={locked || (candidates && coverLocked) || !task.draft.trim()} onClick={onGenerateImages}>{busy === 'images' ? `配图中… ${busySeconds}s` : images ? '重新生成正文配图' : 'AI 生成正文配图'}</button>
        </div>
      </section>
    </div>
    <div className="flow-image-toolbar">
      <button className="button button-secondary" disabled={locked || coverLocked} title="封面与 3 张正文配图一次生成；正文为空时只出封面" onClick={onGenerateImagesWithCover}>{busy === 'images-all' ? `封面与配图生成中… ${busySeconds}s` : '封面 + 正文配图一起生成'}</button>
      <span className="flow-image-toolbar-side">
        <button className="button button-quiet button-small" disabled={locked || coverLocked} title="不打接口、不花钱：把这篇任务以前生成过的封面与配图列出来，挑一张换上" onClick={onPickFromLibrary}>从已生成的图里挑</button>
        <CandidateCountField locked={locked || coverLocked} value={candidateCount} onChange={onCandidateCount} />
      </span>
    </div>
    <small className="flow-image-note">封面和正文配图可以同时生成，各按一次生图计费；选 2–3 张候选时会先出候选再挑，这时两边一起占用。</small>
    <WechatIpCoverPanel task={task} locked={coverLocked} busy={coverBusy === 'ip-cover'} onRender={onIpCover} />
    <InlineImageGallery taskId={task.id} images={assets?.images ?? []} locked={locked} onSwap={onSwapImage} />
  </div>;
}

/**
 * 候选张数：1 张＝沿用「生成即插入」；2–3 张则先生成候选，由用户在候选面板里挑一张再落库。
 * 每张都按生图接口计费，所以默认 1 张，多出几张由用户自己决定。
 */
function CandidateCountField({ locked, value, onChange }: { locked: boolean; value: number; onChange: (count: number) => void }) {
  return <label className="flow-candidate-count"><span>每处出几张</span>
    <select disabled={locked} value={value} title="选 2–3 张时先生成候选，挑好再插入；每张都会消耗一次生图费用" onChange={event => onChange(Number(event.target.value))}>
      <option value={1}>1 张（生成即插入）</option>
      <option value={2}>2 张候选</option>
      <option value={3}>3 张候选</option>
    </select>
  </label>;
}

/**
 * 候选图面板：每处列出这次生成的所有候选，用户挑一张（默认第一张）再点采用。
 * 只有点「采用」才会写进正文或封面，候选本身不落库。
 */
export function ImageCandidatePicker({ bundle, busy, onApply, onDiscard }: {
  bundle: ImageCandidateBundle; busy: string;
  onApply: (picks: Array<{ key: string; path: string }>) => void;
  onDiscard: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  // 换一次生成结果就重新按第一张默认选中，避免沿用上一批的路径。
  useEffect(() => { setPicked({}); }, [bundle]);
  const chosen = (group: ImageCandidateGroup) => picked[group.key] ?? group.options[0]?.path ?? '';
  const picks = bundle.groups.map(group => ({ key: group.key, path: chosen(group) })).filter(pick => pick.path);
  const total = bundle.groups.reduce((sum, group) => sum + group.options.length, 0);
  const newCount = bundle.groups.reduce((sum, group) => sum + group.options.filter(option => option.origin === 'new').length, 0);
  const historyCount = total - newCount;
  return <section className="flow-candidates">
    <div className="flow-sub-head"><h4>挑一张再采用<small>{bundle.groups.length} 处 · 可选 {total} 张{historyCount ? `（其中以前生成 ${historyCount} 张）` : ''}</small></h4></div>
    <p className="ww-muted">选中的图才会写进文章或作为封面；同一位置再挑一张会把原来那张换掉。「以前生成」是这篇文章之前出过的图，可以反复挑，不会再花一次生图费用。</p>
    {bundle.groups.map(group => {
      const fresh = group.options.filter(option => option.origin === 'new');
      const history = group.options.filter(option => option.origin === 'history');
      const render = (option: ImageCandidateOption, label: string) => <button key={option.path} type="button" disabled={busy !== ''}
        className={chosen(group) === option.path ? 'is-picked' : ''}
        title={`用这一张（${label}）`}
        onClick={() => setPicked(current => ({ ...current, [group.key]: option.path }))}>
        {option.thumbnail ? <img src={option.thumbnail} alt={`${group.label} ${label}`} /> : <span className="flow-image-missing">图片不可用</span>}
        <span>{chosen(group) === option.path ? `已选 ${label}` : label}</span>
      </button>;
      return <div className="flow-candidate-group" key={group.key}>
        <div className="flow-candidate-head"><strong>{group.label}</strong>{group.excerpt && <small>{group.excerpt}</small>}</div>
        <div className="flow-candidate-options">
          {fresh.map((option, index) => render(option, `本次第 ${index + 1} 张`))}
        </div>
        {history.length > 0 && <>
          <small className="flow-candidate-history-label">{fresh.length ? '以前生成的图' : '以前生成的图（这次没有新生成）'}</small>
          <div className="flow-candidate-options is-history">
            {history.map((option, index) => render(option, `以前第 ${index + 1} 张`))}
          </div>
        </>}
      </div>;
    })}
    {bundle.warning && <p className="flow-attention-note">{bundle.warning}</p>}
    <div className="flow-inline-actions">
      <button className="button button-primary" disabled={busy !== '' || !picks.length} onClick={() => onApply(picks)}>
        {busy === 'images-apply' ? '采用中…' : `采用选中的 ${picks.length} 张`}
      </button>
      <button className="button button-quiet" disabled={busy !== ''} onClick={onDiscard}>放弃候选</button>
      <small>正文配图插进正文后，旧的审稿结论与成稿会失效，需要重新审稿。</small>
    </div>
  </section>;
}

/** 本地路径比较：Windows 下大小写与分隔符不一致也算同一张。 */
const samePath = (left: string, right: string) => left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();

/**
 * 正文配图的缩略图墙：生成后立刻能看到效果，不用去正文里找路径。
 * 传了 onSwap 时每张图可以单独「换一张」：从这篇文章生成过的配图里挑，不重新生成、不花钱。
 */
export function InlineImageGallery({ taskId, images, locked = false, onSwap }: {
  taskId?: number; images: ContentAssetView[]; locked?: boolean;
  onSwap?: (index: number, path: string, expected: string) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [options, setOptions] = useState<ImageCandidateOption[] | null>(null);
  const [error, setError] = useState('');
  // 换文章或正文里的图变了，正在挑的位置就不再可信。
  const signature = images.map(image => image.path).join('\n');
  useEffect(() => { setEditing(null); }, [taskId, signature]);
  useEffect(() => {
    if (editing === null || !taskId) return;
    let alive = true;
    setOptions(null);
    setError('');
    void window.sydney.listContentImageHistory(taskId)
      .then(result => { if (alive) setOptions(result.inline); })
      .catch(issue => { if (alive) setError(readableError(issue)); });
    return () => { alive = false; };
  }, [editing, taskId]);
  if (!images.length) return null;
  const swappable = Boolean(onSwap && taskId);
  const current = editing === null ? null : images[editing];
  return <>
    <div className="flow-gallery">
      {images.map((image, index) => <figure key={`${image.path}-${index}`} className={editing === index ? 'is-editing' : ''}>
        {image.thumbnail
          ? <img src={image.thumbnail} alt={image.caption || `正文配图 ${index + 1}`} />
          : <div className="flow-image-missing">图片不可用</div>}
        <figcaption>{image.caption || `正文配图 ${index + 1}`}</figcaption>
        {swappable && <button type="button" className="button button-quiet button-small" disabled={locked}
          title="从这篇文章生成过的配图里挑一张换上，不重新生成"
          onClick={() => setEditing(editing === index ? null : index)}>{editing === index ? '收起' : '换一张'}</button>}
      </figure>)}
    </div>
    {swappable && current && editing !== null && <section className="flow-candidates">
      <div className="flow-sub-head"><h4>第 {editing + 1} 张配图换成哪张<small>{current.caption}</small></h4></div>
      {error ? <p className="flow-attention-note">{error}</p>
        : !options ? <p className="ww-muted">正在载入已生成的图…</p>
        : !options.length ? <p className="ww-muted">这篇文章还没有其它生成过的配图，先点「AI 生成正文配图」（可选 2–3 张候选）再来挑。</p>
        : <div className="flow-candidate-options">
          {options.map((option, index) => {
            const inUse = samePath(option.path, current.path);
            return <button key={option.path} type="button" disabled={locked || inUse} className={inUse ? 'is-picked' : ''}
              title={inUse ? '正在用的就是这张' : '换成这一张'}
              onClick={() => { onSwap?.(editing, option.path, current.path); setEditing(null); }}>
              {option.thumbnail ? <img src={option.thumbnail} alt={`已生成配图 ${index + 1}`} /> : <span className="flow-image-missing">图片不可用</span>}
              <span>{inUse ? '当前使用' : images.some(image => samePath(image.path, option.path)) ? '文中其它位置在用' : `第 ${index + 1} 张`}</span>
            </button>;
          })}
        </div>}
      <div className="flow-inline-actions">
        <button className="button button-quiet" onClick={() => setEditing(null)}>取消</button>
        <small>换图会改动正文，旧的审稿结论与成稿会失效，需要重新审稿。</small>
      </div>
    </section>}
  </>;
}

/** 封面和配图都由主进程生成缩略图，任务或内容变动后自动重新拉取。 */
export function useContentAssets(taskId: number, revision: string): ContentAssetBundle | null {
  const [assets, setAssets] = useState<ContentAssetBundle | null>(null);
  useEffect(() => {
    if (!taskId) { setAssets(null); return; }
    let alive = true;
    void window.sydney.getContentAssets(taskId)
      .then(next => { if (alive) setAssets(next); })
      .catch(() => { if (alive) setAssets(null); });
    return () => { alive = false; };
  }, [taskId, revision]);
  return assets;
}

/** 预览必须由主进程渲染：渲染进程读不到本地配图文件。 */
export function ArticlePreview({ taskId, source, revision, title }: { taskId: number; source: 'draft' | 'final'; revision: string; title: string }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void window.sydney.renderContentPreview(taskId, source)
      .then(result => { if (alive) { setHtml(result.html); setError(''); } })
      .catch(issue => { if (alive) setError(readableError(issue)); });
    return () => { alive = false; };
  }, [taskId, source, revision]);
  if (error) return <p className="flow-empty">{error}</p>;
  /**
   * 这里不能用 sandbox=""：当前 Electron/Chromium 下空 sandbox 会让 srcdoc 帧根本不加载，
   * 预览就只剩一块空白（主进程其实已经把 HTML 渲染好了）。
   * 只放开 allow-same-origin、不给 allow-scripts，模型产出的正文依旧不能执行脚本。
   */
  return <iframe className="flow-preview" title={title} sandbox="allow-same-origin" srcDoc={wrapPreviewHtml(html)} />;
}

export function ReviewStep({ task, locked, busy, onRevise }: { task: ContentTask; locked: boolean; busy: string; onRevise: () => void }) {
  const review = parseObject(task.reviewJson);
  if (!review) return <p className="flow-empty">还没有审稿结论。审稿检查表达、逻辑和健康风险；存在待核实的关键健康主张时不会给出「通过」。</p>;
  const decision = String(review.decision ?? '');
  const decisionText: Record<string, string> = { pass: '通过', revise: '需修改', reject: '不通过' };
  const scores = [['准确性', review.accuracy_score], ['实用性', review.usefulness_score], ['可读性', review.readability_score]] as const;
  const groups = [['必须修改', review.required_changes], ['健康风险', review.health_risks], ['缺乏依据的主张', review.unsupported_claims]] as const;
  return <div className="flow-body">
    <div className="flow-review-head">
      <span className={`flow-decision flow-decision-${decision}`}>{decisionText[decision] ?? (decision || '未知')}</span>
      {scores.map(([label, value]) => <span key={label} className="flow-score"><b>{text(value) || '—'}</b>{label}</span>)}
      <span className="flow-spacer" />
      <button className="button button-primary" disabled={locked || decision === 'pass'} title="把上面的审稿意见逐条交给内容 API，让它改出一版新初稿；改完需要重新审稿" onClick={onRevise}>{busy === 'revise' ? '修改中…' : '按审稿意见修改正文'}</button>
    </div>
    {review.summary !== undefined && <p className="flow-summary">{text(review.summary)}</p>}
    {groups.map(([label, value]) => { const items = list(value); return items.length ? <div key={label} className="flow-issue-group"><h4>{label}（{items.length}）</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null; })}
    {decision !== 'pass' && <p className="ww-muted">点「按审稿意见修改正文」会在初稿基础上按上面三条意见重写一版并替换初稿；新初稿需要重新审稿。若你已经手动改好，也可以直接去「来源与证据」之后的发布步骤导出或推送草稿箱。</p>}
  </div>;
}

export function PublishStep({ task, env }: { task: ContentTask; env: Env }) {
  const checklist = publishChecklist(task, env);
  return <div className="flow-body">
    <ul className="flow-checklist">{checklist.map(item => <li key={item.label} className={item.ok ? 'is-ok' : 'is-missing'}><span aria-hidden="true">{item.ok ? '✓' : '○'}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></li>)}</ul>
    <p className="ww-muted">只要正文存在就可以导出或推送草稿箱，不必先通过审稿；未通过审稿时会弹窗列出待处理的问题让你确认。推送只创建草稿、不会群发，仍需封面与公众号凭证。</p>
    {task.exportPath && <p className="native-export-path">最近导出：{task.exportPath}</p>}
    {task.publishJson && <details className="native-json"><summary>草稿推送记录</summary><pre>{task.publishJson}</pre></details>}
    {(task.finalArticle.trim() || task.draft.trim()) && <ArticlePreview taskId={task.id} source="final" revision={task.updatedAt} title="成稿预览" />}
  </div>;
}
