import type { VideoProject, VideoShot } from '../shared.ts';

/**
 * 视频模块的视觉提示词唯一入口。
 *
 * 分镜阶段的 image_prompt 生成规则、逐镜配图最终提示词和平台封面模板都放在这里，
 * 与口播脚本、分镜工作流以及其他内容模块的图片配置解耦。调整视频画面风格时只改本文件。
 */

/** 逐镜配图尺寸：画面区接近方形，使用各图片接口都稳定支持的正方形。 */
export const VIDEO_SHOT_IMAGE_SIZE = '1024x1024';

/** 分镜模型填写 image_prompt 时必须遵守的规则。 */
export const VIDEO_STORYBOARD_IMAGE_PROMPT_RULE = '- image_prompt：给 AI 生图用的中文画面提示词，按“主体 + 一个明确动作 + 环境 + 构图 + 光线 + 情绪”写，突出一个视觉焦点，给字幕和画面大字留出呼吸空间；风格与主题一致、光线自然；不超过 60 字。画面里不要出现任何文字、数字、标志或未提供的品牌元素。';

/** 图片接口实际收到的逐镜配图模板。 */
export const VIDEO_SHOT_IMAGE_PROMPT_TEMPLATE = [
  '短视频画面配图，主题「{title}」。画面：{subject}。',
  '只表现一个清晰的主体和一个明确动作；构图简洁，主体略偏离正中，四周留出排版呼吸空间；光线与色彩符合主题。',
  '画面中不要出现文字、字母、数字、UI、水印或未经提供的 Logo。'
].join('');

/** 图片接口实际收到的平台封面模板。 */
export const VIDEO_COVER_IMAGE_PROMPT_TEMPLATE = [
  '{aspect} 短视频封面，主题「{title}」。',
  '{context}',
  '用清晰的视觉主体表达主题，只保留一个视觉焦点和一个明确动作；主体避开文字安全区，构图简洁，画面风格与主题一致，底部留出标题安全区。',
  '画面中不要出现文字、数字、标志、水印或未经提供的 Logo。'
].join('');

/** 视频模块可恢复的三套默认提示词；设置页只保存覆盖值。 */
export const VIDEO_IMAGE_PROMPT_DEFAULTS = {
  storyboardImagePromptRule: VIDEO_STORYBOARD_IMAGE_PROMPT_RULE,
  shotImagePromptTemplate: VIDEO_SHOT_IMAGE_PROMPT_TEMPLATE,
  coverImagePromptTemplate: VIDEO_COVER_IMAGE_PROMPT_TEMPLATE
} as const;

/** 分镜没给 imagePrompt 时依次退回画面描述、画面大字和视频标题。 */
export function buildVideoShotImagePrompt(
  shot: VideoShot,
  title: string,
  template: string = VIDEO_SHOT_IMAGE_PROMPT_TEMPLATE
): string {
  const subject = (shot.imagePrompt || shot.visual || shot.caption || title).trim();
  return (template.trim() || VIDEO_SHOT_IMAGE_PROMPT_TEMPLATE)
    .replace('{title}', () => title.trim())
    .replace('{subject}', () => subject);
}

/** 封面按标题和正文前 240 字构图，不只照标题猜。 */
export function buildVideoCoverImagePrompt(
  project: VideoProject,
  template: string = VIDEO_COVER_IMAGE_PROMPT_TEMPLATE,
  aspect: '9:16' | '16:9' = project.platform === 'bilibili' || project.platform === 'general' ? '16:9' : '9:16'
): string {
  const title = (project.title || project.topic || '短视频').trim();
  const excerpt = project.script.replace(/\s+/g, ' ').trim().slice(0, 240);
  const context = excerpt ? `内容线索：${excerpt}${/[。！？!?]$/.test(excerpt) ? '' : '。'}` : '';
  return (template.trim() || VIDEO_COVER_IMAGE_PROMPT_TEMPLATE)
    .replace('{title}', () => title)
    .replace('{aspect}', () => aspect)
    .replace('{context}', () => context);
}

/** 兼容现有代码里的简短命名；新代码优先使用 build* 函数。 */
export const shotImagePrompt = buildVideoShotImagePrompt;
export const videoCoverPrompt = buildVideoCoverImagePrompt;
