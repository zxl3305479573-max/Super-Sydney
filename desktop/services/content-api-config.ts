import type { ContentTask, ContentTaxonomy } from '../shared.ts';
import type { ContentApiConfig } from './content-workflow.ts';
import { findSubdirection } from './content-taxonomy.ts';
import { articleLeadExcerpt } from './content-images.ts';
import { DEFAULT_IMAGE_STYLE, renderImageStyle, resolveImageStyle } from './image-style.ts';
import { parseStyleSummary, yamlBlock, yamlScalar } from './wewrite-config.ts';
import type { WeWriteFiles } from './wewrite-files.ts';

/**
 * 内容 API 与图片 API 的配置组装。纯函数：文件内容、密钥、分类树都由调用方传入。
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_LLM_MODEL = 'deepseek-chat';

/**
 * 全应用统一的内容模型地址与模型名（「设置 → 模型」里配置，存在 config.yaml 的 writer 段）。
 * 公众号、视频、小红书、AI 整理与经验卡片都读这一处。
 */
export function writerEndpoint(configText: string | null, env: Env = process.env): { baseUrl: string; model: string } {
  const writer = yamlBlock(configText, 'writer');
  return {
    baseUrl: yamlScalar(writer, 'base_url') || env.SYDNEY_LLM_BASE_URL || DEFAULT_LLM_BASE_URL,
    model: yamlScalar(writer, 'model') || env.SYDNEY_LLM_MODEL || DEFAULT_LLM_MODEL
  };
}

/** 统一模型配置所在的位置，报错时告诉用户去哪里改。 */
export const MODEL_SETTINGS_WHERE = '「设置 → 模型」';

/**
 * 内容 API 配置：所有模块共用同一份内容模型与同一个开关（应用设置里的 llmEnabled）。
 * 关掉开关时所有模块一起停，避免「我在这里关了模型调用，别的模块还在偷偷花钱」。
 * config.yaml 里旧的 writer.enabled 不再参与判断——两个开关并存时总有一个会被忘掉。
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
  if (!input.llmEnabled) throw new Error(`请先在${MODEL_SETTINGS_WHERE}里允许调用内容模型`);
  const found = input.subdirectionId !== undefined ? findSubdirection(input.taxonomy.directions, input.subdirectionId) : null;
  /**
   * 明确传了 subdirectionId 却找不到方向时不能回退到 style.yaml：
   * 那等于把「未归类/方向被删」的文章悄悄塞给最初那份账号配置（用户改了新资料的读者定位也生效不了，
   * 选题还会按老账号的领域出），必须在界面上说清楚。视频流水线不传这个字段，仍然用 style.yaml。
   */
  if (input.subdirectionId !== undefined && !found) {
    throw new Error(input.subdirectionId === null
      ? '这篇文章还没有归到内容方向：先在「选题」里选好内容方向与具体方向，再生成'
      : '这篇文章选的具体方向已经不存在了，请重新选择内容方向');
  }
  const style = parseStyleSummary(input.files.styleText);
  return {
    apiKey: input.apiKey,
    ...writerEndpoint(input.files.configText, env),
    // 只带账号表达相关的字段：topics/default_topic 属于分类范畴，已经由内容方向表达，重复注入只会互相干扰。
    // 写作配置按公众号资料取：归类了的文章只用所属资料的值（空就是空，不回退到最初那份资料的账号设定）；
    // 视频与未归类文章没有资料，才用 style.yaml。
    style: found
      ? {
        targetAudience: found.direction.audience, tone: found.direction.tone, voice: found.direction.voice,
        wordCount: found.direction.wordCount, contentStyle: found.direction.contentStyle,
        blacklistWords: found.direction.blacklistWords, blacklistTopics: found.direction.blacklistTopics
      }
      : {
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
  const image = yamlBlock(configText, 'image');
  const apiKey = yamlScalar(image, 'api_key');
  if (!apiKey) throw new Error(`请先在${MODEL_SETTINGS_WHERE}里配置图片模型的 API Key`);
  return {
    apiKey,
    baseUrl: (yamlScalar(image, 'base_url') || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: yamlScalar(image, 'model') || 'gpt-image-2'
  };
}

/** style 是已经填好占位符的配图风格（见 image-style.ts），直接拼进提示词。 */
export type ImagePromptScope = { direction: { name: string; note: string } | null; audience: string; style: string };

/** 提示词里要用的内容方向（含用户自己写的约束）、账号读者定位与该方向的配图风格模板。 */
export function imagePromptScope(taxonomy: ContentTaxonomy, task: ContentTask, styleText: string | null): ImagePromptScope {
  const found = findSubdirection(taxonomy.directions, task.subdirectionId);
  if (!found) {
    const audience = parseStyleSummary(styleText).targetAudience;
    return { direction: null, audience, style: renderImageStyle(DEFAULT_IMAGE_STYLE, audience) };
  }
  const audience = found.direction.audience;
  return {
    direction: {
      name: found.subdirection.name ? `${found.direction.name} / ${found.subdirection.name}` : found.direction.name,
      note: [found.direction.note, found.subdirection.note].map(item => item.trim()).filter(Boolean).join(' ')
    },
    audience,
    style: renderImageStyle(resolveImageStyle(found.direction, found.subdirection), audience)
  };
}

/**
 * 封面提示词：主题 + 正文提要 + 内容方向约束 + 该方向的配图风格模板。
 * 带上正文提要，封面才会按文章实际写了什么来画，而不是只照标题猜。
 */
export function coverImagePrompt(task: ContentTask, scope: ImagePromptScope): string {
  const excerpt = articleLeadExcerpt(task.draft || task.finalArticle || '');
  return [
    '公众号封面图，横构图。',
    scope.direction ? `内容方向：${scope.direction.name}${scope.direction.note ? `（${scope.direction.note}）` : ''}。` : '',
    `主题：${task.title || task.topic}。`,
    excerpt ? `封面要贴住正文内容：${excerpt}` : '',
    scope.style
  ].filter(Boolean).join('\n');
}
