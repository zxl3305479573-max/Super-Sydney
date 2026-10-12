import { useEffect, useState } from 'react';
import type { ContentAssetBundle, ContentAssetView, ContentTask, ContentTaxonomy } from '../../shared';
import { countInlineImages } from '../../services/content-images';
import { PIPELINE_STEPS, buildPipeline, currentStepKey, publishChecklist, type PipelineStep, type PipelineStepKey } from '../../services/content-pipeline';
import { subdirectionsOf, taskScopeLabel } from '../content-taxonomy';
import { readableError } from '../ui';
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
  return <div className="flow-body">
    <div className="flow-sub-head"><h4>来源资料（{sources.length}）</h4><button className="button button-secondary" disabled={locked} onClick={() => onSources([...sources, { title: '', url: '', excerpt: '', status: 'user_provided' }])}>添加来源</button></div>
    <p className="ww-muted">填写原文链接、发布方/标题和支持主张的摘录。这里只保存你提供的材料，不会自动联网核实；资料变更后需要重新审稿。</p>
    {sources.map((source, index) => <div className="native-source" key={index}>
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
  </div>;
}

export function DraftStep({ task, assets, locked, busy, busySeconds, onEdit, onGenerateImages, onGenerateImagesWithCover }: { task: ContentTask; assets: ContentAssetBundle | null; locked: boolean; busy: string; busySeconds: number; onEdit: (draft: string) => void; onGenerateImages: () => void; onGenerateImagesWithCover: () => void }) {
  const [preview, setPreview] = useState(false);
  const images = countInlineImages(task.draft);
  return <div className="flow-body">
    <div className="flow-sub-head"><h4>{preview ? '正文预览（公众号排版）' : '文章正文（Markdown）'}<small>约 {countChars(task.draft)} 字</small></h4>
      <div className="flow-mode"><button className={!preview ? 'is-active' : ''} onClick={() => setPreview(false)}>编辑</button><button className={preview ? 'is-active' : ''} onClick={() => setPreview(true)}>预览</button></div></div>
    <div className="flow-inline-actions">
      <button className="button button-secondary" disabled={locked} onClick={onGenerateImages}>{busy === 'images' ? `配图中… ${busySeconds}s` : images ? `重新生成正文配图（现有 ${images} 张）` : 'AI 生成正文配图'}</button>
      <button className="button button-secondary" disabled={locked} title="封面与 3 张正文配图一次生成；正文为空时只出封面" onClick={onGenerateImagesWithCover}>{busy === 'images-all' ? `封面与配图生成中… ${busySeconds}s` : 'AI 生成封面 + 正文配图'}</button>
      <small>按小标题自动挑位置插入配图；导出时图片一起复制到知识库，推送时自动上传到微信。插入配图会改动正文，需要重新审稿。</small>
    </div>
    <InlineImageGallery images={assets?.images ?? []} />
    {preview ? <ArticlePreview taskId={task.id} source="draft" revision={task.updatedAt} title="文章预览" />
      : <textarea className="flow-draft" disabled={locked} value={task.draft} onChange={event => onEdit(event.target.value)} placeholder="生成初稿后在这里编辑；也可以直接粘贴自己写的正文。改动正文会使之前的审稿结论失效。" />}
  </div>;
}

export function CoverStep({ task, assets, locked, busy, busySeconds, onChoose, onGenerateCover, onGenerateImages, onGenerateImagesWithCover }: {
  task: ContentTask; assets: ContentAssetBundle | null; locked: boolean; busy: string; busySeconds: number;
  onChoose: () => void; onGenerateCover: () => void; onGenerateImages: () => void; onGenerateImagesWithCover: () => void;
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
        <small>封面是微信草稿的缩略图；正文配图按小标题插进正文，推送时会自动上传到微信。一次生成会同时消耗封面与配图的费用。</small>
      </div>
    </div>
    <InlineImageGallery images={assets?.images ?? []} />
  </div>;
}

/** 正文配图的缩略图墙：生成后立刻能看到效果，不用去正文里找路径。 */
export function InlineImageGallery({ images }: { images: ContentAssetView[] }) {
  if (!images.length) return null;
  return <div className="flow-gallery">
    {images.map((image, index) => <figure key={`${image.path}-${index}`}>
      {image.thumbnail
        ? <img src={image.thumbnail} alt={image.caption || `正文配图 ${index + 1}`} />
        : <div className="flow-image-missing">图片不可用</div>}
      <figcaption>{image.caption || `正文配图 ${index + 1}`}</figcaption>
    </figure>)}
  </div>;
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
  return <iframe className="flow-preview" title={title} sandbox="" srcDoc={wrapPreviewHtml(html)} />;
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
