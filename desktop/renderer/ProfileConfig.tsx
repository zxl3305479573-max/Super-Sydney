import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentDirectionInput, ContentTaxonomy, DirectionNoteRequest, DirectionNoteSuggestion, ImageStyleRequest } from '../shared';
import WeWriteOverviewPanel from './WeWriteOverview';
import { ModuleBody, ModuleHeader, ModuleToolbar, readableError } from './ui';
import { AudienceSection } from './profile-config/AudienceSection';
import { BasicSection } from './profile-config/BasicSection';
import { ComplianceSection } from './profile-config/ComplianceSection';
import { ImageSection } from './profile-config/ImageSection';
import { SubdirectionsSection } from './profile-config/SubdirectionsSection';
import { TemplateSection } from './profile-config/TemplateSection';
import type { AiProps } from './profile-config/fields';
import { MODULES, nextKey, toPayload, toRows, type ModuleKey, type ProfileRow, type SubRow } from './profile-config/types';

export default function ProfileConfig({ profileId, notify, onSaved }: {
  profileId: number | null;
  notify: (message: string) => void;
  onSaved: (taxonomy: ContentTaxonomy, activate?: number | null) => void;
}) {
  const [rows, setRows] = useState<ProfileRow[] | null>(null);
  const [defaultId, setDefaultId] = useState<number | null>(null);
  const [module, setModule] = useState<ModuleKey>('basic');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [optimizing, setOptimizing] = useState('');
  const [suggestions, setSuggestions] = useState<Record<string, DirectionNoteSuggestion>>({});
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const apply = useCallback((next: ContentTaxonomy) => {
    setRows(toRows(next));
    setDefaultId(next.defaultSubdirectionId);
    setSuggestions({});
    setDirty(false);
  }, []);
  const load = useCallback(async () => {
    apply(await window.sydney.getContentTaxonomy());
    setError('');
  }, [apply]);
  useEffect(() => { void load().catch(issue => setError(readableError(issue))); }, [load]);

  const active = rows?.find(row => row.id === profileId) ?? null;
  const touch = (mutate: (current: ProfileRow[]) => ProfileRow[]) => {
    setDirty(true);
    setRows(current => current ? mutate(current) : current);
  };
  const patchActive = (patch: Partial<ProfileRow>) => touch(current => current.map(row => row.id === profileId ? { ...row, ...patch } : row));
  const patchSub = (subKey: string, patch: Partial<SubRow>) => touch(current => current.map(row => row.id === profileId
    ? { ...row, subs: row.subs.map(sub => sub.key === subKey ? { ...sub, ...patch } : sub) }
    : row));
  const addSub = () => touch(current => current.map(row => row.id === profileId ? { ...row, subs: [...row.subs, { key: nextKey(), name: '', note: '', imagePrompt: '' }] } : row));
  const removeSub = (subKey: string) => touch(current => current.map(row => row.id === profileId ? { ...row, subs: row.subs.filter(sub => sub.key !== subKey) } : row));

  const submit = async (payload: ContentDirectionInput[], message: string, activateName?: string) => {
    setSaving(true);
    try {
      const next = await window.sydney.saveContentTaxonomy(payload, defaultId);
      apply(next);
      onSaved(next, activateName ? next.directions.find(item => item.name === activateName)?.id ?? null : undefined);
      notify(message);
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setSaving(false);
    }
  };
  const save = () => rows && submit(toPayload(rows), '「' + (active?.name || '公众号资料') + '」已保存');
  const createProfile = () => {
    if (!rows) return;
    if (dirtyRef.current) { notify('先保存或放弃当前修改，再新建公众号资料'); return; }
    const taken = new Set(rows.map(row => row.name));
    let name = '新公众号资料';
    for (let index = 2; taken.has(name); index += 1) name = '新公众号资料 ' + index;
    void submit([...toPayload(rows), { name, subdirections: [{ name: '综合' }] }], '已新建「' + name + '」，在「基本资料」里改名并补全信息', name);
    setModule('basic');
  };
  const deleteProfile = () => {
    if (!rows || !active) return;
    if (dirtyRef.current) { notify('先保存或放弃当前修改，再删除公众号资料'); return; }
    if (rows.length <= 1) { notify('至少保留一份公众号资料'); return; }
    void submit(toPayload(rows.filter(row => row.id !== profileId)), '已删除「' + active.name + '」');
  };

  const optimize = async (fieldKey: string, request: () => Promise<DirectionNoteSuggestion>) => {
    setOptimizing(fieldKey);
    try {
      const suggestion = await request();
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
  const aiProps = (fieldKey: string, run: () => void, adopt: (note: string) => void): AiProps => ({
    busy: optimizing === fieldKey,
    disabled: optimizing !== '',
    suggestion: suggestions[fieldKey],
    onOptimize: run,
    onAdopt: () => { adopt(suggestions[fieldKey].note); dismissSuggestion(fieldKey); },
    onDismiss: () => dismissSuggestion(fieldKey)
  });
  const requireName = (sub?: SubRow): boolean => {
    if (!active?.name.trim() || (sub && !sub.name.trim())) {
      notify(sub ? '先填写资料名称和具体方向名称，再让 AI 优化' : '先在「基本资料」里填写资料名称，再让 AI 优化');
      return false;
    }
    return true;
  };
  const optimizeNote = (sub?: SubRow) => {
    if (!active || !requireName(sub)) return;
    const request: DirectionNoteRequest = sub
      ? { directionName: active.name, directionNote: active.note, subdirectionName: sub.name, note: sub.note, audience: active.audience }
      : { directionName: active.name, directionNote: '', subdirectionName: '', note: active.note, audience: active.audience };
    void optimize((sub ?? active).key, () => window.sydney.optimizeDirectionNote(request));
  };
  const optimizeImage = (sub?: SubRow) => {
    if (!active || !requireName(sub)) return;
    const request: ImageStyleRequest = {
      directionName: active.name, directionNote: active.note,
      subdirectionName: sub?.name ?? '', subdirectionNote: sub?.note ?? '',
      parentTemplate: sub ? active.imagePrompt : '', template: sub ? sub.imagePrompt : active.imagePrompt, audience: active.audience
    };
    void optimize('img:' + (sub ?? active).key, () => window.sydney.optimizeImageStyle(request));
  };

  const header = <ModuleHeader title={active?.name || '公众号资料'}
    purpose="按资料管理选题、写作、审稿与配图的约束。"
    action={<button className="button button-primary button-small" disabled={saving || !rows} onClick={createProfile}>+ 新建公众号资料</button>} />;
  const toolbar = <ModuleToolbar className="pc-head" label="配置模块">
    <div className="ww-tabs pc-modules" role="tablist" aria-label="配置模块">
      {MODULES.map(item => <button key={item.key} role="tab" aria-selected={module === item.key} className={'ww-tab ' + (module === item.key ? 'is-active' : '')} onClick={() => setModule(item.key)}>{item.label}</button>)}
    </div>
  </ModuleToolbar>;
  if (error && !rows) return <section className="ww-config">{header}{toolbar}<ModuleBody><div className="ww-group"><p className="ww-muted">公众号资料读取失败：{error}</p></div></ModuleBody></section>;
  if (!rows) return <section className="ww-config">{header}{toolbar}<ModuleBody><div className="ww-group"><p className="ww-muted">正在读取公众号资料…</p></div></ModuleBody></section>;

  let body = null;
  if (module === 'global') body = <WeWriteOverviewPanel notify={notify} />;
  else if (!active) body = <div className="ww-group"><p className="ww-muted">在页面右上角选择一份公众号资料。</p></div>;
  else if (module === 'basic') body = <BasicSection active={active} patchActive={patchActive} deleteProfile={deleteProfile} />;
  else if (module === 'audience') body = <AudienceSection active={active} patchActive={patchActive} />;
  else if (module === 'template') body = <TemplateSection active={active} patchActive={patchActive} />;
  else if (module === 'image') body = <ImageSection active={active} patchActive={patchActive} aiProps={aiProps} optimizeImage={() => optimizeImage()} />;
  else if (module === 'subs') body = <SubdirectionsSection active={active} defaultId={defaultId} setDefaultId={setDefaultId} setDirty={setDirty}
    patchSub={patchSub} removeSub={removeSub} addSub={addSub} aiProps={aiProps} optimizeNote={optimizeNote} optimizeImage={optimizeImage} />;
  else if (module === 'compliance') body = <ComplianceSection active={active} patchActive={patchActive} aiProps={aiProps} optimizeNote={() => optimizeNote()} />;

  return <section className="ww-config">
    {header}
    {toolbar}
    <ModuleBody>
      {body}
      {active && module !== 'global' && <div className="ww-savebar">
        <p>{dirty ? '有未保存修改（切换资料不会丢失，保存时一起提交）' : '编辑的是「' + active.name + '」；保存后写入本机，并把默认资料同步到 style.yaml'}</p>
        <div>
          <button className="button button-secondary" disabled={saving || !dirty} onClick={() => void load().catch(issue => notify(readableError(issue)))}>放弃修改</button>
          <button className="button button-primary" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>}
    </ModuleBody>
  </section>;
}
