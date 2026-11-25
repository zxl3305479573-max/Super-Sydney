import { useEffect, useMemo, useState } from 'react';
import type { IpRenderKit, XhsIpCoverInput, XhsIpCoverTemplate, XhsNote } from '../../shared';
import { XHS_CARD_HEIGHT, XHS_CARD_WIDTH } from '../../services/xhs-cards';
import {
  XHS_COVER_THEMES, XHS_IP_COVER_TEMPLATES, emptyIpCoverInput, ipCoverPose, renderIpCoverDocument, seedIpCoverFromNote
} from '../../services/xhs-ip-cover';

/**
 * 小红书本地文字 / IP 封面模板（8 套爆款版式，0 成本秒出）：
 * - 未选 IP 时直接用作高对比纯文字大字封面；选了 IP 时可融合透明底角色，也可切回「不放角色（纯文字）」；
 * - 首次打开自动从当前笔记标题、大纲与正文提取副标题和 3–4 条浓缩要点，版面立刻饱满不空旷；
 * - 填过的字段按笔记持久化到本机（localStorage），下次接着改。
 */

const PREVIEW_SCALE = 0.31;
const storageKey = (noteId: number) => `sydney.xhs.ip-cover.${noteId}`;

function loadInput(note: XhsNote): XhsIpCoverInput {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(note.id)) ?? 'null') as XhsIpCoverInput | null;
    if (saved && XHS_IP_COVER_TEMPLATES.some(item => item.key === saved.template)) {
      return { ...emptyIpCoverInput(saved.template), ...saved };
    }
  } catch { /* 本机存储不可用就从笔记内容自动提炼 */ }
  return seedIpCoverFromNote(note);
}

export function IpCoverPanel({ note, ipId, kit, kitError, locked, busy, onRender }: {
  note: XhsNote; ipId: string; kit: IpRenderKit | null; kitError: string; locked: boolean; busy: boolean; onRender: (input: XhsIpCoverInput) => void;
}) {
  const [input, setInput] = useState<XhsIpCoverInput>(() => loadInput(note));
  const [stepsText, setStepsText] = useState(() => input.steps.join('、'));
  useEffect(() => {
    const loaded = loadInput(note);
    setInput(loaded);
    setStepsText(loaded.steps.join('、'));
  }, [note.id]);
  useEffect(() => {
    try { localStorage.setItem(storageKey(note.id), JSON.stringify(input)); } catch { /* 忽略 */ }
  }, [note.id, input]);

  const activeKit = ipId ? kit : null;
  const fields = XHS_IP_COVER_TEMPLATES.find(item => item.key === input.template)?.fields ?? [];
  const has = (field: keyof XhsIpCoverInput) => fields.includes(field);
  const set = (patch: Partial<XhsIpCoverInput>) => setInput(current => ({ ...current, ...patch }));
  const pick = (template: XhsIpCoverTemplate) => {
    setInput(current => {
      const seeded = seedIpCoverFromNote(note, template);
      const nextSteps = current.steps.length ? current.steps : seeded.steps;
      setStepsText(nextSteps.join('、'));
      return {
        ...emptyIpCoverInput(template),
        pose: current.pose,
        theme: current.theme,
        title: current.title || seeded.title,
        sub: current.sub || seeded.sub,
        steps: nextSteps,
        bubble: current.bubble || seeded.bubble,
        number: current.number || seeded.number,
        unit: current.unit || seeded.unit
      };
    });
  };
  const syncFromNote = () => {
    const seeded = seedIpCoverFromNote(note, input.template);
    setInput(current => ({
      ...seeded,
      pose: current.pose,
      theme: current.theme
    }));
    setStepsText(seeded.steps.join('、'));
  };
  const editSteps = (value: string) => {
    setStepsText(value);
    set({ steps: value.split(/[、,，\n]+/).map(item => item.trim()).filter(Boolean).slice(0, 5) });
  };
  const preview = useMemo(() => (ipId && !activeKit) ? '' : renderIpCoverDocument(input, activeKit), [input, ipId, activeKit]);
  const pose = activeKit ? ipCoverPose(input, activeKit) : null;

  return <div className="xhs-ip-cover">
    <div className="xhs-ip-preview" style={{ width: Math.round(XHS_CARD_WIDTH * PREVIEW_SCALE), height: Math.round(XHS_CARD_HEIGHT * PREVIEW_SCALE) }}>
      {preview
        ? <iframe title="本地封面模板预览" sandbox="allow-same-origin" srcDoc={preview} width={XHS_CARD_WIDTH} height={XHS_CARD_HEIGHT} style={{ transform: `scale(${PREVIEW_SCALE})` }} />
        : <div className="flow-image-missing">{kitError || 'IP 素材加载中…'}</div>}
    </div>
    <div className="xhs-ip-form">
      <div className="xhs-style-picks">{XHS_IP_COVER_TEMPLATES.map(item => <button key={item.key} type="button" className={`xhs-style xhs-ip-pick ${input.template === item.key ? 'is-active' : ''}`} disabled={locked} onClick={() => pick(item.key)}>
        <strong>{item.label}</strong><small>{item.hint}</small>
      </button>)}</div>

      <div className="xhs-ip-pair">
        <label className="xhs-field"><span>封面配色</span>
          <select className="input" disabled={locked} value={input.theme ?? ''} onChange={event => set({ theme: event.target.value || undefined })}>
            {activeKit
              ? <option value="">跟随 IP 品牌色（{activeKit.name}）</option>
              : <option value="">默认暖纸焦橙</option>}
            {XHS_COVER_THEMES.map(theme => <option key={theme.key} value={theme.key}>{theme.label}</option>)}
          </select>
        </label>
        {activeKit && activeKit.poses.length > 0 && <label className="xhs-field"><span>角色动作</span>
          <select className="input" disabled={locked} value={input.pose === 'none' || activeKit.poses.some(item => item.id === input.pose) ? input.pose : ''} onChange={event => set({ pose: event.target.value })}>
            <option value="">自动匹配（{pose?.label ?? '—'}）</option>
            <option value="none">不放角色（纯文字大字报）</option>
            {activeKit.poses.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>}
      </div>

      <label className="xhs-field"><span>主标题（【】包住的词加荧光笔高亮，| 手动换行，每行 5–9 字最醒目）</span>
        <div className="xhs-ip-title-row">
          <input className="input" disabled={locked} value={input.title} placeholder="输入封面主标题，例如：下班2小时|用AI【做完一周小红书】" onChange={event => set({ title: event.target.value })} />
          <button className="button button-quiet button-small" type="button" disabled={locked || (!note.title && !note.topic && !note.body)} onClick={syncFromNote} title="从当前笔记标题、大纲和正文重新提取副标题与浓缩看点">从正文同步要点</button>
        </div>
      </label>

      {has('number') && <div className="xhs-ip-pair">
        <label className="xhs-field"><span>超大数字</span><input className="input" disabled={locked} value={input.number} onChange={event => set({ number: event.target.value })} /></label>
        <label className="xhs-field"><span>量词单位</span><input className="input" disabled={locked} value={input.unit} onChange={event => set({ unit: event.target.value })} /></label>
      </div>}

      <div className="xhs-ip-pair">
        <label className="xhs-field"><span>副标题 / 一句话判断（可选）</span><input className="input" disabled={locked} value={input.sub} placeholder="补充适用人群或核心结论" onChange={event => set({ sub: event.target.value })} /></label>
        {has('tag') && <label className="xhs-field"><span>顶部胶囊标签（可选）</span><input className="input" disabled={locked} value={input.tag} onChange={event => set({ tag: event.target.value })} /></label>}
      </div>

      {has('steps') && <label className="xhs-field"><span>封面浓缩看点 / 对比项（用「、」分开，建议 3–4 条让版面充实饱满）</span>
        <input className="input" disabled={locked} value={stepsText} placeholder="例如：0粉开买手橱窗、千粉接蒲公英、私信闭环收款" onChange={event => editSteps(event.target.value)} /></label>}

      {(has('sticker') || has('bubble')) && <div className="xhs-ip-pair">
        {has('sticker') && <label className="xhs-field"><span>角标印章（| 换行，留空隐藏）</span><input className="input" disabled={locked} value={input.sticker} onChange={event => set({ sticker: event.target.value })} /></label>}
        {has('bubble') && <label className="xhs-field"><span>底部结论 / 气泡金句（可选）</span>
          <div className="xhs-ip-title-row">
            <input className="input" disabled={locked} value={input.bubble} onChange={event => set({ bubble: event.target.value })} />
            {activeKit?.tagline && <button className="button button-quiet button-small" type="button" disabled={locked} onClick={() => set({ bubble: activeKit.tagline.slice(0, 24) })} title="填入 IP 口头禅">用口头禅</button>}
          </div>
        </label>}
      </div>}

      <div className="btn-group">
        <button className="button button-primary" type="button" disabled={locked || !input.title.trim() || Boolean(ipId && !activeKit)} onClick={() => onRender(input)}>{busy ? '出图中…' : '用这个模板生成 3:4 封面'}</button>
      </div>
      <small className="ww-muted">本地高清排版截图（1080×1440），0 成本秒出且中文字体 100% 零乱码。{activeKit ? `当前已关联 IP「${activeKit.name}」（画面不印头像与品牌名）。` : '未选 IP 时直接输出高识别度纯文字封面；想加角色可在上方选 IP。'}</small>
    </div>
  </div>;
}
