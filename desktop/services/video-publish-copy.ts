import type { VideoProject, VideoPublishPlatform } from '../shared';

type PublishLimits = {
  title: number;
  body: number;
};

export const VIDEO_PUBLISH_LIMITS: Record<VideoPublishPlatform, PublishLimits> = {
  douyin: { title: 30, body: 1000 },
  shipinhao: { title: 16, body: 1000 },
  xiaohongshu: { title: 20, body: 1000 },
  bilibili: { title: 80, body: 2000 }
};

/** 按用户看到的字符数截断，避免把 emoji 的代理对从中间切开。 */
export function clipPublishText(value: string, limit: number): string {
  const characters = Array.from(value.trim());
  return characters.slice(0, Math.max(0, limit)).join('');
}

/** 成片发布时各平台共用的标题与正文来源；平台上限不同，标题由调用方按平台截断。 */
export function videoPublishCopy(project: Pick<VideoProject, 'title' | 'topic' | 'script'>, platform: VideoPublishPlatform): {
  title: string;
  body: string;
} {
  const limits = VIDEO_PUBLISH_LIMITS[platform];
  const sourceTitle = project.title.trim() || project.topic.trim() || '未命名视频';
  const sourceBody = project.script.trim() || project.topic.trim() || sourceTitle;
  return {
    title: clipPublishText(sourceTitle, limits.title),
    body: clipPublishText(sourceBody, limits.body)
  };
}
