import type { ProfileRow } from './types';

export function AudienceSection({ active, patchActive }: {
  active: ProfileRow;
  patchActive: (patch: Partial<ProfileRow>) => void;
}) {
  return <div className="ww-group">
    <div className="ww-group-head"><h3>读者定位</h3><small>只作用于这份资料的选题、写作、审稿与配图</small></div>
    <div className="ww-grid">
      <label className="ww-input ww-wide"><span>目标读者</span><input value={active.audience} onChange={event => patchActive({ audience: event.target.value })} placeholder="这份资料写给谁，例如：想入门 AI 工具的职场人" /></label>
      <label className="ww-input"><span>写作语气</span><input value={active.tone} onChange={event => patchActive({ tone: event.target.value })} placeholder="例如：平和、尊重、不吓唬人" /></label>
      <label className="ww-input"><span>写作人称</span><input value={active.voice} onChange={event => patchActive({ voice: event.target.value })} placeholder="例如：第一人称，像懂行的朋友" /></label>
    </div>
  </div>;
}
