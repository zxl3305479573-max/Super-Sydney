import { useCallback, useEffect, useState } from 'react';
import type { WeWriteConfigDraft, WeWriteOverview } from '../shared';
import { CONTENT_CATEGORY_LABELS } from './content-categories';
import { emptyWeWriteDraft, splitLines, weWriteDraftFromOverview } from './config-draft';

const STATUS_TEXT: Record<string, string> = { PASS: '通过', WARN: '警告', FAIL: '失败', SKIP: '跳过' };
const STATUS_CLASS: Record<string, string> = { PASS: 'approved', WARN: 'pending', FAIL: 'rejected', SKIP: 'rejected' };

const CATEGORIES = CONTENT_CATEGORY_LABELS;
const PROVIDERS = ['openai', 'doubao', 'dashscope', 'jimeng', 'minimax', 'gemini', 'openrouter', 'replicate', 'azure_openai', 'sub2api'];

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '').trim() || '操作失败';
}

export default function WeWriteOverviewPanel({ notify }: { notify: (message: string) => void }) {
  const [overview, setOverview] = useState<WeWriteOverview | null>(null);
  const [draft, setDraft] = useState<WeWriteConfigDraft>(emptyWeWriteDraft);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [listText, setListText] = useState({ topics: '', words: '', forbiddenTopics: '' });
  const [savedAt, setSavedAt] = useState('');

  const load = useCallback(async () => {
    const next = await window.sydney.getWeWriteOverview();
    setOverview(next);
    setDraft(weWriteDraftFromOverview(next));
    setListText({ topics: next.style.topics.join('\n'), words: next.style.blacklistWords.join('\n'), forbiddenTopics: next.style.blacklistTopics.join('\n') });
    setError('');
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    void load().catch(issue => { if (alive) setError(readableError(issue)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [load]);

  const patchStyle = (patch: Partial<WeWriteConfigDraft['style']>) => setDraft(current => ({ ...current, style: { ...current.style, ...patch } }));
  const patchWechat = (patch: Partial<WeWriteConfigDraft['wechat']>) => setDraft(current => ({ ...current, wechat: { ...current.wechat, ...patch } }));
  const patchWriter = (patch: Partial<NonNullable<WeWriteConfigDraft['writer']>>) => setDraft(current => ({ ...current, writer: { baseUrl: '', model: '', apiKey: '', enabled: false, ...current.writer, ...patch } }));
  const patchImage = (patch: Partial<WeWriteConfigDraft['image']>) => setDraft(current => ({ ...current, image: { ...current.image, ...patch } }));

  const save = async () => {
    setSaving(true);
    try {
      const next = await window.sydney.saveWeWriteConfig({ ...draft, style: { ...draft.style, topics: splitLines(listText.topics), blacklistWords: splitLines(listText.words), blacklistTopics: splitLines(listText.forbiddenTopics) } });
      setOverview(next);
      setDraft(weWriteDraftFromOverview(next));
      setListText({ topics: next.style.topics.join('\n'), words: next.style.blacklistWords.join('\n'), forbiddenTopics: next.style.blacklistTopics.join('\n') });
      setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      notify('公众号配置已保存');
    } catch (issue) {
      notify(readableError(issue));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <section className="section-heading"><div><h2>环境与配置</h2><p>正在读取配置…</p></div></section>;
  if (error && !overview) return <section className="section-heading"><div><h2>环境与配置</h2><p>{error}</p></div></section>;
  if (!overview) return null;

  const { summary, checks, files, flags } = overview;

  return <section className="ww-config">
    <div className="ww-status">
      <span className={`adapter-state ${summary.failures ? 'adapter-error' : summary.warnings ? 'adapter-stopped' : 'adapter-listening'}`}>
        {summary.failures ? `${summary.failures} 项失败` : summary.warnings ? `${summary.warnings} 项警告` : '全部通过'}
      </span>
      <span><b>配置目录</b>{overview.home}</span>
      <span><b>图片服务</b>{flags.skipImageGen ? '未配置' : '可用'}</span>
      <span><b>微信草稿箱</b>{flags.skipPublish ? '未配置' : '可用'}</span>
    </div>

    <div className="ww-group">
      <div className="ww-group-head"><h3>公众号资料</h3><small>显示名称与署名</small></div>
      <div className="ww-grid ww-grid-three">
        <label className="ww-input"><span>公众号名称</span><input value={draft.style.name} onChange={event => patchStyle({ name: event.target.value })} placeholder="例如：中老年健康科普" /></label>
        <label className="ww-input"><span>行业</span><input value={draft.style.industry} onChange={event => patchStyle({ industry: event.target.value })} placeholder="健康科普/中老年生活" /></label>
        <label className="ww-input"><span>署名</span><input value={draft.style.author} onChange={event => patchStyle({ author: event.target.value })} placeholder="文章作者署名" /></label>
      </div>
    </div>

    <div className="ww-group">
      <div className="ww-group-head"><h3>读者定位</h3><small>决定选题与表达取向</small></div>
      <div className="ww-grid">
        <label className="ww-input ww-wide"><span>目标读者</span><input value={draft.style.targetAudience} onChange={event => patchStyle({ targetAudience: event.target.value })} placeholder="例如：55-75岁关注自身健康的中老年读者，以及替父母查资料的子女" /></label>
        <label className="ww-input"><span>写作语气</span><input value={draft.style.tone} onChange={event => patchStyle({ tone: event.target.value })} placeholder="平和、尊重、不吓唬人" /></label>
        <label className="ww-input"><span>写作人称</span><input value={draft.style.voice} onChange={event => patchStyle({ voice: event.target.value })} placeholder="第一人称，像懂行的邻居" /></label>
        <label className="ww-input"><span>文章篇幅</span><input value={draft.style.wordCount} onChange={event => patchStyle({ wordCount: event.target.value })} placeholder="1200-1800" /></label>
        <label className="ww-input"><span>内容风格</span><input value={draft.style.contentStyle} onChange={event => patchStyle({ contentStyle: event.target.value })} placeholder="干货" /></label>
      </div>
    </div>

    <div className="ww-group">
      <div className="ww-group-head"><h3>内容类别</h3><small>新建文章时的默认类别</small></div>
      <div className="ww-grid">
        <label className="ww-input"><span>默认类别（下拉选择）</span>
          <select value={draft.style.defaultTopic} onChange={event => patchStyle({ defaultTopic: event.target.value })}>
            <option value="">未指定</option>
            {CATEGORIES.map(item => <option key={item} value={item}>{item}</option>)}
            {draft.style.defaultTopic && !CATEGORIES.includes(draft.style.defaultTopic) && <option value={draft.style.defaultTopic}>{draft.style.defaultTopic}</option>}
          </select>
          <small>来自 style.yaml 的 default_topic，并会排到内容方向第一位</small>
        </label>
        <label className="ww-input"><span>写作人格</span><input value={draft.style.persona} onChange={event => patchStyle({ persona: event.target.value })} placeholder="elder-health-guide" /><small>{files.persona ? `当前生效：${files.persona}` : '未检测到自定义人格'}</small></label>
        <label className="ww-input"><span>默认排版主题</span>
          <select value={draft.style.theme} onChange={event => patchStyle({ theme: event.target.value })}>
            <option value="">未指定</option>
            {overview.themes.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
            {draft.style.theme && !overview.themes.some(item => item.name === draft.style.theme) && <option value={draft.style.theme}>{draft.style.theme}</option>}
          </select>
        </label>
        <label className="ww-input"><span>内容方向（每行一个）</span><textarea value={listText.topics} onChange={event => setListText(current => ({ ...current, topics: event.target.value }))} /></label>
      </div>
    </div>

    <div className="ww-group">
      <div className="ww-group-head"><h3>合规与禁忌</h3><small>写入 style.yaml 的 blacklist</small></div>
      <div className="ww-grid">
        <label className="ww-input"><span>禁忌词（每行一个）</span><textarea value={listText.words} onChange={event => setListText(current => ({ ...current, words: event.target.value }))} /></label>
        <label className="ww-input"><span>禁忌话题（每行一个）</span><textarea value={listText.forbiddenTopics} onChange={event => setListText(current => ({ ...current, forbiddenTopics: event.target.value }))} /></label>
      </div>
    </div>

    <div className="ww-group">
      <div className="ww-group-head"><h3>内容生成 API</h3><small>直接由桌面端调用，无需 pi</small></div>
      <label className="ww-writer-toggle"><input type="checkbox" checked={draft.writer?.enabled ?? false} onChange={event => patchWriter({ enabled: event.target.checked })} />允许在主动点击生成、写作或审稿时发送该文章内容</label>
      <div className="ww-grid">
        <label className="ww-input"><span>接口地址</span><input value={draft.writer?.baseUrl ?? ''} onChange={event => patchWriter({ baseUrl: event.target.value })} placeholder="https://api.deepseek.com/v1" /></label>
        <label className="ww-input"><span>模型</span><input value={draft.writer?.model ?? ''} onChange={event => patchWriter({ model: event.target.value })} placeholder="deepseek-chat" /></label>
        <label className="ww-input ww-wide"><span>内容 API Key</span><input type="password" value={draft.writer?.apiKey ?? ''} onChange={event => patchWriter({ apiKey: event.target.value })} placeholder={overview.writer.apiKeyMasked ? `已配置 ${overview.writer.apiKeyMasked}，留空保留` : '填写新的密钥'} /><small>使用系统安全存储，复用现有 DeepSeek 密钥；不会写入 YAML 或回传明文。</small></label>
      </div>
    </div>

    <div className="ww-group">
      <div className="ww-group-head"><h3>图片服务</h3><small>{flags.skipImageGen ? '当前不可用' : '当前可用'}</small></div>
      <div className="ww-grid ww-grid-three">
        <label className="ww-input"><span>Provider</span>
          <select value={draft.image.provider} onChange={event => patchImage({ provider: event.target.value })}>
            <option value="">未选择</option>
            {PROVIDERS.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="ww-input"><span>模型</span><input value={draft.image.model} onChange={event => patchImage({ model: event.target.value })} placeholder="gpt-image-2" /></label>
        <label className="ww-input"><span>预估单价</span><input value={draft.image.estimatedCost} onChange={event => patchImage({ estimatedCost: event.target.value })} placeholder="0.04" /></label>
        <label className="ww-input ww-wide"><span>接口地址</span><input value={draft.image.baseUrl} onChange={event => patchImage({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label className="ww-input ww-wide"><span>API Key</span>
          <input type="password" value={draft.image.apiKey} onChange={event => patchImage({ apiKey: event.target.value })} placeholder={overview.image.apiKeyMasked ? `已配置 ${overview.image.apiKeyMasked}，留空则保留` : '输入图片服务 API Key'} />
          <small>留空表示保留现有密钥；密钥只写入本机 ~/.wewrite/config.yaml，不会回传到界面。</small>
        </label>
      </div>
    </div>

    <div className="ww-group">
      <div className="ww-group-head"><h3>微信草稿箱</h3><small>{flags.skipPublish ? '未配置，推送会降级为本地预览' : '已配置'}</small></div>
      <div className="ww-grid">
        <label className="ww-input"><span>AppID</span><input value={draft.wechat.appid} onChange={event => patchWechat({ appid: event.target.value })} placeholder={flags.skipPublish ? '输入公众号 AppID' : '留空则保留现有 AppID'} /></label>
        <label className="ww-input"><span>AppSecret</span><input type="password" value={draft.wechat.secret} onChange={event => patchWechat({ secret: event.target.value })} placeholder={flags.skipPublish ? '输入公众号 AppSecret' : '留空则保留现有 Secret'} /></label>
        <label className="ww-input ww-wide"><span>草稿默认署名</span><input value={draft.wechat.author} onChange={event => patchWechat({ author: event.target.value })} placeholder="留空则使用公众号资料中的署名" /></label>
      </div>
      <p className="ww-muted">未配置凭证时，排版与预览仍可本地完成，仅推送草稿箱不可用。</p>
    </div>

    <div className="ww-savebar">
      <p>{savedAt ? `已保存于 ${savedAt}` : '修改后点击保存，写入本机 ~/.wewrite 的 style.yaml 与 config.yaml'}</p>
      <div>
        <button className="button button-secondary" disabled={saving} onClick={() => void load().catch(issue => notify(readableError(issue)))}>放弃修改</button>
        <button className="button button-primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存配置'}</button>
      </div>
    </div>

    <details className="ww-group">
      <summary className="ww-group-head"><h3>自检明细</h3><small>通过 {summary.passed} · 警告 {summary.warnings} · 失败 {summary.failures} · 跳过 {summary.skipped}</small></summary>
      <div className="ww-check-row">
        <span className={`status status-${files.configYaml ? 'approved' : 'rejected'}`}>config.yaml</span>
        <span className={`status status-${files.styleYaml ? 'approved' : 'rejected'}`}>style.yaml</span>
        <span className={`status status-${files.playbookMd ? 'approved' : 'rejected'}`}>playbook.md</span>
        <span className={`status status-${files.historyYaml ? 'approved' : 'rejected'}`}>history.yaml</span>
      </div>
      {checks.map(check => <div key={`${check.group}-${check.name}`} className="ww-check-group">
        <h4>{check.group}</h4>
        <ul><li>
          <span className={`status status-${STATUS_CLASS[check.status] ?? 'pending'}`}>{STATUS_TEXT[check.status] ?? check.status}</span>
          <div><strong>{check.name}</strong>{check.detail && <small>{check.detail}</small>}</div>
        </li></ul>
      </div>)}
      {overview.recommendations.length > 0 && <ul className="ww-recos">{overview.recommendations.map(item => <li key={item}>{item}</li>)}</ul>}
    </details>
  </section>;
}
