import type { IpRenderKit, WechatIpCoverInput } from '../shared.ts';
import { escapeHtml } from './xhs-cards.ts';
import { ipPalette, pickPose, richText, titleFontSize } from './ip-theme.ts';

/**
 * 公众号的 IP 封面模板：2.35:1 的草稿封面（1410×600，按微信建议的 900×383 等比放大）+ 1:1 的分享图（900×900）。
 * 和小红书模板一样只认 IpRenderKit：配色、角色图都从当前 IP 取；画面里只放 IP 角色，不放头像和品牌名。
 * 纯字符串函数：渲染进程做预览，主进程截图导出 PNG。
 */

export const WECHAT_COVER_SIZE = { width: 1410, height: 600 } as const;
export const WECHAT_SHARE_SIZE = { width: 900, height: 900 } as const;
export type WechatIpCoverShape = 'cover' | 'share';

export const WECHAT_IP_COVER_STYLES: Array<{ key: WechatIpCoverInput['style']; label: string; hint: string }> = [
  { key: 'light', label: '浅色', hint: '浅色底 + 深色大字，干净耐看' },
  { key: 'dark', label: '深色', hint: '主色深底 + 浅色大字，信息流里更显眼' }
];

/** 想要合影 / 指向类动作；名字对不上就用最后一个（通常是合影）。 */
const POSE_WORDS = ['团队', '合影', '全员', '指'];

export function emptyWechatIpCoverInput(title = ''): WechatIpCoverInput {
  return { style: 'light', pose: '', title, sub: '', tag: '' };
}

const text = (value: unknown, limit: number) => String(value ?? '').trim().slice(0, limit);

export function normalizeWechatIpCoverInput(raw: unknown): WechatIpCoverInput {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    style: input.style === 'dark' ? 'dark' : 'light',
    pose: text(input.pose, 40), title: text(input.title, 60), sub: text(input.sub, 60), tag: text(input.tag, 20)
  };
}

export function wechatCoverPose(input: WechatIpCoverInput, kit: IpRenderKit) {
  return pickPose(kit.poses, input.pose, POSE_WORDS, kit.poses.length - 1);
}

/** 一张完整的 HTML 文档；shape 决定是 2.35:1 封面还是 1:1 分享图。 */
export function renderWechatIpCover(input: WechatIpCoverInput, kit: IpRenderKit, shape: WechatIpCoverShape): string {
  const p = ipPalette(kit.colors);
  const dark = input.style === 'dark';
  const size = shape === 'cover' ? WECHAT_COVER_SIZE : WECHAT_SHARE_SIZE;
  const hero = wechatCoverPose(input, kit)?.src;
  const bg = dark ? p.darkBg : p.softSecondary;
  const ink = dark ? p.onDarkTitle : p.ink;
  const muted = dark ? p.onDarkMuted : p.deepSecondary;
  const markColor = dark ? p.secondary : p.highlight;
  const layout = shape === 'cover'
    ? `.wrap{position:absolute;left:70px;top:64px;width:760px}
.title{margin-top:30px;font-size:${titleFontSize(input.title, 740, 104)}px}
.sub{margin-top:22px;font-size:34px}
.hero{position:absolute;right:36px;bottom:0;width:540px;height:570px;object-fit:contain;object-position:right bottom}
.deco{position:absolute;right:-120px;top:-160px;width:620px;height:620px;border-radius:50%;background:${dark ? p.darkBgRaised : p.softAccent}}`
    : `.wrap{position:absolute;left:64px;right:64px;top:64px}
.title{margin-top:30px;font-size:${titleFontSize(input.title, 772, 88)}px}
.sub{margin-top:20px;font-size:34px}
.hero{position:absolute;right:30px;bottom:0;width:480px;height:470px;object-fit:contain;object-position:right bottom}
.deco{position:absolute;left:-160px;right:-160px;bottom:-420px;height:720px;border-radius:50%;background:${dark ? p.darkBgRaised : p.softAccent}}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${size.width}px;height:${size.height}px;overflow:hidden}
body{position:relative;background:${bg};font-family:'Noto Sans SC','Microsoft YaHei',sans-serif;color:${ink};-webkit-font-smoothing:antialiased}
mark{background:linear-gradient(transparent 56%,${markColor} 56%,${markColor} 92%,transparent 92%);color:inherit;padding:0 4px}
.wrap{z-index:3}
.tag{display:inline-block;padding:10px 24px;border-radius:999px;background:${dark ? p.highlight : p.ink};color:${dark ? p.darkBg : p.highlight};font-size:28px;font-weight:800;letter-spacing:2px}
.title{font-weight:900;letter-spacing:-1px;line-height:1.2}
.sub{font-weight:600;color:${muted};line-height:1.4}
.hero{z-index:2}
${layout}
</style></head><body>
<div class="deco"></div>
<div class="wrap">
  ${input.tag ? `<span class="tag">${escapeHtml(input.tag)}</span>` : ''}
  <h1 class="title">${richText(input.title)}</h1>
  ${input.sub ? `<p class="sub">${richText(input.sub)}</p>` : ''}
</div>
${hero ? `<img class="hero" src="${escapeHtml(hero)}" alt="">` : ''}
</body></html>`;
}
