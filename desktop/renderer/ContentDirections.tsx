import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentDirectionInput, ContentTaxonomy } from '../shared';
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
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const apply = useCallback((next: ContentTaxonomy) => {
    setTaxonomy(next);
    setRows(toRows(next));
    setDefaultId(next.defaultSubdirectionId);
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
            <textarea className="input cd-note" rows={2} value={row.note} placeholder="这个方向的写作与配图约束（会原样进提示词，可留空）" onChange={event => patchDirection(row.key, { note: event.target.value })} />
            <div className="cd-subs">
              {row.subs.map(sub => <div className="cd-sub" key={sub.key}>
                <input className="input" value={sub.name} placeholder="具体方向，例如：饮食营养与蔬果利弊" onChange={event => patchSub(row.key, sub.key, { name: event.target.value })} />
                <input className="input" value={sub.note} placeholder="这个具体方向的额外要求（可留空）" onChange={event => patchSub(row.key, sub.key, { note: event.target.value })} />
                <label className="cd-default">
                  <input type="radio" name="cd-default" checked={Boolean(sub.id) && sub.id === defaultId} disabled={!sub.id}
                    onChange={() => setDefaultId(sub.id ?? null)} title={sub.id ? '新建文章任务时的默认具体方向' : '先保存后才能设为默认'} />
                  默认
                </label>
                <button className="button button-quiet button-small" onClick={() => removeSub(row.key, sub.key)}>移除</button>
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
