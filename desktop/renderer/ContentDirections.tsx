import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentDirectionInput, ContentTaxonomy, DirectionNoteRequest, DirectionNoteSuggestion } from '../shared';
import { readableError } from './ui';

/**
 * 「内容方向」编辑器：两级分类，可增删改，并指定新建任务时的默认具体方向。
 *
 * 这棵树是账号自己的，不预设任何领域——默认只有一条「中老年健康科普」，
 * 换成别的账号就把名称、约束和各条具体方向改成自己的即可。
 * 保存后主进程会同步 style.yaml 的 topics / default_topic，agent 侧的 WeWrite 流程也能读到。
 */

type SubRow = { key: string; id?: number; name: string; note: string };
type DirRow = { key: string; id?: number; name: string; note: string; subs: SubRow[] };

let uid = 0;
const nextKey = () => `row-${uid++}`;

/**
 * 约束说明输入框 + 「AI 优化」。
 * AI 只给建议：结果以卡片形式展示，用户点「采用」才替换输入框内容，之后仍需保存内容方向才会落库。
 */
function NoteField({ value, placeholder, rows, busy, disabled, suggestion, onChange, onOptimize, onAdopt, onDismiss }: {
  value: string; placeholder: string; rows: number; busy: boolean; disabled: boolean; suggestion: DirectionNoteSuggestion | undefined;
  onChange: (value: string) => void; onOptimize: () => void; onAdopt: () => void; onDismiss: () => void;
}) {
  return <div className="cd-note-field">
    <div className="cd-note-row">
      <textarea className="input cd-note" rows={rows} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
      <button className="button button-secondary button-small cd-ai" disabled={disabled} title="用内容 API 把这里的约束整理成可执行的规则条目；结果先给你预览，采用后再保存" onClick={onOptimize}>
        {busy ? '优化中…' : value.trim() ? 'AI 优化' : 'AI 起草'}
      </button>
    </div>
    {suggestion && <div className="cd-suggestion" role="region" aria-label="AI 建议">
      <div className="cd-suggestion-head"><strong>AI 建议</strong><small>采用后会替换上面的内容，仍需点「保存内容方向」</small></div>
      <pre>{suggestion.note}</pre>
      {suggestion.changes.length > 0 && <ul>{suggestion.changes.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      <div className="cd-suggestion-actions">
        <button className="button button-primary button-small" onClick={onAdopt}>采用</button>
        <button className="button button-quiet button-small" onClick={onDismiss}>放弃</button>
      </div>
    </div>}
  </div>;
}

function toRows(taxonomy: ContentTaxonomy): DirRow[] {
  return taxonomy.directions.map(direction => ({
    key: nextKey(), id: direction.id, name: direction.name, note: direction.note,
    subs: direction.subdirections.map(sub => ({ key: nextKey(), id: sub.id, name: sub.name, note: sub.note }))
  }));
}

export default function ContentDirections({ notify }: { notify: (message: string) => void }) {
  const [taxonomy, setTaxonomy] = useState<ContentTaxonomy | null>(null);
  const [rows, setRows] = useState<DirRow[]>([]);
  const [defaultId, setDefaultId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  /** 正在优化的输入框（方向或具体方向的 row key）；同一时间只跑一个，避免并发花费。 */
  const [optimizing, setOptimizing] = useState('');
  const [suggestions, setSuggestions] = useState<Record<string, DirectionNoteSuggestion>>({});
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const apply = useCallback((next: ContentTaxonomy) => {
    setTaxonomy(next);
    setRows(toRows(next));
    setDefaultId(next.defaultSubdirectionId);
    setSuggestions({});
    setDirty(false);
    return next;
  }, []);

  const load = useCallback(async () => {
    const next = apply(await window.sydney.getContentTaxonomy());
    setError('');
    return next;
  }, [apply]);

  useEffect(() => {
    void load().catch(issue => setError(readableError(issue)));
    const off = window.sydney.onWeWriteChanged(() => { if (!dirtyRef.current) void load().catch(() => undefined); });
    return () => off();
  }, [load]);

  const touch = (mutate: (current: DirRow[]) => DirRow[]) => {
    setDirty(true);
    setRows(current => mutate(current));
  };
  const patchDirection = (key: string, patch: Partial<DirRow>) => touch(current => current.map(row => row.key === key ? { ...row, ...patch } : row));
  const patchSub = (dirKey: string, subKey: string, patch: Partial<SubRow>) => touch(current => current.map(row => row.key === dirKey
    ? { ...row, subs: row.subs.map(sub => sub.key === subKey ? { ...sub, ...patch } : sub) }
    : row));

  const addDirection = () => touch(current => [...current, { key: nextKey(), name: '', note: '', subs: [] }]);
  const addSub = (dirKey: string) => touch(current => current.map(row => row.key === dirKey ? { ...row, subs: [...row.subs, { key: nextKey(), name: '', note: '' }] } : row));
  const removeDirection = (dirKey: string) => touch(current => current.filter(row => row.key !== dirKey));
  const removeSub = (dirKey: string, subKey: string) => touch(current => current.map(row => row.key === dirKey ? { ...row, subs: row.subs.filter(sub => sub.key !== subKey) } : row));

  const optimize = async (fieldKey: string, request: DirectionNoteRequest) => {
    setOptimizing(fieldKey);
    try {
      const suggestion = await window.sydney.optimizeDirectionNote(request);
      setSuggestions(current => ({ ...current, [fieldKey]: suggestion }));
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setOptimizing('');
    }
  };
  const dismissSuggestion = (fieldKey: string) => setSuggestions(current => {
    const { [fieldKey]: _removed, ...rest } = current;
    return rest;
  });
  const optimizeDirection = (row: DirRow) => {
    if (!row.name.trim()) { notify('先填写内容方向名称，再让 AI 优化约束'); return; }
    void optimize(row.key, { directionName: row.name, directionNote: '', subdirectionName: '', note: row.note });
  };
  const optimizeSub = (row: DirRow, sub: SubRow) => {
    if (!row.name.trim() || !sub.name.trim()) { notify('先填写内容方向和具体方向名称，再让 AI 优化约束'); return; }
    void optimize(sub.key, { directionName: row.name, directionNote: row.note, subdirectionName: sub.name, note: sub.note });
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload: ContentDirectionInput[] = rows.map(row => ({
        ...(row.id ? { id: row.id } : {}),
        name: row.name,
        note: row.note,
        subdirections: row.subs.map(sub => ({ ...(sub.id ? { id: sub.id } : {}), name: sub.name, note: sub.note }))
      }));
      apply(await window.sydney.saveContentTaxonomy(payload, defaultId));
      notify('内容方向已保存');
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setSaving(false);
    }
  };

  if (error && !taxonomy) return <div className="ww-group"><div className="ww-group-head"><h3>内容方向</h3><small>读取失败</small></div><p className="ww-muted">{error}</p></div>;
  if (!taxonomy) return <div className="ww-group"><div className="ww-group-head"><h3>内容方向</h3><small>正在读取…</small></div></div>;

  const total = rows.reduce((sum, row) => sum + row.subs.length, 0);
  const currentDefault = rows.flatMap(row => row.subs).find(sub => sub.id && sub.id === defaultId);

  return <div className="ww-group">
    <div className="ww-group-head">
      <h3>内容方向</h3>
      <small>{rows.length} 个方向 · {total} 个具体方向 · 默认：{currentDefault?.name || '未指定'}</small>
    </div>
    {!open
      ? <div className="cd-summary">
          {rows.map(row => <span key={row.key}><b>{row.name}</b>{row.subs.length ? row.subs.map(sub => sub.name).join('、') : '（还没分具体方向）'}</span>)}
        </div>
      : <div className="cd-editor">
          {rows.map(row => <div className="cd-direction" key={row.key}>
            <div className="cd-row">
              <input className="input" value={row.name} placeholder="内容方向名称，例如：中老年健康科普" onChange={event => patchDirection(row.key, { name: event.target.value })} />
              <button className="button button-quiet button-small" onClick={() => removeDirection(row.key)}>删除方向</button>
            </div>
            <NoteField value={row.note} rows={3} placeholder="这个方向的写作与配图约束（会原样进提示词，可留空；写几句要点后点「AI 优化」整理成规则）"
              busy={optimizing === row.key} disabled={optimizing !== ''} suggestion={suggestions[row.key]}
              onChange={note => patchDirection(row.key, { note })} onOptimize={() => optimizeDirection(row)}
              onAdopt={() => { patchDirection(row.key, { note: suggestions[row.key].note }); dismissSuggestion(row.key); }}
              onDismiss={() => dismissSuggestion(row.key)} />
            <div className="cd-subs">
              {row.subs.map(sub => <div className="cd-sub" key={sub.key}>
                <input className="input" value={sub.name} placeholder="具体方向，例如：饮食营养与蔬果利弊" onChange={event => patchSub(row.key, sub.key, { name: event.target.value })} />
                <label className="cd-default">
                  <input type="radio" name="cd-default" checked={Boolean(sub.id) && sub.id === defaultId} disabled={!sub.id}
                    onChange={() => setDefaultId(sub.id ?? null)} title={sub.id ? '新建文章任务时的默认具体方向' : '先保存后才能设为默认'} />
                  默认
                </label>
                <button className="button button-quiet button-small" onClick={() => removeSub(row.key, sub.key)}>移除</button>
                <NoteField value={sub.note} rows={2} placeholder="这个具体方向相对上面方向的额外要求（可留空）"
                  busy={optimizing === sub.key} disabled={optimizing !== ''} suggestion={suggestions[sub.key]}
                  onChange={note => patchSub(row.key, sub.key, { note })} onOptimize={() => optimizeSub(row, sub)}
                  onAdopt={() => { patchSub(row.key, sub.key, { note: suggestions[sub.key].note }); dismissSuggestion(sub.key); }}
                  onDismiss={() => dismissSuggestion(sub.key)} />
              </div>)}
              <button className="button button-secondary button-small" onClick={() => addSub(row.key)}>+ 加具体方向</button>
            </div>
          </div>)}
        </div>}
    <div className="cd-actions">
      <button className="button button-secondary button-small" onClick={() => setOpen(current => !current)}>{open ? '收起编辑' : '展开编辑'}</button>
      {open && <button className="button button-secondary button-small" onClick={addDirection}>+ 加内容方向</button>}
      <span className="ww-muted">{dirty ? '有未保存修改' : '保存后写入本机分类表，并同步 style.yaml 的 topics / default_topic'}</span>
      {dirty && <button className="button button-primary button-small" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存内容方向'}</button>}
      {dirty && <button className="button button-quiet button-small" disabled={saving} onClick={() => void load().catch(issue => notify(readableError(issue)))}>放弃修改</button>}
    </div>
  </div>;
}
