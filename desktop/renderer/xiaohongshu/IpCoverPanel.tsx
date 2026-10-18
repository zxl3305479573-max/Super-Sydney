import { useEffect, useMemo, useState } from 'react';
import type { IpRenderKit, XhsIpCoverInput, XhsIpCoverTemplate, XhsNote } from '../../shared';
import { XHS_CARD_HEIGHT, XHS_CARD_WIDTH } from '../../services/xhs-cards';
import { XHS_IP_COVER_TEMPLATES, defaultIpCoverTemplate, emptyIpCoverInput, ipCoverPose, renderIpCoverDocument } from '../../services/xhs-ip-cover';

/**
 * 小红书的 IP 封面模板：选模板、填字段、实时预览，确认后由主进程本地截图成封面（不调图片接口）。
 * 配色、角色图来自账号当前选用的 IP；画面里不放头像和品牌名。
 * 填过的字段按笔记存在本机（localStorage），下次打开接着改；读不到就从笔记标题起步。
 */

const PREVIEW_SCALE = 0.3;
const storageKey = (noteId: number) => `sydney.xhs.ip-cover.${noteId}`;

function loadInput(note: XhsNote): XhsIpCoverInput {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(note.id)) ?? 'null') as XhsIpCoverInput | null;
    if (saved && XHS_IP_COVER_TEMPLATES.some(item => item.key === saved.template)) return { ...emptyIpCoverInput(saved.template), ...saved };
  } catch { /* 本机存储不可用就从默认值开始 */ }
  return emptyIpCoverInput(defaultIpCoverTemplate(note.noteType), note.title || note.topic);
}

export function IpCoverPanel({ note, kit, kitError, locked, busy, onRender }: {
  note: XhsNote; kit: IpRenderKit | null; kitError: string; locked: boolean; busy: boolean; onRender: (input: XhsIpCoverInput) => void;
}) {
  const [input, setInput] = useState<XhsIpCoverInput>(() => loadInput(note));
  // 步骤输入框保留原文：边打边拆的话，刚打出的分隔符会被吞掉。
  const [stepsText, setStepsText] = useState(() => input.steps.join('、'));
  useEffect(() => { const loaded = loadInput(note); setInput(loaded); setStepsText(loaded.steps.join('、')); }, [note.id]);
  useEffect(() => { try { localStorage.setItem(storageKey(note.id), JSON.stringify(input)); } catch { /* 忽略 */ } }, [note.id, input]);

  const fields = XHS_IP_COVER_TEMPLATES.find(item => item.key === input.template)?.fields ?? [];
  const has = (field: keyof XhsIpCoverInput) => fields.includes(field);
  const set = (patch: Partial<XhsIpCoverInput>) => setInput(current => ({ ...current, ...patch }));
  const pick = (template: XhsIpCoverTemplate) => { setInput(current => ({ ...emptyIpCoverInput(template), title: current.title, sub: current.sub })); setStepsText(''); };
  const editSteps = (value: string) => { setStepsText(value); set({ steps: value.split(/[、,，\s]+/).filter(Boolean).slice(0, 5) }); };
  const preview = useMemo(() => kit ? renderIpCoverDocument(input, kit) : '', [input, kit]);
  const pose = kit ? ipCoverPose(input, kit) : null;

  return <div className="xhs-ip-cover">
    <div className="xhs-ip-preview" style={{ width: XHS_CARD_WIDTH * PREVIEW_SCALE, height: XHS_CARD_HEIGHT * PREVIEW_SCALE }}>
      {preview ? <iframe title="IP 封面预览" sandbox="" srcDoc={preview} width={XHS_CARD_WIDTH} height={XHS_CARD_HEIGHT} style={{ transform: `scale(${PREVIEW_SCALE})` }} />
        : <div className="flow-image-missing">{kitError || 'IP 素材加载中…'}</div>}
    </div>
    <div className="xhs-ip-form">
      <div className="xhs-style-picks">{XHS_IP_COVER_TEMPLATES.map(item => <button key={item.key} className={`xhs-style xhs-ip-pick ${input.template === item.key ? 'is-active' : ''}`} disabled={locked} onClick={() => pick(item.key)}>
        <strong>{item.label}</strong><small>{item.hint}</small>
      </button>)}</div>
      {kit && kit.poses.length > 1 && <label className="xhs-field"><span>角色动作</span>
        <select className="input" disabled={locked} value={input.pose && kit.poses.some(item => item.id === input.pose) ? input.pose : ''} onChange={event => set({ pose: event.target.value })}>
          <option value="">自动（{pose?.label ?? '—'}）</option>
          {kit.poses.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>}
      <label className="xhs-field"><span>标题（【】包住的字加荧光笔，| 换行，每行 4–9 字最醒目）</span>
        <div className="xhs-ip-title-row">
          <input className="input" disabled={locked} value={input.title} onChange={event => set({ title: event.target.value })} />
          <button className="button button-quiet button-small" disabled={locked || !note.title} onClick={() => set({ title: note.title })} title="换成笔记当前的标题">用笔记标题</button>
        </div>
      </label>
      {has('number') && <div className="xhs-ip-pair">
        <label className="xhs-field"><span>大数字</span><input className="input" disabled={locked} value={input.number} onChange={event => set({ number: event.target.value })} /></label>
        <label className="xhs-field"><span>单位</span><input className="input" disabled={locked} value={input.unit} onChange={event => set({ unit: event.target.value })} /></label>
      </div>}
      <label className="xhs-field"><span>副标题（可选）</span><input className="input" disabled={locked} value={input.sub} onChange={event => set({ sub: event.target.value })} /></label>
      {has('tag') && <label className="xhs-field"><span>标签（可选）</span><input className="input" disabled={locked} value={input.tag} onChange={event => set({ tag: event.target.value })} /></label>}
      {has('steps') && <label className="xhs-field"><span>步骤（可选，用、或空格分开，最多 5 步）</span>
        <input className="input" disabled={locked} value={stepsText} onChange={event => editSteps(event.target.value)} /></label>}
      {has('sticker') && <label className="xhs-field"><span>贴纸（| 换行，留空不显示）</span><input className="input" disabled={locked} value={input.sticker} onChange={event => set({ sticker: event.target.value })} /></label>}
      {has('bubble') && <label className="xhs-field"><span>气泡台词（可选）</span>
        <div className="xhs-ip-title-row">
          <input className="input" disabled={locked} value={input.bubble} onChange={event => set({ bubble: event.target.value })} />
          {kit?.tagline && <button className="button button-quiet button-small" disabled={locked} onClick={() => set({ bubble: kit.tagline.slice(0, 20) })} title="用 IP 的口头禅">用口头禅</button>}
        </div>
      </label>}
      <div className="btn-group">
        <button className="button button-primary" disabled={locked || !input.title.trim() || !kit} onClick={() => onRender(input)}>{busy ? '出图中…' : '用这个模板出封面'}</button>
      </div>
      <small className="ww-muted">本地排版截图，不消耗图片接口额度。配色和角色取自 IP「{kit?.name ?? '—'}」，画面里不放头像和品牌名；在「设置 → IP 形象」里改。</small>
    </div>
  </div>;
}
