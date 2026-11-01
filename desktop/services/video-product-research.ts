/**
 * 产品片官网研究的纯函数。
 *
 * 浏览器抓取依赖 Electron，放在另一个模块；这里只处理 URL、文本压缩和品牌色，
 * 因此可以脱离桌面运行时做单测，也便于在写库前统一限制不可信网页内容的大小。
 */

export type ProductSiteResearch = {
  url: string;
  title: string;
  description: string;
  headings: string[];
  bodyText: string;
  colors: string[];
};

const MAX_RESEARCH_CHARS = 12_000;

function cleanLine(value: unknown, maxLength = 300): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function normalizeWebsiteUrl(value: unknown): string {
  const input = String(value ?? '').trim();
  if (!input) throw new Error('请填写产品官网 URL');
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('官网 URL 格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('官网只支持 HTTP 或 HTTPS 地址');
  if (url.username || url.password) throw new Error('官网 URL 不能包含账号或密码');
  url.hash = '';
  return url.href;
}

/** 只接收颜色字符串，不让网页内容直接进入 HTML style。 */
export function normalizeBrandColors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap(item => {
    const color = cleanLine(item, 32).toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(color)) return [color];
    const rgb = color.match(/^rgb\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})\s*\)$/);
    if (!rgb) return [];
    const channels = rgb.slice(1).map(Number);
    return channels.every(channel => channel <= 255) ? [`rgb(${channels.join(' ')})`] : [];
  }))].slice(0, 8);
}

function rgbOf(color: string): [number, number, number] | null {
  if (/^#[0-9a-f]{6}$/.test(color)) {
    return [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16)];
  }
  const match = color.match(/^rgb\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*\)$/);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  return values.every(value => value >= 0 && value <= 255) ? values as [number, number, number] : null;
}

/**
 * 从网页计算样式里挑一个适合做强调色的品牌色：
 * 跳过近白、近黑和低饱和灰，优先选择亮度中等且饱和度高的颜色。
 */
export function chooseProductAccent(colors: string[], fallback = '#B4472C'): string {
  let best = fallback;
  let bestScore = -1;
  for (const color of normalizeBrandColors(colors)) {
    const rgb = rgbOf(color);
    if (!rgb) continue;
    const [r, g, b] = rgb.map(value => value / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (saturation < 0.18 || luminance > 0.78 || luminance < 0.08) continue;
    const score = saturation * 2 + (1 - Math.abs(luminance - 0.43));
    if (score > bestScore) {
      best = color;
      bestScore = score;
    }
  }
  return best;
}

export function compactProductResearch(value: ProductSiteResearch): string {
  const headings = value.headings.map(item => cleanLine(item, 180)).filter(Boolean).slice(0, 24);
  const lines = [
    `官网：${normalizeWebsiteUrl(value.url)}`,
    `页面标题：${cleanLine(value.title, 240) || '未提供'}`,
    `页面描述：${cleanLine(value.description, 600) || '未提供'}`,
    headings.length ? `页面标题结构：\n${headings.map(item => `- ${item}`).join('\n')}` : '',
    `公开页面正文：\n${cleanLine(value.bodyText, MAX_RESEARCH_CHARS) || '页面没有可读取的正文'}`
  ].filter(Boolean);
  return lines.join('\n\n').slice(0, MAX_RESEARCH_CHARS);
}
