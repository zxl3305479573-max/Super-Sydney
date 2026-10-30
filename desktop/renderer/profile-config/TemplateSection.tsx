import { DEFAULT_CONTENT_WORD_COUNT } from '../../shared';
import { ARTICLE_THEMES } from '../../services/article-html';
import type { ProfileRow } from './types';

export function TemplateSection({ active, patchActive }: {
  active: ProfileRow;
  patchActive: (patch: Partial<ProfileRow>) => void;
}) {
  return <div className="ww-group">
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
  </div>;
}
