/**
 * 正文配图的纯逻辑：挑位置、写提示词、把图片插回 Markdown、提取图片清单。
 *
 * 不碰文件系统也不发网络请求，方便单测；真正的生成与上传在 main.ts。
 * 图片统一写成独立成行的 Markdown 语法 ![说明](<路径>)，这样渲染、导出和
 * 推送时都能稳定识别，不会和正文段落混在一起。
 */

import { DEFAULT_IMAGE_STYLE, renderImageStyle } from './image-style.ts';

export type ImageSlot = {
  /** 插在这一行之后（0-based）。 */
  afterLine: number;
  /** 归属的小标题；正文开头那段记为「导语」。 */
  heading: string;
  /** 所在段落的开头文字，用来生成贴合内容的提示词。 */
  excerpt: string;
};

export type InlineImage = { caption: string; source: string };

const IMAGE_LINE = /^!\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)]*))\s*\)\s*$/;
/**
 * 配图门槛只用来滤掉「- 降压药」这类碎片，不能太高：
 * 中老年科普常见两句话成段，门槛定高了整篇一张图都挑不到。
 */
const MIN_EXCERPT_LENGTH = 30;

export function matchImageLine(line: string): InlineImage | null {
  const match = line.trim().match(IMAGE_LINE);
  if (!match) return null;
  const source = (match[2] ?? match[3] ?? '').trim();
  return source ? { caption: match[1].trim(), source } : null;
}

/** 按出现顺序列出正文里的图片，用于推送前上传到微信。 */
export function listInlineImages(markdown: string): InlineImage[] {
  const found: InlineImage[] = [];
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const image = matchImageLine(line);
    if (image) found.push(image);
  }
  return found;
}

export function countInlineImages(markdown: string): number {
  return listInlineImages(markdown).length;
}

/**
 * 正文开头的提要：抹掉标题、图片、引用等结构，只留成句的文字，用来让封面也贴着文章实际内容画，
 * 而不是只看标题。正文还是空的时返回空串，调用方把这一行整段省掉。
 */
export function articleLeadExcerpt(markdown: string, limit = 200): string {
  const plain = markdown.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('![') && !line.startsWith('>'))
    .map(line => line.replace(/^(?:[-*+]|\d+[.、)])\s*/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, limit);
}

/** 前端可视化用的资源清单：封面 + 正文配图；缩略图由主进程负责生成。 */
export function collectTaskAssets(task: { coverPath: string; draft: string }): { cover: string; images: InlineImage[] } {
  return { cover: task.coverPath.trim(), images: listInlineImages(task.draft) };
}

/** 候选图分组的 key：封面固定是 cover，正文配图按位置序号。界面挑完图原样回传。 */
export const COVER_CANDIDATE_KEY = 'cover';
export function slotCandidateKey(index: number): string {
  return `slot:${index}`;
}

/**
 * 任务配图目录里的文件按用途分类：cover-* 是封面，inline-* 是正文配图，其它文件忽略。
 * 命名由生成时决定（见 ipc/content.ts），历史图片就是靠这个认出来的。
 */
export function classifyAssetFile(name: string): 'cover' | 'inline' | null {
  const base = name.trim().toLowerCase();
  if (!/\.(png|jpe?g|webp)$/.test(base)) return null;
  if (base.startsWith('cover-')) return 'cover';
  if (base.startsWith('inline-')) return 'inline';
  return null;
}

/**
 * 候选面板的选项：本次生成的排前面，再补上这篇文章以前生成过的图（去重）。
 * 历史图也在同一个目录里，去重后的顺序才是「先看新图，再往回翻」。
 */
export function mergeCandidateOptions(fresh: string[], history: string[]): Array<{ path: string; origin: 'new' | 'history' }> {
  const seen = new Set<string>();
  const options: Array<{ path: string; origin: 'new' | 'history' }> = [];
  const groups: Array<[string[], 'new' | 'history']> = [[fresh, 'new'], [history, 'history']];
  for (const [paths, origin] of groups) {
    for (const candidate of paths) {
      const target = candidate.trim();
      if (!target || seen.has(target)) continue;
      seen.add(target);
      options.push({ path: target, origin });
    }
  }
  return options;
}

/**
 * 把用户挑好的候选图分派回位置：cover 归封面，slot:<i> 归第 i 个配图位置。
 * 认不出的 key 或空路径直接丢掉——界面回传的东西不能当成可信输入。
 */
export function resolveCandidatePicks(
  slots: ImageSlot[],
  picks: Array<{ key: string; path: string }>
): { cover: string; images: Array<{ afterLine: number; caption: string; path: string }> } {
  let cover = '';
  const images: Array<{ afterLine: number; caption: string; path: string }> = [];
  for (const pick of picks) {
    const target = pick.path.trim();
    if (!target) continue;
    if (pick.key === COVER_CANDIDATE_KEY) { cover = target; continue; }
    const index = Number(pick.key.startsWith('slot:') ? pick.key.slice('slot:'.length) : NaN);
    const slot = Number.isInteger(index) ? slots[index] : undefined;
    if (slot) images.push({ afterLine: slot.afterLine, caption: slot.heading, path: target });
  }
  return { cover, images };
}

/** 挑配图位置：导语段加各小节的段落，超出上限时均匀取样覆盖全文。 */
export function planImageSlots(markdown: string, maxImages = 3): ImageSlot[] {
  const limit = Math.max(1, Math.round(maxImages));
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const candidates: ImageSlot[] = [];
  let heading = '导语';
  let paragraph: string[] = [];
  let paragraphEnd = -1;

  const flush = () => {
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text.length < MIN_EXCERPT_LENGTH) return;
    candidates.push({ afterLine: paragraphEnd, heading, excerpt: text.slice(0, 160) });
  };

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) { flush(); return; }
    const headingMatch = line.match(/^#{2,3}\s+(.*)$/);
    if (headingMatch) { flush(); heading = headingMatch[1].trim(); return; }
    if (matchImageLine(line) || line.startsWith('>')) { flush(); return; }
    paragraph.push(line);
    paragraphEnd = index;
  });
  flush();

  if (candidates.length <= limit) return candidates;
  const step = (candidates.length - 1) / (limit - 1 || 1);
  const picked = new Map<number, ImageSlot>();
  for (let index = 0; index < limit; index += 1) {
    const slot = candidates[Math.round(index * step)];
    if (slot) picked.set(slot.afterLine, slot);
  }
  return [...picked.values()];
}

/**
 * 正文配图提示词：贴合段落内容，画风与红线来自内容方向的配图风格模板，不写死某个领域。
 * direction.note 与 style 都由用户在「内容方向」里自己维护，所以换方向就等于换一套约束。
 * style 不传时用内置默认模板（按 audience 填占位符）。
 */
export function buildImagePrompt(input: { articleTitle: string; heading: string; excerpt: string; direction?: { name: string; note: string } | null; audience?: string; style?: string }): string {
  const style = input.style?.trim() || renderImageStyle(DEFAULT_IMAGE_STYLE, input.audience ?? '');
  return [
    '公众号正文配图，横构图。',
    input.direction?.name.trim() ? `内容方向：${input.direction.name.trim()}${input.direction.note.trim() ? `（${input.direction.note.trim()}）` : ''}。` : '',
    `文章主题：${input.articleTitle || '这篇文章'}；配图位置：${input.heading}。`,
    `配合这段内容：${input.excerpt}`,
    style
  ].filter(Boolean).join('\n');
}

/**
 * 「封面 + 正文配图」一次生成的前置判断。
 *
 * 正文为空或段落太短时只出封面，并把原因交给界面提示——
 * 这时候直接报错会让用户以为封面也没生成，而封面本来是可以生成的。
 */
export function planCoverAndInlineImages(markdown: string, count: number): { withInline: boolean; slots: ImageSlot[]; note: string } {
  if (!markdown.trim()) return { withInline: false, slots: [], note: '正文还是空的，这次只生成了封面' };
  const slots = planImageSlots(markdown, count);
  if (!slots.length) return { withInline: false, slots: [], note: '正文段落太短，这次只生成了封面' };
  return { withInline: true, slots, note: '' };
}

/**
 * 把并发生成的结果合并回正文：paths 与 slots 一一对应，null 表示这一张没生成成功。
 * 失败的图直接跳过，不打断已经成功的那些。
 */
export function applyGeneratedImages(markdown: string, slots: ImageSlot[], paths: Array<string | null>): { draft: string; inserted: number; failed: number } {
  const inserts = slots.flatMap((slot, index) => {
    const target = paths[index];
    return target ? [{ afterLine: slot.afterLine, caption: slot.heading, path: target }] : [];
  });
  return { draft: insertImages(markdown, inserts), inserted: inserts.length, failed: slots.length - inserts.length };
}

/** 把图片插回正文；从后往前插，避免前面的插入让后面的行号漂移。 */
export function insertImages(markdown: string, images: Array<{ afterLine: number; caption: string; path: string }>): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const ordered = [...images].sort((left, right) => right.afterLine - left.afterLine);
  for (const image of ordered) {
    const at = Math.max(0, Math.min(image.afterLine + 1, lines.length));
    lines.splice(at, 0, '', imageMarkdownLine(image.caption, image.path), '');
  }
  return lines.join('\n');
}

/** 图片的 Markdown 写法：说明去掉方括号、路径去掉尖括号，避免破坏行语法。 */
function imageMarkdownLine(caption: string, path: string): string {
  const text = caption.replace(/[[\]]/g, '').replace(/\n/g, ' ').trim();
  const target = path.replace(/[<>\n]/g, '').trim();
  return `![${text}](<${target}>)`;
}

/**
 * 换掉正文里第 index 张图（按出现顺序，与 listInlineImages 一致），说明文字保留不动。
 * 只改那一行，不动行数和其它内容。传了 expected 时，那个位置的图必须还是它——
 * 界面上看到的是保存时的正文，中途改过正文序号就可能错位，宁可报错也不换错图。
 * 序号越界或对不上时返回 null，由调用方报错。
 */
export function replaceInlineImage(markdown: string, index: number, path: string, expected?: string): string | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let seen = -1;
  for (let at = 0; at < lines.length; at += 1) {
    const image = matchImageLine(lines[at]);
    if (!image) continue;
    seen += 1;
    if (seen !== index) continue;
    if (expected !== undefined && image.source !== expected) return null;
    lines[at] = imageMarkdownLine(image.caption, path);
    return lines.join('\n');
  }
  return null;
}

/**
 * 把挑好的图放到位置上：这个位置已经有图就换掉，没有才插一张。
 * 与 insertImages 的差别只在「同一位置反复挑图」这一种情况——换图时越插越多会让正文越堆越乱。
 * 替换不改行数，所以多个位置的 afterLine 在这一轮里始终有效。
 */
export function placeImages(markdown: string, images: Array<{ afterLine: number; caption: string; path: string }>): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const ordered = [...images].sort((left, right) => right.afterLine - left.afterLine);
  const inserts: Array<{ afterLine: number; caption: string; path: string }> = [];
  for (const image of ordered) {
    const at = Math.max(0, Math.min(image.afterLine + 1, lines.length));
    // 上一轮插在这个位置的图长这样：一个空行 + 一个图片行。
    const replaced = lines[at]?.trim() === '' && matchImageLine(lines[at + 1] ?? '');
    if (replaced) {
      lines[at + 1] = imageMarkdownLine(image.caption, image.path);
      continue;
    }
    inserts.push(image);
  }
  return inserts.length ? insertImages(lines.join('\n'), inserts) : lines.join('\n');
}
