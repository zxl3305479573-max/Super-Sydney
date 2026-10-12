import { useEffect, useState } from 'react';
import type { VideoAssetBundle, VideoPlatform, VideoProject } from '../../shared';
import { VIDEO_PLATFORMS, formatDuration, parseVideoShots, videoExportChecklist, type VideoStep, type VideoStepKey } from '../../services/video-pipeline';
import { estimatedSeconds, stateNames, type TopicSuggestion } from './format';

/** 视频流水线的各步骤面板。只负责展示与收集输入，动作由 VideoPanel 传入。 */

export function Stepper({ steps, active, onSelect }: { steps: VideoStep[]; active: VideoStepKey; onSelect: (key: VideoStepKey) => void }) {
  return <ol className="flow-stepper" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-label="视频创作流程">
    {steps.map(item => <li key={item.key} className={`flow-node flow-node-${item.state} ${active === item.key ? 'is-active' : ''}`}>
      <button onClick={() => onSelect(item.key)} aria-current={active === item.key ? 'step' : undefined} title={item.reason || item.hint}>
        <span className="flow-dot">{item.state === 'done' ? '✓' : item.state === 'attention' ? '!' : item.index}</span>
        <span className="flow-node-label">{item.label}</span>
        <small>{stateNames[item.state]}</small>
      </button>
    </li>)}
  </ol>;
}

export function TopicStep({ project, suggestions, locked, busy, onEdit, onRun }: {
  project: VideoProject; suggestions: TopicSuggestion[]; locked: boolean; busy: string;
  onEdit: (patch: Partial<VideoProject>) => void; onRun: () => void;
}) {
  const drift = project.durationSeconds > 0 && project.script.trim() ? estimatedSeconds(project.script) - project.durationSeconds : 0;
  return <div className="flow-body">
    <div className="native-task-fields">
      <label className="native-field-wide"><span>视频标题</span><input disabled={locked} value={project.title} onChange={event => onEdit({ title: event.target.value })} placeholder="观众一眼能看懂的标题" /></label>
      <label><span>发布平台</span><select disabled={locked} value={project.platform} onChange={event => onEdit({ platform: event.target.value as VideoPlatform })}>{VIDEO_PLATFORMS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label><span>目标时长（秒）</span><input disabled={locked} type="number" min={5} value={project.durationSeconds} onChange={event => onEdit({ durationSeconds: Number(event.target.value) })} /></label>
      <label><span>目标受众</span><input disabled={locked} value={project.audience} placeholder="例如：60 岁以上、有高血压的读者" onChange={event => onEdit({ audience: event.target.value })} /></label>
      <label className="native-field-wide"><span>选题方向 / 想解决的问题</span><input disabled={locked} value={project.topic} onChange={event => onEdit({ topic: event.target.value })} placeholder="描述观众的问题或想解决的需求" /></label>
    </div>
    {project.script.trim() && Math.abs(drift) >= 15 && <p className="flow-attention-note">现有脚本约 {formatDuration(estimatedSeconds(project.script))}，与目标 {formatDuration(project.durationSeconds)} 相差 {drift > 0 ? '+' : ''}{drift} 秒，可重新生成脚本或调整目标时长。</p>}
    <div className="flow-inline-actions">
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'topics' ? '生成中…' : suggestions.length ? '换一批 AI 选题' : 'AI 生成 5 个候选选题'}</button>
      <small>点选候选会填入标题与方向；选好标题后点右上角「自动生成」，可一次跑完口播脚本 → 分镜。</small>
    </div>
    {suggestions.length > 0 && <div className="native-topic-options">{suggestions.map(item => <button key={item.title} disabled={locked} className={`native-task ${project.title === item.title ? 'is-selected' : ''}`} onClick={() => onEdit({ title: item.title, topic: item.angle })}>
      <strong>{item.title}</strong>
      {item.hook && <small>开场：{item.hook}</small>}
      {item.angle && <small>{item.angle}</small>}
      {item.risk && <small className="flow-risk">风险提示：{item.risk}</small>}
      <span>{project.title === item.title ? '已采用' : '采用这个选题'}</span>
    </button>)}</div>}
  </div>;
}

export function ScriptStep({ project, locked, busy, onEdit, onRun }: {
  project: VideoProject; locked: boolean; busy: string; onEdit: (script: string) => void; onRun: () => void;
}) {
  const estimate = estimatedSeconds(project.script);
  return <div className="flow-body">
    <div className="flow-sub-head">
      <h4>口播脚本<small>约 {project.script.replace(/\s/g, '').length} 字 · 念出来约 {formatDuration(estimate)}（目标 {formatDuration(project.durationSeconds)}）</small></h4>
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'script' ? '生成中…' : project.script.trim() ? '重新生成脚本' : 'AI 写口播脚本'}</button>
    </div>
    <textarea className="flow-draft" disabled={locked} value={project.script} onChange={event => onEdit(event.target.value)}
      placeholder="生成脚本后在这里改；也可以直接写或粘贴自己的口播稿。第一句就是开场，之后一次只讲一件事。" />
    <p className="ww-muted">口播稿是脚本、分镜与字幕的唯一来源：改完这里，分镜与制作包会标成「需要重做」，重新生成即可。</p>
  </div>;
}

export function StoryboardStep({ shots, raw, locked, busy, onEdit, onRun }: {
  shots: ReturnType<typeof parseVideoShots>; raw: string; locked: boolean; busy: string;
  onEdit: (storyboardJson: string) => void; onRun: () => void;
}) {
  const total = shots.reduce((sum, shot) => sum + shot.seconds, 0);
  return <div className="flow-body">
    <div className="flow-sub-head">
      <h4>镜头清单<small>{shots.length} 个镜头 · 共 {formatDuration(total)}</small></h4>
      <button className="button button-secondary" disabled={locked} onClick={onRun}>{busy === 'storyboard' ? '拆解中…' : shots.length ? '重新生成分镜' : 'AI 拆分镜'}</button>
    </div>
    {shots.length ? <table className="flow-table"><thead><tr><th>镜号</th><th>秒</th><th>画面</th><th>口播</th><th>字幕</th></tr></thead><tbody>
      {shots.map((shot, position) => <tr key={position}>
        <td>{shot.index}</td><td>{shot.seconds}</td>
        <td>{shot.visual || '—'}</td><td>{shot.narration || '—'}</td><td>{shot.caption || '（同口播）'}</td>
      </tr>)}
    </tbody></table> : <p className="flow-empty">还没有分镜。分镜决定每个镜头拍什么、说多久，字幕和制作包都从它推出来。</p>}
    {raw.trim() && <details className="native-json"><summary>直接编辑分镜 JSON（进阶）</summary>
      <textarea className="flow-draft" style={{ minHeight: 220 }} disabled={locked} value={raw} onChange={event => onEdit(event.target.value)} />
      <p className="ww-muted">字段：shots 数组，每项含 index、seconds、visual、narration、caption。保存时会按时长与编号归一化；JSON 无效会拒绝保存。</p>
    </details>}
  </div>;
}

export function CaptionsStep({ shots, srt, locked, onCopy }: { shots: number; srt: string; locked: boolean; onCopy: () => void }) {
  return <div className="flow-body">
    <div className="flow-sub-head">
      <h4>字幕（SRT）<small>{shots} 条 · 由分镜时长累加</small></h4>
      <button className="button button-secondary" disabled={locked || !srt} onClick={onCopy}>复制字幕</button>
    </div>
    {srt ? <pre className="video-srt">{srt}</pre> : <p className="flow-empty">先生成分镜，字幕会自动排好时间轴。</p>}
    <p className="ww-muted">时间轴直接由分镜秒数算出，不回模型、不额外花钱。导出制作包时会写入 captions.srt；改分镜后这里同步变化，需要重新导出。</p>
  </div>;
}

export function CoverStep({ project, assets, locked, busy, onChoose, onGenerate }: {
  project: VideoProject; assets: VideoAssetBundle | null; locked: boolean; busy: string; onChoose: () => void; onGenerate: () => void;
}) {
  return <div className="flow-body">
    <div className="flow-cover">
      <figure className="flow-cover-figure video-cover-figure">
        {assets?.cover?.thumbnail ? <img src={assets.cover.thumbnail} alt="封面预览" /> : <div className="flow-image-missing">还没有封面图</div>}
        <figcaption>{project.coverPath ? project.coverPath.split(/[\\/]/).pop() : '未选择封面（可跳过）'}</figcaption>
      </figure>
      <div className="flow-cover-actions">
        <button className="button button-secondary" disabled={locked} onClick={onChoose}>选择本地图片</button>
        <button className="button button-primary" disabled={locked} onClick={onGenerate}>{busy === 'cover' ? '生成中…' : 'AI 生成竖版封面'}</button>
        <small>竖版 9:16，导出时连同脚本、分镜表、字幕一起拷进制作包。封面不是导出的硬门槛，但发布到平台时基本都要。</small>
      </div>
    </div>
  </div>;
}

export function ExportStep({ project, locked, busy, onExport, onOpen }: {
  project: VideoProject; locked: boolean; busy: string; onExport: () => void; onOpen: () => void;
}) {
  const checklist = videoExportChecklist(project);
  const ready = checklist.filter(item => !item.optional).every(item => item.ok);
  return <div className="flow-body">
    <ul className="flow-checklist">{checklist.map(item => <li key={item.label} className={item.ok ? 'is-ok' : 'is-missing'}>
      <span aria-hidden="true">{item.ok ? '✓' : '○'}</span>
      <div><strong>{item.label}{item.optional && '（可选）'}</strong><small>{item.detail}</small></div>
    </li>)}</ul>
    <div className="flow-inline-actions">
      <button className="button button-primary" disabled={locked || !ready} onClick={onExport}>{busy === 'export' ? '导出中…' : '导出制作包'}</button>
      {project.exportPath && <button className="button button-secondary" disabled={locked} onClick={onOpen}>打开制作包目录</button>}
    </div>
    {project.exportPath && <p className="native-export-path">最近导出：{project.exportPath}</p>}
    <p className="ww-muted">制作包里是 制作包.md（脚本 + 分镜表）、shotlist.csv、captions.srt 与封面图。成片需要人工剪辑合成；本模块不上传、不发布到任何平台。</p>
  </div>;
}

/** 封面缩略图由主进程生成（渲染进程读不到本地文件），项目变动后自动重新拉取。 */
export function useVideoAssets(projectId: number, revision: string): VideoAssetBundle | null {
  const [assets, setAssets] = useState<VideoAssetBundle | null>(null);
  useEffect(() => {
    if (!projectId) { setAssets(null); return; }
    let alive = true;
    void window.sydney.getVideoAssets(projectId)
      .then(next => { if (alive) setAssets(next); })
      .catch(() => { if (alive) setAssets(null); });
    return () => { alive = false; };
  }, [projectId, revision]);
  return assets;
}
