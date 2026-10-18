import type { IpRenderKit, VideoIpCoverInput } from '../shared.ts';
import { escapeHtml } from './xhs-cards.ts';
import { ipPalette, pickPose, richText, titleFontSize } from './ip-theme.ts';

/**
 * 视频的 IP 竖版封面（1080×1920）：大标题在上半部分，IP 角色在下方；不放头像和品牌名。
 * 重要内容都在约 1540px 以上，不被抖音 / 视频号底部信息栏挡住。
 * 只认 IpRenderKit，配色和角色图从当前 IP 取。纯字符串函数：渲染进程预览，主进程截图导出。
 */

export const VIDEO_COVER_SIZE = { width: 1080, height: 1920 } as const;
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

export function renderVideoIpCover(input: VideoIpCoverInput, kit: IpRenderKit): string {
  const p = ipPalette(kit.colors);
  const dark = input.style === 'dark';
  const hero = videoCoverPose(input, kit)?.src;
  const { width, height } = VIDEO_COVER_SIZE;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${width}px;height:${height}px;overflow:hidden}
body{position:relative;background:${dark ? p.darkBg : p.softSecondary};font-family:'Noto Sans SC','Microsoft YaHei',sans-serif;color:${dark ? p.onDarkTitle : p.ink};-webkit-font-smoothing:antialiased}
mark{background:linear-gradient(transparent 56%,${dark ? p.secondary : p.highlight} 56%,${dark ? p.secondary : p.highlight} 92%,transparent 92%);color:inherit;padding:0 4px}
.deco{position:absolute;left:-200px;right:-200px;top:1020px;height:1200px;border-radius:50%;background:${dark ? p.darkBgRaised : p.softAccent}}
.wrap{position:absolute;left:84px;right:84px;top:200px;z-index:3}
.title{font-size:${titleFontSize(input.title, 912, 132)}px;font-weight:900;letter-spacing:-1px;line-height:1.2}
.sub{margin-top:36px;font-size:52px;font-weight:600;line-height:1.4;color:${dark ? p.onDarkMuted : p.deepSecondary}}
.hero{position:absolute;left:90px;top:820px;width:900px;height:700px;object-fit:contain;object-position:center bottom;z-index:2}
</style></head><body>
<div class="deco"></div>
<div class="wrap">
  <h1 class="title">${richText(input.title)}</h1>
  ${input.sub ? `<p class="sub">${richText(input.sub)}</p>` : ''}
</div>
${hero ? `<img class="hero" src="${escapeHtml(hero)}" alt="">` : ''}
</body></html>`;
}
