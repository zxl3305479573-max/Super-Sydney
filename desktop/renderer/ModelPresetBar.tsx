import { useState } from 'react';
import type { ModelPresetKind, ModelPresetView } from '../shared';

/**
 * 模型预设条：下拉选中即切换（写回当前在用的配置）；「存为预设」把下面表单里的值存一套，key 留空就沿用当前的 key。
 * 「自定义」表示当前配置和任何预设都对不上（例如手动改过地址或模型）。
 */
export default function ModelPresetBar({ kind, presets, activeId, defaultName, busy, onApply, onSave, onDelete }: {
  kind: ModelPresetKind; presets: ModelPresetView[]; activeId: string; defaultName: string; busy: boolean;
  onApply: (preset: ModelPresetView) => void; onSave: (name: string) => void; onDelete: (preset: ModelPresetView) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const active = presets.find(item => item.id === activeId) ?? null;
  const label = kind === 'writer' ? '内容模型' : '图片模型';
  const submit = () => { onSave(name.trim() || defaultName.trim()); setNaming(false); setName(''); };
  return <div className="ww-preset">
    <label className="ww-input"><span>{label}预设</span>
      <select value={activeId} disabled={busy || !presets.length} onChange={event => {
        const picked = presets.find(item => item.id === event.target.value);
        if (picked) onApply(picked);
      }}>
        <option value="">{presets.length ? '自定义（未存为预设）' : '还没有预设'}</option>
        {presets.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
      </select>
      <small>{active ? `${active.baseUrl} · key ${active.apiKeyMasked || '未读到'}` : '选中即切换，之后的生成都用这套模型'}</small>
    </label>
    <div className="ww-preset-actions">
      {naming
        ? <>
          <input className="ww-preset-name" autoFocus value={name} placeholder={defaultName || '预设名称'} maxLength={40}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') submit(); if (event.key === 'Escape') setNaming(false); }} />
          <button className="button button-primary button-small" disabled={busy} onClick={submit}>保存</button>
          <button className="button button-quiet button-small" onClick={() => setNaming(false)}>取消</button>
        </>
        : <>
          <button className="button button-secondary button-small" disabled={busy} title="把下面表单里的地址、模型和 key 存成一套预设；同名会覆盖；key 留空则沿用当前的 key" onClick={() => setNaming(true)}>存为预设</button>
          {active && <button className="button button-quiet button-small" disabled={busy} onClick={() => onDelete(active)}>删除此预设</button>}
        </>}
    </div>
  </div>;
}
