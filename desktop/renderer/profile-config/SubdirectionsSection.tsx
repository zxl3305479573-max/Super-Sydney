import { ImagePromptField, NoteField, type AiProps } from './fields';
import type { ProfileRow, SubRow } from './types';

export function SubdirectionsSection({ active, defaultId, setDefaultId, setDirty, patchSub, removeSub, addSub, aiProps, optimizeNote, optimizeImage }: {
  active: ProfileRow; defaultId: number | null; setDefaultId: (value: number | null) => void; setDirty: (value: boolean) => void;
  patchSub: (subKey: string, patch: Partial<SubRow>) => void; removeSub: (subKey: string) => void; addSub: () => void;
  aiProps: (fieldKey: string, run: () => void, adopt: (note: string) => void) => AiProps; optimizeNote: (sub: SubRow) => void; optimizeImage: (sub: SubRow) => void;
}) {
  const subDefault = active.subs.find(sub => sub.id && sub.id === defaultId);
  return <div className="ww-group">
    <div className="ww-group-head"><h3>具体方向</h3><small>{active.subs.length} 个 · 新建任务默认：{subDefault?.name || '第一个'}</small></div>
    <div className="cd-subs">
      {active.subs.map(sub => <div className="cd-sub" key={sub.key}>
        <input className="input" value={sub.name} placeholder="具体方向，例如：饮食营养与蔬果利弊" onChange={event => patchSub(sub.key, { name: event.target.value })} />
        <label className="cd-default">
          <input type="radio" name="cd-default" checked={Boolean(sub.id) && sub.id === defaultId} disabled={!sub.id}
            onChange={() => { setDefaultId(sub.id ?? null); setDirty(true); }} title={sub.id ? '应用启动与新建文章任务时默认选中的具体方向' : '先保存后才能设为默认'} />
          默认
        </label>
        <button className="button button-quiet button-small" onClick={() => removeSub(sub.key)}>移除</button>
        <NoteField value={sub.note} rows={2} placeholder="这个具体方向相对整份资料的额外要求（可留空）"
          onChange={note => patchSub(sub.key, { note })}
          {...aiProps(sub.key, () => optimizeNote(sub), note => patchSub(sub.key, { note }))} />
        <ImagePromptField value={sub.imagePrompt} inherited={active.imagePrompt.trim()} collapsible
          onChange={imagePrompt => patchSub(sub.key, { imagePrompt })}
          {...aiProps(`img:${sub.key}`, () => optimizeImage(sub), imagePrompt => patchSub(sub.key, { imagePrompt }))} />
      </div>)}
      <button className="button button-secondary button-small" onClick={addSub}>+ 加具体方向</button>
    </div>
  </div>;
}
