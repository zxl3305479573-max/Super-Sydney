import { ConfirmButton } from '../ui';
import type { ProfileRow } from './types';

export function BasicSection({ active, patchActive, deleteProfile }: {
  active: ProfileRow;
  patchActive: (patch: Partial<ProfileRow>) => void;
  deleteProfile: () => void;
}) {
  return <div className="ww-group">
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
  </div>;
}
