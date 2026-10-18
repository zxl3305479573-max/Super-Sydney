import { useCallback, useEffect, useState } from 'react';
import type { IpColors, IpLibraryView, IpRenderKit } from '../shared';
import { ConfirmButton, Icon, readableError } from './ui';

/**
 * IP 库的界面部分：各模块共用的数据钩子、IP 选择器，以及「设置 → IP 形象」里的管理卡片。
 * IP 库只在设置里管理；公众号、小红书、视频只选用（选择各自记住）。
 */

const EMPTY_VIEW: IpLibraryView = { ips: [], selections: { wechat: '', video: '' } };

/** 整个 IP 库；主进程发 ip:changed 时重新拉取。 */
export function useIpLibrary(): { view: IpLibraryView; setView: (view: IpLibraryView) => void } {
  const [view, setView] = useState<IpLibraryView>(EMPTY_VIEW);
  useEffect(() => {
    const load = () => void window.sydney.listIps().then(setView).catch(() => undefined);
    load();
    return window.sydney.onIpChanged(load);
  }, []);
  return { view, setView };
}

/** 模板渲染用的 IP 资料（图片是 data URI）；id 为空时为 null。IP 改了会自动重新拉。 */
export function useIpKit(id: string): { kit: IpRenderKit | null; error: string } {
  const [kit, setKit] = useState<IpRenderKit | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) { setKit(null); setError(''); return; }
    let alive = true;
    const load = () => window.sydney.getIpKit(id).then(next => { if (alive) { setKit(next); setError(''); } }, reason => { if (alive) { setKit(null); setError(readableError(reason)); } });
    void load();
    const off = window.sydney.onIpChanged(() => void load());
    return () => { alive = false; off(); };
  }, [id]);
  return { kit, error };
}

/** 下拉选 IP；第一项是「不使用 IP」。 */
export function IpPicker({ value, ips, onChange, disabled = false, label = 'IP' }: {
  value: string; ips: IpLibraryView['ips']; onChange: (id: string) => void; disabled?: boolean; label?: string;
}) {
  const current = ips.find(ip => ip.id === value);
  return <label className="ip-picker" title="IP 在「设置 → IP 形象」里管理">
    <span>{label}</span>
    {current?.avatarThumb && <img src={current.avatarThumb} alt="" />}
    <select className="input" disabled={disabled} value={current ? value : ''} onChange={event => onChange(event.target.value)}>
      <option value="">不使用 IP</option>
      {ips.map(ip => <option key={ip.id} value={ip.id}>{ip.name}</option>)}
    </select>
  </label>;
}

const COLOR_FIELDS: Array<{ key: keyof IpColors; label: string; hint: string }> = [
  { key: 'primary', label: '主色', hint: '深色：标题字、深色底' },
  { key: 'accent', label: '强调色', hint: '荧光笔高亮、标签' },
  { key: 'secondary', label: '辅色', hint: '浅色底、点缀' }
];

/** 「设置 → IP 形象」：增删 IP，改名称、口头禅、配色，管理头像、角色动作与参考图。 */
export function IpLibraryCard({ notify }: { notify: (message: string) => void }) {
  const { view, setView } = useIpLibrary();
  const [activeId, setActiveId] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const active = view.ips.find(ip => ip.id === activeId) ?? view.ips[0];
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [poseLabel, setPoseLabel] = useState('');
  const [colors, setColors] = useState<IpColors | null>(null);
  useEffect(() => { setName(active?.name ?? ''); setTagline(active?.tagline ?? ''); }, [active?.id, active?.name, active?.tagline]);
  useEffect(() => { setColors(active?.colors ?? null); }, [active?.id, active?.colors.primary, active?.colors.accent, active?.colors.secondary]);

  const run = useCallback(async (action: () => Promise<IpLibraryView | null>, done?: string) => {
    setBusy(true);
    try { const next = await action(); if (next) { setView(next); if (done) notify(done); } }
    catch (error) { notify(readableError(error)); }
    finally { setBusy(false); }
  }, [notify, setView]);

  const create = () => run(async () => {
    const next = await window.sydney.createIp(newName);
    setNewName('');
    setActiveId(next.ips[next.ips.length - 1]?.id ?? '');
    return next;
  }, '已新建 IP，接着上传头像和角色素材');
  const save = (patch: Parameters<typeof window.sydney.updateIp>[1]) => active && run(() => window.sydney.updateIp(active.id, patch));
  // 拖动取色器会连续触发：停手 400 毫秒后再写一次。
  useEffect(() => {
    if (!active || !colors) return;
    if (COLOR_FIELDS.every(field => colors[field.key].toUpperCase() === active.colors[field.key].toUpperCase())) return;
    const timer = setTimeout(() => void save({ colors }), 400);
    return () => clearTimeout(timer);
  }, [colors]);

  return <section id="set-ip" className="set-card">
    <header><Icon name="user" size={18} /><div><h2>IP 形象</h2><p>全应用共用的 IP：名称（也是封面上的品牌名）、头像、透明底角色动作、配色。公众号、小红书、视频在各自模块里选用，模板只从这里取品牌信息。</p></div></header>
    <div className="ip-library">
      <aside className="ip-list">
        {view.ips.map(ip => <button key={ip.id} className={ip.id === active?.id ? 'is-active' : ''} onClick={() => setActiveId(ip.id)}>
          {ip.avatarThumb ? <img src={ip.avatarThumb} alt="" /> : <span className="ip-avatar-empty"><Icon name="user" size={14} /></span>}
          <span><strong>{ip.name}</strong><small>{ip.poses.length} 个动作</small></span>
        </button>)}
        <div className="ip-new">
          <input className="input" value={newName} maxLength={30} placeholder="新 IP 名称" onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && newName.trim()) void create(); }} />
          <button className="button button-secondary button-small" disabled={busy || !newName.trim()} onClick={() => void create()}><Icon name="plus" />新建</button>
        </div>
      </aside>

      {active ? <div className="ip-editor">
        <div className="ip-editor-head">
          <button className="ip-avatar" disabled={busy} title="更换头像" onClick={() => void run(() => window.sydney.addIpImage(active.id, 'avatar'), '头像已更新')}>
            {active.avatarThumb ? <img src={active.avatarThumb} alt="头像" /> : <Icon name="plus" />}
            <small>{active.avatarThumb ? '换头像' : '上传头像'}</small>
          </button>
          <div className="ip-fields">
            <label className="xhs-field"><span>名称 / 品牌名</span>
              <input className="input" value={name} maxLength={30} disabled={busy} onChange={event => setName(event.target.value)} onBlur={() => { if (name.trim() && name.trim() !== active.name) void save({ name }); }} /></label>
            <label className="xhs-field"><span>口头禅或简介</span>
              <input className="input" value={tagline} maxLength={60} disabled={busy} onChange={event => setTagline(event.target.value)} onBlur={() => { if (tagline.trim() !== active.tagline) void save({ tagline }); }} /></label>
          </div>
        </div>

        <div className="ip-colors">{COLOR_FIELDS.map(field => <label key={field.key} title={field.hint}>
          <input type="color" value={(colors ?? active.colors)[field.key]} onChange={event => setColors({ ...(colors ?? active.colors), [field.key]: event.target.value })} />
          <span><strong>{field.label}</strong><small>{field.hint}</small></span>
        </label>)}</div>

        <h4 className="ip-sub">角色动作<small>透明底 PNG；名字里带「打字 / 指向 / 团队」之类的词，模板会按名字挑合适的那张</small></h4>
        <ul className="ip-poses">
          {active.poses.map(pose => <li key={pose.id}>
            <div className="ip-pose-image">{active.poseThumbs[pose.id] ? <img src={active.poseThumbs[pose.id]} alt={pose.label} /> : <span>缺图</span>}</div>
            <input className="input" defaultValue={pose.label} maxLength={12} disabled={busy} onBlur={event => { const label = event.target.value.trim(); if (label && label !== pose.label) void save({ poses: [{ id: pose.id, label }] }); }} />
            <ConfirmButton className="icon-button" armedLabel="确认删除" title="删除这个动作" onConfirm={() => void run(() => window.sydney.removeIpPose(active.id, pose.id))}><Icon name="trash" size={13} /></ConfirmButton>
          </li>)}
          <li className="ip-pose-add">
            <input className="input" value={poseLabel} maxLength={12} placeholder="动作名，如：打字" onChange={event => setPoseLabel(event.target.value)} />
            <button className="button button-secondary button-small" disabled={busy} onClick={() => void run(async () => { const next = await window.sydney.addIpImage(active.id, 'pose', poseLabel); if (next) setPoseLabel(''); return next; }, '已添加角色动作')}><Icon name="plus" />添加动作</button>
          </li>
        </ul>

        <h4 className="ip-sub">参考图<small>可选：整体设定图，以后生成新动作时当参考</small></h4>
        <div className="ip-reference">
          {active.referenceThumb ? <img src={active.referenceThumb} alt="参考图" /> : <span className="ww-muted">还没有参考图</span>}
          <button className="button button-quiet button-small" disabled={busy} onClick={() => void run(() => window.sydney.addIpImage(active.id, 'reference'), '参考图已更新')}>{active.referenceThumb ? '更换' : '上传'}参考图</button>
        </div>

        <div className="ip-danger">
          <span className="ww-muted">图片导入时会自动缩到够用的尺寸，存在本机应用数据目录的 ip-library 里。</span>
          <ConfirmButton className="button button-quiet button-small" armedLabel={`确认删除「${active.name}」？`} onConfirm={() => void run(() => window.sydney.deleteIp(active.id), '已删除这个 IP')}>删除这个 IP</ConfirmButton>
        </div>
      </div> : <p className="flow-empty">还没有 IP。在左边输入名称新建一个。</p>}
    </div>
  </section>;
}
