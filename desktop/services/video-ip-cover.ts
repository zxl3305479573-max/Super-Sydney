import type { IpRenderKit, VideoIpCoverInput, VideoPlatform } from '../shared.ts';
import { escapeHtml } from './xhs-cards.ts';
import { ipPalette, pickPose, richText, titleFontSize } from './ip-theme.ts';

/**
 * 视频的 IP 封面：竖屏 1080×1920 用上下布局，横屏 1920×1080 用左右布局；不放头像和品牌名。
 * 重要内容都在约 1540px 以上，不被抖音 / 视频号底部信息栏挡住。
 * 只认 IpRenderKit，配色和角色图从当前 IP 取。纯字符串函数：渲染进程预览，主进程截图导出。
 */

export const VIDEO_COVER_SIZE = { width: 1080, height: 1920 } as const;
export const VIDEO_LANDSCAPE_COVER_SIZE = { width: 1920, height: 1080 } as const;

export function videoCoverSize(platform: VideoPlatform): { width: number; height: number } {
  return platform === 'bilibili' || platform === 'general' ? VIDEO_LANDSCAPE_COVER_SIZE : VIDEO_COVER_SIZE;
}
const POSE_WORDS = ['团队', '合影', '指'];

export function emptyVideoIpCoverInput(title = ''): VideoIpCoverInput {
  return { style: 'dark', pose: '', title, sub: '' };
}

const text = (value: unknown, limit: number) => String(value ?? '').trim().slice(0, limit);

export function normalizeVideoIpCoverInput(raw: unknown): VideoIpCoverInput {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { style: input.style === 'light' ? 'light' : 'dark', pose: text(input.pose, 40), title: text(input.title, 60), sub: text(input.sub, 60) };
}

export function videoCoverPose(input: VideoIpCoverInput, kit: IpRenderKit) {
  return pickPose(kit.poses, input.pose, POSE_WORDS, kit.poses.length - 1);
}

export function renderVideoIpCover(
  input: VideoIpCoverInput,
  kit: IpRenderKit,
  size: { width: number; height: number } = VIDEO_COVER_SIZE
): string {
  const p = ipPalette(kit.colors);
  const dark = input.style === 'dark';
  const hero = videoCoverPose(input, kit)?.src;
  const { width, height } = size;
  const landscape = width > height;
  const titleSize = landscape ? titleFontSize(input.title, 820, 104) : titleFontSize(input.title, 912, 132);
  const layout = landscape
    ? `
.deco{position:absolute;right:-180px;top:-180px;width:1050px;height:1050px;border-radius:50%;background:${dark ? p.darkBgRaised : p.softAccent}}
.wrap{position:absolute;left:120px;top:150px;width:820px;z-index:3}
.title{font-size:${titleSize}px;font-weight:900;letter-spacing:-1px;line-height:1.18}
.sub{margin-top:34px;font-size:44px;font-weight:600;line-height:1.4;color:${dark ? p.onDarkMuted : p.deepSecondary}}
.hero{position:absolute;right:100px;top:90px;width:760px;height:900px;object-fit:contain;object-position:center bottom;z-index:2}`
    : `
.deco{position:absolute;left:-200px;right:-200px;top:1020px;height:1200px;border-radius:50%;background:${dark ? p.darkBgRaised : p.softAccent}}
.wrap{position:absolute;left:84px;right:84px;top:200px;z-index:3}
.title{font-size:${titleSize}px;font-weight:900;letter-spacing:-1px;line-height:1.2}
.sub{margin-top:36px;font-size:52px;font-weight:600;line-height:1.4;color:${dark ? p.onDarkMuted : p.deepSecondary}}
.hero{position:absolute;left:90px;top:820px;width:900px;height:700px;object-fit:contain;object-position:center bottom;z-index:2}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${width}px;height:${height}px;overflow:hidden}
body{position:relative;background:${dark ? p.darkBg : p.softSecondary};font-family:'Noto Sans SC','Microsoft YaHei',sans-serif;color:${dark ? p.onDarkTitle : p.ink};-webkit-font-smoothing:antialiased}
mark{background:linear-gradient(transparent 56%,${dark ? p.secondary : p.highlight} 56%,${dark ? p.secondary : p.highlight} 92%,transparent 92%);color:inherit;padding:0 4px}
${layout}
</style></head><body>
<div class="deco"></div>
<div class="wrap">
  <h1 class="title">${richText(input.title)}</h1>
  ${input.sub ? `<p class="sub">${richText(input.sub)}</p>` : ''}
</div>
${hero ? `<img class="hero" src="${escapeHtml(hero)}" alt="">` : ''}
</body></html>`;
}
