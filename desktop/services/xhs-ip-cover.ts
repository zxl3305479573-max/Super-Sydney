import type { IpRenderKit, XhsIpCoverInput, XhsIpCoverTemplate } from '../shared.ts';
import { escapeHtml, XHS_CARD_HEIGHT, XHS_CARD_WIDTH } from './xhs-cards.ts';
import { ipPalette, pickPose, richText, titleFontSize } from './ip-theme.ts';

/**
 * 小红书的 IP 封面模板（1080×1440）：IP 的透明底角色 + 真实字体排版的大标题，换标题不用重新生图，中文也不会乱码。
 *
 * 模板不认具体是哪个 IP：配色、角色图都从 IpRenderKit 取（图片是 data URI——截图窗口载入的是 data: 页面，引用不了 file://）。
 * 画面里只放 IP 角色，不放头像和品牌名。
 * 纯字符串函数：渲染进程拿它做预览（iframe srcdoc），主进程拿它截图导出 PNG。
 *
 * 标题写法：【】包住的字加荧光笔高亮，| 手动换行；字号按最长一行自动缩小，保证不出版心。
 */

export const XHS_IP_COVER_TEMPLATES: Array<{ key: XhsIpCoverTemplate; label: string; hint: string; fields: Array<keyof XhsIpCoverInput>; poseWords: string[]; poseIndex: number }> = [
  { key: 'tutorial', label: '教程实操', hint: '浅色点阵底 + 干活的角色，适合工作流实操、教程', fields: ['title', 'sub', 'tag', 'steps'], poseWords: ['打字', '电脑', '工作'], poseIndex: 0 },
  { key: 'list', label: '收藏清单', hint: '巨大数字 + 指向标题的角色，适合收藏型清单', fields: ['number', 'unit', 'title', 'sub', 'sticker'], poseWords: ['指', '介绍'], poseIndex: 1 },
  { key: 'recap', label: '真实复盘', hint: '深色底 + 角色合影和气泡台词，适合复盘、日常', fields: ['title', 'sub', 'tag', 'bubble'], poseWords: ['团队', '合影', '全员'], poseIndex: 2 }
];

const TEMPLATE_KEYS = new Set<string>(XHS_IP_COVER_TEMPLATES.map(item => item.key));
const DEFAULT_TAG: Record<XhsIpCoverTemplate, string> = { tutorial: '全流程公开', list: '', recap: '真实复盘' };
const MAX_STEPS = 5;
const STEP_MARKS = '①②③④⑤';

/** 笔记类型 → 默认模板：合集清单用 list，经验复盘、个人故事用 recap，其余用 tutorial。 */
export function defaultIpCoverTemplate(noteType: string): XhsIpCoverTemplate {
  if (noteType === 'list') return 'list';
  if (noteType === 'recap' || noteType === 'story') return 'recap';
  return 'tutorial';
}

export function emptyIpCoverInput(template: XhsIpCoverTemplate, title = ''): XhsIpCoverInput {
  return { template, pose: '', title, sub: '', tag: DEFAULT_TAG[template], steps: [], number: '10', unit: '个', sticker: '建议|收藏', bubble: '' };
}

const text = (value: unknown, limit: number) => String(value ?? '').trim().slice(0, limit);

/** IPC 进来的输入一律过一遍：未知模板拒绝，字段截断，步骤最多 5 条。 */
export function normalizeIpCoverInput(raw: unknown): XhsIpCoverInput {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const template = String(input.template ?? '');
  if (!TEMPLATE_KEYS.has(template)) throw new Error(`没有这个封面模板：${template || '（空）'}`);
  const steps = (Array.isArray(input.steps) ? input.steps : []).map(step => text(step, 12)).filter(Boolean).slice(0, MAX_STEPS);
  return {
    template: template as XhsIpCoverTemplate, pose: text(input.pose, 40),
    title: text(input.title, 60), sub: text(input.sub, 60), tag: text(input.tag, 20), steps,
    number: text(input.number, 4), unit: text(input.unit, 4), sticker: text(input.sticker, 12), bubble: text(input.bubble, 20)
  };
}

/** 这个模板这次用哪张角色图：用户指定的优先，否则按模板想要的动作名挑。 */
export function ipCoverPose(input: XhsIpCoverInput, kit: IpRenderKit) {
  const template = XHS_IP_COVER_TEMPLATES.find(item => item.key === input.template) ?? XHS_IP_COVER_TEMPLATES[0];
  return pickPose(kit.poses, input.pose, template.poseWords, template.poseIndex);
}

type Parts = { css: string; body: string };
type Palette = ReturnType<typeof ipPalette>;

function baseCss(p: Palette): string {
  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${XHS_CARD_WIDTH}px;height:${XHS_CARD_HEIGHT}px;overflow:hidden}
body{position:relative;font-family:'Noto Sans SC','Microsoft YaHei',sans-serif;color:${p.ink};-webkit-font-smoothing:antialiased}
mark{background:linear-gradient(transparent 56%,${p.highlight} 56%,${p.highlight} 92%,transparent 92%);color:inherit;padding:0 4px}
.tag{display:inline-block;padding:14px 30px;border-radius:999px;background:${p.ink};color:${p.highlight};font-size:36px;font-weight:800;letter-spacing:2px}
.title{font-weight:900;letter-spacing:-1px}
`;
}

const subBlock = (sub: string) => sub ? `<p class="sub">${richText(sub)}</p>` : '';
const tagBlock = (tag: string) => tag ? `<span class="tag">${escapeHtml(tag)}</span>` : '';
const heroBlock = (src: string | undefined) => src ? `<img class="hero" src="${escapeHtml(src)}" alt="">` : '';

/** 工作流实操：浅色点阵底，大标题 + 干活的角色。 */
function tutorial(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  return {
    css: `
body{background:${p.softSecondary} radial-gradient(${p.ink}14 3px,transparent 3.5px) 0 0/40px 40px}
.wrap{position:absolute;left:72px;right:72px;top:96px}
.title{margin-top:56px;font-size:${titleFontSize(input.title, 930, 116)}px;line-height:1.2}
.sub{margin-top:36px;font-size:44px;font-weight:600;color:${p.deepSecondary};line-height:1.45}
.steps{margin-top:44px;display:flex;flex-direction:column;gap:18px}
.steps span{align-self:flex-start;padding:12px 26px;border-radius:16px;background:#fff;border:3px solid ${p.ink};font-size:34px;font-weight:700}
.hero{position:absolute;right:30px;bottom:30px;width:520px;height:700px;object-fit:contain;object-position:right bottom}`,
    body: `<div class="wrap">
  ${tagBlock(input.tag)}
  <h1 class="title">${richText(input.title)}</h1>
  ${subBlock(input.sub)}
  ${input.steps.length ? `<div class="steps">${input.steps.map((step, index) => `<span>${STEP_MARKS[index] ?? ''} ${escapeHtml(step)}</span>`).join('')}</div>` : ''}
</div>
${heroBlock(hero)}`
  };
}

/** 收藏型清单：浅色底，巨大数字 + 指向标题的角色。 */
function list(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  return {
    css: `
body{background:${p.softAccent}}
body::before{content:'';position:absolute;inset:36px;border:4px dashed ${p.ink}30;border-radius:40px}
.wrap{position:absolute;left:80px;right:80px;top:110px}
.num{font-size:400px;font-weight:900;line-height:.9;color:${p.ink};text-shadow:16px 16px 0 ${p.shadow}}
.num small{font-size:120px;margin-left:8px;text-shadow:8px 8px 0 ${p.shadow}}
.title{margin-top:40px;font-size:${titleFontSize(input.title, 620, 104)}px;line-height:1.22;max-width:640px}
.sub{margin-top:30px;font-size:42px;font-weight:600;color:${p.deepAccent};max-width:600px;line-height:1.45}
.sticker{position:absolute;right:86px;top:130px;width:220px;height:220px;border-radius:50%;background:${p.ink};color:${p.highlight};display:grid;place-items:center;text-align:center;font-size:44px;font-weight:900;line-height:1.2;transform:rotate(12deg);box-shadow:0 0 0 8px #fff,0 0 0 11px ${p.ink}}
.hero{position:absolute;right:40px;bottom:40px;width:480px;height:760px;object-fit:contain;object-position:right bottom}`,
    body: `<div class="wrap">
  <div class="num">${escapeHtml(input.number || '10')}<small>${escapeHtml(input.unit)}</small></div>
  <h1 class="title">${richText(input.title)}</h1>
  ${subBlock(input.sub)}
</div>
${input.sticker ? `<div class="sticker">${richText(input.sticker)}</div>` : ''}
${heroBlock(hero)}`
  };
}

/** 真实复盘 / 日常：深色底，浅色大字 + 角色合影。 */
function recap(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  return {
    css: `
body{background:${p.darkBg};color:${p.onDark}}
body::after{content:'';position:absolute;left:-120px;right:-120px;bottom:-260px;height:760px;border-radius:50%;background:${p.darkBgRaised}}
mark{background:linear-gradient(transparent 56%,${p.secondary} 56%,${p.secondary} 92%,transparent 92%)}
.wrap{position:absolute;left:72px;right:72px;top:96px;z-index:3}
.tag{background:${p.highlight};color:${p.darkBg}}
.title{margin-top:52px;font-size:${titleFontSize(input.title, 930, 112)}px;line-height:1.2;color:${p.onDarkTitle}}
.sub{margin-top:32px;font-size:44px;font-weight:600;color:${p.onDarkMuted};line-height:1.45}
.bubble{position:absolute;right:70px;top:680px;z-index:2;padding:22px 34px;background:#fff;color:${p.darkBg};border-radius:30px;font-size:40px;font-weight:800;border:4px solid ${p.darkBg}}
.bubble::after{content:'';position:absolute;left:60px;bottom:-26px;border:14px solid transparent;border-top:16px solid #fff}
.hero{position:absolute;left:100px;bottom:150px;width:880px;height:680px;object-fit:contain;object-position:center bottom;z-index:1}`,
    body: `<div class="wrap">
  ${tagBlock(input.tag)}
  <h1 class="title">${richText(input.title)}</h1>
  ${subBlock(input.sub)}
</div>
${input.bubble ? `<div class="bubble">${richText(input.bubble)}</div>` : ''}
${heroBlock(hero)}`
  };
}

const RENDERERS: Record<XhsIpCoverTemplate, (input: XhsIpCoverInput, palette: Palette, hero?: string) => Parts> = { tutorial, list, recap };

/** 完整的 HTML 文档，尺寸正好 1080×1440。 */
export function renderIpCoverDocument(input: XhsIpCoverInput, kit: IpRenderKit): string {
  const render = RENDERERS[input.template];
  if (!render) throw new Error(`没有这个封面模板：${input.template}`);
  const palette = ipPalette(kit.colors);
  const parts = render(input, palette, ipCoverPose(input, kit)?.src);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${baseCss(palette)}${parts.css}</style></head><body>${parts.body}</body></html>`;
}
