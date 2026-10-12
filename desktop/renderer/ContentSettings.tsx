import { useCallback, useEffect, useRef, useState } from 'react';
import type { WeWriteConfigDraft, WeWriteOverview } from '../shared';
import ContentDirections from './ContentDirections';
import { weWriteDraftFromOverview } from './config-draft';
import { readableError } from './ui';


/**
 * 创作设置：模板设置、公众号资料、读者定位、内容类别四组值直接放在创作流水线里。
 *
 * 这些值会进入 content-workflow 的生成提示词（读者定位、篇幅、语气），或决定推送与
 * 兼容预览的排版（主题），所以在写文章的界面里就能看见和改。写的是同一份
 * ~/.wewrite/style.yaml，与「环境与配置」互通。
 */
export default function ContentSettingsPanel({ notify, onSaved }: {
  notify: (message: string) => void;
  onSaved?: (overview: WeWriteOverview) => void;
}) {
  const [overview, setOverview] = useState<WeWriteOverview | null>(null);
  const [draft, setDraft] = useState<WeWriteConfigDraft | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const apply = useCallback((next: WeWriteOverview) => {
    setOverview(next);
    setDraft(weWriteDraftFromOverview(next));
    setDirty(false);
    return next;
  }, []);

  const load = useCallback(async () => {
    const next = apply(await window.sydney.getWeWriteOverview());
    setError('');
    // 还没配过读者定位或默认类别时直接展开，否则新用户看不到入口。
    if (!next.style.targetAudience || !next.style.defaultTopic) setOpen(true);
    return next;
  }, [apply]);

  useEffect(() => {
    let alive = true;
    void load().catch(issue => { if (alive) setError(readableError(issue)); });
    // 在「环境与配置」里改过配置时同步过来；本地有未保存修改时不覆盖。
    const off = window.sydney.onWeWriteChanged(() => { if (!dirtyRef.current) void load().catch(() => undefined); });
    return () => { alive = false; off(); };
  }, [load]);

  const patchStyle = (patch: Partial<WeWriteConfigDraft['style']>) => {
    setDirty(true);
    setDraft(current => current ? { ...current, style: { ...current.style, ...patch } } : current);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await window.sydney.saveWeWriteConfig(draft);
      apply(next);
      setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      onSaved?.(next);
      notify('创作设置已保存');
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setSaving(false);
    }
  };

  if (error && !overview) return <section className="flow-settings"><p className="ww-muted">创作设置读取失败：{error}</p></section>;
  if (!overview || !draft) return <section className="flow-settings"><p className="ww-muted">正在读取创作设置…</p></section>;

  const style = draft.style;
  const faces = [
    { label: '模板', value: [style.persona || '未设人格', style.theme || '默认排版', style.wordCount || '未设篇幅'].join(' · ') },
    { label: '公众号', value: style.name ? `${style.name}${style.author ? ` · 署名 ${style.author}` : ''}` : '未设置' },
    { label: '读者定位', value: style.targetAudience || '未设置' },
    { label: '内容类别', value: style.defaultTopic || '未指定' }
  ];

  return <section className="flow-settings">
    <header className="flow-settings-head">
      <div>
        <h2>创作设置</h2>
        <p>模板设置、公众号资料、读者定位、内容类别。这些值会写进生成提示词，选题、任务书与初稿都按它来。</p>
      </div>
      <div className="flow-settings-actions">
        {dirty && <span className="flow-dirty">有未保存修改</span>}
        <button className="button button-secondary" onClick={() => setOpen(current => !current)}>{open ? '收起编辑' : '展开编辑'}</button>
      </div>
    </header>

    <div className="flow-settings-summary">
      {faces.map(item => <span key={item.label}><b>{item.label}</b>{item.value}</span>)}
    </div>

    {open && <div className="flow-settings-body">
      <div className="ww-group">
        <div className="ww-group-head"><h3>模板设置</h3><small>文章按什么模板写：人格、排版、篇幅与风格</small></div>
        <div className="ww-grid">
          <label className="ww-input"><span>写作人格</span>
            <input value={style.persona} onChange={event => patchStyle({ persona: event.target.value })} placeholder="elder-health-guide" />
            <small>{overview.files.persona ? `当前生效：${overview.files.persona}` : '未检测到自定义人格，将使用 skill 里的默认人格'}</small>
          </label>
          <label className="ww-input"><span>默认排版主题</span>
            <select value={style.theme} onChange={event => patchStyle({ theme: event.target.value })}>
              <option value="">未指定</option>
              {overview.themes.map(item => <option key={item.name} value={item.name}>{item.description ? `${item.name} · ${item.description}` : item.name}</option>)}
              {style.theme && !overview.themes.some(item => item.name === style.theme) && <option value={style.theme}>{style.theme}</option>}
            </select>
            <small>用于 WeWrite 兼容预览与推送；单篇文章的排版主题在编辑器右上角切换。</small>
          </label>
          <label className="ww-input"><span>文章篇幅</span><input value={style.wordCount} onChange={event => patchStyle({ wordCount: event.target.value })} placeholder="1200-1800" /></label>
          <label className="ww-input"><span>内容风格</span><input value={style.contentStyle} onChange={event => patchStyle({ contentStyle: event.target.value })} placeholder="干货" /></label>
        </div>
      </div>

      <div className="ww-group">
        <div className="ww-group-head"><h3>公众号资料</h3><small>显示名称与署名</small></div>
        <div className="ww-grid ww-grid-three">
          <label className="ww-input"><span>公众号名称</span><input value={style.name} onChange={event => patchStyle({ name: event.target.value })} placeholder="例如：中老年健康科普" /></label>
          <label className="ww-input"><span>行业</span><input value={style.industry} onChange={event => patchStyle({ industry: event.target.value })} placeholder="健康科普/中老年生活" /></label>
          <label className="ww-input"><span>署名</span><input value={style.author} onChange={event => patchStyle({ author: event.target.value })} placeholder="文章作者署名" /></label>
        </div>
      </div>

      <div className="ww-group">
        <div className="ww-group-head"><h3>读者定位</h3><small>决定选题与表达取舍</small></div>
        <div className="ww-grid">
          <label className="ww-input ww-wide"><span>目标读者</span><input value={style.targetAudience} onChange={event => patchStyle({ targetAudience: event.target.value })} placeholder="例如：55-75岁关注自身健康的中老年读者，以及替父母查资料的子女" /></label>
          <label className="ww-input"><span>写作语气</span><input value={style.tone} onChange={event => patchStyle({ tone: event.target.value })} placeholder="平和、尊重、不吓唬人" /></label>
          <label className="ww-input"><span>写作人称</span><input value={style.voice} onChange={event => patchStyle({ voice: event.target.value })} placeholder="第一人称，像懂行的邻居" /></label>
        </div>
      </div>

      <ContentDirections notify={notify} />

      <div className="ww-savebar">
        <p>{savedAt ? `已保存于 ${savedAt}` : '修改后点保存，写入本机 ~/.wewrite/style.yaml（与「环境与配置」是同一份）'}</p>
        <div>
          <button className="button button-secondary" disabled={saving} onClick={() => void load().catch(issue => notify(readableError(issue)))}>放弃修改</button>
          <button className="button button-primary" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button>
        </div>
      </div>
    </div>}
  </section>;
}
