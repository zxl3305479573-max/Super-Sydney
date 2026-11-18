import { useEffect, useMemo, useState } from 'react';
import type {
  VideoAssetBundle,
  VideoPlatform,
  VideoProject,
  VideoQualityReport,
  VideoShot,
  VideoWorkflow
} from '../../shared';
import { buildFramePlan, framePlanOptions, framePlanStills } from '../../services/video-compose';
import { videoFrameSpec } from '../../services/video-frame-spec';
import {
  emptyVideoLocalCoverInput,
  pickVideoCoverPose,
  renderVideoLocalCoverHtml,
  type VideoLocalCoverInput,
  type VideoLocalCoverStyle
} from '../../services/video-local-cover';
import {
  buildTimeline,
  formatDuration,
  isRenderFresh,
  isVideoExportable,
  renderBlockers,
  shotDurations,
  videoExportChecklist
} from '../../services/video-pipeline';
import { IpPicker, useIpKit, useIpLibrary } from '../IpLibrary';
import { Icon } from '../ui';
import { isExternalSkillWorkflow } from './format';

export function RenderStep({
  project,
  shots,
  platform,
  workflow,
  assetBundle,
  qualityReport,
  busy,
  onRender,
  onInspectQuality,
  onSaveMp4,
  onOpenExternalPlayer,
  onNextStep
}: {
  project: VideoProject;
  shots: VideoShot[];
  platform: VideoPlatform;
  workflow: VideoWorkflow;
  assetBundle: VideoAssetBundle | null;
  qualityReport: VideoQualityReport | null;
  busy: string;
  onRender: () => void;
  onInspectQuality: () => void;
  onSaveMp4: () => void;
  onOpenExternalPlayer: () => void;
  onNextStep: () => void;
}) {
  const locked = Boolean(busy);
  const externalSkill = isExternalSkillWorkflow(workflow);
  const spec = videoFrameSpec(platform);
  const blockers = externalSkill ? [] : renderBlockers(project);
  const { seconds, voiced } = shotDurations(project, shots);
  const timeline = buildTimeline(shots, seconds);
  const stillCount = shots.length ? framePlanStills(buildFramePlan(shots, timeline, framePlanOptions(project.options))) : 0;
  const fresh = isRenderFresh(project);
  const video = project.assets.video;
  const hasVideoFile = Boolean(assetBundle?.videoPath && video);
  const qualityWarnings = qualityReport?.checks.filter(item => item.status === 'warn').length ?? 0;
  const qualityErrors = qualityReport?.checks.filter(item => item.status === 'error').length ?? 0;

  return (
    <section className="flow-panel">
      <header className="flow-panel-head">
        <div>
          <h3>成片合成与质量验收</h3>
          <p>合成后自动运行 11 项交付门禁（画布、比例、帧率、音画同步、黑帧、静音、安全区、封面与 MP4 faststart 流式头）。</p>
        </div>
      </header>

      {blockers.length > 0 && (
        <ul className="flow-checklist">
          {blockers.map(item => (
            <li key={item} className="is-missing">
              <span aria-hidden="true">○</span>
              <div><strong>渲染前置未就绪：{item}</strong></div>
            </li>
          ))}
        </ul>
      )}

      <div className="workbench-status-grid">
        <div>
          <strong>{video ? (fresh ? '有效成片' : '需重渲染') : '待生成'}</strong>
          <span>{video ? `实际 ${formatDuration(video.seconds)}` : externalSkill ? '外部工作流成片' : `预计 ${formatDuration(timeline.total)}（${voiced ? '真实配音' : '估算'}）`}</span>
        </div>
        <div>
          <strong>{spec.label}</strong>
          <span>{externalSkill ? '内置 FFmpeg 画布适配' : `约 ${stillCount} 张合并静帧 · 30fps`}</span>
        </div>
        <div>
          <strong>
            {qualityReport
              ? qualityReport.ok
                ? qualityWarnings ? `通过（${qualityWarnings} 警告）` : '全部通过'
                : `${qualityErrors} 项硬错误`
              : hasVideoFile ? '待检查' : '未生成'}
          </strong>
          <span>11 项本地交付验收</span>
        </div>
      </div>

      {hasVideoFile && video && (
        <div className="video-player-card">
          <div className={`video-player-frame ${spec.width > spec.height ? 'is-landscape' : 'is-portrait'}`}>
            <video
              key={`${video.signature}-${video.renderedAt}`}
              controls
              preload="metadata"
              src={`sydney-video://project/${project.id}?sig=${encodeURIComponent(video.signature)}`}
            />
          </div>
          <div className="video-player-meta">
            <span className={fresh ? 'badge badge-on' : 'badge badge-idle'}>
              {fresh ? '与当前脚本/分镜/声音一致' : '上游已修改 · 当前预览为旧成片'}
            </span>
            <code>{assetBundle?.videoPath}</code>
          </div>
        </div>
      )}

      <div className="flow-inline-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={locked || blockers.length > 0}
          onClick={onRender}
        >
          {busy === 'render' || busy === 'workflow'
            ? '合成处理中…'
            : externalSkill
              ? (video ? '重新运行工作流生成成片' : '运行工作流生成成片')
              : (video ? '重新渲染成片' : '渲染成片')}
        </button>
        {fresh && hasVideoFile && (
          <button type="button" className="button button-secondary" disabled={locked} onClick={onSaveMp4}>
            {busy === 'save-mp4' ? '导出中…' : '另存 MP4'}
          </button>
        )}
        <button type="button" className="button button-secondary" disabled={locked || !video} onClick={onInspectQuality}>
          {busy === 'quality' ? '检查中…' : '重新质检'}
        </button>
        {hasVideoFile && (
          <button type="button" className="button button-quiet" disabled={locked} onClick={onOpenExternalPlayer}>
            系统播放器打开
          </button>
        )}
        <button type="button" className="button button-quiet" disabled={locked} onClick={onNextStep}>
          下一步：主封面 →
        </button>
      </div>

      {qualityReport && (
        <div className="video-quality-report">
          <div className={`video-quality-summary ${!qualityReport.ok ? 'is-error' : qualityWarnings ? 'is-warn' : 'is-ok'}`}>
            <strong>
              {qualityReport.ok
                ? qualityWarnings ? `质量检查通过（含 ${qualityWarnings} 项温和提醒）` : '11 项质量检查全部通过'
                : `存在 ${qualityErrors} 项必须修复的硬错误（阻止导出与分发）`}
            </strong>
            <span>
              {qualityReport.width}×{qualityReport.height} · {qualityReport.seconds.toFixed(2)} 秒 · {qualityReport.hasAudio ? '含音轨' : '无音轨'} · 检查于 {new Date(qualityReport.inspectedAt).toLocaleString()}
            </span>
          </div>
          <ul>
            {qualityReport.checks.map(check => (
              <li key={check.key} className={`is-${check.status}`}>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const COVER_STORAGE_KEY = (id: number) => `sydney.video.local-cover.${id}`;

const LOCAL_STYLES_PLAIN: Array<{ value: VideoLocalCoverStyle; label: string; hint: string }> = [
  { value: 'warm', label: '暖米纸感', hint: '柔和耐看，适合科普干货' },
  { value: 'clean', label: '素白松绿', hint: '清爽克制，适合教程拆解' },
  { value: 'night', label: '深邃科技', hint: '高反差暗底，适合 AI / 产品' }
];

const LOCAL_STYLES_IP: Array<{ value: VideoLocalCoverStyle; label: string; hint: string }> = [
  { value: 'ip-dark', label: 'IP 主色深底', hint: '信息流醒目，突出角色与荧光词' },
  { value: 'ip-light', label: 'IP 浅底清爽', hint: '白底画框，亲和自然' }
];

function loadSavedCoverInput(project: VideoProject, hasIp: boolean): VideoLocalCoverInput {
  const defaultTitle = project.title || project.topic || '';
  try {
    const raw = JSON.parse(localStorage.getItem(COVER_STORAGE_KEY(project.id)) ?? 'null') as Partial<VideoLocalCoverInput> | null;
    if (raw && typeof raw.title === 'string') {
      return { ...emptyVideoLocalCoverInput(defaultTitle, hasIp), ...raw };
    }
  } catch { /* 忽略本地存储异常 */ }
  return emptyVideoLocalCoverInput(defaultTitle, hasIp);
}

export function CoverStep({
  project,
  platform,
  assetBundle,
  busy,
  onGenerateAiCover,
  onChooseLocalCover,
  onRenderTemplateCover,
  onNextStep
}: {
  project: VideoProject;
  platform: VideoPlatform;
  assetBundle: VideoAssetBundle | null;
  busy: string;
  onGenerateAiCover: () => void;
  onChooseLocalCover: () => void;
  onRenderTemplateCover: (input: VideoLocalCoverInput) => void;
  onNextStep: () => void;
}) {
  const locked = Boolean(busy);
  const spec = videoFrameSpec(platform);
  const landscape = spec.width > spec.height;
  const { view: ipView } = useIpLibrary();
  const selectedIpId = ipView.selections.video || '';
  const { kit, error: kitError } = useIpKit(selectedIpId);
  const hasIp = Boolean(selectedIpId && kit);

  const [input, setInput] = useState<VideoLocalCoverInput>(() => loadSavedCoverInput(project, Boolean(selectedIpId)));

  useEffect(() => {
    setInput(loadSavedCoverInput(project, Boolean(selectedIpId)));
  }, [project.id]);

  useEffect(() => {
    setInput(current => {
      if (selectedIpId && current.style !== 'ip-dark' && current.style !== 'ip-light') {
        return { ...current, style: 'ip-dark' };
      }
      if (!selectedIpId && (current.style === 'ip-dark' || current.style === 'ip-light')) {
        return { ...current, style: 'warm' };
      }
      return current;
    });
  }, [selectedIpId]);

  useEffect(() => {
    try { localStorage.setItem(COVER_STORAGE_KEY(project.id), JSON.stringify(input)); } catch { /* 忽略 */ }
  }, [project.id, input]);

  const patch = (next: Partial<VideoLocalCoverInput>) => setInput(current => ({ ...current, ...next }));
  const previewScale = landscape ? 0.17 : 0.19;
  const previewHtml = useMemo(
    () => renderVideoLocalCoverHtml(input, platform, hasIp ? kit : null),
    [input, platform, hasIp, kit]
  );
  const activePose = hasIp ? pickVideoCoverPose(input, kit) : null;
  const availableStyles = hasIp ? [...LOCAL_STYLES_IP, ...LOCAL_STYLES_PLAIN] : LOCAL_STYLES_PLAIN;

  return (
    <section className="flow-panel">
      <header className="flow-panel-head">
        <div>
          <h3>主封面工作区（{spec.label}）</h3>
          <p>可用下方本地模板 0 成本秒出高对比大字/IP 封面，也可调 AI 生图或选本地图。更换主封面后，「多平台分发」会自动按新封面重新衍生 3:4 / 4:3 / 16:9 / 9:16 专属比例。</p>
        </div>
      </header>

      <div className="video-cover-top-grid">
        <div className="video-current-cover-box">
          <span className="eyebrow">当前已关联主封面</span>
          {assetBundle?.cover?.thumbnail ? (
            <figure className={`video-cover-preview ${landscape ? 'is-landscape' : 'is-portrait'}`}>
              <img src={assetBundle.cover.thumbnail} alt="当前视频主封面" />
              <figcaption>{assetBundle.cover.path}</figcaption>
            </figure>
          ) : (
            <p className="flow-empty">尚未设置主封面（可选，但多平台发布强烈建议设置）。</p>
          )}
          <div className="flow-inline-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={locked || !(project.title || project.topic).trim()}
              onClick={onGenerateAiCover}
            >
              {busy === 'cover-ai' ? 'AI 生图中…' : `AI 生成 ${spec.aspect} 封面`}
            </button>
            <button type="button" className="button button-secondary" disabled={locked} onClick={onChooseLocalCover}>
              选择本地图片
            </button>
          </div>
        </div>

        <div className="video-local-cover-studio">
          <div className="video-local-cover-head">
            <div>
              <strong>本地大字 / IP 模板封面（0 成本秒出）</strong>
              <small>主体居中收敛，天然适配抖音/小红书 3:4、视频号 4:3 与 B 站 16:9 衍生封面</small>
            </div>
            <IpPicker
              label="封面 IP"
              value={selectedIpId}
              ips={ipView.ips}
              disabled={locked}
              onChange={id => void window.sydney.selectIp('video', id).catch(() => undefined)}
            />
          </div>

          <div className="video-local-cover-body">
            <div
              className="xhs-ip-preview video-local-cover-iframe-wrap"
              style={{ width: Math.round(spec.width * previewScale), height: Math.round(spec.height * previewScale) }}
            >
              {selectedIpId && !kit ? (
                <div className="flow-image-missing">{kitError || '加载 IP 素材中…'}</div>
              ) : (
                <iframe title="本地视频封面预览" sandbox="allow-same-origin" srcDoc={previewHtml} width={spec.width} height={spec.height} style={{ transform: `scale(${previewScale})` }} />
              )}
            </div>

            <div className="xhs-ip-form">
              <div className="xhs-style-picks">
                {availableStyles.map(style => (
                  <button
                    type="button"
                    key={style.value}
                    disabled={locked}
                    className={`xhs-style xhs-ip-pick ${input.style === style.value ? 'is-active' : ''}`}
                    onClick={() => patch({ style: style.value })}
                  >
                    <strong>{style.label}</strong>
                    <small>{style.hint}</small>
                  </button>
                ))}
              </div>

              {hasIp && kit && kit.poses.length > 1 && (input.style === 'ip-dark' || input.style === 'ip-light') && (
                <label className="xhs-field">
                  <span>IP 角色动作</span>
                  <select
                    className="input"
                    disabled={locked}
                    value={input.pose && kit.poses.some(item => item.id === input.pose) ? input.pose : ''}
                    onChange={event => patch({ pose: event.target.value })}
                  >
                    <option value="">自动挑选（{activePose?.label ?? '默认'}）</option>
                    {kit.poses.map(pose => <option key={pose.id} value={pose.id}>{pose.label}</option>)}
                  </select>
                </label>
              )}

              <div className="video-cover-two-cols">
                <label className="xhs-field">
                  <span>顶部胶囊标签（可选）</span>
                  <input
                    className="input"
                    disabled={locked}
                    maxLength={20}
                    value={input.tag}
                    onChange={event => patch({ tag: event.target.value })}
                    placeholder="如：3步实操 / 避坑必看"
                  />
                </label>
                <label className="xhs-field">
                  <span>副标题（可选）</span>
                  <input
                    className="input"
                    disabled={locked}
                    maxLength={60}
                    value={input.sub}
                    onChange={event => patch({ sub: event.target.value })}
                    placeholder="补充结果或适用人群"
                  />
                </label>
              </div>

              <label className="xhs-field">
                <span>封面主标题（用【】标荧光重点，用 | 手动换行）</span>
                <div className="xhs-ip-title-row">
                  <input
                    className="input"
                    disabled={locked}
                    maxLength={60}
                    value={input.title}
                    onChange={event => patch({ title: event.target.value })}
                    placeholder="例如：起床记住|【三个半分钟】"
                  />
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    disabled={locked || !(project.title || project.topic)}
                    onClick={() => patch({ title: project.title || project.topic })}
                  >
                    填入视频标题
                  </button>
                </div>
              </label>

              <div className="flow-inline-actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={locked || !input.title.trim()}
                  onClick={() => onRenderTemplateCover(input)}
                >
                  {busy === 'cover-local' ? '渲染封面中…' : '用此模板生成主封面'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flow-inline-actions">
        <button type="button" className="button button-quiet" disabled={locked} onClick={onNextStep}>
          下一步：交付与多平台分发 →
        </button>
      </div>
    </section>
  );
}

export function DeliverStep({
  project,
  qualityReport,
  busy,
  onSaveMp4,
  onExportPackage,
  onInspectQuality,
  onOpenPackage,
  onJumpToPublish
}: {
  project: VideoProject;
  qualityReport: VideoQualityReport | null;
  busy: string;
  onSaveMp4: () => void;
  onExportPackage: () => void;
  onInspectQuality: () => void;
  onOpenPackage: () => void;
  onJumpToPublish: () => void;
}) {
  const locked = Boolean(busy);
  const checklist = videoExportChecklist(project);
  const exportable = isVideoExportable(project);
  const freshVideo = Boolean(project.assets.video && isRenderFresh(project));
  const qualityWarnings = qualityReport?.checks.filter(item => item.status === 'warn').length ?? 0;
  const qualityErrors = qualityReport?.checks.filter(item => item.status === 'error').length ?? 0;

  return (
    <section className="flow-panel">
      <header className="flow-panel-head">
        <div>
          <h3>交付导出与分发衔接</h3>
          <p>可将有效成片直接另存为 MP4、沉淀完整制作包到 Obsidian 知识库（`07-视频/`），或切到「多平台分发」一键生成四平台专属文案与衍生封面并填入草稿。</p>
        </div>
      </header>

      <ul className="flow-checklist">
        {checklist.map(item => (
          <li key={item.label} className={item.ok ? 'is-ok' : 'is-missing'}>
            <span aria-hidden="true">{item.ok ? '✓' : '○'}</span>
            <div>
              <strong>{item.label}{item.optional ? '（可选）' : ''}</strong>
              <small>{item.detail}</small>
            </div>
          </li>
        ))}
        <li className={freshVideo && qualityReport?.ok ? 'is-ok' : 'is-missing'}>
          <span aria-hidden="true">{freshVideo && qualityReport?.ok ? '✓' : '○'}</span>
          <div>
            <strong>11 项成片质量验收</strong>
            <small>
              {qualityReport
                ? qualityReport.ok
                  ? qualityWarnings ? `通过（${qualityWarnings} 项温和警告）` : '全部通过（含 MP4 faststart 流式封装校验）'
                  : `未通过（${qualityErrors} 项硬错误，需修复后导出）`
                : freshVideo ? '导出时将自动执行验收' : '渲染成片后自动执行'}
            </small>
          </div>
        </li>
      </ul>

      {project.exportPath && (
        <p className="native-export-path">最近导出的知识库制作包：{project.exportPath}</p>
      )}

      <div className="flow-inline-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={locked || !freshVideo}
          onClick={onJumpToPublish}
        >
          <Icon name="arrowRight" size={14} />前往多平台分发填草稿
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={locked || !freshVideo}
          onClick={onSaveMp4}
        >
          {busy === 'save-mp4' ? '另存中…' : '另存 MP4 视频'}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={locked || !exportable}
          onClick={onExportPackage}
        >
          {busy === 'export' ? '导出中…' : '导出知识库制作包'}
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={locked || !project.assets.video}
          onClick={onInspectQuality}
        >
          {busy === 'quality' ? '检查中…' : '重跑质量验收'}
        </button>
        {project.exportPath && (
          <button type="button" className="button button-quiet" disabled={locked} onClick={onOpenPackage}>
            打开制作包目录
          </button>
        )}
      </div>
    </section>
  );
}
