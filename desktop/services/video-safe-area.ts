import type { VideoPlatform } from '../shared.ts';
import type { VideoFrameSpec } from './video-frame-spec.ts';

export type VideoSafeAreaFractions = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type VideoSafeAreaPixels = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  label: string;
};

/**
 * 平台自带界面会遮住画面边缘。竖屏平台按各自最保守的预留值排版；
 * B 站和通用横屏沿用 5% 标题安全区。数值与 ffmpeg-skill 的平台安全区表一致。
 */
export function videoSafeAreaFractions(platform: VideoPlatform): VideoSafeAreaFractions {
  if (platform === 'douyin') return { top: 0.10, bottom: 0.22, left: 0.05, right: 0.14 };
  if (platform === 'shipinhao') return { top: 0.08, bottom: 0.20, left: 0.05, right: 0.12 };
  if (platform === 'xiaohongshu') return { top: 0.06, bottom: 0.18, left: 0.05, right: 0.12 };
  return { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 };
}

export function videoSafeArea(platform: VideoPlatform, frame: VideoFrameSpec): VideoSafeAreaPixels {
  const fractions = videoSafeAreaFractions(platform);
  return {
    top: Math.round(frame.height * fractions.top),
    bottom: Math.round(frame.height * fractions.bottom),
    left: Math.round(frame.width * fractions.left),
    right: Math.round(frame.width * fractions.right),
    label: `${Math.round(fractions.top * 100)}%/${Math.round(fractions.bottom * 100)}%/${Math.round(fractions.left * 100)}%/${Math.round(fractions.right * 100)}%`
  };
}
