import type { ContentDirection } from '../shared';

/**
 * 创作设置摘要：在写文章的界面里只读展示当前公众号资料的模板、资料与读者定位。
 *
 * 编辑入口统一在「环境与配置」，这里不再放一份重复的表单——两处都能改时，
 * 用户分不清哪边的值才算数。切换资料时跟着变，生成时用的也是这一份。
 */
export default function ContentSettingsPanel({ profile, onOpenConfig }: { profile: ContentDirection | null; onOpenConfig: () => void }) {
  if (!profile) return <details className="flow-settings" open><summary><strong>创作设置</strong><small>还没有公众号资料</small></summary><div className="flow-settings-body"><p className="ww-muted">请先在「环境与配置」里新建公众号资料。</p><button className="button button-primary" onClick={onOpenConfig}>去环境与配置</button></div></details>;
  const missing = !profile.audience;
  const faces = [
    { label: '公众号', value: profile.accountName ? `${profile.accountName}${profile.author ? ` · 署名 ${profile.author}` : ''}` : '未设置' },
    { label: '模板', value: [profile.persona || '未设人格', profile.theme || '默认排版', profile.wordCount || '未设篇幅'].join(' · ') },
    { label: '读者定位', value: profile.audience || '未设置' },
    { label: '语气 / 人称', value: [profile.tone, profile.voice].filter(Boolean).join(' · ') || '未设置' }
  ];
  return <details className={`flow-settings ${missing ? 'is-incomplete' : ''}`}>
    <summary>
      <span><strong>创作设置 · {profile.name}</strong><small>{missing ? '未设置读者定位，建议先补上' : `${profile.audience} · ${profile.theme || '默认排版'}`}</small></span>
      <span className="flow-settings-hint">详情</span>
    </summary>
    <div className="flow-settings-body">
      <p>这些值会写进这份资料的生成提示词，选题、任务书、初稿与配图都按它来。</p>
      <div className="flow-settings-summary">
        {faces.map(item => <span key={item.label}><b>{item.label}</b>{item.value}</span>)}
      </div>
      <button className={`button ${missing ? 'button-primary' : 'button-secondary'}`} onClick={onOpenConfig}>在「环境与配置」中修改</button>
    </div>
  </details>;
}
