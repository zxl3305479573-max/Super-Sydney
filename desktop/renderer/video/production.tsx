import { useEffect, useState } from 'react';
import type { VideoAssetBundle, VideoProgress, VideoProject, VideoRenderOptions, VideoShot, VideoTtsSettings, VideoTtsStatus } from '../../shared';
import { buildSrt, buildTimeline, formatDuration, isPreviewFresh, isRenderFresh, renderBlockers, shotDurations } from '../../services/video-pipeline';
import { VIDEO_TEMPLATES, describeVoiceProfile, imageCoverage, parseVoiceProfile, shotAudio, shotImage, voiceCoverage } from '../../services/video-production';
import { buildFramePlan, framePlanOptions, framePlanStills } from '../../services/video-compose';
import { VIDEO_IMAGE_PROMPT_DEFAULTS } from '../../services/video-image-prompts';
import { readableError } from '../ui';
import { IpPicker, useIpLibrary } from '../IpLibrary';

/** 成片三步（配音与字幕、画面、成片）的面板。只负责展示与收集输入，动作由 VideoPanel 传入。 */

type EditOptions = (patch: Partial<VideoRenderOptions>) => void;

export function ProgressBar({ progress }: { progress: VideoProgress | null }) {
  if (!progress || !progress.total) return <div className="video-progress"><span>准备中…</span></div>;
  const percent = Math.min(100, Math.round(progress.done / progress.total * 100));
  return <div className="video-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
    <i style={{ width: `${percent}%` }} />
    <span>{progress.message || `${progress.done}/${progress.total}`}</span>
  </div>;
}

export function VoiceStep({ project, shots, locked, busy, progress, notify, onOptions, onGenerate, onCopySrt }: {
  project: VideoProject; shots: VideoShot[]; locked: boolean; busy: string; progress: VideoProgress | null;
  notify: (message: string) => void; onOptions: EditOptions; onGenerate: (force: boolean) => void; onCopySrt: (srt: string) => void;
}) {
  const silent = project.options.voiceMode === 'silent';
  const coverage = voiceCoverage(project, shots);
  const { seconds, voiced } = shotDurations(project, shots);
  const timeline = buildTimeline(shots, seconds);
  const srt = buildSrt(timeline.lines);
  const profile = parseVoiceProfile(project.assets.voiceProfile);
  const shotState = (shot: VideoShot) => {
    if (!shot.narration.trim()) return '无口播';
    if (silent) return '不配音';
    const audio = shotAudio(project, shot);
    if (audio) return '✓ 已配音';
    return project.assets.audio.length ? '待重配' : '待配音';
  };
  return <div className="flow-body">
    <div className="choice-row" role="radiogroup" aria-label="配音方式">
      <button role="radio" aria-checked={!silent} className={`choice ${silent ? '' : 'is-active'}`} disabled={locked} onClick={() => onOptions({ voiceMode: 'tts' })}>AI 配音</button>
      <button role="radio" aria-checked={silent} className={`choice ${silent ? 'is-active' : ''}`} disabled={locked} onClick={() => onOptions({ voiceMode: 'silent' })}>不配音（只出字幕和画面）</button>
    </div>
    {!silent && <>
      <TtsSettingsPanel locked={locked} notify={notify} />
      <div className="flow-sub-head">
        <h4>逐镜配音<small>已配 {coverage.ready}/{coverage.needed} 个镜头{profile ? ` · ${describeVoiceProfile(profile)}` : ''}</small></h4>
        <div className="flow-inline-actions">
          <button className="button button-primary" disabled={locked || !coverage.needed || coverage.ready === coverage.needed} onClick={() => onGenerate(false)}>
            {busy === 'voice' ? '配音中…' : coverage.ready ? '补齐配音' : '生成配音'}
          </button>
          {coverage.ready > 0 && <button className="button button-secondary" disabled={locked} title="按当前配音设置重新合成全部镜头" onClick={() => onGenerate(true)}>按当前设置全部重配</button>}
        </div>
      </div>
      {busy === 'voice' && <ProgressBar progress={progress} />}
    </>}
    <table className="flow-table video-voice-table"><thead><tr><th>镜号</th><th>口播</th><th>时长</th><th>配音</th></tr></thead><tbody>
      {shots.map((shot, position) => <tr key={position}>
        <td>{shot.index}</td><td>{shot.narration || '—'}</td><td>{seconds[position].toFixed(1)} 秒</td><td>{shotState(shot)}</td>
      </tr>)}
    </tbody></table>
    <div className="flow-sub-head">
      <h4>字幕（SRT）<small>{timeline.lines.length} 行 · 共 {formatDuration(timeline.total)} · {voiced ? '按真实配音' : '按分镜秒数估算'}</small></h4>
      <button className="button button-secondary" disabled={locked || !srt} onClick={() => onCopySrt(srt)}>复制字幕</button>
    </div>
    {srt ? <pre className="video-srt">{srt}</pre> : <p className="flow-empty">分镜里还没有口播，字幕会在有口播后自动排好。</p>}
    <p className="ww-muted">字幕按句切分，每行不超过 14 个字，镜头内按字数分配时间；配音后镜头时长换成真实音频长度（每镜之后留 0.35 秒气口），不回模型、不额外花钱。改了某一镜的口播，只需要补配那一镜。</p>
  </div>;
}

/** 全局配音设置：改完保存，之后新配的音才按新设置合成；已经配好的视频不会悄悄变声。 */
function TtsSettingsPanel({ locked, notify }: { locked: boolean; notify: (message: string) => void }) {
  const [status, setStatus] = useState<VideoTtsStatus | null>(null);
  const [draft, setDraft] = useState<VideoTtsSettings | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.sydney.getVideoTtsStatus()
      .then(next => { if (alive) { setStatus(next); setDraft(next.settings); } })
      .catch(error => notify(readableError(error)));
    return () => { alive = false; };
  }, [notify]);
  if (!status || !draft) return <p className="ww-muted">正在读取配音设置…</p>;
  const edit = (patch: Partial<VideoTtsSettings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(status.settings) || Boolean(key.trim());
  const run = async (action: () => Promise<VideoTtsStatus>, message: string) => {
    setSaving(true);
    try {
      const next = await action();
      setStatus(next);
      setDraft(next.settings);
      setKey('');
      notify(message);
    } catch (error) { notify(readableError(error)); } finally { setSaving(false); }
  };
  const save = () => run(async () => {
    let next = await window.sydney.saveVideoTtsSettings(draft);
    if (key.trim()) next = await window.sydney.saveVideoTtsKey(key);
    return next;
  }, '配音设置已保存；已经配好的镜头不受影响，点「按当前设置全部重配」才会换声音');
  const summary = status.settings.provider === 'system'
    ? `系统语音 · ${status.settings.systemVoice || '系统默认'}`
    : `${status.settings.model} · ${status.settings.voice}${status.key.configured ? '' : ' · 未填 Key'}`;
  return <details className="video-tts">
    <summary>配音设置<small>{summary}</small></summary>
    <div className="native-task-fields">
      <label><span>配音来源</span><select disabled={locked || saving} value={draft.provider} onChange={event => edit({ provider: event.target.value as VideoTtsSettings['provider'] })}>
        <option value="system">系统语音（免费、离线）</option>
        <option value="openai">OpenAI 兼容接口</option>
      </select></label>
      {draft.provider === 'system' ? <>
        <label><span>声音</span><select disabled={locked || saving} value={draft.systemVoice} onChange={event => edit({ systemVoice: event.target.value })}>
          <option value="">系统默认</option>
          {status.systemVoices.map(voice => <option key={voice} value={voice}>{voice}</option>)}
        </select></label>
        <label><span>语速（-5 慢 ～ 5 快）</span><input type="number" min={-5} max={5} step={1} disabled={locked || saving} value={draft.systemRate} onChange={event => edit({ systemRate: Number(event.target.value) })} /></label>
      </> : <>
        <label className="native-field-wide"><span>接口地址</span><input disabled={locked || saving} value={draft.baseUrl} onChange={event => edit({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>
        <label><span>模型</span><input disabled={locked || saving} value={draft.model} onChange={event => edit({ model: event.target.value })} placeholder="gpt-4o-mini-tts" /></label>
        <label><span>音色</span><input disabled={locked || saving} value={draft.voice} onChange={event => edit({ voice: event.target.value })} placeholder="alloy" /></label>
        <label><span>语速倍率（0.5–2）</span><input type="number" min={0.5} max={2} step={0.05} disabled={locked || saving} value={draft.speed} onChange={event => edit({ speed: Number(event.target.value) })} /></label>
        <label><span>API Key{status.key.configured ? `（已保存 ${status.key.masked}）` : ''}</span><input type="password" autoComplete="off" disabled={locked || saving} value={key} onChange={event => setKey(event.target.value)} placeholder={status.key.configured ? '留空则不修改' : '填入后随设置一起保存'} /></label>
      </>}
    </div>
    <div className="flow-inline-actions">
      <button className="button button-secondary" disabled={locked || saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '保存配音设置'}</button>
      {draft.provider === 'openai' && status.key.configured && <button className="button button-quiet" disabled={locked || saving} onClick={() => void run(() => window.sydney.deleteVideoTtsKey(), '已删除配音接口的 API Key')}>删除 Key</button>}
      <small>{draft.provider === 'system'
        ? status.systemVoices.length ? '用 Windows 自带的语音合成，不联网、不花钱，音质一般；想要更自然的声音可以换成接口。' : '没有读到系统语音：这台电脑可能没装中文语音包，可在 Windows 设置 → 时间和语言 → 语音 里添加。'
        : '按 OpenAI 的 /audio/speech 格式调用，每镜一次、按字数计费。硅基流动等兼容网关同样适用，模型和音色按服务商文档填写。'}</small>
    </div>
  </details>;
}

export function VisualsStep({ project, shots, assets, locked, busy, progress, onOptions, onImages, onPreview }: {
  project: VideoProject; shots: VideoShot[]; assets: VideoAssetBundle | null; locked: boolean; busy: string; progress: VideoProgress | null;
  onOptions: EditOptions; onImages: (force: boolean) => void; onPreview: () => void;
}) {
  const ai = project.options.imageMode === 'ai';
  const { view: ipLibrary } = useIpLibrary();
  const coverage = imageCoverage(project, shots);
  const previews = assets?.preview ?? [];
  const previewFresh = isPreviewFresh(project);
  return <div className="flow-body">
    <h4>画面模板</h4>
    <div className="video-template-grid" role="radiogroup" aria-label="画面模板">
      {VIDEO_TEMPLATES.map(item => <button key={item.value} role="radio" aria-checked={project.options.template === item.value} disabled={locked}
        className={`video-template video-template-${item.value} ${project.options.template === item.value ? 'is-active' : ''}`} onClick={() => onOptions({ template: item.value })}>
        <span className="video-template-swatch" aria-hidden="true"><i /><b /></span>
        <strong>{item.label}</strong>
        <small>{item.hint}</small>
      </button>)}
    </div>
    <div className="xhs-ip-head">
      <IpPicker label="画面里带的 IP" value={project.options.ipId} ips={ipLibrary.ips} disabled={locked} onChange={ipId => { onOptions({ ipId }); void window.sydney.selectIp('video', ipId).catch(() => undefined); }} />
      <small className="ww-muted">带上 IP 后，AI 配图和 AI 封面会把 IP 角色融进画面，每一帧标题右侧有 IP 角色（不放头像和品牌名）；新建的视频默认用这里上次选的 IP。</small>
    </div>
    <div className="native-task-fields">
      <label className="native-field-wide"><span>画面底部一行（账号名或合规提示，留空不显示）</span>
        <input disabled={locked} maxLength={40} value={project.options.footer} onChange={event => onOptions({ footer: event.target.value })} />
      </label>
    </div>
    <h4>配图</h4>
    <div className="choice-row" role="radiogroup" aria-label="配图方式">
      <button role="radio" aria-checked={!ai} className={`choice ${ai ? '' : 'is-active'}`} disabled={locked} onClick={() => onOptions({ imageMode: 'none' })}>纯文字卡片（不花钱）</button>
      <button role="radio" aria-checked={ai} className={`choice ${ai ? 'is-active' : ''}`} disabled={locked} onClick={() => onOptions({ imageMode: 'ai' })}>逐镜 AI 配图（每镜一张，按张计费）</button>
    </div>
    <details className="flow-secondary-tools video-prompt-settings">
      <summary>生图提示词（高级）<small>按这条视频保存，修改后重新生成才生效</small></summary>
      <p className="ww-muted">逐镜模板支持 <code>{'{title}'}</code> 和 <code>{'{subject}'}</code>；封面模板支持 <code>{'{title}'}</code> 和 <code>{'{context}'}</code>。留空保存会恢复对应默认值。</p>
      <div className="video-prompt-fields">
        <div>
          <label><span>分镜生图规则</span><small>控制模型如何填写每一镜的 image_prompt；影响下次生成或重新生成分镜。</small></label>
          <textarea className="flow-draft video-prompt-textarea" disabled={locked} maxLength={3000} value={project.options.storyboardImagePromptRule}
            onChange={event => onOptions({ storyboardImagePromptRule: event.target.value })} />
        </div>
        <div>
          <label><span>逐镜配图最终模板</span><small>图片接口实际收到的模板。修改后，已有 AI 配图会因提示词变化标记为待重新生成。</small></label>
          <textarea className="flow-draft video-prompt-textarea" disabled={locked} maxLength={3000} value={project.options.shotImagePromptTemplate}
            onChange={event => onOptions({ shotImagePromptTemplate: event.target.value })} />
        </div>
        <div>
          <label><span>AI 竖版封面模板</span><small>只在「封面」步骤点 AI 生成时使用，不影响逐镜配图。</small></label>
          <textarea className="flow-draft video-prompt-textarea" disabled={locked} maxLength={3000} value={project.options.coverImagePromptTemplate}
            onChange={event => onOptions({ coverImagePromptTemplate: event.target.value })} />
        </div>
      </div>
      <div className="flow-inline-actions">
        <button className="button button-quiet" disabled={locked} onClick={() => onOptions({ ...VIDEO_IMAGE_PROMPT_DEFAULTS })}>恢复全部默认提示词</button>
      </div>
    </details>
    {ai && <>
      <div className="flow-sub-head">
        <h4>逐镜配图<small>已有 {coverage.ready}/{coverage.needed} 张 · 用公众号配置里的图片接口</small></h4>
        <div className="flow-inline-actions">
          <button className="button button-primary" disabled={locked || coverage.ready === coverage.needed} onClick={() => onImages(false)}>{busy === 'images' ? '生成中…' : coverage.ready ? '补齐配图' : '生成配图'}</button>
          {coverage.ready > 0 && <button className="button button-secondary" disabled={locked} onClick={() => onImages(true)}>全部重新生成</button>}
        </div>
      </div>
      {busy === 'images' && <ProgressBar progress={progress} />}
      <div className="video-shot-images">{shots.map((shot, position) => <figure key={position}>
        {assets?.shotImages[position] ? <img src={assets.shotImages[position]} alt={`第 ${shot.index} 镜配图`} /> : <div className="flow-image-missing">{shotImage(project, shot) ? '文件缺失' : '待生成'}</div>}
        <figcaption><strong>第 {shot.index} 镜</strong>{shot.imagePrompt || shot.visual}</figcaption>
      </figure>)}</div>
    </>}
    <div className="flow-sub-head">
      <h4>预览<small>{previewFresh ? `每镜一帧 · 共 ${previews.length} 帧` : previews.length ? '预览已过期：画面相关的内容改过了，重新预览一下' : '渲染前先看一眼版式'}</small></h4>
      <button className="button button-secondary" disabled={locked || !shots.length} onClick={onPreview}>{busy === 'preview' ? '渲染预览中…' : previews.length ? '重新预览' : '预览画面'}</button>
    </div>
    {busy === 'preview' && <ProgressBar progress={progress} />}
    {previews.length ? <div className={`video-frame-grid ${previewFresh ? '' : 'is-stale'}`}>{previews.map((src, position) => <figure key={position}>
      {src ? <img src={src} alt={`第 ${position + 1} 镜预览`} /> : <div className="flow-image-missing">文件缺失</div>}
      <figcaption>第 {position + 1} 镜</figcaption>
    </figure>)}</div> : <p className="flow-empty">点「预览画面」，每个镜头渲染一帧（不调接口、不花钱），先看标题、画面大字和字幕会不会挤、颜色合不合适。</p>}
  </div>;
}

export function RenderStep({ project, shots, assets, locked, busy, progress, onOptions, onChooseBgm, onRender, onSaveMp4, onOpen }: {
  project: VideoProject; shots: VideoShot[]; assets: VideoAssetBundle | null; locked: boolean; busy: string; progress: VideoProgress | null;
  onOptions: EditOptions; onChooseBgm: () => void; onRender: () => void; onSaveMp4: () => void; onOpen: () => void;
}) {
  const blockers = renderBlockers(project);
  const { seconds, voiced } = shotDurations(project, shots);
  const timeline = buildTimeline(shots, seconds);
  const frames = framePlanStills(buildFramePlan(shots, timeline, framePlanOptions(project.options)));
  const fresh = isRenderFresh(project);
  const video = project.assets.video;
  const template = VIDEO_TEMPLATES.find(item => item.value === project.options.template)?.label ?? '';
  const bgmName = project.options.bgmPath.split(/[\\/]/).pop();
  return <div className="flow-body">
    {blockers.length > 0 && <ul className="flow-checklist">{blockers.map(item => <li key={item} className="is-missing">
      <span aria-hidden="true">○</span><div><strong>{item}</strong></div>
    </li>)}</ul>}
    <ul className="video-summary">
      <li><span>时长</span><strong>{formatDuration(timeline.total)}</strong><small>{voiced ? '按真实配音' : project.options.voiceMode === 'silent' ? '不配音，按分镜秒数' : '估算，配音后会变'}</small></li>
      <li><span>画面</span><strong>{frames} 帧</strong><small>{template}模板 · {project.options.imageMode === 'ai' ? 'AI 配图' : '纯文字卡片'}</small></li>
      <li><span>规格</span><strong>1080×1920</strong><small>30 fps · H.264 + AAC</small></li>
    </ul>
    <div className="flow-sub-head">
      <h4>背景音乐<small>{bgmName ? bgmName : '可选：不加也行，口播更清楚'}</small></h4>
      <div className="flow-inline-actions">
        <button className="button button-secondary" disabled={locked} onClick={onChooseBgm}>{bgmName ? '换一首' : '选择本地音乐'}</button>
        {bgmName && <button className="button button-quiet" disabled={locked} onClick={() => onOptions({ bgmPath: '' })}>不要背景音乐</button>}
      </div>
    </div>
    {bgmName && <label className="video-volume"><span>音量 {project.options.bgmVolume}%</span>
      <input type="range" min={0} max={40} step={1} disabled={locked} value={project.options.bgmVolume} onChange={event => onOptions({ bgmVolume: Number(event.target.value) })} />
      <small>建议 8–15%，结尾 2 秒自动淡出。音乐版权请自行确认。</small>
    </label>}
    <div className="flow-inline-actions">
      <button className={`button ${fresh ? 'button-secondary' : 'button-primary'}`} disabled={locked || blockers.length > 0} onClick={onRender}>{busy === 'render' ? '渲染中…' : video ? '重新渲染' : '渲染成片'}</button>
      {fresh && <button className="button button-primary" disabled={locked || !assets?.videoPath} onClick={onSaveMp4}>{busy === 'save-mp4' ? '导出中…' : '导出 MP4'}</button>}
      {assets?.videoPath && <button className="button button-secondary" disabled={locked} onClick={onOpen}>打开成片</button>}
      <small>需要本机安装 ffmpeg。渲染完成后可直接导出 MP4；制作包仍会带上当前有效成片。不会上传到任何平台。</small>
    </div>
    {busy === 'render' && <ProgressBar progress={progress} />}
    {video && <p className={fresh ? 'native-export-path' : 'flow-attention-note'}>
      {fresh ? '最近成片' : '旧成片已过期（分镜、配音或画面改过）'}：{formatDuration(video.seconds)} · {video.path}
    </p>}
  </div>;
}
