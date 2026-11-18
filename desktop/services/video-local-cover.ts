import type { IpRenderKit, VideoPlatform } from '../shared.ts';
import { escapeHtml, PALETTES } from './video-compose.ts';
import { videoFrameSpec, type VideoFrameSpec } from './video-frame-spec.ts';
import { ipPalette, pickPose, richText, titleFontSize } from './ip-theme.ts';

/**
 * 视频本地确定性封面模板（0 成本秒出，不调生图接口）：
 * - 支持竖屏 1080×1920（抖音/视频号/小红书）与横屏 1920×1080（B 站/通用）；
 * - 未选 IP 时提供素白松绿（clean）、暖米纸感（warm）、深邃科技（night）三套杂志大字封面；
 * - 选用 IP 时自动切换或可选 IP 浅色（ip-light）/ IP 深色（ip-dark），配色与透明底角色图全取自 IpRenderKit；
 * - 主体严格收敛在安全区与黄金视觉中心，完美适配下游多比例衍生封面（3:4 / 4:3 / 16:9 / 9:16 高斯模糊补边）。
 */

export type VideoLocalCoverStyle = 'clean' | 'warm' | 'night' | 'ip-light' | 'ip-dark';

export type VideoLocalCoverInput = {
  style: VideoLocalCoverStyle;
  /** IP 角色动作 id；空串按关键词自动挑选。 */
  pose: string;
  /** 主标题：支持【重点高亮】与 | 手动换行。 */
  title: string;
  /** 副标题或一句话补充（可选）。 */
  sub: string;
  /** 顶部胶囊角标（如「3步实操」「避坑指南」，可选）。 */
  tag: string;
};

const VALID_STYLES = new Set<VideoLocalCoverStyle>(['clean', 'warm', 'night', 'ip-light', 'ip-dark']);
const POSE_KEYWORDS = ['指', '团队', '合影', '打字'];

const cleanField = (value: unknown, limit: number) => String(value ?? '').trim().slice(0, limit);

export function emptyVideoLocalCoverInput(title = '', hasIp = false): VideoLocalCoverInput {
  return {
    style: hasIp ? 'ip-dark' : 'warm',
    pose: '',
    title: cleanField(title, 60),
    sub: '',
    tag: ''
  };
}

export function normalizeVideoLocalCoverInput(raw: unknown, hasIp = false): VideoLocalCoverInput {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fallbackStyle: VideoLocalCoverStyle = hasIp ? 'ip-dark' : 'warm';
  const rawStyle = String(record.style ?? '') as VideoLocalCoverStyle;
  let style = VALID_STYLES.has(rawStyle) ? rawStyle : fallbackStyle;
  if (!hasIp && (style === 'ip-light' || style === 'ip-dark')) {
    style = style === 'ip-dark' ? 'night' : 'warm';
  }
  return {
    style,
    pose: cleanField(record.pose, 40),
    title: cleanField(record.title, 60),
    sub: cleanField(record.sub, 60),
    tag: cleanField(record.tag, 20)
  };
}

export function videoCoverSize(platform: VideoPlatform): VideoFrameSpec {
  return videoFrameSpec(platform);
}

export function pickVideoCoverPose(input: Pick<VideoLocalCoverInput, 'pose'>, kit: IpRenderKit | null) {
  if (!kit || !kit.poses.length) return null;
  return pickPose(kit.poses, input.pose, POSE_KEYWORDS, 0);
}

type CoverTheme = {
  bg: string;
  sheet: string;
  border: string;
  ink: string;
  sub: string;
  accent: string;
  tagBg: string;
  tagInk: string;
  mark: string;
  glow: string;
};

function resolveTheme(style: VideoLocalCoverStyle, kit: IpRenderKit | null): CoverTheme {
  if (kit && (style === 'ip-light' || style === 'ip-dark')) {
    const p = ipPalette(kit.colors);
    if (style === 'ip-dark') {
      return {
        bg: p.darkBg,
        sheet: p.darkBgRaised,
        border: 'rgba(255,255,255,0.14)',
        ink: p.onDarkTitle,
        sub: p.onDarkMuted,
        accent: p.highlight,
        tagBg: p.highlight,
        tagInk: p.ink,
        mark: p.secondary,
        glow: 'rgba(255,255,255,0.06)'
      };
    }
    return {
      bg: p.softSecondary,
      sheet: '#FFFFFF',
      border: p.shadow,
      ink: p.ink,
      sub: p.deepSecondary,
      accent: p.ink,
      tagBg: p.ink,
      tagInk: '#FFFFFF',
      mark: p.highlight,
      glow: p.softAccent
    };
  }

  const key = style === 'clean' || style === 'night' ? style : 'warm';
  const base = PALETTES[key];
  const isNight = key === 'night';
  return {
    bg: base.bg,
    sheet: base.panel,
    border: base.border,
    ink: base.ink,
    sub: base.muted,
    accent: base.accent,
    tagBg: base.accent,
    tagInk: base.solidInk,
    mark: base.mark,
    glow: isNight ? 'rgba(79,209,181,0.10)' : 'rgba(35,104,91,0.07)'
  };
}

export function renderVideoLocalCoverHtml(
  rawInput: VideoLocalCoverInput,
  platform: VideoPlatform,
  kit: IpRenderKit | null = null
): string {
  const useIp = Boolean(kit && (rawInput.style === 'ip-light' || rawInput.style === 'ip-dark'));
  const input = normalizeVideoLocalCoverInput(rawInput, Boolean(kit));
  const frame = videoFrameSpec(platform);
  const landscape = frame.width > frame.height;
  const theme = resolveTheme(input.style, useIp ? kit : null);
  const pose = useIp ? pickVideoCoverPose(input, kit) : null;
  const heroSrc = pose?.src ?? '';
  const title = input.title || '未命名视频';

  const maxTitleWidth = landscape
    ? (heroSrc ? 1020 : 1480)
    : 840;
  const maxFont = landscape ? 124 : 132;
  const fontSize = Math.max(landscape ? 68 : 74, titleFontSize(title, maxTitleWidth, maxFont));

  const tagHtml = input.tag
    ? `<div class="tag">${escapeHtml(input.tag)}</div>`
    : '';
  const subHtml = input.sub
    ? `<p class="sub">${richText(input.sub)}</p>`
    : '';
  const heroHtml = heroSrc
    ? `<img class="hero" src="${escapeHtml(heroSrc)}" alt="">`
    : '';

  const layoutCss = landscape
    ? `
.sheet{position:absolute;inset:56px 72px;border-radius:36px;background:${theme.sheet};border:2px solid ${theme.border};overflow:hidden;display:flex;align-items:center;padding:72px 88px}
.glow{position:absolute;right:-140px;bottom:-180px;width:780px;height:780px;border-radius:50%;background:${theme.glow}}
.content{position:relative;z-index:2;max-width:${heroSrc ? '1080px' : '1560px'};display:flex;flex-direction:column;align-items:flex-start;gap:34px}
.title{font-size:${fontSize}px;font-weight:900;line-height:1.18;letter-spacing:-1px;color:${theme.ink};text-wrap:balance}
.sub{font-size:44px;font-weight:650;line-height:1.4;color:${theme.sub};max-width:980px}
.accent-bar{width:128px;height:12px;border-radius:999px;background:${theme.accent}}
.hero{position:absolute;right:56px;bottom:0;width:620px;height:860px;object-fit:contain;object-position:center bottom;z-index:2}`
    : `
.sheet{position:absolute;left:56px;right:56px;top:170px;bottom:340px;border-radius:40px;background:${theme.sheet};border:2px solid ${theme.border};overflow:hidden;padding:84px 68px;display:flex;flex-direction:column;justify-content:${heroSrc ? 'flex-start' : 'center'}}
.glow{position:absolute;left:-160px;right:-160px;bottom:-260px;height:820px;border-radius:50%;background:${theme.glow}}
.content{position:relative;z-index:2;display:flex;flex-direction:column;align-items:${heroSrc ? 'flex-start' : 'center'};text-align:${heroSrc ? 'left' : 'center'};gap:34px}
.title{font-size:${fontSize}px;font-weight:900;line-height:1.2;letter-spacing:-1px;color:${theme.ink};text-wrap:balance;overflow-wrap:anywhere}
.sub{font-size:48px;font-weight:650;line-height:1.4;color:${theme.sub}}
.accent-bar{width:136px;height:12px;border-radius:999px;background:${theme.accent}}
.hero{position:absolute;left:110px;right:110px;bottom:0;width:748px;height:620px;margin:0 auto;object-fit:contain;object-position:center bottom;z-index:2}`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${frame.width}px;height:${frame.height}px;overflow:hidden;background:${theme.bg};font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",sans-serif;-webkit-font-smoothing:antialiased}
.tag{display:inline-flex;align-items:center;padding:12px 30px;border-radius:999px;background:${theme.tagBg};color:${theme.tagInk};font-size:36px;font-weight:800;letter-spacing:2px}
mark{background:linear-gradient(transparent 56%,${theme.mark} 56%,${theme.mark} 92%,transparent 92%);color:inherit;padding:0 6px}
${layoutCss}
</style></head><body>
<div class="sheet">
  <div class="glow"></div>
  <div class="content">
    ${tagHtml}
    <h1 class="title">${richText(title)}</h1>
    <div class="accent-bar"></div>
    ${subHtml}
  </div>
  ${heroHtml}
</div>
</body></html>`;
}
