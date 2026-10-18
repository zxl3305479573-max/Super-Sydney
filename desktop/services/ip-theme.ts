import type { IpColors } from '../shared.ts';
import { escapeHtml } from './xhs-cards.ts';

/**
 * IP 模板共用的小工具：配色推导、标题富文本、字号估算、挑角色图。
 * 纯字符串函数，渲染进程（预览）与主进程（截图导出）都用；各平台的模板只从 IpRenderKit 取配色和角色图。
 */

function channels(hex: string): [number, number, number] {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '000000';
  return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

/** 把 hex 颜色向 target 混合 amount（0–1），用来从 IP 的三个颜色推出浅底、阴影、深字。 */
export function mixColor(hex: string, target: string, amount: number): string {
  const from = channels(hex);
  const to = channels(target);
  return `#${from.map((value, index) => Math.round(value + (to[index] - value) * amount).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** 由 IP 的主色 / 强调色 / 辅色推出模板要用的一整套颜色。 */
export function ipPalette(colors: IpColors) {
  return {
    ink: colors.primary,
    highlight: colors.accent,
    secondary: colors.secondary,
    softSecondary: mixColor(colors.secondary, '#FFFFFF', 0.78),
    softAccent: mixColor(colors.accent, '#FFFFFF', 0.72),
    shadow: mixColor(colors.secondary, '#FFFFFF', 0.4),
    deepSecondary: mixColor(colors.secondary, '#000000', 0.45),
    deepAccent: mixColor(colors.accent, '#000000', 0.55),
    darkBg: colors.primary,
    darkBgRaised: mixColor(colors.primary, '#FFFFFF', 0.08),
    onDark: mixColor(colors.accent, '#FFFFFF', 0.85),
    onDarkTitle: mixColor(colors.accent, '#FFFFFF', 0.45),
    onDarkMuted: mixColor(colors.primary, '#FFFFFF', 0.78)
  };
}

/** 【高亮】与 | 换行；先转义再替换，用户输入进不了标签。 */
export function richText(value: string): string {
  return escapeHtml(value).replace(/【(.+?)】/g, '<mark>$1</mark>').replace(/\|/g, '<br>');
}

/** 按最长一行算字号：中文按 1 个字宽，英文、数字和空格按半个多一点。 */
export function titleFontSize(title: string, width: number, max: number): number {
  const longest = Math.max(...title.replace(/[【】]/g, '').split('|').map(line => [...line].reduce((sum, ch) => sum + (/[ -~]/.test(ch) ? 0.56 : 1), 0)));
  return Math.min(max, Math.floor(width / Math.max(longest, 1)));
}

/**
 * 按关键词挑一个角色动作：模板说「我想要打字 / 指向 / 合影」，IP 里有名字对得上的就用它，
 * 关键词靠前的优先，都对不上再按 fallbackIndex 取。这样模板不认具体 IP，新 IP 起什么动作名都能用。
 */
export function pickPose<T extends { id: string; label: string }>(poses: T[], wanted: string, keywords: string[], fallbackIndex = 0): T | null {
  if (!poses.length) return null;
  const exact = wanted ? poses.find(pose => pose.id === wanted) : undefined;
  if (exact) return exact;
  // 关键词按优先级排：先找最想要的那种动作，找不到再退到下一个词。
  for (const word of keywords) {
    const byLabel = poses.find(pose => pose.label.includes(word));
    if (byLabel) return byLabel;
  }
  return poses[Math.min(fallbackIndex, poses.length - 1)];
}
