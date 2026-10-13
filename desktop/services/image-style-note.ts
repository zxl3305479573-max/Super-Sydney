import type { DirectionNoteSuggestion, ImageStyleRequest } from '../shared.ts';
import type { ContentApiConfig } from './content-workflow.ts';
import { DEFAULT_IMAGE_STYLE } from './image-style.ts';
import { parseJsonObject, requestChatContent } from './llm-json.ts';

/**
 * 「配图风格模板」的 AI 优化：按内容方向（名称 + 写作约束）和用户已经写的模板，
 * 整理出一段只描述画风与禁忌的模板。
 *
 * 模板会原样拼在配图提示词末尾，前面的用途、主题、段落内容由程序自动拼，
 * 所以这里不能写具体画面内容，只写"怎么画、不能画什么"。
 * 具体方向的模板生效时会整段替换上级模板，因此给具体方向的建议必须是完整模板。
 * 结果只是建议，界面展示后由用户确认采用。
 */

const MAX_TEXT = 2_000;
const MAX_NAME = 60;
const MAX_TEMPLATE = 600;

export function normalizeImageStyleRequest(input: unknown): ImageStyleRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求格式不正确');
  const source = input as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const value = source[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new Error(`${key} 必须是文本`);
    return value.trim().slice(0, max);
  };
  const request: ImageStyleRequest = {
    directionName: text('directionName', MAX_NAME),
    directionNote: text('directionNote', MAX_TEXT),
    subdirectionName: text('subdirectionName', MAX_NAME),
    subdirectionNote: text('subdirectionNote', MAX_TEXT),
    parentTemplate: text('parentTemplate', MAX_TEXT),
    template: text('template', MAX_TEXT),
    audience: text('audience', MAX_TEXT)
  };
  if (!request.directionName) throw new Error('先填写内容方向名称，再让 AI 优化配图模板');
  return request;
}

const SYSTEM = [
  '你是公众号视觉编辑，负责为一个内容方向写「配图风格模板」，它会被拼在 AI 生图提示词的末尾。',
  '输出 JSON：{"template": "模板正文", "changes": ["相对原稿做了什么改动，每条一句"]}，不要输出其它内容。',
  '提示词前面已经由程序写好了用途（封面/正文配图）、文章主题和要配合的段落，模板里不要写具体画什么内容、不要出现某篇文章的主题。',
  '模板只写两类东西：画面风格（画风/写实或插画、色调、光线、构图、氛围、人物形象）和画面里要不要出现文字、数字，以及禁止出现的元素。',
  '2-5 行，每行一句，不加序号和 Markdown 符号，全文不超过 220 字；用生图模型能理解的具体描述，不写空泛形容词堆砌。',
  '必须保留一条：画面里可以出现与内容相关的文字、字母、数字和图表数值，但要求写对、写清楚、字号够大；不要水印或 logo。',
  '用户原稿里写过的风格要求和禁忌必须全部保留（可以改写得更具体，不能删掉或放宽）。',
  '内容方向的写作约束里如果有涉及配图、画面、封面的要求，要吸收进模板；其余写作规则（语气、事实来源等）不要搬进来。',
  '风格必须贴合这个方向的领域和它自己的读者；不要套用其它领域（例如健康、医疗、养老）的画面设定或禁忌，除非方向约束或原稿里写了。',
  '可以用占位符 {读者} 代表账号的读者定位，例如"面向{读者}："；不要自己编具体的读者年龄段，除非方向约束里写了。',
  '只要 template 与原稿有任何差异，changes 就不能为空。'
].join('\n');

/** 只带方向自己的目标读者（可空），不用账号级读者定位：理由同 direction-note。模板里仍建议用 {读者} 占位，生图时代入。 */
export function buildImageStylePrompt(request: ImageStyleRequest): string {
  const isSub = Boolean(request.subdirectionName);
  const parent = request.parentTemplate || DEFAULT_IMAGE_STYLE;
  return [
    `内容方向：${request.directionName}`,
    request.audience ? `这个方向的目标读者（{读者} 会被替换成它）：${request.audience}` : '',
    `内容方向的写作约束：\n${request.directionNote || '（无）'}`,
    isSub ? `具体方向：${request.subdirectionName}` : '',
    isSub ? `具体方向的额外要求：\n${request.subdirectionNote || '（无）'}` : '',
    isSub ? `上级方向当前生效的配图模板：\n${parent}` : '',
    `${isSub ? '具体方向' : '内容方向'}配图模板原稿：\n${request.template || (isSub ? '（空：在上级模板基础上，按这个具体方向调整）' : `（空，可参考内置默认模板改写）\n${DEFAULT_IMAGE_STYLE}`)}`,
    isSub
      ? '任务：给出这个具体方向的完整配图模板。它生效时会整段替换上级模板，所以上级模板里仍然适用的风格和禁忌要一并写进去，再按具体方向调整。'
      : '任务：给出这个内容方向的完整配图模板。'
  ].filter(Boolean).join('\n\n');
}

export function parseImageStyleSuggestion(content: string): DirectionNoteSuggestion {
  const value = parseJsonObject(content, '内容 API');
  const raw = typeof value.template === 'string' ? value.template : typeof value.note === 'string' ? value.note : '';
  const note = raw.split('\n').map(line => line.trim().replace(/^(?:[-*•]|\d+[.、)])\s*/, '')).filter(Boolean).join('\n');
  if (!note) throw new Error('AI 没有给出配图模板，请补充几句风格要求后重试');
  const changes = Array.isArray(value.changes) ? value.changes.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()) : [];
  return { note: note.slice(0, MAX_TEMPLATE), changes };
}

export async function requestImageStyle(request: ImageStyleRequest, config: ContentApiConfig, fetchImpl: typeof fetch = fetch): Promise<DirectionNoteSuggestion> {
  if (!config.apiKey.trim()) throw new Error('请先配置内容生成 API Key');
  if (!config.baseUrl.trim() || !config.model.trim()) throw new Error('请配置内容 API 地址与模型');
  const content = await requestChatContent(config, SYSTEM, buildImageStylePrompt(request), {
    label: '内容 API', timeoutMs: 60_000, temperature: 0.4, fetchImpl
  });
  return parseImageStyleSuggestion(content);
}
