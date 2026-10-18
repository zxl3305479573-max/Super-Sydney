import { useEffect, useState } from 'react';
import type { ContentAssetBundle, ContentAssetView, ContentTask, ContentTaxonomy, ImageCandidateBundle, ImageCandidateGroup, ImageCandidateOption, WechatIpCoverInput } from '../../shared';
import { ARTICLE_THEMES, DEFAULT_ARTICLE_THEME } from '../../services/article-html';
import { countInlineImages } from '../../services/content-images';
import { renderEvidenceSection } from '../../services/evidence-section';
import { FEATURED_SOURCE_LIMIT, pickFeaturedSources } from '../../services/content-sources';
import { PIPELINE_STEPS, buildPipeline, currentStepKey, publishChecklist, type PipelineStep, type PipelineStepKey } from '../../services/content-pipeline';
import { findDirectionById, findSubdirectionById, subdirectionsOf, taskScopeLabel } from '../content-taxonomy';
import { readableError } from '../ui';
import { WechatIpCoverPanel } from './IpCoverPanel';
import { countChars, list, parseObject, readSources, stateNames, text, topicSuggestions, wrapPreviewHtml, type Env, type Source } from './format';

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

export function TopicStep({ task, taxonomy, locked, busy, onEdit, onRun }: { task: ContentTask; taxonomy: ContentTaxonomy | null; locked: boolean; busy: string; onEdit: (patch: Partial<ContentTask>) => void; onRun: () => void }) {
  const suggestions = topicSuggestions(task.topicsJson);
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
    <div className="flow-inline-actions"><button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'topics' ? '生成中…' : suggestions.length ? '换一批 AI 选题' : 'AI 生成 5 个候选选题'}</button><small>点选候选会填入标题和方向；选好标题后点右上角「自动生成」，可一次跑完任务书 → 证据计划 → 初稿 → AI 审稿。</small></div>
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

export function DraftStep({ task, assets, locked, busy, busySeconds, candidateCount, onCandidateCount, onEdit, onTheme, onGenerateImages, onGenerateImagesWithCover, onPickFromLibrary, onSwapImage }: {
  task: ContentTask; assets: ContentAssetBundle | null; locked: boolean; busy: string; busySeconds: number;
  candidateCount: number; onCandidateCount: (count: number) => void;
  onEdit: (draft: string) => void; onTheme: (theme: string) => void; onGenerateImages: () => void; onGenerateImagesWithCover: () => void;
  onPickFromLibrary: () => void; onSwapImage: (index: number, path: string, expected: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const images = countInlineImages(task.draft);
  return <div className="flow-body">
    <div className="flow-sub-head"><h4>{preview ? '正文预览（公众号排版）' : '文章正文（Markdown）'}<small>约 {countChars(task.draft)} 字</small></h4>
      <div className="flow-mode"><button className={!preview ? 'is-active' : ''} onClick={() => setPreview(false)}>编辑</button><button className={preview ? 'is-active' : ''} onClick={() => setPreview(true)}>预览</button></div></div>
    <ThemePicker value={task.theme} locked={locked} onPick={theme => { onTheme(theme); setPreview(true); }} />
    <div className="flow-inline-actions">
      <button className="button button-secondary" disabled={locked} onClick={onGenerateImages}>{busy === 'images' ? `配图中… ${busySeconds}s` : images ? `重新生成正文配图（现有 ${images} 张）` : 'AI 生成正文配图'}</button>
      <button className="button button-secondary" disabled={locked} title="封面与 3 张正文配图一次生成；正文为空时只出封面" onClick={onGenerateImagesWithCover}>{busy === 'images-all' ? `封面与配图生成中… ${busySeconds}s` : 'AI 生成封面 + 正文配图'}</button>
      <button className="button button-quiet button-small" disabled={locked} title="不打接口、不花钱：把这篇正文以前生成过的配图列出来，挑一张插到对应的小节" onClick={onPickFromLibrary}>从已生成的图里挑</button>
      <CandidateCountField locked={locked} value={candidateCount} onChange={onCandidateCount} />
      <small>按小标题自动挑位置插入配图；导出时图片一起复制到知识库，推送时自动上传到微信。插入配图会改动正文，需要重新审稿。</small>
    </div>
    <InlineImageGallery taskId={task.id} images={assets?.images ?? []} locked={locked} onSwap={onSwapImage} />
    {preview ? <ArticlePreview taskId={task.id} source="draft" revision={task.updatedAt} title="文章预览" />
      : <textarea className="flow-draft" disabled={locked} value={task.draft} onChange={event => onEdit(event.target.value)} placeholder="生成初稿后在这里编辑；也可以直接粘贴自己写的正文。改动正文会使之前的审稿结论失效。" />}
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

export function CoverStep({ task, assets, locked, busy, busySeconds, candidateCount, onCandidateCount, onChoose, onGenerateCover, onGenerateImages, onGenerateImagesWithCover, onPickFromLibrary, onSwapImage, onIpCover }: {
  task: ContentTask; assets: ContentAssetBundle | null; locked: boolean; busy: string; busySeconds: number;
  candidateCount: number; onCandidateCount: (count: number) => void;
  onChoose: () => void; onGenerateCover: () => void; onGenerateImages: () => void; onGenerateImagesWithCover: () => void;
  onPickFromLibrary: () => void; onSwapImage: (index: number, path: string, expected: string) => void;
  onIpCover: (input: WechatIpCoverInput) => Promise<{ path: string; thumbnail: string } | null>;
}) {
  return <div className="flow-body">
    <div className="flow-cover">
      <figure className="flow-cover-figure">
        {assets?.cover?.thumbnail
          ? <img src={assets.cover.thumbnail} alt="封面预览" />
          : <div className="flow-image-missing">还没有封面图</div>}
        <figcaption>{task.coverPath ? task.coverPath.split(/[\\/]/).pop() : '未选择封面'}</figcaption>
      </figure>
      <div className="flow-cover-actions">
        <button className="button button-secondary" disabled={locked} onClick={onChoose}>选择本地图片</button>
        <button className="button button-secondary" disabled={locked} onClick={onGenerateCover}>{busy === 'cover' ? `生成中… ${busySeconds}s` : 'AI 生成封面'}</button>
        <button className="button button-primary" disabled={locked} title="封面与 3 张正文配图一次生成；正文为空时只出封面" onClick={onGenerateImagesWithCover}>{busy === 'images-all' ? `封面与配图生成中… ${busySeconds}s` : 'AI 生成封面 + 正文配图'}</button>
        <button className="button button-secondary" disabled={locked} onClick={onGenerateImages}>{busy === 'images' ? `配图中… ${busySeconds}s` : '只生成正文配图'}</button>
        <button className="button button-quiet button-small" disabled={locked} title="不打接口、不花钱：把这篇任务以前生成过的封面与配图列出来，挑一张换上" onClick={onPickFromLibrary}>从已生成的图里挑</button>
        <CandidateCountField locked={locked} value={candidateCount} onChange={onCandidateCount} />
        <small>封面是微信草稿的缩略图；正文配图按小标题插进正文，推送时会自动上传到微信。一次生成会同时消耗封面与配图的费用。</small>
      </div>
    </div>
    <WechatIpCoverPanel task={task} locked={locked} busy={busy === 'ip-cover'} onRender={onIpCover} />
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
