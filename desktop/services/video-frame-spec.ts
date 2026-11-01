import type { VideoPlatform } from '../shared.ts';

/** 一条成片最终交给 FFmpeg 编码的固定画布。所有平台差异在这里收口。 */
export type VideoFrameSpec = {
  width: number;
  height: number;
  aspect: '9:16' | '16:9';
  label: string;
};

export const VERTICAL_FRAME: VideoFrameSpec = {
  width: 1080,
  height: 1920,
  aspect: '9:16',
  label: '1080×1920 · 9:16'
};

export const LANDSCAPE_FRAME: VideoFrameSpec = {
  width: 1920,
  height: 1080,
  aspect: '16:9',
  label: '1920×1080 · 16:9'
};

/**
 * 抖音、视频号和小红书按竖屏输出；B 站和通用项目按横屏输出。
 * 外部 Skill 适配和内置逐帧渲染共用这一个函数，避免两条链路选到不同比例。
 */
export function videoFrameSpec(platform: VideoPlatform): VideoFrameSpec {
  return platform === 'bilibili' || platform === 'general' ? LANDSCAPE_FRAME : VERTICAL_FRAME;
}
