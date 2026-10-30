import type { DirectionNoteSuggestion } from '../../shared';
import { DEFAULT_IMAGE_STYLE, IMAGE_STYLE_PRESETS } from '../../services/image-style';

function SuggestionCard({ suggestion, onAdopt, onDismiss }: { suggestion: DirectionNoteSuggestion; onAdopt: () => void; onDismiss: () => void }) {
  return <div className="cd-suggestion" role="region" aria-label="AI 建议">
    <div className="cd-suggestion-head"><strong>AI 建议</strong><small>采用后会替换上面的内容，仍需点「保存」</small></div>
    <pre>{suggestion.note}</pre>
    {suggestion.changes.length > 0 && <ul>{suggestion.changes.map((item, index) => <li key={index}>{item}</li>)}</ul>}
    <div className="cd-suggestion-actions">
      <button className="button button-primary button-small" onClick={onAdopt}>采用</button>
      <button className="button button-quiet button-small" onClick={onDismiss}>放弃</button>
    </div>
  </div>;
}

export type AiProps = { busy: boolean; disabled: boolean; suggestion: DirectionNoteSuggestion | undefined; onOptimize: () => void; onAdopt: () => void; onDismiss: () => void };

/** 写作约束输入框 + 「AI 优化」。 */
export function NoteField({ value, placeholder, rows, onChange, busy, disabled, suggestion, onOptimize, onAdopt, onDismiss }: AiProps & {
  value: string; placeholder: string; rows: number; onChange: (value: string) => void;
}) {
  return <div className="cd-note-field">
    <div className="cd-note-row">
      <textarea className="input cd-note" rows={rows} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
      <button className="button button-secondary button-small cd-ai" disabled={disabled} title="用内容 API 把这里的约束整理成可执行的规则条目；结果先给你预览，采用后再保存" onClick={onOptimize}>
        {busy ? '优化中…' : value.trim() ? 'AI 优化' : 'AI 起草'}
      </button>
    </div>
    {suggestion && <SuggestionCard suggestion={suggestion} onAdopt={onAdopt} onDismiss={onDismiss} />}
  </div>;
}

/** 配图风格模板 + 「AI 优化」。资料留空 = 用内置默认；具体方向留空 = 沿用资料的模板。 */
export function ImagePromptField({ value, inherited, collapsible, onChange, busy, disabled, suggestion, onOptimize, onAdopt, onDismiss }: AiProps & {
  value: string; inherited: string; collapsible: boolean; onChange: (value: string) => void;
}) {
  const custom = value.trim() !== '';
  const body = <>
    <div className="cd-note-row">
      <textarea className="input" rows={collapsible ? 3 : 5} value={value} placeholder={inherited || DEFAULT_IMAGE_STYLE} onChange={event => onChange(event.target.value)} />
      <button className="button button-secondary button-small cd-ai" disabled={disabled}
        title="按资料的名称、读者、写作约束和这里已写的内容，整理出画风与禁忌；结果先给你预览，采用后再保存" onClick={onOptimize}>
        {busy ? '优化中…' : custom ? 'AI 优化' : 'AI 起草'}
      </button>
    </div>
    {suggestion && <SuggestionCard suggestion={suggestion} onAdopt={onAdopt} onDismiss={onDismiss} />}
    <div className="cd-image-prompt-foot">
      <small>封面和正文配图都会用这段描述画风与禁忌（画面里要不要出现文字、数字也写在这里）；文章主题、正文提要、所在段落由程序自动拼在前面。可用 {'{读者}'} 代入「读者定位」。</small>
      {!custom && <button className="button button-quiet button-small" onClick={() => onChange(inherited || DEFAULT_IMAGE_STYLE)}>在{inherited ? '资料模板' : '默认模板'}基础上修改</button>}
      {custom && <button className="button button-quiet button-small" onClick={() => onChange('')}>{inherited ? '改回沿用资料模板' : '恢复默认'}</button>}
      <select className="cd-preset" value="" aria-label="套用配图风格预设" title="把预设填进上面的模板，可以继续改；保存后才生效" onChange={event => {
        const preset = IMAGE_STYLE_PRESETS.find(item => item.key === event.target.value);
        if (!preset) return;
        if (custom && value.trim() !== preset.template && !window.confirm(`用「${preset.label}」预设替换当前已写的配图模板？`)) return;
        onChange(preset.template);
      }}>
        <option value="">套用预设…</option>
        {IMAGE_STYLE_PRESETS.map(item => <option key={item.key} value={item.key} title={item.hint}>{item.label}</option>)}
      </select>
    </div>
  </>;
  const status = custom ? '已自定义' : inherited ? '沿用资料模板' : '使用默认模板';
  if (!collapsible) return <div className="cd-image-prompt is-flat"><div className="cd-image-prompt-status">{status}</div>{body}</div>;
  return <details className="cd-image-prompt" open={custom || Boolean(suggestion) || busy || undefined}>
    <summary>配图风格模板<small>{status}</small></summary>
    {body}
  </details>;
}
