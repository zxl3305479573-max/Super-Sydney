import type { DatabaseSync } from 'node:sqlite';
import {
  VIDEO_PUBLISH_PLATFORMS,
  type VideoCoverRatio,
  type VideoPlatformCopy,
  type VideoProject,
  type VideoPublishPack,
  type VideoPublishPlatform
} from '../shared.ts';
import { requestChatContent, type ChatOptions, type LlmConfig } from './llm-json.ts';
import { parseVideoShots, shotDurations } from './video-pipeline.ts';
import { clipPublishText } from './video-publish-copy.ts';
import { PLATFORM_COPY_RULES } from './video-publish-validate.ts';

/**
 * 多平台差异化发布包（借鉴麦田 skills/maitian-publish + make-publish.mjs）：
 * - 为抖音、视频号、小红书、B 站分别维护专属标题、正文、话题标签与封面比例。
 * - B 站简介自动附带按真实配音/分镜时长计算的 `00:00` 章节时间轴。
 * - 支持一键调全应用统一内容模型生成四平台差异化文案，落库在 ops_video_publish_packs。
 */

function formatChapterTimestamp(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 从分镜与真实配音时长生成 B 站简介可用的时间轴章节（至少 2 镜时生成）。 */
export function buildBilibiliChapters(project: VideoProject): string {
  const shots = parseVideoShots(project.storyboardJson);
  if (shots.length < 2) return '';
  const { seconds } = shotDurations(project, shots);
  let cursor = 0;
  const lines: string[] = [];
  shots.forEach((shot, index) => {
    const label = (shot.caption || shot.narration.split(/[，。！？；\n]/)[0] || `第 ${shot.index} 部分`)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    if (label) lines.push(`${formatChapterTimestamp(cursor)} ${label}`);
    cursor += seconds[index] ?? shot.seconds ?? 0;
  });
  return lines.length >= 2 ? `【章节时间轴】\n${lines.join('\n')}` : '';
}

export function normalizePublishTags(raw: unknown, limit = 10): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const clean = String(item ?? '').replace(/^#+/, '').replace(/[\s,，]+/g, '').trim().slice(0, 24);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

/** 视频号短标题要求 6–16 字：太短时补上主题说明，太长时安全截断。 */
export function normalizeShipinhaoTitle(sourceTitle: string, fallbackTopic = ''): string {
  const cleaned = sourceTitle.replace(/[#@|｜【】[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
  let candidate = clipPublishText(cleaned || fallbackTopic.trim() || '实用干货分享', 16);
  if (Array.from(candidate).length < 6) {
    const padded = `${candidate}实用分享`.trim();
    candidate = clipPublishText(padded.length >= 6 ? padded : `${candidate}干货指南分享`, 16);
  }
  return candidate;
}

export function defaultPlatformCopy(project: VideoProject, platform: VideoPublishPlatform): VideoPlatformCopy {
  const rule = PLATFORM_COPY_RULES[platform];
  const baseTitle = project.title.trim() || project.topic.trim() || '未命名视频';
  const baseScript = project.script.trim() || project.topic.trim() || baseTitle;
  const chapters = platform === 'bilibili' ? buildBilibiliChapters(project) : '';

  const title = platform === 'shipinhao'
    ? normalizeShipinhaoTitle(baseTitle, project.topic)
    : clipPublishText(baseTitle, rule.maxTitle);

  let body = baseScript;
  if (platform === 'bilibili' && chapters) {
    body = `${baseScript}\n\n${chapters}`;
  }
  body = clipPublishText(body, Math.max(100, rule.maxBody - 60));

  return {
    title,
    body,
    tags: [],
    coverRatio: rule.defaultCoverRatio,
    skip: false
  };
}

export function defaultVideoPublishPack(project: VideoProject): VideoPublishPack {
  const copies = {} as Record<VideoPublishPlatform, VideoPlatformCopy>;
  for (const item of VIDEO_PUBLISH_PLATFORMS) {
    copies[item.value] = defaultPlatformCopy(project, item.value);
  }
  return {
    projectId: project.id,
    scheduledAt: '',
    copies,
    variants: {},
    updatedAt: ''
  };
}

const VALID_RATIOS = new Set<VideoCoverRatio>(['9:16', '3:4', '4:3', '16:9']);

function normalizePlatformCopy(raw: unknown, fallback: VideoPlatformCopy, platform: VideoPublishPlatform): VideoPlatformCopy {
  if (!raw || typeof raw !== 'object') return fallback;
  const record = raw as Record<string, unknown>;
  const rule = PLATFORM_COPY_RULES[platform];
  const coverRatio = VALID_RATIOS.has(record.coverRatio as VideoCoverRatio)
    ? (record.coverRatio as VideoCoverRatio)
    : fallback.coverRatio;
  return {
    title: typeof record.title === 'string' ? record.title.trim() : fallback.title,
    body: typeof record.body === 'string' ? record.body.trim() : fallback.body,
    tags: record.tags !== undefined ? normalizePublishTags(record.tags, rule.maxTags + 4) : fallback.tags,
    coverRatio,
    skip: Boolean(record.skip)
  };
}

export function getVideoPublishPack(db: DatabaseSync, project: VideoProject): VideoPublishPack {
  const defaults = defaultVideoPublishPack(project);
  const row = db.prepare('SELECT * FROM ops_video_publish_packs WHERE project_id=?').get(project.id) as Record<string, unknown> | undefined;
  if (!row) return defaults;

  let parsedCopies: Record<string, unknown> = {};
  try { parsedCopies = JSON.parse(String(row.copies_json ?? '{}')) as Record<string, unknown>; } catch { /* 损坏 JSON 退回默认 */ }

  let parsedVariants: Partial<Record<VideoCoverRatio, string>> = {};
  try {
    const rawVar = JSON.parse(String(row.variants_json ?? '{}')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(rawVar)) {
      if (VALID_RATIOS.has(k as VideoCoverRatio) && typeof v === 'string' && v.trim()) {
        parsedVariants[k as VideoCoverRatio] = v.trim();
      }
    }
  } catch { /* 损坏 JSON 退回空 */ }

  const copies = {} as Record<VideoPublishPlatform, VideoPlatformCopy>;
  for (const item of VIDEO_PUBLISH_PLATFORMS) {
    copies[item.value] = normalizePlatformCopy(parsedCopies[item.value], defaults.copies[item.value], item.value);
  }

  return {
    projectId: project.id,
    scheduledAt: String(row.scheduled_at ?? ''),
    copies,
    variants: parsedVariants,
    updatedAt: String(row.updated_at ?? '')
  };
}

export type SaveVideoPublishPackPatch = {
  scheduledAt?: string;
  copies?: Partial<Record<VideoPublishPlatform, Partial<VideoPlatformCopy>>>;
  variants?: Partial<Record<VideoCoverRatio, string>>;
};

export function saveVideoPublishPack(
  db: DatabaseSync,
  project: VideoProject,
  patch: SaveVideoPublishPackPatch,
  now = new Date().toISOString()
): VideoPublishPack {
  const current = getVideoPublishPack(db, project);
  const nextCopies = { ...current.copies };
  if (patch.copies) {
    for (const item of VIDEO_PUBLISH_PLATFORMS) {
      const p = item.value;
      if (patch.copies[p]) {
        nextCopies[p] = normalizePlatformCopy({ ...current.copies[p], ...patch.copies[p] }, current.copies[p], p);
      }
    }
  }
  const nextVariants: Partial<Record<VideoCoverRatio, string>> = patch.variants
    ? { ...current.variants, ...patch.variants }
    : current.variants;
  const scheduledAt = patch.scheduledAt !== undefined ? String(patch.scheduledAt).trim() : current.scheduledAt;

  db.prepare(`
    INSERT INTO ops_video_publish_packs (project_id, scheduled_at, copies_json, variants_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      scheduled_at=excluded.scheduled_at,
      copies_json=excluded.copies_json,
      variants_json=excluded.variants_json,
      updated_at=excluded.updated_at
  `).run(project.id, scheduledAt, JSON.stringify(nextCopies), JSON.stringify(nextVariants), now);

  return getVideoPublishPack(db, project);
}

const PUBLISH_PACK_SYSTEM_PROMPT = `你是一位精通国内多平台分发的资深自媒体总编。
请根据用户提供的视频标题、目标受众、口播脚本与分镜信息，一次性为【抖音、微信视频号、小红书、B站】四个平台编写原生调性的差异化发布文案，输出严格 JSON 对象：
{
  "douyin": { "title": "≤28字抓停留标题", "body": "痛点切入、短句快节奏正文（不含#话题）", "tags": ["话题1", "话题2", "话题3"] },
  "shipinhao": { "title": "严格6到15个字的规范短标题（不带书名号和特殊符号）", "body": "温和清晰、适合熟人推荐转发的描述（不含#话题）", "tags": ["话题1", "话题2", "话题3"] },
  "xiaohongshu": { "title": "≤19字真诚分享感标题", "body": "像跟朋友聊天的真实经验分享笔记体，少营销腔、少生硬清单（不含#话题）", "tags": ["话题1", "话题2", "话题3", "话题4"] },
  "bilibili": { "title": "≤60字信息量充足的完整标题", "body": "开头两三句讲清本期看点与收获（不含#话题，系统会自动在后面拼章节时间轴）", "tags": ["标签1", "标签2", "标签3", "标签4"] }
}

硬性合规要求：
1. 严禁在抖音、视频号、小红书文案中出现任何站外引流词（如微信号、vx、+v、私信领、评论区扣、网址链接）。
2. 在抖音、视频号、小红书里避免直写海外大模型英文品牌名（如 ChatGPT、Claude、Gemini），统一用「AI 工具」「智能体」「大模型」自然代称。
3. 抖音 tags 最多 5 个；tags 数组里不要带 # 号。`;

export function parseGeneratedPublishPackJson(rawText: string, project: VideoProject): Record<VideoPublishPlatform, VideoPlatformCopy> {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(cleaned) as Record<string, Record<string, unknown>>;
  const defaults = defaultVideoPublishPack(project).copies;
  const chapters = buildBilibiliChapters(project);

  const out = {} as Record<VideoPublishPlatform, VideoPlatformCopy>;
  for (const item of VIDEO_PUBLISH_PLATFORMS) {
    const p = item.value;
    const rule = PLATFORM_COPY_RULES[p];
    const block = parsed?.[p] ?? {};
    const rawTitle = typeof block.title === 'string' && block.title.trim() ? block.title.trim() : defaults[p].title;
    const title = p === 'shipinhao'
      ? normalizeShipinhaoTitle(rawTitle, project.topic)
      : clipPublishText(rawTitle, rule.maxTitle);

    let body = typeof block.body === 'string' && block.body.trim() ? block.body.trim() : defaults[p].body;
    if (p === 'bilibili' && chapters && !body.includes('00:00')) {
      body = `${body}\n\n${chapters}`;
    }
    body = clipPublishText(body, Math.max(120, rule.maxBody - 80));

    out[p] = {
      title,
      body,
      tags: normalizePublishTags(block.tags, rule.maxTags),
      coverRatio: defaults[p].coverRatio,
      skip: false
    };
  }
  return out;
}

export async function generateAiVideoPublishPack(
  project: VideoProject,
  llmConfig: LlmConfig,
  chatOptions: ChatOptions = {}
): Promise<Record<VideoPublishPlatform, VideoPlatformCopy>> {
  const shots = parseVideoShots(project.storyboardJson);
  const shotSummary = shots.slice(0, 12).map(s => `第${s.index}镜：${s.caption || s.visual}｜${s.narration}`).join('\n');
  const userPrompt = [
    `项目标题：${project.title || project.topic || '未命名视频'}`,
    `选题方向：${project.topic || '无'}`,
    `目标受众：${project.audience || '大众观众'}`,
    `口播脚本：\n${project.script || '（暂无完整口播稿，请根据标题和分镜撰写）'}`,
    shotSummary ? `分镜摘要：\n${shotSummary}` : ''
  ].filter(Boolean).join('\n\n');

  const response = await requestChatContent(llmConfig, PUBLISH_PACK_SYSTEM_PROMPT, userPrompt, {
    label: '多平台发布文案生成',
    temperature: 0.4,
    timeoutMs: 90_000,
    ...chatOptions
  });
  return parseGeneratedPublishPackJson(response, project);
}
