import { NoteField, type AiProps } from './fields';
import type { ProfileRow } from './types';

export function ComplianceSection({ active, patchActive, aiProps, optimizeNote }: {
  active: ProfileRow;
  patchActive: (patch: Partial<ProfileRow>) => void;
  aiProps: (fieldKey: string, run: () => void, adopt: (note: string) => void) => AiProps;
  optimizeNote: () => void;
}) {
  return <div className="ww-group">
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
  </div>;
}
