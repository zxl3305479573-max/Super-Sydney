import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContentDirectionInput, ContentProfileFields, ContentTaxonomy, DirectionNoteRequest, DirectionNoteSuggestion, ImageStyleRequest } from '../shared';
import { DEFAULT_CONTENT_WORD_COUNT } from '../shared';
import { ARTICLE_THEMES } from '../services/article-html';
import { DEFAULT_IMAGE_STYLE, IMAGE_STYLE_PRESETS } from '../services/image-style';
import WeWriteOverviewPanel from './WeWriteOverview';
import { ConfirmButton, readableError } from './ui';

/**
 * 「环境与配置」：按公众号资料隔离的配置编辑器。
 *
 * 一份资料 = 一个一级内容方向。页面顶部选中哪份资料，这里就只编辑哪份；资料内的配置拆成模块标签，
 * 一次只显示一个模块。写作相关的配置（资料、读者、模板、约束、配图、具体方向、禁忌）都按资料存，
 * 图片服务、内容 API、微信凭证属于整个应用，单独放在「全局服务」。
 *
 * 编辑的是整棵分类树的副本：保存时整棵提交（主进程按 id 增改删），所以切换资料不会丢掉未保存的修改。
 * 保存后主进程会把默认资料同步进 style.yaml，agent 侧的 WeWrite 流程读到的也是同一份。
 */

type SubRow = { key: string; id?: number; name: string; note: string; imagePrompt: string };
type ProfileRow = Omit<ContentProfileFields, 'blacklistWords' | 'blacklistTopics'> & {
  key: string; id?: number; name: string; note: string; imagePrompt: string; subs: SubRow[];
  /** 禁忌词/话题在编辑时按多行文本保存，保存时再拆成列表，避免边打字边被去空行。 */
  wordsText: string; topicsText: string;
};
type ModuleKey = 'basic' | 'audience' | 'template' | 'image' | 'subs' | 'compliance' | 'global';

const MODULES: Array<{ key: ModuleKey; label: string }> = [
  { key: 'basic', label: '基本资料' },
  { key: 'audience', label: '读者定位' },
  { key: 'template', label: '模板设置' },
  { key: 'image', label: '配图模板' },
  { key: 'subs', label: '具体方向' },
  { key: 'compliance', label: '合规禁忌' },
  { key: 'global', label: '全局服务' }
];

let uid = 0;
const nextKey = () => `row-${uid++}`;
const lines = (text: string) => text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);

function toRows(taxonomy: ContentTaxonomy): ProfileRow[] {
  return taxonomy.directions.map(({ subdirections, blacklistWords, blacklistTopics, ...profile }) => ({
    ...profile,
    key: nextKey(),
    wordsText: blacklistWords.join('\n'),
    topicsText: blacklistTopics.join('\n'),
    subs: subdirections.map(sub => ({ key: nextKey(), id: sub.id, name: sub.name, note: sub.note, imagePrompt: sub.imagePrompt }))
  }));
}

function toPayload(rows: ProfileRow[]): ContentDirectionInput[] {
  return rows.map(({ key: _key, subs, wordsText, topicsText, id, ...profile }) => ({
    ...(id ? { id } : {}),
    ...profile,
    blacklistWords: lines(wordsText),
    blacklistTopics: lines(topicsText),
    subdirections: subs.map(sub => ({ ...(sub.id ? { id: sub.id } : {}), name: sub.name, note: sub.note, imagePrompt: sub.imagePrompt }))
  }));
}

/** AI 建议卡片：采用才替换输入框内容，之后仍需保存资料才会落库。 */
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

type AiProps = { busy: boolean; disabled: boolean; suggestion: DirectionNoteSuggestion | undefined; onOptimize: () => void; onAdopt: () => void; onDismiss: () => void };

/** 写作约束输入框 + 「AI 优化」。 */
function NoteField({ value, placeholder, rows, onChange, busy, disabled, suggestion, onOptimize, onAdopt, onDismiss }: AiProps & {
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
function ImagePromptField({ value, inherited, collapsible, onChange, busy, disabled, suggestion, onOptimize, onAdopt, onDismiss }: AiProps & {
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

export default function ProfileConfig({ profileId, notify, onSaved }: {
  profileId: number | null;
  notify: (message: string) => void;
  /** 保存后把新的分类树交回页面；activate 指定保存后要切到的资料（新建时）。 */
  onSaved: (taxonomy: ContentTaxonomy, activate?: number | null) => void;
}) {
  const [rows, setRows] = useState<ProfileRow[] | null>(null);
  const [defaultId, setDefaultId] = useState<number | null>(null);
  const [module, setModule] = useState<ModuleKey>('basic');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /** 正在 AI 优化的输入框 key；同一时间只跑一个，避免并发花费。 */
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

  /** 整棵树提交；activateName 用于新建资料后按名称找回新分配的 id。 */
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
  const save = () => rows && submit(toPayload(rows), `「${active?.name || '公众号资料'}」已保存`);

  const createProfile = () => {
    if (!rows) return;
    if (dirtyRef.current) { notify('先保存或放弃当前修改，再新建公众号资料'); return; }
    const taken = new Set(rows.map(row => row.name));
    let name = '新公众号资料';
    for (let index = 2; taken.has(name); index += 1) name = `新公众号资料 ${index}`;
    void submit([...toPayload(rows), { name, subdirections: [{ name: '综合' }] }], `已新建「${name}」，在「基本资料」里改名并补全信息`, name);
    setModule('basic');
  };
  const deleteProfile = () => {
    if (!rows || !active) return;
    if (dirtyRef.current) { notify('先保存或放弃当前修改，再删除公众号资料'); return; }
    if (rows.length <= 1) { notify('至少保留一份公众号资料'); return; }
    void submit(toPayload(rows.filter(row => row.id !== profileId)), `已删除「${active.name}」`);
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
    if (!active?.name.trim() || (sub && !sub.name.trim())) { notify(sub ? '先填写资料名称和具体方向名称，再让 AI 优化' : '先在「基本资料」里填写资料名称，再让 AI 优化'); return false; }
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
    void optimize(`img:${(sub ?? active).key}`, () => window.sydney.optimizeImageStyle(request));
  };

  if (error && !rows) return <section className="ww-config"><div className="ww-group"><p className="ww-muted">公众号资料读取失败：{error}</p></div></section>;
  if (!rows) return <section className="ww-config"><div className="ww-group"><p className="ww-muted">正在读取公众号资料…</p></div></section>;

  const header = <div className="pc-head">
    <div className="ww-tabs pc-modules" role="tablist" aria-label="配置模块">
      {MODULES.map(item => <button key={item.key} role="tab" aria-selected={module === item.key} className={`ww-tab ${module === item.key ? 'is-active' : ''}`} onClick={() => setModule(item.key)}>{item.label}</button>)}
    </div>
    <button className="button button-secondary button-small" disabled={saving} onClick={createProfile}>+ 新建公众号资料</button>
  </div>;

  if (module === 'global') return <section className="ww-config">{header}<WeWriteOverviewPanel notify={notify} /></section>;
  if (!active) return <section className="ww-config">{header}<div className="ww-group"><p className="ww-muted">在页面右上角选择一份公众号资料。</p></div></section>;

  const subDefault = active.subs.find(sub => sub.id && sub.id === defaultId);

  return <section className="ww-config">
    {header}

    {module === 'basic' && <div className="ww-group">
      <div className="ww-group-head"><h3>基本资料</h3><small>资料名称用于切换；公众号名称与署名用于文章与推送</small></div>
      <div className="ww-grid">
        <label className="ww-input"><span>资料名称</span><input value={active.name} onChange={event => patchActive({ name: event.target.value })} placeholder="例如：中老年健康科普" /></label>
        <label className="ww-input"><span>公众号名称</span><input value={active.accountName} onChange={event => patchActive({ accountName: event.target.value })} placeholder="对外显示的公众号名称" /></label>
        <label className="ww-input"><span>行业</span><input value={active.industry} onChange={event => patchActive({ industry: event.target.value })} placeholder="例如：健康科普/中老年生活" /></label>
        <label className="ww-input"><span>署名</span><input value={active.author} onChange={event => patchActive({ author: event.target.value })} placeholder="推送草稿时的作者署名" /><small>留空时使用「全局服务」里的草稿默认署名。</small></label>
      </div>
      <div className="pc-danger">
        <small>删除资料不会删除文章；资料下还有文章任务时无法删除。</small>
        <ConfirmButton className="button button-quiet button-small" armedLabel={`确认删除「${active.name}」？`} onConfirm={deleteProfile}>删除这份资料</ConfirmButton>
      </div>
    </div>}

    {module === 'audience' && <div className="ww-group">
      <div className="ww-group-head"><h3>读者定位</h3><small>只作用于这份资料的选题、写作、审稿与配图</small></div>
      <div className="ww-grid">
        <label className="ww-input ww-wide"><span>目标读者</span><input value={active.audience} onChange={event => patchActive({ audience: event.target.value })} placeholder="这份资料写给谁，例如：想入门 AI 工具的职场人" /></label>
        <label className="ww-input"><span>写作语气</span><input value={active.tone} onChange={event => patchActive({ tone: event.target.value })} placeholder="例如：平和、尊重、不吓唬人" /></label>
        <label className="ww-input"><span>写作人称</span><input value={active.voice} onChange={event => patchActive({ voice: event.target.value })} placeholder="例如：第一人称，像懂行的朋友" /></label>
      </div>
    </div>}

    {module === 'template' && <div className="ww-group">
      <div className="ww-group-head"><h3>模板设置</h3><small>文章按什么模板写：人格、排版、篇幅与风格</small></div>
      <div className="ww-grid">
        <label className="ww-input"><span>写作人格</span><input value={active.persona} onChange={event => patchActive({ persona: event.target.value })} placeholder="elder-health-guide" /><small>WeWrite 人格文件名，供 agent 侧写作流程使用。</small></label>
        <label className="ww-input"><span>默认排版主题</span>
          <select value={active.theme} onChange={event => patchActive({ theme: event.target.value })}>
            <option value="">未指定（用应用默认）</option>
            {ARTICLE_THEMES.map(item => <option key={item.name} value={item.name}>{item.label}</option>)}
            {active.theme && !ARTICLE_THEMES.some(item => item.name === active.theme) && <option value={active.theme}>{active.theme}</option>}
          </select>
          <small>这份资料新建的文章默认用它；单篇可在编辑器右上角切换。</small>
        </label>
        <label className="ww-input"><span>文章篇幅</span><input value={active.wordCount} onChange={event => patchActive({ wordCount: event.target.value })} placeholder={DEFAULT_CONTENT_WORD_COUNT} /></label>
        <label className="ww-input"><span>内容风格</span><input value={active.contentStyle} onChange={event => patchActive({ contentStyle: event.target.value })} placeholder="干货" /></label>
      </div>
    </div>}

    {module === 'image' && <div className="ww-group">
      <div className="ww-group-head"><h3>配图风格模板</h3><small>这份资料的封面与正文配图；具体方向可在「具体方向」里单独覆盖</small></div>
      <ImagePromptField value={active.imagePrompt} inherited="" collapsible={false}
        onChange={imagePrompt => patchActive({ imagePrompt })}
        {...aiProps(`img:${active.key}`, () => optimizeImage(), imagePrompt => patchActive({ imagePrompt }))} />
    </div>}

    {module === 'subs' && <div className="ww-group">
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
    </div>}

    {module === 'compliance' && <div className="ww-group">
      <div className="ww-group-head"><h3>合规与禁忌</h3><small>合规要求会原样进入这份资料的生成提示词；禁忌用于生成与审稿</small></div>
      <div className="cd-field">
        <span>合规要求（这份资料的写作与配图红线）</span>
        <NoteField value={active.note} rows={7}
          placeholder="例如：不诊断、不开药方、不提供剂量疗程；不宣称根治、抗癌、排毒；配图不出现医疗符号，文字与数字要写对（可留空；写几句要点后点「AI 优化」整理成规则）"
          onChange={note => patchActive({ note })}
          {...aiProps(active.key, () => optimizeNote(), note => patchActive({ note }))} />
      </div>
      <div className="ww-grid">
        <label className="ww-input"><span>禁忌词（每行一个）</span><textarea value={active.wordsText} onChange={event => patchActive({ wordsText: event.target.value })} /></label>
        <label className="ww-input"><span>禁忌话题（每行一个）</span><textarea value={active.topicsText} onChange={event => patchActive({ topicsText: event.target.value })} /></label>
      </div>
    </div>}

    <div className="ww-savebar">
      <p>{dirty ? '有未保存修改（切换资料不会丢失，保存时一起提交）' : `编辑的是「${active.name}」；保存后写入本机，并把默认资料同步到 style.yaml`}</p>
      <div>
        <button className="button button-secondary" disabled={saving || !dirty} onClick={() => void load().catch(issue => notify(readableError(issue)))}>放弃修改</button>
        <button className="button button-primary" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </div>
  </section>;
}
