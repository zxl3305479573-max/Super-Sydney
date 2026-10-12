import type { ContentTask, ContentTaxonomy, VideoProject } from '../shared.ts';
import type { ContentApiConfig } from './content-workflow.ts';
import { findSubdirection } from './content-taxonomy.ts';
import { parseStyleSummary, yamlBlock, yamlScalar } from './wewrite-config.ts';
import type { WeWriteFiles } from './wewrite-files.ts';

/**
 * 内容 API 与图片 API 的配置组装。纯函数：文件内容、密钥、分类树都由调用方传入。
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_LLM_MODEL = 'deepseek-chat';

/**
 * 内容 API 配置：公众号与视频两条流水线共用同一份 writer 配置与密钥开关。
 * 关掉开关时两条流水线一起停，避免「我在公众号里关了模型调用，视频还在偷偷花钱」。
 */
export function buildContentApiConfig(input: {
  files: WeWriteFiles;
  llmEnabled: boolean;
  apiKey: string;
  taxonomy: ContentTaxonomy;
  subdirectionId?: number | null;
  env?: Env;
}): ContentApiConfig {
  const env = input.env ?? process.env;
  const writer = yamlBlock(input.files.configText, 'writer');
  const enabled = yamlScalar(writer, 'enabled');
  if (enabled ? enabled !== 'true' : !input.llmEnabled) throw new Error('请先在公众号配置中允许内容 API 调用');
  const found = input.subdirectionId !== undefined ? findSubdirection(input.taxonomy.directions, input.subdirectionId) : null;
  const style = parseStyleSummary(input.files.styleText);
  return {
    apiKey: input.apiKey,
    baseUrl: yamlScalar(writer, 'base_url') || env.SYDNEY_LLM_BASE_URL || DEFAULT_LLM_BASE_URL,
    model: yamlScalar(writer, 'model') || env.SYDNEY_LLM_MODEL || DEFAULT_LLM_MODEL,
    // 只带账号表达相关的字段：topics/default_topic 属于分类范畴，已经由内容方向表达，重复注入只会互相干扰。
    style: {
      targetAudience: style.targetAudience, tone: style.tone, voice: style.voice, wordCount: style.wordCount,
      blacklistWords: style.blacklistWords, blacklistTopics: style.blacklistTopics
    },
    ...(found ? {
      direction: { name: found.direction.name, note: found.direction.note },
      subdirection: { name: found.subdirection.name, note: found.subdirection.note }
    } : {})
  };
}

export type ImageApiConfig = { apiKey: string; baseUrl: string; model: string };

/** 图片 API 配置读 config.yaml 的 image 段（简单标量键）。 */
export function imageApiConfig(configText: string | null): ImageApiConfig {
  const apiKey = yamlScalar(configText, 'api_key');
  if (!apiKey) throw new Error('请先在公众号「环境与配置」中配置图片 API Key');
  return {
    apiKey,
    baseUrl: (yamlScalar(configText, 'base_url') || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: yamlScalar(configText, 'model') || 'gpt-image-2'
  };
}

export type ImagePromptScope = { direction: { name: string; note: string } | null; audience: string };

/** 提示词里要用的内容方向（含用户自己写的约束）与账号读者定位。 */
export function imagePromptScope(taxonomy: ContentTaxonomy, task: ContentTask, styleText: string | null): ImagePromptScope {
  const found = findSubdirection(taxonomy.directions, task.subdirectionId);
  const audience = parseStyleSummary(styleText).targetAudience;
  if (!found) return { direction: null, audience };
  return {
    direction: {
      name: found.subdirection.name ? `${found.direction.name} / ${found.subdirection.name}` : found.direction.name,
      note: [found.direction.note, found.subdirection.note].map(item => item.trim()).filter(Boolean).join(' ')
    },
    audience
  };
}

/** 封面提示词：主题 + 内容方向约束 + 读者定位，禁止文字与效果承诺。 */
export function coverImagePrompt(task: ContentTask, scope: ImagePromptScope): string {
  return [
    '公众号封面图，横构图。',
    scope.direction ? `内容方向：${scope.direction.name}${scope.direction.note ? `（${scope.direction.note}）` : ''}。` : '',
    `主题：${task.title || task.topic}。`,
    scope.audience ? `面向${scope.audience}：温暖写实、自然光、简洁清晰。` : '写实、自然光、简洁清晰。',
    '不要文字、不要水印、不要器械或医疗符号、不要夸张效果或效果承诺。'
  ].filter(Boolean).join('\n');
}

/** 竖版封面提示词：中老年观众、不要文字与医疗符号、不夸大疗效。 */
export function videoCoverPrompt(project: VideoProject): string {
  return `短视频竖版封面图，主题：${project.title || project.topic}。面向中老年观众，写实、自然光、主体清楚、对比适中；画面里不要出现文字、不要医疗符号、不要夸大疗效。`;
}
