import type { VideoProject, VideoQualityCheck, VideoQualityReport } from '../shared.ts';
import { parseVideoShots } from './video-pipeline.ts';
import { videoFrameSpec } from './video-frame-spec.ts';
import type { VideoProbe } from './video-render.ts';

function fpsNumber(value: string): number {
  const [numerator, denominator] = value.split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) return numerator / denominator;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function status(checks: VideoQualityCheck[]): boolean {
  return checks.every(check => check.status !== 'error');
}

/**
 * 成片交付前的本地验收：只使用 ffprobe 读到的实际参数，不修改视频文件。
 * warn 允许交付，但会把与目标时长的偏差等情况明确展示给用户。
 */
export function evaluateVideoQuality(project: VideoProject, probe: VideoProbe, filePath: string): VideoQualityReport {
  const frame = videoFrameSpec(project.platform);
  const actualAspect = probe.height > 0 ? probe.width / probe.height : 0;
  const expectedAspect = frame.width / frame.height;
  const fps = fpsNumber(probe.fps);
  const shots = parseVideoShots(project.storyboardJson);
  const expectsAudio = (project.options.voiceMode === 'tts' && shots.some(shot => shot.narration.trim())) || project.options.bgmMode !== 'none';
  const durationDrift = project.durationSeconds > 0
    ? Math.abs(probe.seconds - project.durationSeconds) / project.durationSeconds
    : 0;
  const checks: VideoQualityCheck[] = [
    {
      key: 'dimensions',
      label: '画布尺寸',
      status: probe.width === frame.width && probe.height === frame.height ? 'ok' : 'error',
      detail: `${probe.width}×${probe.height}，目标 ${frame.width}×${frame.height}`
    },
    {
      key: 'aspect',
      label: '画面比例',
      status: Math.abs(actualAspect - expectedAspect) <= 0.01 ? 'ok' : 'error',
      detail: `${frame.aspect}，实际 ${probe.width}:${probe.height}`
    },
    {
      key: 'fps',
      label: '帧率',
      status: Math.abs(fps - 30) <= 0.5 ? 'ok' : 'warn',
      detail: `${probe.fps || '未知'}（约 ${fps ? fps.toFixed(2) : '未知'} fps，目标 30 fps）`
    },
    {
      key: 'duration',
      label: '时长',
      status: durationDrift <= 0.2 ? 'ok' : 'warn',
      detail: `${probe.seconds.toFixed(2)} 秒，目标 ${project.durationSeconds} 秒`
    },
    {
      key: 'audio',
      label: '音频轨道',
      status: probe.hasAudio || !expectsAudio ? 'ok' : 'error',
      detail: probe.hasAudio ? '已检测到音频轨道' : expectsAudio ? '当前项目需要旁白或 BGM，但成片没有音频轨道' : '项目未要求旁白或 BGM'
    }
  ];
  return {
    path: filePath,
    width: probe.width,
    height: probe.height,
    aspect: frame.aspect,
    fps: probe.fps,
    seconds: probe.seconds,
    hasAudio: probe.hasAudio,
    checks,
    ok: status(checks)
  };
}
