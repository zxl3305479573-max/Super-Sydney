import type { DirectionNoteRequest, DirectionNoteSuggestion } from '../shared.ts';
import type { ContentApiConfig } from './content-workflow.ts';
import { parseJsonObject, requestChatContent } from './llm-json.ts';

/**
 * 「内容方向」约束说明的 AI 优化：把用户随手写的几句话整理成可直接进提示词的条目。
 *
 * 约束会原样拼进写作与配图提示词，所以这里要的是可执行的规则，不是文案润色：
 * 用户写过的限制一条不能丢，没写的只按方向本身补齐常见红线，不编造机构与数据。
 * 结果只是建议，由界面展示给用户确认后才会写回输入框。
 */

const MAX_NOTE = 2_000;
const MAX_NAME = 60;

export function normalizeDirectionNoteRequest(input: unknown): DirectionNoteRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求格式不正确');
  const source = input as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const value = source[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new Error(`${key} 必须是文本`);
    return value.trim().slice(0, max);
  };
  const request: DirectionNoteRequest = {
    directionName: text('directionName', MAX_NAME),
    directionNote: text('directionNote', MAX_NOTE),
    subdirectionName: text('subdirectionName', MAX_NAME),
    note: text('note', MAX_NOTE),
    audience: text('audience', MAX_NOTE)
  };
  if (!request.directionName) throw new Error('先填写内容方向名称，再让 AI 优化约束');
  return request;
}

const SYSTEM = [
  '你是公众号内容策划编辑，负责把「内容方向」的写作与配图约束整理成能直接放进生成提示词的规则。',
  '输出 JSON：{"note": "约束正文", "changes": ["相对原稿做了什么改动，每条一句"]}，不要输出其它内容。',
  'note 每行一条规则，不加序号和 Markdown 符号，每条一句话、可执行、可检查。',
  '用户原稿里写过的限制必须全部保留（可以改写得更清楚，不能删掉或放宽）。',
  '原稿没覆盖到的，只按这个方向本身补齐常见要求：读者与语气、内容边界与合规红线、事实与来源要求、配图画面要求与禁止出现的元素。',
  '所有规则必须紧扣这个方向的名称所指的领域和它自己的读者；不要套用其它领域（例如健康、医疗、养老）的读者设定或红线，除非原稿里写了。',
  '不要新写这些通用底线（系统已统一注入）：不编造经历/案例/采访/数字/来源、区分事实推断与意见、没有联网核实能力；原稿里与它们重复的条目可以删去，但必须在 changes 里写明删了哪条、因为已由通用底线覆盖。',
  '只要 note 与原稿有任何差异，changes 就不能为空：新增、合并、拆分、删除、改写各写一句。',
  '不编造具体机构、指南名称、数据或产品；不写与该方向无关的空话。',
  '全文不超过 400 字。'
].join('\n');

/**
 * 只注入方向自己的目标读者（可空），不用账号级 style.yaml：那是按最初那个方向写的，
 * 拿去给新方向（比如 AI 技术）起草会把它带偏成老年健康。
 */
export function buildDirectionNotePrompt(request: DirectionNoteRequest): string {
  const isSub = Boolean(request.subdirectionName);
  const lines = [
    `内容方向：${request.directionName}`,
    request.audience ? `这个方向的目标读者：${request.audience}` : '',
    isSub ? `具体方向：${request.subdirectionName}` : '',
    isSub ? `一级方向已有约束（不要重复）：\n${request.directionNote || '（无）'}` : '',
    `${isSub ? '具体方向' : '内容方向'}约束原稿：\n${request.note || '（空，请从零写）'}`,
    isSub
      ? '任务：只写这个具体方向相对一级方向的额外要求，1-4 条；一级方向已覆盖的不要再写。'
      : '任务：整理成 4-8 条规则，覆盖读者与语气、内容边界、事实要求、配图要求。'
  ];
  return lines.filter(Boolean).join('\n\n');
}

export function parseDirectionNoteSuggestion(content: string): DirectionNoteSuggestion {
  const value = parseJsonObject(content, '内容 API');
  const note = typeof value.note === 'string'
    ? value.note.split('\n').map(line => line.trim().replace(/^(?:[-*•]|\d+[.、)])\s*/, '')).filter(Boolean).join('\n')
    : '';
  if (!note) throw new Error('AI 没有给出约束内容，请补充几句原稿后重试');
  const changes = Array.isArray(value.changes) ? value.changes.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()) : [];
  return { note: note.slice(0, MAX_NOTE), changes };
}

export async function requestDirectionNote(request: DirectionNoteRequest, config: ContentApiConfig, fetchImpl: typeof fetch = fetch): Promise<DirectionNoteSuggestion> {
  if (!config.apiKey.trim()) throw new Error('请先配置内容生成 API Key');
  if (!config.baseUrl.trim() || !config.model.trim()) throw new Error('请配置内容 API 地址与模型');
  const content = await requestChatContent(config, SYSTEM, buildDirectionNotePrompt(request), {
    label: '内容 API', timeoutMs: 60_000, temperature: 0.3, fetchImpl
  });
  return parseDirectionNoteSuggestion(content);
}
