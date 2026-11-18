import {
  VIDEO_PUBLISH_PLATFORMS,
  type VideoCoverRatio,
  type VideoPlatformCopy,
  type VideoPublishCheckIssue,
  type VideoPublishPack,
  type VideoPublishPlatform,
  type VideoPublishValidation
} from '../shared.ts';

/**
 * 多平台视频发布纯文本与结构校验（零 Node 内置模块依赖，主进程与渲染进程通用）。
 * 本地 MP4 文件二进制读取见 services/mp4-faststart.ts。
 */

export type PlatformCopyRule = {
  label: string;
  minTitle: number;
  maxTitle: number;
  maxBody: number;
  maxTags: number;
  defaultCoverRatio: VideoCoverRatio;
};

export const PLATFORM_COPY_RULES: Record<VideoPublishPlatform, PlatformCopyRule> = {
  douyin: { label: '抖音', minTitle: 1, maxTitle: 30, maxBody: 1000, maxTags: 5, defaultCoverRatio: '3:4' },
  shipinhao: { label: '微信视频号', minTitle: 6, maxTitle: 16, maxBody: 1000, maxTags: 8, defaultCoverRatio: '4:3' },
  xiaohongshu: { label: '小红书', minTitle: 1, maxTitle: 20, maxBody: 1000, maxTags: 10, defaultCoverRatio: '3:4' },
  bilibili: { label: 'B 站', minTitle: 1, maxTitle: 80, maxBody: 2000, maxTags: 10, defaultCoverRatio: '16:9' }
};

export function charCount(value: string): number {
  return Array.from((value ?? '').trim()).length;
}

const DIVERSION_PATTERN = /(?:微信号|加微|加[vV]|\+[vV]\b|vx[:：\s]|[vV]信|私信(?:我|领|发|拿)|评论区(?:扣|领|留)|主页(?:简介|置顶)?(?:领|加))/i;
const URL_PATTERN = /https?:\/\/[^\s]+/i;
const OVERSEAS_AI_PATTERN = /\b(ChatGPT|OpenAI|Claude|Anthropic|Gemini|Midjourney)\b/i;

export function composePlatformBody(copy: Pick<VideoPlatformCopy, 'body' | 'tags'>): string {
  const base = (copy.body ?? '').trim();
  const cleanTags = (copy.tags ?? [])
    .map(tag => tag.trim().replace(/^#+/, '').trim())
    .filter(Boolean);
  const missingTags = cleanTags.filter(tag => !base.includes(`#${tag}`));
  if (!missingTags.length) return base;
  const tagLine = missingTags.map(tag => `#${tag}`).join(' ');
  return base ? `${base}\n\n${tagLine}` : tagLine;
}

export function validatePlatformCopy(platform: VideoPublishPlatform, copy: VideoPlatformCopy): VideoPublishCheckIssue[] {
  if (copy.skip) return [];
  const rule = PLATFORM_COPY_RULES[platform];
  const issues: VideoPublishCheckIssue[] = [];
  const titleLen = charCount(copy.title);
  const fullBody = composePlatformBody(copy);
  const bodyLen = charCount(fullBody);

  if (titleLen === 0) {
    issues.push({
      platform,
      level: 'error',
      code: 'title-empty',
      message: `${rule.label}标题不能为空`
    });
  } else if (titleLen < rule.minTitle) {
    issues.push({
      platform,
      level: 'error',
      code: 'title-too-short',
      message: `${rule.label}短标题至少需要 ${rule.minTitle} 个字（当前 ${titleLen} 字）`
    });
  } else if (titleLen > rule.maxTitle) {
    issues.push({
      platform,
      level: 'error',
      code: 'title-too-long',
      message: `${rule.label}标题超过上限：当前 ${titleLen}/${rule.maxTitle} 字`
    });
  }

  if (bodyLen > rule.maxBody) {
    issues.push({
      platform,
      level: 'error',
      code: 'body-too-long',
      message: `${rule.label}正文（含话题）超过上限：当前 ${bodyLen}/${rule.maxBody} 字`
    });
  }

  if (copy.tags.length > rule.maxTags) {
    issues.push({
      platform,
      level: 'warn',
      code: 'too-many-tags',
      message: `${rule.label}建议最多带 ${rule.maxTags} 个话题标签（当前 ${copy.tags.length} 个）`
    });
  }

  const combinedText = `${copy.title}\n${fullBody}`;
  if (platform === 'douyin' || platform === 'shipinhao' || platform === 'xiaohongshu') {
    const diversionMatch = combinedText.match(DIVERSION_PATTERN);
    if (diversionMatch) {
      issues.push({
        platform,
        level: 'error',
        code: 'diversion-risk',
        message: `${rule.label}检测到疑似引流词「${diversionMatch[0]}」，极易触发限流或仅自己可见`
      });
    }
    if (URL_PATTERN.test(combinedText)) {
      issues.push({
        platform,
        level: 'error',
        code: 'external-url',
        message: `${rule.label}正文或标题不建议放站外网址链接，请移除后再填草稿`
      });
    }
    const aiBrand = combinedText.match(OVERSEAS_AI_PATTERN);
    if (aiBrand) {
      issues.push({
        platform,
        level: 'warn',
        code: 'overseas-brand',
        message: `${rule.label}包含海外厂商/模型名「${aiBrand[0]}」，建议改用「AI 工具 / 智能体 / 大模型」代称以防审核延迟`
      });
    }
  }

  return issues;
}

export function validateVideoPublishPack(
  pack: Pick<VideoPublishPack, 'copies'>,
  options: { targetPlatforms?: VideoPublishPlatform[]; faststart?: boolean | null } = {}
): VideoPublishValidation {
  const issues: VideoPublishCheckIssue[] = [];
  const faststart = options.faststart ?? null;

  if (faststart === false) {
    issues.push({
      platform: 'global',
      level: 'error',
      code: 'mp4-not-faststart',
      message: '成片不是 faststart 封装（moov 在文件尾部），小红书会报「无视频流信息」、抖音可能不出表单；请重新渲染或用 ffmpeg -movflags +faststart 重封装'
    });
  }

  const targets = options.targetPlatforms ?? VIDEO_PUBLISH_PLATFORMS.map(item => item.value);
  for (const platform of targets) {
    const copy = pack.copies[platform];
    if (!copy) continue;
    issues.push(...validatePlatformCopy(platform, copy));
  }

  return {
    ok: issues.every(issue => issue.level !== 'error'),
    faststart,
    issues
  };
}
