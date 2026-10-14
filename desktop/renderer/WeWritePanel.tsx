import { useCallback, useEffect, useState } from 'react';
import type { ContentTaxonomy } from '../shared';
import EmbeddedSitePanel from './EmbeddedSitePanel';
import NativeContentPanel from './NativeContentPanel';
import ProfileConfig from './ProfileConfig';
import WeWriteStats from './WeWriteStats';
import { findDirectionById, initialProfileId } from './content-taxonomy';
import { readableError } from './ui';

/** 上次选中的公众号资料只是界面便利，存在本机；读写失败时退回默认资料。 */
const PROFILE_KEY = 'sydney.wewrite.profile';
function rememberedProfile(): number | null {
  try { return Number(window.localStorage.getItem(PROFILE_KEY)) || null; } catch { return null; }
}
function rememberProfile(id: number | null): void {
  try { if (id) window.localStorage.setItem(PROFILE_KEY, String(id)); } catch { /* 无痕模式等场景下忽略 */ }
}

/**
 * 公众号工作区。每个一级内容方向就是一份「公众号资料」：页面顶部切换当前资料，
 * 创作流水线、文章数据、环境与配置都只显示和修改这份资料的内容。
 */
export default function WeWritePanel({ notify, overlay }: { notify: (message: string) => void; overlay: boolean }) {
  const [tab, setTab] = useState<'native' | 'stats' | 'config' | 'mp'>('native');
  const [taxonomy, setTaxonomy] = useState<ContentTaxonomy | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);

  const applyTaxonomy = useCallback((next: ContentTaxonomy, preferred?: number | null) => {
    setTaxonomy(next);
    setProfileId(current => initialProfileId(next, preferred ?? current ?? rememberedProfile()));
  }, []);

  useEffect(() => {
    window.sydney.getContentTaxonomy().then(next => applyTaxonomy(next)).catch(issue => notify(readableError(issue)));
  }, [applyTaxonomy, notify]);
  useEffect(() => { rememberProfile(profileId); }, [profileId]);

  const profile = findDirectionById(taxonomy?.directions ?? [], profileId);

  return <section className="wewrite">
    <header className="ww-page-header">
      <div>
        <p className="eyebrow">内容工作区</p>
        <h1>公众号</h1>
        <p>选题 → 任务书 → 来源与证据 → 初稿 → AI 审稿 → 封面 → 导出与发布，每一步状态都在界面上可见。</p>
      </div>
      <label className="ww-profile-switch">
        <span>当前公众号资料</span>
        <select value={profileId ?? ''} onChange={event => setProfileId(Number(event.target.value) || null)} disabled={!taxonomy}>
          {(taxonomy?.directions ?? []).map(item => <option key={item.id} value={item.id}>{item.name}{item.accountName && item.accountName !== item.name ? ` · ${item.accountName}` : ''}</option>)}
        </select>
        <small>{profile ? [profile.audience ? `读者：${profile.audience}` : '未设置读者定位', profile.theme || '默认排版'].join(' · ') : '正在读取…'}</small>
      </label>
    </header>
    <div className="ww-tabs">
      <button className={`ww-tab ${tab === 'native' ? 'is-active' : ''}`} onClick={() => setTab('native')}>创作流水线</button>
      <button className={`ww-tab ${tab === 'stats' ? 'is-active' : ''}`} onClick={() => setTab('stats')}>文章数据</button>
      <button className={`ww-tab ${tab === 'config' ? 'is-active' : ''}`} onClick={() => setTab('config')}>环境与配置</button>
      <button className={`ww-tab ${tab === 'mp' ? 'is-active' : ''}`} title="在应用里打开微信公众平台（创作者发布平台）" onClick={() => setTab('mp')}>公众号后台</button>
    </div>
    {/* key 绑定资料：切换资料时子面板整体重建，不会把上一份资料的选中状态带过来。 */}
    {tab === 'native' && <NativeContentPanel key={profileId ?? 0} profile={profile} notify={notify} onOpenConfig={() => setTab('config')} onOpenBackend={() => setTab('mp')} />}
    {tab === 'stats' && <WeWriteStats key={profileId ?? 0} profile={profile} notify={notify} />}
    {tab === 'config' && <ProfileConfig profileId={profileId} notify={notify} onSaved={(next, activate) => applyTaxonomy(next, activate)} />}
    {/* 不随资料切换重建：后台登录的是哪个公众号由页面里的扫码决定，与当前资料无关。 */}
    {tab === 'mp' && <EmbeddedSitePanel key="wechatMp" siteKey="wechatMp" label="公众号后台" overlay={overlay}
      privacy="页面由微信公众平台提供，登录请在页面里扫码完成；应用不读它的 cookie，也不往页面里注入脚本，发表、群发都由你在页面里自己操作。" />}
  </section>;
}
