import { useEffect, useMemo, useState } from 'react';
import type { ContentTask, WechatIpCoverInput } from '../../shared';
import { WECHAT_COVER_SIZE, WECHAT_IP_COVER_STYLES, WECHAT_SHARE_SIZE, emptyWechatIpCoverInput, renderWechatIpCover, wechatCoverPose } from '../../services/wechat-ip-cover';
import { IpPicker, useIpKit, useIpLibrary } from '../IpLibrary';

/**
 * 公众号封面步骤里的 IP 模板：选 IP（公众号模块记住上次选的）、填字段、预览 2.35:1 封面与 1:1 分享图，
 * 确认后主进程本地截图：封面写成这篇的封面，分享图另存。不消耗图片接口额度。
 * 填过的字段按文章存在本机（localStorage）。
 */

const storageKey = (taskId: number) => `sydney.wechat.ip-cover.${taskId}`;

function loadInput(task: ContentTask): WechatIpCoverInput {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(task.id)) ?? 'null') as WechatIpCoverInput | null;
    if (saved && typeof saved.title === 'string') return { ...emptyWechatIpCoverInput(), ...saved };
  } catch { /* 本机存储不可用就从默认值开始 */ }
  return emptyWechatIpCoverInput(task.title || task.topic);
}

function ScaledFrame({ html, width, height, scale, title }: { html: string; width: number; height: number; scale: number; title: string }) {
  return <div className="xhs-ip-preview" style={{ width: width * scale, height: height * scale }}>
    <iframe title={title} sandbox="" srcDoc={html} width={width} height={height} style={{ transform: `scale(${scale})` }} />
  </div>;
}

export function WechatIpCoverPanel({ task, locked, busy, onRender }: {
  task: ContentTask; locked: boolean; busy: boolean;
  onRender: (input: WechatIpCoverInput) => Promise<{ path: string; thumbnail: string } | null>;
}) {
  const { view } = useIpLibrary();
  const ipId = view.selections.wechat;
  const { kit, error } = useIpKit(ipId);
  const [input, setInput] = useState<WechatIpCoverInput>(() => loadInput(task));
  const [share, setShare] = useState<{ path: string; thumbnail: string } | null>(null);
  useEffect(() => { setInput(loadInput(task)); setShare(null); }, [task.id]);
  useEffect(() => { try { localStorage.setItem(storageKey(task.id), JSON.stringify(input)); } catch { /* 忽略 */ } }, [task.id, input]);
  const set = (patch: Partial<WechatIpCoverInput>) => setInput(current => ({ ...current, ...patch }));
  const cover = useMemo(() => kit ? renderWechatIpCover(input, kit, 'cover') : '', [input, kit]);
  const square = useMemo(() => kit ? renderWechatIpCover(input, kit, 'share') : '', [input, kit]);
  const pose = kit ? wechatCoverPose(input, kit) : null;
  const select = (id: string) => void window.sydney.selectIp('wechat', id).catch(() => undefined);

  return <div className="wechat-ip">
    <div className="xhs-ip-head">
      <IpPicker label="公众号用的 IP" value={ipId} ips={view.ips} disabled={locked} onChange={select} />
      <small className="ww-muted">选了 IP 后，「AI 生成封面 / 配图」会把 IP 角色融进画面（参考图一起传给图片接口，不加品牌名和头像）；下面的模板可以本地出图，不花钱。</small>
    </div>
    {ipId && <div className="xhs-ip-cover">
      <div className="wechat-ip-previews">
        {cover ? <>
          <ScaledFrame html={cover} width={WECHAT_COVER_SIZE.width} height={WECHAT_COVER_SIZE.height} scale={0.34} title="封面预览（2.35:1）" />
          <ScaledFrame html={square} width={WECHAT_SHARE_SIZE.width} height={WECHAT_SHARE_SIZE.height} scale={0.26} title="分享图预览（1:1）" />
        </> : <div className="flow-image-missing">{error || 'IP 素材加载中…'}</div>}
      </div>
      <div className="xhs-ip-form">
        <div className="xhs-style-picks">{WECHAT_IP_COVER_STYLES.map(item => <button key={item.key} className={`xhs-style xhs-ip-pick ${input.style === item.key ? 'is-active' : ''}`} disabled={locked} onClick={() => set({ style: item.key })}>
          <strong>{item.label}</strong><small>{item.hint}</small>
        </button>)}</div>
        {kit && kit.poses.length > 1 && <label className="xhs-field"><span>角色动作</span>
          <select className="input" disabled={locked} value={input.pose && kit.poses.some(item => item.id === input.pose) ? input.pose : ''} onChange={event => set({ pose: event.target.value })}>
            <option value="">自动（{pose?.label ?? '—'}）</option>
            {kit.poses.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>}
        <label className="xhs-field"><span>标题（【】高亮，| 换行；封面上每行 6–10 字最醒目）</span>
          <div className="xhs-ip-title-row">
            <input className="input" disabled={locked} value={input.title} onChange={event => set({ title: event.target.value })} />
            <button className="button button-quiet button-small" disabled={locked || !task.title} onClick={() => set({ title: task.title })}>用文章标题</button>
          </div>
        </label>
        <label className="xhs-field"><span>副标题（可选）</span><input className="input" disabled={locked} value={input.sub} onChange={event => set({ sub: event.target.value })} /></label>
        <label className="xhs-field"><span>标签（可选）</span><input className="input" disabled={locked} value={input.tag} onChange={event => set({ tag: event.target.value })} /></label>
        <div className="btn-group">
          <button className="button button-primary" disabled={locked || !input.title.trim() || !kit} onClick={() => void onRender(input).then(result => { if (result) setShare(result); })}>{busy ? '出图中…' : '用这个模板出封面'}</button>
        </div>
        {share && <div className="wechat-ip-share">
          {share.thumbnail && <img src={share.thumbnail} alt="1:1 分享图" />}
          <div><strong>1:1 分享图已另存</strong><small>微信草稿只收一张封面，分享图需要时自己取用。</small>
            <button className="button button-quiet button-small" onClick={() => void window.sydney.revealContentAsset(task.id, share.path)}>在文件夹中显示</button></div>
        </div>}
        <small className="ww-muted">配色和角色取自 IP「{kit?.name ?? '—'}」，画面里不放头像和品牌名；在「设置 → IP 形象」里改。</small>
      </div>
    </div>}
  </div>;
}
