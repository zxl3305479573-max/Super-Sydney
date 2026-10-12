import type { ContentDirection } from '../shared';

/**
 * 创作设置摘要：在写文章的界面里只读展示当前公众号资料的模板、资料与读者定位。
 *
 * 编辑入口统一在「环境与配置」，这里不再放一份重复的表单——两处都能改时，
 * 用户分不清哪边的值才算数。切换资料时跟着变，生成时用的也是这一份。
 */
export default function ContentSettingsPanel({ profile, onOpenConfig }: { profile: ContentDirection | null; onOpenConfig: () => void }) {
  if (!profile) return <section className="flow-settings"><p className="ww-muted">还没有公众号资料，请先在「环境与配置」里新建。</p></section>;
  const missing = !profile.audience;
  const faces = [
    { label: '公众号', value: profile.accountName ? `${profile.accountName}${profile.author ? ` · 署名 ${profile.author}` : ''}` : '未设置' },
    { label: '模板', value: [profile.persona || '未设人格', profile.theme || '默认排版', profile.wordCount || '未设篇幅'].join(' · ') },
    { label: '读者定位', value: profile.audience || '未设置' },
    { label: '语气 / 人称', value: [profile.tone, profile.voice].filter(Boolean).join(' · ') || '未设置' }
  ];
  return <section className="flow-settings">
    <header className="flow-settings-head">
      <div>
        <h2>创作设置 · {profile.name}</h2>
        <p>这些值会写进这份资料的生成提示词，选题、任务书、初稿与配图都按它来。{missing && '还没有设置读者定位，建议先补上。'}</p>
      </div>
      <div className="flow-settings-actions">
        <button className={`button ${missing ? 'button-primary' : 'button-secondary'}`} onClick={onOpenConfig}>在「环境与配置」中修改</button>
      </div>
    </header>
    <div className="flow-settings-summary">
      {faces.map(item => <span key={item.label}><b>{item.label}</b>{item.value}</span>)}
    </div>
  </section>;
}
