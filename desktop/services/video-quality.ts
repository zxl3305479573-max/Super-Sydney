import type { VideoProject, VideoQualityCheck, VideoQualityReport } from '../shared.ts';
import { parseVideoShots, qualitySignature } from './video-pipeline.ts';
import { videoFrameSpec } from './video-frame-spec.ts';
import { videoSafeArea } from './video-safe-area.ts';
import type { VideoProbe } from './video-render.ts';

export type VideoContentScan = {
  blackSeconds: number;
  blackSegments: number;
  silenceSeconds: number;
  silenceSegments: number;
};

export type VideoImageProbe = {
  width: number;
  height: number;
};

export type VideoQualityExtras = {
  content?: VideoContentScan | null;
  cover?: VideoImageProbe | null;
};

function fpsNumber(value: string): number {
  const [numerator, denominator] = value.split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) return numerator / denominator;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function reportOk(checks: VideoQualityCheck[]): boolean {
  return checks.every(check => check.status !== 'error');
}

function shares(seconds: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, seconds / total)) : 0;
}

function contentStatus(share: number): VideoQualityCheck['status'] {
  if (share >= 0.95) return 'error';
  if (share > 0.10) return 'warn';
  return 'ok';
}

function silenceStatus(share: number): VideoQualityCheck['status'] {
  if (share >= 0.95) return 'error';
  if (share > 0.50) return 'warn';
  return 'ok';
}

/** 把 blackdetect / silencedetect 的起止标记解析成总时长与段数。 */
export function parseDetectionIntervals(log: string, prefix: 'black' | 'silence', duration: number): { seconds: number; segments: number } {
  const starts = [...log.matchAll(new RegExp(`${prefix}_start:\\s*(-?[\\d.]+)`, 'g'))].map(match => Number(match[1]));
  const ends = [...log.matchAll(new RegExp(`${prefix}_end:\\s*(\\d+(?:\\.\\d+)?)`, 'g'))].map(match => Number(match[1]));
  const intervals = starts.flatMap((start, index) => {
    const end = Number.isFinite(ends[index]) ? ends[index] : duration;
    const from = Math.max(0, Math.min(duration, start));
    const to = Math.max(from, Math.min(duration, end));
    return to > from ? [to - from] : [];
  });
  return {
    seconds: Math.round(intervals.reduce((sum, seconds) => sum + seconds, 0) * 1000) / 1000,
    segments: intervals.length
  };
}

function timelineCheck(probe: VideoProbe): VideoQualityCheck {
  if (!probe.hasAudio) {
    return { key: 'timeline', label: '音画时间轴', status: 'ok', detail: '没有音频轨道，不检查起止对齐' };
  }
  const values = [probe.videoStartTime, probe.audioStartTime, probe.videoDuration, probe.audioDuration];
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    return { key: 'timeline', label: '音画时间轴', status: 'warn', detail: 'ffprobe 没有返回完整的音视频起止时间，需要人工试听确认' };
  }
  const videoStart = probe.videoStartTime!;
  const audioStart = probe.audioStartTime!;
  const videoEnd = videoStart + probe.videoDuration!;
  const audioEnd = audioStart + probe.audioDuration!;
  const startDelta = Math.abs(audioStart - videoStart);
  const endDelta = Math.abs(audioEnd - videoEnd);
  const status = startDelta <= 0.10 && endDelta <= 0.35 ? 'ok' : startDelta <= 0.25 && endDelta <= 1 ? 'warn' : 'error';
  return {
    key: 'timeline',
    label: '音画时间轴',
    status,
    detail: `起播差 ${startDelta.toFixed(3)} 秒，结束差 ${endDelta.toFixed(3)} 秒；检查轨道错位，不替代逐帧唇形校验`
  };
}

function safeAreaCheck(project: VideoProject): VideoQualityCheck {
  const frame = videoFrameSpec(project.platform);
  const safe = videoSafeArea(project.platform, frame);
  if (project.options.workflow === 'script-to-video' || project.options.workflow === 'product-demo') {
    return {
      key: 'safe-area',
      label: '平台安全区',
      status: 'ok',
      detail: `内置画面模板已避开顶部 ${safe.top}px、底部 ${safe.bottom}px、左侧 ${safe.left}px、右侧 ${safe.right}px`
    };
  }
  return {
    key: 'safe-area',
    label: '平台安全区',
    status: 'warn',
    detail: `外部 Skill 成片沿用原素材排版；${frame.aspect} 平台建议预留顶部 ${safe.top}px、底部 ${safe.bottom}px、右侧 ${safe.right}px，需抽查字幕和角标`
  };
}

function coverCheck(project: VideoProject, cover: VideoImageProbe | null | undefined): VideoQualityCheck {
  if (!project.coverPath.trim()) return { key: 'cover', label: '封面规格', status: 'ok', detail: '未设置封面，不参与本次验收' };
  if (!cover) return { key: 'cover', label: '封面规格', status: 'error', detail: '封面文件无法读取，请重新选择或生成封面' };
  const frame = videoFrameSpec(project.platform);
  const actual = cover.height > 0 ? cover.width / cover.height : 0;
  const expected = frame.width / frame.height;
  const ratioOk = Math.abs(actual - expected) <= 0.015;
  const small = Math.min(cover.width, cover.height) < 720;
  return {
    key: 'cover',
    label: '封面规格',
    status: ratioOk ? small ? 'warn' : 'ok' : 'error',
    detail: `${cover.width}×${cover.height}，目标比例 ${frame.aspect}${ratioOk ? '' : `；实际约 ${actual.toFixed(3)}`}${small ? '；分辨率偏低' : ''}`
  };
}

/**
 * 成片交付前的本地验收：基础参数来自 ffprobe，黑帧和静音来自一次 FFmpeg 解码，
 * 安全区来自内置模板的平台预留值。warn 允许交付，error 会阻止导出。
 */
export function evaluateVideoQuality(
  project: VideoProject,
  probe: VideoProbe,
  filePath: string,
  extras: VideoQualityExtras = {}
): VideoQualityReport {
  const frame = videoFrameSpec(project.platform);
  const actualAspect = probe.height > 0 ? probe.width / probe.height : 0;
  const expectedAspect = frame.width / frame.height;
  const fps = fpsNumber(probe.fps);
  const shots = parseVideoShots(project.storyboardJson);
  const expectsAudio = (project.options.voiceMode === 'tts' && shots.some(shot => shot.narration.trim())) || project.options.bgmMode !== 'none';
  const durationDrift = project.durationSeconds > 0
    ? Math.abs(probe.seconds - project.durationSeconds) / project.durationSeconds
    : 0;
  const blackShare = shares(extras.content?.blackSeconds ?? 0, probe.seconds);
  const silenceShare = shares(extras.content?.silenceSeconds ?? 0, probe.seconds);
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
    },
    timelineCheck(probe),
    {
      key: 'black',
      label: '黑帧',
      status: extras.content ? contentStatus(blackShare) : 'warn',
      detail: extras.content
        ? `${extras.content.blackSegments} 段，共 ${extras.content.blackSeconds.toFixed(2)} 秒（${Math.round(blackShare * 100)}%）`
        : '黑帧扫描不可用，需要人工抽查片头、片尾和转场'
    },
    {
      key: 'silence',
      label: '静音',
      status: !probe.hasAudio ? 'ok' : extras.content ? silenceStatus(silenceShare) : 'warn',
      detail: !probe.hasAudio
        ? '没有音频轨道，静音检测不适用'
        : extras.content
          ? `${extras.content.silenceSegments} 段，共 ${extras.content.silenceSeconds.toFixed(2)} 秒（${Math.round(silenceShare * 100)}%）`
          : '静音扫描不可用，需要人工试听'
    },
    safeAreaCheck(project),
    coverCheck(project, extras.cover)
  ];
  return {
    signature: qualitySignature(project),
    inspectedAt: new Date().toISOString(),
    path: filePath,
    width: probe.width,
    height: probe.height,
    aspect: frame.aspect,
    fps: probe.fps,
    seconds: probe.seconds,
    hasAudio: probe.hasAudio,
    checks,
    ok: reportOk(checks)
  };
}
