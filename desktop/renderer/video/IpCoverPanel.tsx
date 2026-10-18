import { useEffect, useMemo, useState } from 'react';
import type { VideoIpCoverInput, VideoProject, VideoRenderOptions } from '../../shared';
import { VIDEO_COVER_SIZE, emptyVideoIpCoverInput, renderVideoIpCover, videoCoverPose } from '../../services/video-ip-cover';
import { IpPicker, useIpKit, useIpLibrary } from '../IpLibrary';

/**
 * 视频封面步骤里的 IP 模板：IP 跟着这条视频走（和画面步骤里选的是同一个），
 * 填标题、预览竖版封面，确认后主进程本地截图写成封面，不调图片接口。填过的字段按视频存在本机。
 */

const storageKey = (id: number) => `sydney.video.ip-cover.${id}`;
const PREVIEW_SCALE = 0.2;

function loadInput(project: VideoProject): VideoIpCoverInput {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(project.id)) ?? 'null') as VideoIpCoverInput | null;
    if (saved && typeof saved.title === 'string') return { ...emptyVideoIpCoverInput(), ...saved };
  } catch { /* 本机存储不可用就从默认值开始 */ }
  return emptyVideoIpCoverInput(project.title || project.topic);
}

export function VideoIpCoverPanel({ project, locked, busy, onOptions, onRender }: {
  project: VideoProject; locked: boolean; busy: boolean;
  onOptions: (patch: Partial<VideoRenderOptions>) => void; onRender: (input: VideoIpCoverInput) => void;
}) {
  const { view } = useIpLibrary();
  const ipId = project.options.ipId;
  const { kit, error } = useIpKit(ipId);
  const [input, setInput] = useState<VideoIpCoverInput>(() => loadInput(project));
  useEffect(() => { setInput(loadInput(project)); }, [project.id]);
  useEffect(() => { try { localStorage.setItem(storageKey(project.id), JSON.stringify(input)); } catch { /* 忽略 */ } }, [project.id, input]);
  const set = (patch: Partial<VideoIpCoverInput>) => setInput(current => ({ ...current, ...patch }));
  const preview = useMemo(() => kit ? renderVideoIpCover(input, kit) : '', [input, kit]);
  const pose = kit ? videoCoverPose(input, kit) : null;
  const select = (id: string) => { onOptions({ ipId: id }); void window.sydney.selectIp('video', id).catch(() => undefined); };

  return <div className="wechat-ip">
    <div className="xhs-ip-head">
      <IpPicker label="这条视频的 IP" value={ipId} ips={view.ips} disabled={locked} onChange={select} />
      <small className="ww-muted">选了 IP 后，「AI 生成竖版封面」会把 IP 角色融进画面；也可以用下面的模板本地出图，不花钱。</small>
    </div>
    {ipId && <div className="xhs-ip-cover">
      <div className="xhs-ip-preview" style={{ width: VIDEO_COVER_SIZE.width * PREVIEW_SCALE, height: VIDEO_COVER_SIZE.height * PREVIEW_SCALE }}>
        {preview ? <iframe title="竖版封面预览" sandbox="" srcDoc={preview} width={VIDEO_COVER_SIZE.width} height={VIDEO_COVER_SIZE.height} style={{ transform: `scale(${PREVIEW_SCALE})` }} />
          : <div className="flow-image-missing">{error || 'IP 素材加载中…'}</div>}
      </div>
      <div className="xhs-ip-form">
        <div className="xhs-style-picks">{(['dark', 'light'] as const).map(style => <button key={style} className={`xhs-style xhs-ip-pick ${input.style === style ? 'is-active' : ''}`} disabled={locked} onClick={() => set({ style })}>
          <strong>{style === 'dark' ? '深色' : '浅色'}</strong><small>{style === 'dark' ? '主色深底，信息流里显眼' : '浅色底，清爽'}</small>
        </button>)}</div>
        {kit && kit.poses.length > 1 && <label className="xhs-field"><span>角色动作</span>
          <select className="input" disabled={locked} value={input.pose && kit.poses.some(item => item.id === input.pose) ? input.pose : ''} onChange={event => set({ pose: event.target.value })}>
            <option value="">自动（{pose?.label ?? '—'}）</option>
            {kit.poses.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>}
        <label className="xhs-field"><span>标题（【】高亮，| 换行；每行 4–7 字最醒目）</span>
          <div className="xhs-ip-title-row">
            <input className="input" disabled={locked} value={input.title} onChange={event => set({ title: event.target.value })} />
            <button className="button button-quiet button-small" disabled={locked || !project.title} onClick={() => set({ title: project.title })}>用视频标题</button>
          </div>
        </label>
        <label className="xhs-field"><span>副标题（可选）</span><input className="input" disabled={locked} value={input.sub} onChange={event => set({ sub: event.target.value })} /></label>
        <div className="btn-group">
          <button className="button button-primary" disabled={locked || !input.title.trim() || !kit} onClick={() => onRender(input)}>{busy ? '出图中…' : '用这个模板出封面'}</button>
        </div>
        <small className="ww-muted">配色和角色取自 IP「{kit?.name ?? '—'}」，画面里不放头像和品牌名；在「设置 → IP 形象」里改。</small>
      </div>
    </div>}
  </div>;
}
