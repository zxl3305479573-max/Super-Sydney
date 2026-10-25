import { useEffect, useMemo, useState } from 'react';
import type { XhsBasis, XhsCandidateView, XhsCardPlan, XhsIpCoverInput, XhsNote, XhsNoteAssets, XhsNoteType } from '../../shared';
import {
  XHS_BODY_LIMIT, XHS_CARD_STYLES, XHS_CHECKS, XHS_NOTE_TYPES, XHS_PAGE_COUNTS, XHS_TITLE_LIMIT, XHS_TITLE_METHODS, XHS_TITLE_ROLES
} from '../../services/xhs-catalog';
import { renderCardsPreview } from '../../services/xhs-cards';
import {
  countChars, readCardPlan, readCheckReport, readImages, readTags, readTitleWorkshop, readWriterMeta, xhsExportChecklist, xhsPackageImagePaths, type XhsStep
} from '../../services/xhs-pipeline';
import { ConfirmButton, Icon, TagEditor } from '../ui';
import { ScoreBar, sourceOf } from './common';
import { IpCoverPanel } from './IpCoverPanel';
import { IpPicker, useIpKit, useIpLibrary } from '../IpLibrary';

/** 小红书笔记流水线的各步骤面板：只负责展示与收集输入，动作由 NotesTab 传入。 */

export const stateNames: Record<XhsStep['state'], string> = { done: '已完成', current: '当前步骤', attention: '需处理', ready: '可进行', locked: '未解锁' };

export function Stepper({ steps, active, onSelect }: { steps: XhsStep[]; active: string; onSelect: (key: XhsStep['key']) => void }) {
  return <ol className="flow-stepper" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="小红书笔记流程">
    {steps.map(item => <li key={item.key} className={`flow-node flow-node-${item.state} ${active === item.key ? 'is-active' : ''}`}>
      <button onClick={() => onSelect(item.key)} aria-current={active === item.key ? 'step' : undefined} title={item.reason || item.hint}>
        <span className="flow-dot">{item.state === 'done' ? '✓' : item.state === 'attention' ? '!' : item.index}</span>
        <span className="flow-node-label">{item.label}</span>
        <small>{stateNames[item.state]}</small>
      </button>
    </li>)}
  </ol>;
}

type Common = { note: XhsNote; locked: boolean; busy: string };

function Counter({ value, limit }: { value: number; limit: number }) {
  return <span className={`xhs-counter ${value > limit ? 'is-over' : ''}`}>{value}/{limit}</span>;
}

function ConfirmStale({ text, onConfirm, locked }: { text: string; onConfirm: () => void; locked: boolean }) {
  return <p className="flow-attention-note xhs-stale">{text}<button className="button button-quiet" disabled={locked} onClick={onConfirm}>仍然可用，确认</button></p>;
}

export function TopicStep({ note, locked, onEdit }: Common & { onEdit: (patch: Partial<XhsNote>) => void }) {
  const source = sourceOf(note);
  const type = XHS_NOTE_TYPES.find(item => item.value === note.noteType);
  return <div className="flow-body">
    <div className="native-task-fields">
      <label className="native-field-wide"><span>选题</span><input disabled={locked} value={note.topic} onChange={event => onEdit({ topic: event.target.value })} placeholder="这篇笔记要解决读者的什么问题" /></label>
      <label><span>笔记类型</span><select disabled={locked} value={note.noteType} onChange={event => onEdit({ noteType: event.target.value as XhsNoteType })}>{XHS_NOTE_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <div className="xhs-type-hint"><span>结构</span><p>{type?.structure}</p></div>
    </div>
    <label className="xhs-field"><span>你的经验与素材（推荐填写）</span>
      <textarea className="input xhs-textarea" rows={6} disabled={locked} value={note.material} onChange={event => onEdit({ material: event.target.value })}
        placeholder="写下你自己的经历、做法、踩过的坑、具体数字。正文只会基于这里写「亲身经历」；不填就按科普 / 整理的口吻写，不会编造亲测。" />
    </label>
    {source && <p className="xhs-hint">选题来源：{source.title}{source.unverified ? '（联网搜索，热度未知）' : source.interactive ? ` · ${source.interactive} 互动` : ''}</p>}
    <p className="xhs-hint">填好选题和素材后，可以点右上角「自动生成」一次完成正文、标题与发布前检测；当前修改会先自动保存。</p>
  </div>;
}

export function BodyStep({ note, locked, busy, stale, onEdit, onRun, onConfirm }: Common & { stale: boolean; onEdit: (patch: Partial<XhsNote>) => void; onRun: () => void; onConfirm: (key: keyof XhsBasis) => void }) {
  const meta = readWriterMeta(note);
  const tags = readTags(note);
  const length = countChars(note.body);
  return <div className="flow-body">
    {stale && <ConfirmStale text="笔记类型改过，正文还是按旧类型的结构写的。" locked={locked} onConfirm={() => onConfirm('body')} />}
    <div className="flow-sub-head">
      <h4>正文<small>{length} 字 · 小红书上限 {XHS_BODY_LIMIT} 字</small><Counter value={length} limit={XHS_BODY_LIMIT} /></h4>
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'body' ? '写作中…' : note.body.trim() ? '重新写正文' : 'AI 写正文'}</button>
    </div>
    <textarea className="flow-draft xhs-body" disabled={locked} value={note.body} onChange={event => onEdit({ body: event.target.value })}
      placeholder="生成后在这里改；也可以直接写。前 3 行是开头，要让人想继续看；结尾留一个好回答的互动问题。" />
    <div className="xhs-field"><span>标签（{tags.length} 个，建议 3–10 个，不带 #）</span>
      <TagEditor values={tags} onChange={values => onEdit({ tagsJson: JSON.stringify(values) })} placeholder="输入标签后回车" />
    </div>
    {meta && (meta.opening.length > 0 || meta.outline.length > 0) && <dl className="flow-fields">
      {meta.opening.length > 0 && <div><dt>开头 3 行</dt><dd><ol>{meta.opening.map(line => <li key={line}>{line}</li>)}</ol></dd></div>}
      {meta.outline.length > 0 && <div><dt>分段骨架</dt><dd><ol>{meta.outline.map(line => <li key={line}>{line}</li>)}</ol></dd></div>}
      {meta.interaction && <div><dt>结尾互动</dt><dd>{meta.interaction}</dd></div>}
    </dl>}
  </div>;
}

export function TitleStep({ note, locked, busy, stale, onEdit, onRun, onConfirm }: Common & { stale: boolean; onEdit: (patch: Partial<XhsNote>) => void; onRun: () => void; onConfirm: (key: keyof XhsBasis) => void }) {
  const workshop = readTitleWorkshop(note);
  const length = countChars(note.title);
  return <div className="flow-body">
    {stale && <ConfirmStale text="正文改过，选定的标题可能不再贴合。" locked={locked} onConfirm={() => onConfirm('title')} />}
    <div className="native-task-fields">
      <label className="native-field-wide"><span>选定的标题 <Counter value={length} limit={XHS_TITLE_LIMIT} /></span><input disabled={locked} value={note.title} onChange={event => onEdit({ title: event.target.value })} placeholder="从下面的候选里采用一个，或自己写" /></label>
    </div>
    <div className="flow-sub-head">
      <h4>标题工坊<small>15 种方法各出 1 个候选，逐条评分（搜索词 / 人群 / 收藏 / 钩子，各 5 分）</small></h4>
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'titles' ? '生成中…' : workshop ? '重新出一批' : 'AI 出 15 个候选'}</button>
    </div>
    {workshop ? <>
      {workshop.keywords.length > 0 && <div className="xhs-chip-row"><span className="xhs-chip-label">搜索关键词</span>{workshop.keywords.map(word => <span key={word} className="chip chip-soft">{word}</span>)}</div>}
      <table className="flow-table xhs-title-table"><thead><tr><th>候选</th><th>方法</th><th>评分</th><th>风险</th><th /></tr></thead><tbody>
        {workshop.candidates.map(item => <tr key={item.title} className={note.title === item.title ? 'is-picked' : ''}>
          <td><strong>{item.title}</strong><span className={`xhs-role xhs-role-${item.role}`}>{XHS_TITLE_ROLES[item.role]}</span>{item.reason && <small>{item.reason}</small>}</td>
          <td>{item.method}</td>
          <td className="xhs-scores">
            <b>{item.total}</b><small>/20</small>
            {(['search', 'audience', 'save', 'hook'] as const).map(key => <span key={key} title={{ search: '搜索词覆盖', audience: '人群指向', save: '收藏动机', hook: '点击钩子' }[key]}>{{ search: '搜', audience: '人', save: '藏', hook: '钩' }[key]}<ScoreBar value={item.scores[key]} max={5} /></span>)}
          </td>
          <td>{item.risks.length ? <ul className="xhs-risks">{item.risks.map(risk => <li key={risk}>{risk}</li>)}</ul> : <small className="ww-muted">无</small>}</td>
          <td><button className="button button-secondary" disabled={locked || note.title === item.title} onClick={() => onEdit({ title: item.title })}>{note.title === item.title ? '已采用' : '采用'}</button></td>
        </tr>)}
      </tbody></table>
      {workshop.ab.length > 0 && <div className="xhs-ab"><h4>A/B 测试建议</h4>{workshop.ab.map(item => <div key={`${item.a}|${item.b}`}>
        <p><span className="chip">A</span>{item.a}</p><p><span className="chip">B</span>{item.b}</p>
        <small>变量：{item.variable || '—'}；做法：{item.how || '—'}</small>
      </div>)}</div>}
    </> : <p className="flow-empty">标题要基于已经写成的正文做搜索词覆盖与收藏动机，所以放在正文之后。方法：{XHS_TITLE_METHODS.map(item => item.label).join('、')}。</p>}
  </div>;
}

function CoverPreview({ assets, title }: { assets: XhsNoteAssets | null; title: string }) {
  const fallback = assets?.cover ? null : assets?.images[0] ?? null;
  const preview = assets?.cover?.thumbnail || fallback?.thumbnail || '';
  const label = assets?.cover ? '3:4 封面' : fallback ? '封面使用图组第 1 张' : '还没有封面';
  return <div className="xhs-cover-preview">
    <figure className="xhs-cover-large">{preview ? <img src={preview} alt="封面" /> : <div className="flow-image-missing">还没有封面</div>}<figcaption>{label}</figcaption></figure>
    <figure className="xhs-feed-card" title="手机信息流里的大小（约 170 像素宽）">
      {preview ? <img src={preview} alt="信息流预览" /> : <div className="flow-image-missing">—</div>}
      <figcaption>{title || '标题'}</figcaption>
      <small>信息流预览：这么小还看得清吗？</small>
    </figure>
  </div>;
}

export function VisualStep({ note, locked, busy, assets, coverStale, cardsStale, ipId, onSelectIp, onEdit, onCover, onChooseCover, onIpCover, onCards, onRenderCards, onInfo, onCancel, onAddLocal, onArrange, onUseCover, onRemoveCandidate, onConfirm }: Common & {
  assets: XhsNoteAssets | null; coverStale: boolean; cardsStale: boolean;
  /** 账号选用的 IP；空串表示不使用 IP（不显示 IP 模板）。 */
  ipId: string; onSelectIp: (id: string) => void;
  onEdit: (patch: Partial<XhsNote>) => void; onCover: (brief: string) => void; onChooseCover: () => void; onIpCover: (input: XhsIpCoverInput) => void;
  onCards: (pageCount: number, style: string) => void; onRenderCards: () => void; onInfo: (mode: 'single' | 'pages') => void; onCancel: () => void;
  onAddLocal: () => void; onArrange: (paths: string[]) => void; onUseCover: (path: string) => void; onRemoveCandidate: (path: string) => void;
  onConfirm: (key: keyof XhsBasis) => void;
}) {
  const [brief, setBrief] = useState('');
  const { view: ipLibrary } = useIpLibrary();
  const { kit, error: kitError } = useIpKit(ipId);
  const [ipOpen, setIpOpen] = useState(true);
  const plan = readCardPlan(note);
  const [pageCount, setPageCount] = useState(plan?.pages.length && XHS_PAGE_COUNTS.includes(plan.pages.length) ? plan.pages.length : 6);
  const [style, setStyle] = useState(plan?.style ?? XHS_CARD_STYLES[0].key);
  useEffect(() => { if (plan?.style) setStyle(plan.style); }, [plan?.style]);
  const images = readImages(note);
  const preview = useMemo(() => plan ? renderCardsPreview({ ...plan, style }, note.title || note.topic, undefined, kit) : '', [plan, style, note.title, note.topic, kit]);
  const editPlan = (next: XhsCardPlan) => onEdit({ cardsJson: JSON.stringify(next) });
  const imageBusy = busy === 'cover' || busy === 'info-single' || busy === 'info-pages';
  const move = (index: number, delta: number) => {
    const order = images.map(item => item.path);
    const [item] = order.splice(index, 1);
    order.splice(index + delta, 0, item);
    onArrange(order);
  };

  return <div className="flow-body">
    <h4 className="xhs-step-sub">① 封面（可选，3:4）</h4>
    {coverStale && <ConfirmStale text="标题改过，封面上的标题字可能和新标题不一致。" locked={locked} onConfirm={() => onConfirm('cover')} />}
    <div className="xhs-cover-row">
      <CoverPreview assets={assets} title={note.title} />
      <div className="xhs-cover-actions">
        <label className="xhs-field"><span>画面主体与素材（可选）</span><textarea className="input xhs-textarea" rows={3} disabled={locked} value={brief} onChange={event => setBrief(event.target.value)} placeholder="例如：桌面上摆着收纳盒和整理好的杂物；暖色调；背景简单。不填就按选题和正文自动构图" /></label>
        <div className="btn-group">
          <button className="button button-primary" disabled={locked} onClick={() => onCover(brief)}>{busy === 'cover' ? '生成中…' : note.coverPath ? '重新生成封面' : 'AI 生成封面'}</button>
          <button className="button button-secondary" disabled={locked} onClick={onChooseCover}>用本地图片</button>
          {imageBusy && <button className="button button-quiet" onClick={onCancel}>取消生成</button>}
        </div>
        <small className="ww-muted">封面会把标题做成大字放在上半部分，画风按笔记内容与定位档案里的视觉建议。生成后在左右补边成 3:4，不裁切画面；换下来的旧封面留在下面的候选图库里。也可以不单独做封面，导出时会自动使用发布图组第 1 张。</small>
      </div>
    </div>
    <div className="xhs-ip-head">
      <IpPicker label="这个账号的 IP" value={ipId} ips={ipLibrary.ips} disabled={locked} onChange={onSelectIp} />
      {ipId && <small className="ww-muted">AI 生成封面、信息图时会把 IP 角色融进画面；图文卡片每页右下角也会放 IP 角色（不加品牌名和头像）。</small>}
      {ipId && <button className={`button ${ipOpen ? 'button-quiet' : 'button-secondary'}`} onClick={() => setIpOpen(open => !open)}>{ipOpen ? '收起 IP 模板' : '用 IP 模板出封面'}</button>}
    </div>
    {ipId && ipOpen && <IpCoverPanel note={note} kit={kit} kitError={kitError} locked={locked} busy={busy === 'ip-cover'} onRender={onIpCover} />}

    <h4 className="xhs-step-sub">② 图文卡片（本地模板，免费）</h4>
    {cardsStale && <ConfirmStale text="正文改过，卡片 / 信息图里的内容可能过时了。" locked={locked} onConfirm={() => onConfirm('cards')} />}
    <div className="xhs-style-picks">{XHS_CARD_STYLES.map(item => <button key={item.key} className={`xhs-style ${style === item.key ? 'is-active' : ''}`} disabled={locked}
      onClick={() => { setStyle(item.key); if (plan) editPlan({ ...plan, style: item.key }); }}>
      <i style={{ background: item.bg, borderColor: item.accent }}><b style={{ background: item.accent }} /></i><strong>{item.label}</strong><small>{item.hint}</small>
    </button>)}</div>
    <div className="flow-inline-actions">
      <label className="xhs-inline-select"><span>页数</span><select className="input" disabled={locked} value={pageCount} onChange={event => setPageCount(Number(event.target.value))}>{XHS_PAGE_COUNTS.map(value => <option key={value} value={value}>{value} 张</option>)}</select></label>
      <button className="button button-secondary" disabled={locked} onClick={() => onCards(pageCount, style)}>{busy === 'cards' ? '拆分中…' : plan ? '重新拆分页' : 'AI 拆分页'}</button>
      <button className="button button-primary" disabled={locked || !plan} onClick={onRenderCards}>{busy === 'render' ? '渲染中…' : '导出为卡片图'}</button>
    </div>
    {plan && <>
      <iframe className="xhs-cards-frame" title="图文卡片预览" sandbox="" srcDoc={preview} />
      <details className="native-json"><summary>逐页修改卡片文字</summary>
        <div className="xhs-page-editor">{plan.pages.map((page, index) => <fieldset key={index} disabled={locked}>
          <legend>第 {index + 1} 页</legend>
          <input className="input" value={page.heading} placeholder="标题（≤14 字）" onChange={event => editPlan({ ...plan, pages: plan.pages.map((item, position) => position === index ? { ...item, heading: event.target.value } : item) })} />
          <textarea className="input" rows={4} value={page.points.join('\n')} placeholder="要点，一行一条" onChange={event => editPlan({ ...plan, pages: plan.pages.map((item, position) => position === index ? { ...item, points: event.target.value.split('\n') } : item) })} />
          <input className="input" value={page.emphasis} placeholder="强调语（可选）" onChange={event => editPlan({ ...plan, pages: plan.pages.map((item, position) => position === index ? { ...item, emphasis: event.target.value } : item) })} />
        </fieldset>)}</div>
        <p className="ww-muted">改完先点右上角「保存」，再「导出为卡片图」。</p>
      </details>
    </>}

    <details className="flow-secondary-tools">
      <summary>更多图片生成<small>生图信息图按张计费；历史候选图库也在这里</small></summary>
      <h4 className="xhs-step-sub">③ 生图信息图（图片接口，按张计费）</h4>
      <div className="flow-inline-actions">
        <button className="button button-secondary" disabled={locked || !plan} onClick={() => onInfo('single')}>{busy === 'info-single' ? '生成中…' : '出 1 张总览信息图'}</button>
        <button className="button button-secondary" disabled={locked || !plan} onClick={() => onInfo('pages')}>{busy === 'info-pages' ? '生成中…' : `按分页出 ${plan?.pages.length ?? 6} 张`}</button>
        <small className="ww-muted">{plan ? '固定「轻盈信息图」风格：白底、紫蓝 + 青柠绿、圆角卡片、线性图标。' : '先拆好分页：信息图按卡片分页逐页出图。'}</small>
      </div>
      <CandidateLibrary candidates={assets?.candidates ?? []} order={images.map(item => item.path)} hasCover={Boolean(note.coverPath)} locked={locked} onArrange={onArrange} onUseCover={onUseCover} onRemove={onRemoveCandidate} />
    </details>

    <h4 className="xhs-step-sub">④ 发布图组<small>独立封面优先；没有封面时第 1 张自动作封面，同一张图不会重复导出</small></h4>
    {assets?.images.length ? <ol className="xhs-gallery">{assets.images.map((item, index) => <li key={item.path}>
      {item.thumbnail ? <img src={item.thumbnail} alt={item.caption} /> : <div className="flow-image-missing">缺图</div>}
      <span>{index + (note.coverPath ? 2 : 1)}. {{ card: '卡片', info: '信息图', local: '本地' }[item.source]}{!note.coverPath && index === 0 ? ' · 封面' : ''}{item.caption ? ` · ${item.caption}` : ''}</span>
      <div className="btn-group">
        <button className="icon-button" title="前移" disabled={locked || index === 0} onClick={() => move(index, -1)}>↑</button>
        <button className="icon-button" title="后移" disabled={locked || index === assets.images.length - 1} onClick={() => move(index, 1)}>↓</button>
        <button className="icon-button" title="移出图组" disabled={locked} onClick={() => onArrange(images.filter(image => image.path !== item.path).map(image => image.path))}><Icon name="x" /></button>
      </div>
    </li>)}</ol> : <p className="flow-empty">图组还是空的：导出卡片图、生成信息图，或添加本地图片。</p>}
    <button className="button button-quiet" disabled={locked} onClick={onAddLocal}><Icon name="plus" />添加本地图片</button>

  </div>;
}

const candidateSource: Record<XhsCandidateView['source'], string> = { cover: '封面', card: '卡片图', info: '信息图', local: '本地图片' };

/**
 * 候选图库：每次生成 / 添加的图按批次排开（新的在前），从这里挑出最终的封面和发布图组。
 * 新一批生成出来时会先自动替换图组里同来源的旧图，被换下的旧图留在这里，可以整组或单张挑回去。
 */
function CandidateLibrary({ candidates, order, hasCover, locked, onArrange, onUseCover, onRemove }: {
  candidates: XhsCandidateView[]; order: string[]; hasCover: boolean; locked: boolean;
  onArrange: (paths: string[]) => void; onUseCover: (path: string) => void; onRemove: (path: string) => void;
}) {
  const batches = useMemo(() => {
    const groups = new Map<string, XhsCandidateView[]>();
    for (const item of candidates) groups.set(item.batch, [...(groups.get(item.batch) ?? []), item]);
    return [...groups.values()];
  }, [candidates]);
  if (!candidates.length) return null;
  const toggle = (item: XhsCandidateView) => onArrange(item.inGroup ? order.filter(file => file !== item.path) : [...order, item.path]);
  const batchLabel = (items: XhsCandidateView[]) => {
    const first = items[0];
    const when = first.createdAt ? new Date(first.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '之前的版本';
    return `${candidateSource[first.source]} · ${when} · ${items.length} 张`;
  };
  return <>
    <h4 className="xhs-step-sub">⑤ 候选图库<small>历次生成的图都在这里：挑选加入发布图组，或设为封面</small></h4>
    <div className="xhs-candidates">{batches.map(items => {
      const usable = items.filter(item => !item.isCover);
      const allIn = usable.length > 0 && usable.every(item => item.inGroup);
      return <section key={items[0].batch} className="xhs-candidate-batch">
        <header>
          <strong>{batchLabel(items)}</strong>
          {usable.length > 1 && <div className="btn-group">
            <button className="button button-quiet button-small" disabled={locked || allIn} onClick={() => onArrange([...order, ...usable.map(item => item.path)])}>整组加入</button>
            <button className="button button-quiet button-small" disabled={locked} title="发布图组只保留这一组，顺序按这一组的生成顺序" onClick={() => onArrange(usable.map(item => item.path))}>只用这一组</button>
          </div>}
        </header>
        <ol className="xhs-gallery">{items.map(item => <li key={item.path} className={item.inGroup || item.isCover ? 'is-picked' : ''}>
          <img src={item.thumbnail} alt={item.caption} />
          <span title={item.caption}>{item.isCover ? '当前封面' : item.inGroup ? `图组第 ${order.indexOf(item.path) + (hasCover ? 2 : 1)} 张` : '未使用'}{item.caption ? ` · ${item.caption}` : ''}</span>
          <div className="btn-group">
            {!item.isCover && <button className="button button-quiet button-small" disabled={locked} onClick={() => toggle(item)}>{item.inGroup ? '移出图组' : '加入图组'}</button>}
            {!item.isCover && <button className="button button-quiet button-small" disabled={locked} onClick={() => onUseCover(item.path)}>设为封面</button>}
            {!item.isCover && !item.inGroup && <ConfirmButton className="icon-button" armedLabel="确认删除" title="从候选图库删除这张图" onConfirm={() => onRemove(item.path)}><Icon name="trash" size={13} /></ConfirmButton>}
          </div>
        </li>)}</ol>
      </section>;
    })}</div>
  </>;
}

export function ChecksStep({ note, locked, busy, stale, onRun, onRevise }: Common & { stale: boolean; onRun: () => void; onRevise: () => void }) {
  const report = readCheckReport(note);
  const failed = report?.items.filter(item => item.ok === false) ?? [];
  return <div className="flow-body">
    {stale && <p className="flow-attention-note">检测之后标题、正文或标签又改过，结果可能过时，请重新检测。</p>}
    <div className="flow-sub-head">
      <h4>发布前 14 项检测<small>{XHS_CHECKS.filter(item => item.source === 'local').length} 项本地规则 + {XHS_CHECKS.filter(item => item.source === 'model').length} 项模型判断</small></h4>
      <div className="btn-group">
        {failed.length > 0 && <button className="button button-secondary" disabled={locked} onClick={onRevise}>{busy === 'revise' ? '回改中…' : `按检测意见回改正文（${failed.length} 项）`}</button>}
        <button className="button button-primary" disabled={locked} onClick={onRun}>{busy === 'checks' ? '检测中…' : report ? '重新检测' : '开始检测'}</button>
      </div>
    </div>
    {report?.modelError && <p className="xhs-hint xhs-hint-warn">模型那 5 项没有检测成功：{report.modelError}</p>}
    {report ? <ul className="flow-checklist xhs-checks">{report.items.map(item => <li key={item.id} className={item.ok === true ? 'is-ok' : item.ok === false ? 'is-missing' : ''}>
      <span aria-hidden="true">{item.ok === true ? '✓' : item.ok === false ? (item.level === 'error' ? '✗' : '!') : '○'}</span>
      <div><strong>{item.label}<em className="xhs-check-source">{item.source === 'local' ? '规则' : '模型'}{item.ok === false && item.level === 'error' ? ' · 必须处理' : ''}</em></strong><small>{item.detail}</small></div>
    </li>)}</ul> : <p className="flow-empty">检测标题长度、正文长度、标签、emoji、绝对化用语、外链引流、段落，再让模型看开头、兑现、合规、人设与互动。</p>}
    {report && <p className="ww-muted">检测于 {new Date(report.checkedAt).toLocaleString('zh-CN')}。「必须处理」的项不通过时不建议发布；「!」是建议项。</p>}
  </div>;
}

export function PackageStep({ note, locked, busy, assets, onEdit, onExport, onOpen, onCopy, onFillDraft }: Common & {
  assets: XhsNoteAssets | null; onEdit: () => void; onExport: () => void; onOpen: () => void; onCopy: (kind: 'title' | 'body') => void; onFillDraft: () => void;
}) {
  const checklist = xhsExportChecklist(note);
  const ready = checklist.filter(item => !item.optional).every(item => item.ok);
  const exportPaths = xhsPackageImagePaths(note);
  const exportAssets: Array<{ path: string; caption: string; thumbnail: string; source: 'cover' | 'card' | 'info' | 'local' }> = [];
  for (const file of exportPaths) {
    if (assets?.cover?.path === file) {
      exportAssets.push({ ...assets.cover, source: 'cover' });
      continue;
    }
    const item = assets?.images.find(image => image.path === file);
    if (item) exportAssets.push(item);
  }
  return <div className="flow-body">
    <ul className="flow-checklist">{checklist.map(item => <li key={item.label} className={item.ok ? 'is-ok' : 'is-missing'}>
      <span aria-hidden="true">{item.ok ? '✓' : '○'}</span>
      <div><strong>{item.label}{item.optional && '（建议）'}</strong><small>{item.detail}</small></div>
    </li>)}</ul>
    <div className="flow-inline-actions">
      <button className="button button-primary" disabled={locked || !ready} onClick={onExport}>{busy === 'export' ? '导出中…' : note.exportPath ? '重新导出发布包' : '导出发布包'}</button>
      <button className="button button-primary" disabled={locked || !ready} title="打开当前账号的创作者中心，自动上传图片并填入标题、正文与标签；不会点击发布" onClick={onFillDraft}>{busy === 'draft' ? '正在填入…' : '填入小红书草稿'}</button>
      {note.exportPath && <button className="button button-secondary" disabled={locked} onClick={onOpen}>打开发布包目录</button>}
      <button className="button button-quiet" disabled={!note.title} onClick={() => onCopy('title')}>复制标题</button>
      <button className="button button-quiet" disabled={!note.body} onClick={() => onCopy('body')}>复制正文 + 标签</button>
    </div>
    <div className="flow-sub-head">
      <h4>将要导出的图组<small>{exportAssets.length} 张，按这个顺序导出为 01、02…，同一路径只导出一次</small></h4>
      <button className="button button-quiet" onClick={onEdit}>去调整图组</button>
    </div>
    {exportAssets.length ? <ol className="xhs-gallery xhs-export-strip">
      {exportAssets.map((item, index) => <li key={item.path}>
        {item.thumbnail ? <img src={item.thumbnail} alt={item.caption} /> : <div className="flow-image-missing">缺图</div>}
        <span>{String(index + 1).padStart(2, '0')} · {index === 0 ? `封面${note.coverPath ? '' : '（图组第 1 张）'}` : item.caption || '图片'}</span>
      </li>)}
    </ol> : <p className="flow-empty">还没有封面和图组。</p>}
    {note.exportPath && <p className="native-export-path">最近导出：{note.exportPath}</p>}
    <p className="ww-muted">「填入小红书草稿」会按发布顺序上传 01、02… 并填好标题、正文与标签，随后停在创作者中心；你只需要检查并手动点击发布。也可以继续导出本地发布包。含 AI 生成内容时，发布前记得勾选平台的 AI 内容声明。</p>
  </div>;
}

/** 封面与图组缩略图由主进程生成（渲染进程读不到本地文件），笔记变动后自动重新拉取。 */
export function useXhsAssets(accountId: number, noteId: number, revision: string): XhsNoteAssets | null {
  const [assets, setAssets] = useState<XhsNoteAssets | null>(null);
  useEffect(() => {
    if (!noteId) { setAssets(null); return; }
    let alive = true;
    void window.sydney.getXhsNoteAssets(accountId, noteId).then(next => { if (alive) setAssets(next); }).catch(() => { if (alive) setAssets(null); });
    return () => { alive = false; };
  }, [accountId, noteId, revision]);
  return assets;
}
