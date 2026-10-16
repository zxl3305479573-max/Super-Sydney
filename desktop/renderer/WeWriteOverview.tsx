import { useCallback, useEffect, useState } from 'react';
import type { WeWriteConfigDraft, WeWriteOverview } from '../shared';
import { emptyWeWriteDraft, weWriteDraftFromOverview } from './config-draft';
import { readableError } from './ui';

const STATUS_TEXT: Record<string, string> = { PASS: '通过', WARN: '警告', FAIL: '失败', SKIP: '跳过' };
const STATUS_CLASS: Record<string, string> = { PASS: 'approved', WARN: 'pending', FAIL: 'rejected', SKIP: 'rejected' };

/**
 * 「全局服务」：微信草稿箱凭证与自检。内容模型与图片模型已统一到「设置 → 模型」，这里不再单独配置。
 * 写作相关的配置（资料、读者、模板、禁忌等）已按公众号资料隔离，在 ProfileConfig 里编辑；
 * 这里保存时 style.yaml 原样带回，不会改动资料同步过去的值。
 */
export default function WeWriteOverviewPanel({ notify }: { notify: (message: string) => void }) {
  const [overview, setOverview] = useState<WeWriteOverview | null>(null);
  const [draft, setDraft] = useState<WeWriteConfigDraft>(emptyWeWriteDraft);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');

  const load = useCallback(async () => {
    const next = await window.sydney.getWeWriteOverview();
    setOverview(next);
    setDraft(weWriteDraftFromOverview(next));
    setError('');
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    void load().catch(issue => { if (alive) setError(readableError(issue)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [load]);

  const patchWechat = (patch: Partial<WeWriteConfigDraft['wechat']>) => setDraft(current => ({ ...current, wechat: { ...current.wechat, ...patch } }));
  const save = async () => {
    setSaving(true);
    try {
      const next = await window.sydney.saveWeWriteConfig(draft);
      setOverview(next);
      setDraft(weWriteDraftFromOverview(next));
      setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      notify('全局服务配置已保存');
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

    <p className="ww-muted">内容模型与图片模型在「设置 → 模型」统一配置，公众号、视频、小红书共用同一套。</p>

    <div className="ww-group">
      <div className="ww-group-head"><h3>微信草稿箱</h3><small>{flags.skipPublish ? '未配置，推送会降级为本地预览' : '已配置'}</small></div>
      <div className="ww-grid">
        <label className="ww-input"><span>AppID</span><input value={draft.wechat.appid} onChange={event => patchWechat({ appid: event.target.value })} placeholder={flags.skipPublish ? '输入公众号 AppID' : '留空则保留现有 AppID'} /></label>
        <label className="ww-input"><span>AppSecret</span><input type="password" value={draft.wechat.secret} onChange={event => patchWechat({ secret: event.target.value })} placeholder={flags.skipPublish ? '输入公众号 AppSecret' : '留空则保留现有 Secret'} /></label>
        <label className="ww-input ww-wide"><span>草稿默认署名</span><input value={draft.wechat.author} onChange={event => patchWechat({ author: event.target.value })} placeholder="公众号资料没填署名时使用" /></label>
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

