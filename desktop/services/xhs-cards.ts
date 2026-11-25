import type { IpColors, IpRenderKit, XhsCardItem, XhsCardLayout, XhsCardPage, XhsCardPlan, XhsMascotMode, XhsNote } from '../shared.ts';
import { XHS_CARD_LAYOUTS, xhsCardStyle, type XhsCardStyleSpec } from './xhs-catalog.ts';

/**
 * 图文卡片本地 HTML 模板引擎 3.0（1080×1440）。
 *
 * 核心升级：
 * 1. 满版弹性纵向分布（Full-Frame Flex Rhythm）：彻底消灭旧版「内容挤在上面 1/3、中间留出 500px 空白大洞、底栏孤悬」的散乱感；
 * 2. 真实多骨架视觉世界（Multi-Skeleton Variants）：
 *    - memo：苹果备忘录横线纸直接书写 + 荧光笔涂抹 + 虚线分割（不再盖圆角灰框遮住横线）；
 *    - swiss：杂志实线分栏 + 46px 超大几何序号列（去掉廉价圆角套娃框）；
 *    - poster：黑黄高反差爆款大字报，粗黑框线 + 反转色顶栏；
 *    - grid：28px 方格学霸手账纸 + 荧光绿批注；
 *    - redblack：深炭刊头 + 红绿正反强对比测评榜；
 *    - editorial：燕麦/杏粉书页 + 宋体大标题人文排版；
 *    - notion / bento / dark：知识库提示块、满版 Bento 磁贴与暗夜黑金商业内参；
 * 3. 字号与信息密度升级：主标题 64–72px、条目小标题 37px、细节 30px，单卡稳定承载充实干货且缩略图清晰；
 * 4. 10 种语义分镜母版（新增 qa 痛点问答、quote 金句洞察）+ 免 AI「从正文快速套版」与实时预览样张。
 */

export const XHS_CARD_WIDTH = 1080;
export const XHS_CARD_HEIGHT = 1440;

const VALID_LAYOUTS = new Set<string>(XHS_CARD_LAYOUTS.map(item => item.key));
const NEGATIVE_RE = /^(❌|✗|×|误区|踩坑|避坑|错误|反例|别做|不要|禁区|雷区|风险)/;
const POSITIVE_RE = /^(✅|✓|正解|正确|做法|建议|替代|正例|推荐|必做|解法)/;
const QA_RE = /^(Q\d*[：:.\s]|问[：:\s]|为什么|怎么|如何)/i;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 先转义再解析轻量标记：【荧光高亮】、**加粗**、`行内胶囊`，用户输入绝不会注入 HTML 标签。 */
export function richCardText(value: string): string {
  return escapeHtml(value)
    .replace(/【([^】]+)】/g, '<mark>$1</mark>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function plainLength(value: string): number {
  return [...value.replace(/【|】|\*\*|`/g, '').trim()].length;
}

/**
 * 把单行文本解析为结构化卡片条目（兼容历史纯字符串 points 与逐页编辑器里的单行语法）：
 * 支持：`[角标] 小标题：具体细节`、`小标题 :: 具体细节`、或纯单句。
 */
export function parsePointLine(raw: string): XhsCardItem {
  let text = String(raw ?? '').trim();
  if (!text) return { title: '', detail: '' };
  let badge = '';
  const leadBadge = text.match(/^\[([^\]]{1,14})\]\s*(.+)$/);
  if (leadBadge) {
    badge = leadBadge[1].trim();
    text = leadBadge[2].trim();
  } else {
    const tailBadge = text.match(/^(.+?)\s*\[([^\]]{1,14})\]$/);
    if (tailBadge) {
      text = tailBadge[1].trim();
      badge = tailBadge[2].trim();
    }
  }
  const explicit = text.split(/\s*::\s*/);
  if (explicit.length >= 2 && explicit[0].trim()) {
    return { title: explicit[0].trim(), detail: explicit.slice(1).join('：').trim(), ...(badge ? { badge } : {}) };
  }
  const colon = text.match(/^([^：:｜|]{2,18})[：:｜|]\s*(.+)$/);
  if (colon && colon[2].trim()) {
    return { title: colon[1].trim(), detail: colon[2].trim(), ...(badge ? { badge } : {}) };
  }
  return { title: '', detail: text, ...(badge ? { badge } : {}) };
}

export function formatCardItemLine(item: XhsCardItem): string {
  const prefix = item.badge?.trim() ? `[${item.badge.trim()}] ` : '';
  const title = item.title.trim();
  const detail = item.detail.trim();
  if (title && detail) return `${prefix}${title}：${detail}`;
  return `${prefix}${title || detail}`.trim();
}

/** 渲染时统一取出结构化条目：优先用 page.items，老数据自动从 points 拆解小标题与细节。 */
export function resolveCardItems(page: XhsCardPage): XhsCardItem[] {
  if (page.items?.length) {
    return page.items
      .map(item => ({ title: String(item.title ?? '').trim(), detail: String(item.detail ?? '').trim(), ...(item.badge?.trim() ? { badge: item.badge.trim() } : {}) }))
      .filter(item => item.title || item.detail);
  }
  return (page.points ?? []).map(parsePointLine).filter(item => item.title || item.detail);
}

/** 逐页编辑器用的文本行表示：一行一条，改完可无损回写 items 与 points。 */
export function cardPageLines(page: XhsCardPage): string[] {
  const items = resolveCardItems(page);
  return items.length ? items.map(formatCardItemLine) : page.points;
}

export function linesToCardItems(lines: string[]): { items: XhsCardItem[]; points: string[] } {
  const items = lines.map(parsePointLine).filter(item => item.title || item.detail);
  return { items, points: items.map(formatCardItemLine) };
}

export function resolveCardLayout(page: XhsCardPage, index: number, total: number): XhsCardLayout {
  if (page.layout && VALID_LAYOUTS.has(page.layout)) return page.layout;
  if (page.stats?.length) return 'metrics';
  const items = resolveCardItems(page);
  if (items.some(item => NEGATIVE_RE.test(item.title || item.detail)) && items.some(item => POSITIVE_RE.test(item.title || item.detail))) {
    return 'compare';
  }
  if (items.length >= 2 && items.every(item => QA_RE.test(item.title))) {
    return 'qa';
  }
  if (total === 1) return items.length >= 4 ? 'bento' : 'summary';
  if (index === 0) return 'roadmap';
  if (index === total - 1) return 'summary';
  return 'keypoints';
}

/** 第 index 页用哪个动作：按 mascotMode 控制（默认 all 每页轮换；bookends 仅首尾页；none 不放）。 */
export function cardMascotIndex(kit: IpRenderKit | null | undefined, index: number, total = 0, mode: XhsMascotMode = 'all'): number {
  if (!kit?.poses.length || mode === 'none') return -1;
  if (mode === 'bookends' && total > 2 && index !== 0 && index !== total - 1) return -1;
  return index % kit.poses.length;
}

function blendHex(hex: string, target: string, ratio: number): string {
  const clean = (val: string) => (/^#[0-9a-f]{6}$/i.test(val) ? val.slice(1) : '000000');
  const a = clean(hex);
  const b = clean(target);
  return `#${[0, 2, 4].map(pos => {
    const from = parseInt(a.slice(pos, pos + 2), 16);
    const to = parseInt(b.slice(pos, pos + 2), 16);
    return Math.round(from + (to - from) * ratio).toString(16).padStart(2, '0');
  }).join('').toUpperCase()}`;
}

function effectiveCardStyle(styleKey: string, ipColors?: IpColors | null): XhsCardStyleSpec {
  const base = xhsCardStyle(styleKey);
  if (!ipColors) return base;
  const dark = base.variant === 'dark';
  const accent = ipColors.accent || base.accent;
  return {
    ...base,
    accent,
    soft: dark ? blendHex(accent, '#000000', 0.72) : blendHex(accent, '#FFFFFF', 0.82),
    mark: dark ? blendHex(accent, '#000000', 0.55) : blendHex(accent, '#FFFFFF', 0.62)
  };
}

/**
 * 按整页实际文字与版式列数计算字号档位（'' | 'dense' | 'denser'）：
 * 双列 Bento 会折算纵向行数，避免常规 4 宫格被误缩成蚂蚁字；真正超长 5–6 条时才收紧防裁切。
 */
export function cardDensity(page: XhsCardPage, cover: boolean, withIp = false): '' | 'dense' | 'denser' {
  const items = resolveCardItems(page);
  const isTwoCol = page.layout === 'bento' || (page.layout === 'roadmap' && items.length >= 4);
  const rawItemLines = items.reduce((total, item) => {
    const chars = plainLength(item.title) + plainLength(item.detail);
    return total + 1.1 + Math.max(1, Math.ceil(chars / 20)) * 1.15 + (item.title && item.detail ? 0.35 : 0);
  }, 0);
  const itemLines = isTwoCol ? rawItemLines * 0.56 : rawItemLines;
  const headLines = Math.ceil(Math.max(1, plainLength(page.heading)) / (cover ? 11 : 13)) * 1.35;
  const extra = (page.lead ? Math.ceil(plainLength(page.lead) / 24) * 1.05 : 0)
    + (page.stats?.length ? 2.1 : 0)
    + (page.emphasis ? 1.35 : 0)
    + (withIp ? 2.2 : 0);
  const score = itemLines + headLines + extra;
  return score > 21.5 ? 'denser' : score > 9.5 ? 'dense' : '';
}

function variantCss(s: XhsCardStyleSpec): string {
  if (s.variant === 'memo') {
    return `
.sheet{border-radius:30px;border:1.5px solid ${s.line};box-shadow:0 18px 46px rgba(28,25,20,.09);background-color:${s.sheet};background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 51px,${s.line}88 51px,${s.line}88 52.5px);background-position:0 84px}
.sheet-top{background:${s.surface};border-bottom:1.5px solid ${s.line}}
.chrome-memo{display:inline-flex;align-items:center;gap:8px;color:${s.accent};font-weight:800}
.lead{background:#FEF9C3;border:1.5px solid #FDE047;color:#423B2B}
.kp-item,.chk-row,.qa-card{background:transparent;border:0;border-bottom:2px dashed ${s.line};border-radius:0;padding-inline:8px}
.kp-list>.kp-item:last-child,.chk-list>.chk-row:last-child,.qa-list>.qa-card:last-child{border-bottom:0}
.kp-idx{background:${s.soft};color:#92400E;border:2px solid ${s.accent};border-radius:50%}
.bento-tile,.step-card,.stat-box{background:rgba(255,253,247,.88);border:1.5px solid ${s.line}}
mark{background:linear-gradient(transparent 44%,${s.mark} 44%,${s.mark} 94%,transparent 94%);padding:0 5px;color:${s.ink}}`;
  }

  if (s.variant === 'poster') {
    return `
.card{padding:24px}
.sheet{border-radius:24px;border:3.5px solid ${s.line};box-shadow:10px 10px 0 ${s.line}}
.sheet-top{background:${s.ink};color:#FFFFFF;border-bottom:3px solid ${s.line};height:82px}
.sheet-top .kicker{color:#FFFFFF}
.sheet-top .kicker-dot{background:${s.mark}}
.sheet-top .no{background:${s.mark};color:${s.ink}}
.lead{background:${s.soft};border:2px solid ${s.line};color:${s.ink};font-weight:700}
.kp-item,.bento-tile,.step-card,.chk-row,.qa-card,.stat-box{border:2.5px solid ${s.line};background:#FFFFFF;box-shadow:4px 4px 0 ${s.line}}
.kp-idx{background:${s.ink};color:${s.mark};border-radius:10px}
.emphasis{background:${s.ink};color:#FFFFFF;border:0}
.emphasis .emp-tag{background:${s.mark};color:${s.ink}}
.emphasis code{background:rgba(255,255,255,.16);color:${s.mark};border-color:rgba(255,255,255,.28)}
mark{background:${s.mark};padding:1px 7px;border-radius:6px;border:1.5px solid ${s.line};color:${s.ink}}`;
  }

  if (s.variant === 'grid') {
    return `
.sheet{border-radius:26px;border:2px solid ${s.line};box-shadow:0 16px 40px rgba(18,52,38,.08);background-color:${s.sheet};background-image:linear-gradient(to right,${s.line}4D 1px,transparent 1px),linear-gradient(to bottom,${s.line}4D 1px,transparent 1px);background-size:28px 28px}
.sheet-top{background:${s.surface};border-bottom:2px solid ${s.line}}
.kp-item,.bento-tile,.step-card,.chk-row,.qa-card,.stat-box{background:rgba(255,255,255,.92);border:1.5px solid ${s.line};border-radius:16px}
mark{background:linear-gradient(transparent 48%,${s.mark} 48%,${s.mark} 94%,transparent 94%);padding:0 5px;color:${s.ink}}`;
  }

  if (s.variant === 'redblack') {
    return `
.sheet{border-radius:24px;border:2.5px solid ${s.ink};box-shadow:0 18px 44px rgba(0,0,0,.09)}
.sheet-top{background:${s.ink};color:#FFFFFF;height:80px}
.sheet-top .kicker{color:#FFFFFF}
.sheet-top .kicker-dot{background:#F87171}
.sheet-top .no{background:#DC2626;color:#FFFFFF}
.kp-item,.bento-tile,.step-card,.chk-row,.qa-card{border:1.5px solid ${s.line};background:${s.surface}}
mark{background:linear-gradient(transparent 52%,${s.mark} 52%,${s.mark} 94%,transparent 94%);padding:0 5px;color:inherit}`;
  }

  if (s.variant === 'bento') {
    return `
.sheet{border-radius:30px;border:1.5px solid ${s.line};box-shadow:0 20px 50px rgba(15,23,42,.08),0 2px 6px rgba(15,23,42,.04)}
.sheet-top{background:${s.surface};border-bottom:1.5px solid ${s.line}}
.win-dots{display:inline-flex;gap:9px;margin-right:8px}
.win-dots i{width:14px;height:14px;border-radius:50%;display:inline-block}
.win-dots i:nth-child(1){background:#FF5F57}.win-dots i:nth-child(2){background:#FEBC2E}.win-dots i:nth-child(3){background:#28C840}
mark{background:linear-gradient(transparent 52%,${s.mark} 52%,${s.mark} 94%,transparent 94%);padding:0 5px;color:inherit}`;
  }

  if (s.variant === 'dark') {
    return `
.card{background:radial-gradient(circle at 86% 12%,${s.accent}24,transparent 42%),${s.bg}}
.sheet{border-radius:28px;border:1.5px solid ${s.line};box-shadow:0 24px 60px rgba(0,0,0,.52)}
.sheet-top{border-bottom:1px solid ${s.line};background:rgba(255,255,255,.03)}
.kp-item,.bento-tile,.step-card,.chk-row,.qa-card,.stat-box{background:${s.surface};border:1px solid ${s.line}}
.emphasis{background:${s.surface};border:1.5px solid ${s.accent}66}
mark{background:${s.mark};color:#FDE68A;padding:1px 7px;border-radius:6px}`;
  }

  if (s.variant === 'editorial') {
    return `
.sheet{border-radius:16px;border:1.5px solid ${s.line};box-shadow:0 14px 36px rgba(44,34,25,.07)}
.sheet-top{border-bottom:3px double ${s.line}}
.sheet-head{border-bottom:1px solid ${s.line}}
.kp-item,.chk-row,.qa-card{background:transparent;border:0;border-bottom:1px solid ${s.line};border-radius:0;padding-inline:4px}
.kp-list>.kp-item:last-child,.chk-list>.chk-row:last-child,.qa-list>.qa-card:last-child{border-bottom:0}
.kp-idx{background:transparent;color:${s.accent};font-family:${s.headingFont};font-size:42px;min-width:54px;height:auto;padding:0;margin-top:-2px}
mark{background:linear-gradient(transparent 54%,${s.mark} 54%,${s.mark} 93%,transparent 93%);padding:0 5px;color:inherit}`;
  }

  if (s.variant === 'notion') {
    return `
.sheet{border-radius:26px;border:1.5px solid ${s.line};box-shadow:0 14px 36px rgba(20,41,34,.06)}
.sheet-top{border-bottom:1.5px solid ${s.line};background:${s.surface}}
.kp-item,.bento-tile,.chk-row,.qa-card{border:1px solid ${s.line};background:${s.surface};border-radius:18px}
mark{background:${s.mark};padding:1px 6px;border-radius:6px;color:inherit}`;
  }

  // swiss（苏黎世网格 / 暖调杂志 / 黑白画报）：去圆角套娃灰框，改用杂志分栏实线 + 超大几何序号！
  return `
.card{padding:24px}
.sheet{border-radius:12px;border:2px solid ${s.line};box-shadow:8px 8px 0 ${s.line}18}
.sheet-top{border-bottom:2px solid ${s.line}}
.sheet-head{border-bottom:2px solid ${s.line}}
.kp-item{background:transparent;border:0;border-bottom:1.5px solid ${s.line};border-radius:0;padding-inline:4px}
.kp-list>.kp-item:last-child{border-bottom:0}
.kp-idx{background:transparent;color:${s.accent};font-size:46px;font-weight:950;min-width:66px;height:auto;padding:0;line-height:1;margin-top:0}
.bento-tile{border-radius:12px;border:1.5px solid ${s.line}}
mark{background:linear-gradient(transparent 52%,${s.mark} 52%,${s.mark} 94%,transparent 94%);padding:0 5px;color:inherit}`;
}

function cardCss(styleKey: string, ipColors?: IpColors | null): string {
  const s = effectiveCardStyle(styleKey, ipColors);
  const dark = s.variant === 'dark';
  const badBg = dark ? '#2D161B' : '#FFF1F2';
  const badLine = dark ? '#7F1D1D' : '#FDA4AF';
  const badInk = dark ? '#FCA5A5' : '#BE123C';
  const goodBg = dark ? '#122920' : '#ECFDF5';
  const goodLine = dark ? '#14532D' : '#6EE7B7';
  const goodInk = dark ? '#6EE7B7' : '#047857';
  const codeBg = dark ? 'rgba(255,255,255,.10)' : '#FFFFFF';
  const codeLine = dark ? 'rgba(255,255,255,.20)' : `${s.accent}44`;
  const codeInk = dark ? '#FDE68A' : s.ink;

  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${XHS_CARD_WIDTH}px;height:${XHS_CARD_HEIGHT}px;background:${s.bg};overflow:hidden}
::-webkit-scrollbar{display:none}
body{font-family:${s.font};color:${s.ink};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.card{position:relative;width:${XHS_CARD_WIDTH}px;height:${XHS_CARD_HEIGHT}px;padding:28px;background:${s.bg};overflow:hidden;display:flex}
.sheet{position:relative;width:100%;height:100%;background:${s.sheet};display:flex;flex-direction:column;overflow:hidden}
.sheet-top{flex:none;display:flex;align-items:center;justify-content:space-between;gap:16px;height:76px;padding:0 44px;font-size:24px;font-weight:750;color:${s.muted};letter-spacing:.5px}
.kicker{display:inline-flex;align-items:center;gap:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${s.ink}}
.kicker-dot{width:12px;height:12px;border-radius:3px;background:${s.accent};flex:none}
.no{flex:none;display:inline-flex;align-items:center;justify-content:center;padding:6px 18px;border-radius:999px;background:${s.soft};color:${s.accent};font-size:22px;font-weight:850;font-variant-numeric:tabular-nums;letter-spacing:1px}

.sheet-head{flex:none;padding:30px 44px 22px;display:flex;flex-direction:column;gap:16px}
h1{font-family:${s.headingFont};font-size:64px;line-height:1.18;font-weight:900;letter-spacing:-1px;color:${s.ink};text-wrap:balance}
.cover h1{font-size:70px}
.lead{font-size:29px;line-height:1.46;font-weight:600;color:${s.muted};padding:14px 20px;border-radius:14px;background:${s.surface};border:1px solid ${s.line}}
code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:.88em;padding:2px 10px;border-radius:8px;background:${codeBg};border:1.5px solid ${codeLine};color:${codeInk};font-weight:750}
strong{font-weight:850;color:${s.ink}}

/* 满版弹性内容区：子模块自动纵向延展填满画幅，告别中间留白大洞 */
.sheet-body{flex:1;min-height:0;padding:12px 44px 18px;display:flex;flex-direction:column;gap:18px;justify-content:space-between}

/* 顶部关键指标看板 */
.stats-strip{flex:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.stat-box{padding:22px 26px;border-radius:18px;background:${s.surface};border:1.5px solid ${s.line};display:flex;flex-direction:column;gap:6px}
.stat-val{font-size:50px;line-height:1.08;font-weight:950;color:${s.accent};font-variant-numeric:tabular-nums}
.stat-lbl{font-size:25px;line-height:1.35;color:${s.muted};font-weight:650}

/* 结构化要点列表 */
.kp-list{flex:1;list-style:none;display:flex;flex-direction:column;justify-content:space-evenly;gap:16px}
.kp-item{flex:1;max-height:290px;padding:22px 26px;border-radius:20px;background:${s.surface};border:1.5px solid ${s.line};display:flex;gap:20px;align-items:center}
.kp-idx{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:50px;height:50px;padding:0 12px;border-radius:14px;background:${s.accent};color:#fff;font-size:25px;font-weight:900;font-variant-numeric:tabular-nums}
.kp-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.kp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.kp-title{font-size:37px;line-height:1.28;font-weight:850;color:${s.ink}}
.badge{flex:none;display:inline-flex;align-items:center;padding:5px 15px;border-radius:999px;background:${s.soft};color:${s.accent};font-size:22px;font-weight:800}
.kp-detail{font-size:29.5px;line-height:1.52;font-weight:520;color:${s.muted}}
.kp-only{font-size:34px;line-height:1.48;font-weight:680;color:${s.ink}}

/* 2×2 满版 Bento 宫格 */
.bento-grid{flex:1;list-style:none;display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:1fr;gap:18px}
.bento-tile{padding:28px 28px;border-radius:22px;background:${s.surface};border:1.5px solid ${s.line};display:flex;flex-direction:column;justify-content:center;gap:18px}
.bento-tile.span-2{grid-column:span 2}
.bento-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.bento-no{font-size:38px;line-height:1;font-weight:950;color:${s.accent};font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.bento-mid{display:flex;flex-direction:column;gap:12px}
.bento-title{font-size:37px;line-height:1.26;font-weight:850;color:${s.ink}}
.bento-detail{font-size:29.5px;line-height:1.52;color:${s.muted};font-weight:520}

/* 步骤实操链路 */
.steps-list{flex:1;list-style:none;display:flex;flex-direction:column;justify-content:space-between;gap:16px}
.step-row{flex:1;max-height:280px;display:grid;grid-template-columns:98px minmax(0,1fr);gap:18px;align-items:stretch}
.step-rail{display:flex;flex-direction:column;align-items:center}
.step-pill{display:inline-flex;align-items:center;justify-content:center;width:94px;height:46px;border-radius:12px;background:${s.accent};color:#fff;font-size:22px;font-weight:850;font-variant-numeric:tabular-nums}
.step-line{flex:1;width:3.5px;background:${s.line};margin-top:8px;border-radius:2px}
.step-row:last-child .step-line{display:none}
.step-card{padding:22px 26px;border-radius:18px;background:${s.surface};border:1.5px solid ${s.line};display:flex;flex-direction:column;justify-content:center;gap:8px}

/* 正反避坑对比 */
.cmp-list{flex:1;list-style:none;display:flex;flex-direction:column;justify-content:space-evenly;gap:16px}
.cmp-card{flex:1;max-height:280px;padding:22px 28px;border-radius:20px;border:2px solid ${s.line};background:${s.surface};display:flex;flex-direction:column;justify-content:center;gap:8px}
.cmp-card.is-bad{background:${badBg};border-color:${badLine}}
.cmp-card.is-bad .cmp-tag{background:${badInk};color:#FFFFFF}
.cmp-card.is-good{background:${goodBg};border-color:${goodLine}}
.cmp-card.is-good .cmp-tag{background:${goodInk};color:#FFFFFF}
.cmp-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.cmp-tag{padding:5px 15px;border-radius:10px;font-size:22px;font-weight:850;background:${s.soft};color:${s.accent}}

/* 自查行动清单 */
.chk-list{flex:1;list-style:none;display:flex;flex-direction:column;justify-content:space-evenly;gap:15px}
.chk-row{flex:1;max-height:270px;padding:20px 26px;border-radius:18px;background:${s.surface};border:1.5px solid ${s.line};display:flex;gap:18px;align-items:center}
.chk-box{flex:none;width:42px;height:42px;border-radius:11px;border:2.5px solid ${s.accent};background:${s.soft};color:${s.accent};display:inline-flex;align-items:center;justify-content:center;font-size:25px;font-weight:950}

/* 痛点问答 Q&A */
.qa-list{flex:1;list-style:none;display:flex;flex-direction:column;justify-content:space-evenly;gap:18px}
.qa-card{flex:1;max-height:310px;padding:22px 26px;border-radius:20px;background:${s.surface};border:1.5px solid ${s.line};display:flex;flex-direction:column;justify-content:center;gap:12px}
.qa-q,.qa-a{display:flex;align-items:flex-start;gap:14px}
.qa-pill{flex:none;width:40px;height:40px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:950}
.qa-q .qa-pill{background:${s.ink};color:#FFFFFF}
.qa-a .qa-pill{background:${s.accent};color:#FFFFFF}

/* 金句洞察卡 */
.quote-stage{flex:1;display:flex;flex-direction:column;gap:20px}
.quote-hero{flex:1.15;padding:34px 38px;border-radius:24px;background:${s.surface};border:2px solid ${s.line};display:flex;flex-direction:column;justify-content:center;gap:16px}
.quote-mark{font-family:Georgia,serif;font-size:96px;line-height:.6;color:${s.accent};font-weight:900}
.quote-text{font-family:${s.headingFont};font-size:44px;line-height:1.34;font-weight:900;color:${s.ink}}
.quote-sublist{flex:1;list-style:none;display:flex;flex-direction:column;justify-content:space-evenly;gap:14px}

/* 一页纸满版速查表 */
.sum-table{flex:1;list-style:none;border:2px solid ${s.line};border-radius:20px;overflow:hidden;background:${s.surface};display:flex;flex-direction:column}
.sum-row{flex:1;display:grid;grid-template-columns:280px minmax(0,1fr);border-top:1.5px solid ${s.line}}
.sum-row:first-child{border-top:0}
.sum-row.is-single{grid-template-columns:minmax(0,1fr)}
.sum-key{padding:22px 24px;background:${s.soft}88;border-right:1.5px solid ${s.line};display:flex;flex-direction:column;justify-content:center;gap:8px}
.sum-val{padding:22px 28px;font-size:29.5px;line-height:1.5;font-weight:540;color:${s.ink};display:flex;align-items:center}

/* 底部收束总结框 + IP 角色左右共排 */
.sheet-foot{flex:none;padding:10px 44px 28px;display:flex;align-items:flex-end;gap:20px}
.emphasis{flex:1;min-width:0;padding:22px 28px;background:${s.soft};border:1.5px solid ${s.accent}44;border-radius:18px;font-size:29.5px;font-weight:800;line-height:1.42;color:${s.ink};display:flex;align-items:center;gap:16px}
.emp-tag{flex:none;padding:6px 14px;border-radius:9px;background:${s.accent};color:#FFFFFF;font-size:21px;font-weight:900;letter-spacing:1px}
.progress{flex:none;height:7px;width:100%;background:${s.line}44}
.progress i{display:block;height:100%;background:${s.accent}}

/* 中高密度档位（字号依然饱满易读，绝不缩成蚂蚁字） */
.card.dense .sheet-head{padding:24px 42px 16px;gap:12px}
.card.dense h1{font-size:56px}
.card.dense .lead{font-size:26.5px;padding:11px 18px}
.card.dense .sheet-body{gap:14px;padding:8px 42px 14px}
.card.dense .kp-list,.card.dense .cmp-list,.card.dense .chk-list,.card.dense .steps-list,.card.dense .qa-list{gap:13px}
.card.dense .kp-item,.card.dense .cmp-card,.card.dense .chk-row,.card.dense .step-card,.card.dense .qa-card{padding:17px 22px}
.card.dense .bento-tile{padding:22px 22px;gap:9px}
.card.dense .kp-title,.card.dense .bento-title{font-size:33px}
.card.dense .kp-detail,.card.dense .sum-val,.card.dense .bento-detail{font-size:26.5px;line-height:1.46}
.card.dense .kp-only{font-size:30px}
.card.dense .emphasis{font-size:27px;padding:18px 24px}

/* 超高信息量防溢出档位（5-6 条长干货时启用） */
.card.denser .sheet-top{height:66px;padding:0 38px;font-size:22px}
.card.denser .sheet-head{padding:20px 38px 12px;gap:10px}
.card.denser h1{font-size:48px}
.card.denser .lead{font-size:24.5px;padding:9px 16px}
.card.denser .sheet-body{gap:10px;padding:6px 38px 12px}
.card.denser .kp-list,.card.denser .cmp-list,.card.denser .chk-list,.card.denser .steps-list,.card.denser .qa-list{gap:10px}
.card.denser .kp-item,.card.denser .cmp-card,.card.denser .chk-row,.card.denser .step-card,.card.denser .qa-card{padding:13px 18px}
.card.denser .bento-grid{gap:12px}
.card.denser .bento-tile{padding:16px 18px;gap:6px}
.card.denser .kp-idx{min-width:40px;height:40px;font-size:22px}
.card.denser .kp-title,.card.denser .bento-title{font-size:29px}
.card.denser .kp-detail,.card.denser .bento-detail,.card.denser .sum-val{font-size:24px;line-height:1.42}
.card.denser .kp-only{font-size:26.5px}
.card.denser .sum-row{grid-template-columns:235px minmax(0,1fr)}
.card.denser .sum-key,.card.denser .sum-val{padding:14px 18px}
.card.denser .stat-box{padding:15px 18px}
.card.denser .stat-val{font-size:40px}
.card.denser .emphasis{font-size:24.5px;padding:14px 20px}
.card.denser .sheet-foot{padding:8px 38px 20px}
${variantCss(s)}`;
}

/** 角色的样式只在用到时输出（不带 IP 的卡片无角色节点）；与总结框左右共排，比例协调不显渺小。 */
function mascotCss(kit: IpRenderKit | null | undefined, used: number[]): string {
  const picked = [...new Set(used.filter(item => item >= 0))];
  if (!kit || !picked.length) return '';
  return `.ip-mascot{flex:none;width:152px;height:152px;margin-top:-42px;margin-left:auto;background:right bottom/contain no-repeat}
.card.denser .ip-mascot{width:128px;height:128px;margin-top:-32px}
` + picked.map(item => `.ip-m${item}{background-image:url("${kit.poses[item].src.replace(/"/g, '%22')}")}`).join('\n');
}

function renderTopChrome(style: XhsCardStyleSpec, kicker: string, index: number, total: number): string {
  const pageNo = `${index + 1}/${total}`;
  if (style.variant === 'memo') {
    return `<div class="sheet-top"><span class="chrome-memo">‹ 备忘录 · ${escapeHtml(kicker)}</span><span class="no">${pageNo}</span></div>`;
  }
  if (style.variant === 'bento') {
    return `<div class="sheet-top"><span class="kicker"><span class="win-dots"><i></i><i></i><i></i></span>${escapeHtml(kicker)}</span><span class="no">${pageNo}</span></div>`;
  }
  return `<div class="sheet-top"><span class="kicker"><i class="kicker-dot"></i>${escapeHtml(kicker)}</span><span class="no">${pageNo}</span></div>`;
}

function renderBodyByLayout(layout: XhsCardLayout, items: XhsCardItem[], stats: NonNullable<XhsCardPage['stats']>): string {
  const statsHtml = stats.length
    ? `<div class="stats-strip">${stats.map(stat => `<div class="stat-box"><span class="stat-val">${escapeHtml(stat.value)}</span><span class="stat-lbl">${escapeHtml(stat.label)}</span></div>`).join('')}</div>`
    : '';
  if (!items.length) return statsHtml;

  if (layout === 'bento' || (layout === 'roadmap' && items.length >= 4)) {
    const oddLast = items.length % 2 === 1;
    return `${statsHtml}<ul class="bento-grid">${items.map((item, idx) => {
      const span = oddLast && idx === items.length - 1 ? ' span-2' : '';
      return `<li class="bento-tile${span}">
        <div class="bento-top"><span class="bento-no">0${idx + 1}</span>${item.badge ? `<span class="badge">${escapeHtml(item.badge)}</span>` : ''}</div>
        <div class="bento-mid">
          ${item.title ? `<div class="bento-title">${richCardText(item.title)}</div>` : ''}
          ${item.detail ? `<div class="bento-detail">${richCardText(item.detail)}</div>` : ''}
        </div>
      </li>`;
    }).join('')}</ul>`;
  }

  if (layout === 'steps') {
    return `${statsHtml}<ol class="steps-list">${items.map((item, idx) => `<li class="step-row">
      <div class="step-rail"><span class="step-pill">STEP ${idx + 1}</span><span class="step-line"></span></div>
      <div class="step-card">
        <div class="kp-head">${item.title ? `<span class="kp-title">${richCardText(item.title)}</span>` : ''}${item.badge ? `<span class="badge">${escapeHtml(item.badge)}</span>` : ''}</div>
        <div class="${item.title ? 'kp-detail' : 'kp-only'}">${richCardText(item.detail)}</div>
      </div>
    </li>`).join('')}</ol>`;
  }

  if (layout === 'compare') {
    return `${statsHtml}<ul class="cmp-list">${items.map((item, idx) => {
      const probe = `${item.badge ?? ''}${item.title}${item.detail}`;
      const bad = NEGATIVE_RE.test(probe);
      const good = !bad && (POSITIVE_RE.test(probe) || idx % 2 === 1);
      const tag = item.badge || (bad ? '✗ 避坑误区' : '✓ 正确做法');
      return `<li class="cmp-card${bad ? ' is-bad' : good ? ' is-good' : ''}">
        <div class="cmp-head"><span class="cmp-tag">${escapeHtml(tag)}</span>${item.title ? `<span class="kp-title">${richCardText(item.title)}</span>` : ''}</div>
        ${item.detail ? `<div class="${item.title ? 'kp-detail' : 'kp-only'}">${richCardText(item.detail)}</div>` : ''}
      </li>`;
    }).join('')}</ul>`;
  }

  if (layout === 'checklist') {
    return `${statsHtml}<ul class="chk-list">${items.map(item => `<li class="chk-row">
      <span class="chk-box">✓</span>
      <div class="kp-main">
        <div class="kp-head">${item.title ? `<span class="kp-title">${richCardText(item.title)}</span>` : ''}${item.badge ? `<span class="badge">${escapeHtml(item.badge)}</span>` : ''}</div>
        ${item.detail ? `<div class="${item.title ? 'kp-detail' : 'kp-only'}">${richCardText(item.detail)}</div>` : ''}
      </div>
    </li>`).join('')}</ul>`;
  }

  if (layout === 'qa') {
    return `${statsHtml}<ul class="qa-list">${items.map((item, idx) => {
      const qText = (item.title || `高频卡点 0${idx + 1}`).replace(/^(Q\d*|问)[：:.\s]*/i, '');
      const aText = (item.detail || item.title).replace(/^(A\d*|答)[：:.\s]*/i, '');
      return `<li class="qa-card">
        <div class="qa-q"><span class="qa-pill">Q</span><div class="kp-head" style="flex:1"><span class="kp-title">${richCardText(qText)}</span>${item.badge ? `<span class="badge">${escapeHtml(item.badge)}</span>` : ''}</div></div>
        <div class="qa-a"><span class="qa-pill">A</span><div class="kp-detail" style="flex:1">${richCardText(aText)}</div></div>
      </li>`;
    }).join('')}</ul>`;
  }

  if (layout === 'quote') {
    const [first, ...rest] = items;
    const heroQuote = first.detail && first.title ? `${first.title}：${first.detail}` : (first.detail || first.title);
    return `${statsHtml}<div class="quote-stage">
      <div class="quote-hero"><span class="quote-mark">“</span><div class="quote-text">${richCardText(heroQuote)}</div></div>
      ${rest.length ? `<ul class="quote-sublist">${rest.map((item, idx) => `<li class="kp-item" style="max-height:200px">
        <b class="kp-idx">${String(idx + 1).padStart(2, '0')}</b>
        <div class="kp-main">
          ${item.title ? `<div class="kp-head"><span class="kp-title">${richCardText(item.title)}</span>${item.badge ? `<span class="badge">${escapeHtml(item.badge)}</span>` : ''}</div>` : ''}
          ${item.detail ? `<div class="${item.title ? 'kp-detail' : 'kp-only'}">${richCardText(item.detail)}</div>` : ''}
        </div>
      </li>`).join('')}</ul>` : ''}
    </div>`;
  }

  if (layout === 'summary') {
    return `${statsHtml}<ul class="sum-table">${items.map((item, idx) => item.title && item.detail
      ? `<li class="sum-row"><div class="sum-key"><span class="kp-title" style="font-size:32px">${richCardText(item.title)}</span>${item.badge ? `<span class="badge" style="width:fit-content">${escapeHtml(item.badge)}</span>` : ''}</div><div class="sum-val"><span>${richCardText(item.detail)}</span></div></li>`
      : `<li class="sum-row is-single"><div class="sum-val"><span><b>0${idx + 1}.</b> ${richCardText(item.title || item.detail)}</span></div></li>`
    ).join('')}</ul>`;
  }

  // keypoints / roadmap (<4 items) / metrics
  return `${statsHtml}<ul class="kp-list">${items.map((item, idx) => `<li class="kp-item">
    <b class="kp-idx">${String(idx + 1).padStart(2, '0')}</b>
    <div class="kp-main">
      ${item.title
        ? `<div class="kp-head"><span class="kp-title">${richCardText(item.title)}</span>${item.badge ? `<span class="badge">${escapeHtml(item.badge)}</span>` : ''}</div>
           ${item.detail ? `<div class="kp-detail">${richCardText(item.detail)}</div>` : ''}`
        : `<div class="kp-only">${richCardText(item.detail)}</div>`}
    </div>
  </li>`).join('')}</ul>`;
}

export function renderCardPage(page: XhsCardPage, index: number, total: number, title: string, mascot = -1, styleKey = ''): string {
  const cover = index === 0 && total > 1;
  const withIp = mascot >= 0;
  const style = xhsCardStyle(styleKey);
  const density = cardDensity(page, cover, withIp);
  const layout = resolveCardLayout(page, index, total);
  const items = resolveCardItems(page);
  const stats = (page.stats ?? []).filter(stat => stat.value.trim() || stat.label.trim()).slice(0, 3);
  const kicker = page.kicker?.trim() || (total === 1 ? '一页纸干货速查' : index === 0 ? (title.slice(0, 18) || '核心框架') : title.slice(0, 18));
  const progress = Math.max(8, Math.round(((index + 1) / Math.max(total, 1)) * 100));
  const hasFoot = Boolean(page.emphasis?.trim()) || withIp;

  return `<section class="card layout-${layout}${cover ? ' cover' : ''}${density ? ` ${density}` : ''}${withIp ? ' with-ip' : ''}">
  <div class="sheet">
    ${renderTopChrome(style, kicker, index, total)}
    <div class="sheet-head">
      <h1>${richCardText(page.heading || title)}</h1>
      ${page.lead?.trim() ? `<p class="lead">${richCardText(page.lead.trim())}</p>` : ''}
    </div>
    <div class="sheet-body">
      ${renderBodyByLayout(layout, items, stats)}
    </div>
    ${hasFoot ? `<div class="sheet-foot">
      ${page.emphasis?.trim() ? `<div class="emphasis"><span class="emp-tag">划重点</span><span>${richCardText(page.emphasis.trim())}</span></div>` : ''}
      ${withIp ? `<div class="ip-mascot ip-m${mascot}"></div>` : ''}
    </div>` : ''}
    <div class="progress"><i style="width:${progress}%"></i></div>
  </div>
</section>`;
}

/** 导出用：一页一个文档，尺寸正好 1080×1440。kit 是账号选用的 IP，没有就不放角色。 */
export function renderCardDocument(plan: XhsCardPlan, index: number, title: string, kit?: IpRenderKit | null): string {
  const page = plan.pages[index];
  if (!page) throw new Error(`第 ${index + 1} 页不存在`);
  const mascot = cardMascotIndex(kit, index, plan.pages.length, plan.mascotMode ?? 'all');
  const ipColors = plan.useIpPalette ? kit?.colors : null;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${cardCss(plan.style, ipColors)}${mascotCss(kit, [mascot])}</style></head><body>${renderCardPage(page, index, plan.pages.length, title, mascot, plan.style)}</body></html>`;
}

/** 预览用：所有页缩小后排开，或只聚焦放大看某一页（focusIndex），放进 iframe srcdoc。 */
export function renderCardsPreview(plan: XhsCardPlan, title: string, scale = 0.25, kit?: IpRenderKit | null, focusIndex?: number | null): string {
  const focused = typeof focusIndex === 'number' && focusIndex >= 0 && focusIndex < plan.pages.length ? focusIndex : null;
  const actualScale = focused !== null ? Math.max(scale, 0.42) : scale;
  const width = Math.round(XHS_CARD_WIDTH * actualScale);
  const height = Math.round(XHS_CARD_HEIGHT * actualScale);
  const indices = focused !== null ? [focused] : plan.pages.map((_, index) => index);
  const mascots = indices.map(index => cardMascotIndex(kit, index, plan.pages.length, plan.mascotMode ?? 'all'));
  const ipColors = plan.useIpPalette ? kit?.colors : null;
  const pages = indices.map((pageIdx, pos) => `<div class="frame" style="width:${width}px;height:${height}px"><div style="transform:scale(${actualScale});transform-origin:0 0">${renderCardPage(plan.pages[pageIdx], pageIdx, plan.pages.length, title, mascots[pos], plan.style)}</div></div>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${cardCss(plan.style, ipColors)}${mascotCss(kit, mascots)}
html,body{width:auto;height:auto;background:transparent;overflow:auto}
.strip{display:flex;gap:14px;padding:8px;flex-wrap:wrap;justify-content:${focused !== null ? 'center' : 'flex-start'}}
.frame{flex:none;overflow:hidden;border-radius:12px;box-shadow:0 3px 12px rgba(0,0,0,.14)}
</style></head><body><div class="strip">${pages}</div></body></html>`;
}

/**
 * 免 AI 本地秒套卡片：直接将笔记正文与经验素材切分为多张高密度结构化卡片，
 * 或在还没有拆页时生成风格样张预览，让用户点任何文字模板都能立刻看见真实排版效果。
 */
export function buildQuickCardPlan(
  note: Pick<XhsNote, 'title' | 'topic' | 'body' | 'material' | 'writerJson'>,
  styleKey: string,
  targetPages = 4
): XhsCardPlan {
  const style = xhsCardStyle(styleKey).key;
  const mainTitle = (note.title || note.topic || '核心干货速查清单').trim();
  const paragraphs = `${note.body || ''}\n${note.material || ''}`
    .replace(/#[^\s#]+/g, '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length >= 6);

  if (paragraphs.length < 2) {
    return {
      style,
      pages: [
        {
          layout: 'bento',
          kicker: '核心总览 · 建议收藏',
          heading: `${mainTitle.slice(0, 14)}【4大关键点】`,
          lead: '切换上方任意模板风格即可实时预览排版骨架；写好正文后可一键拆页。',
          items: [
            { title: '结论先行不绕弯', detail: '前 3 行直接点破具体场景痛点或【反常识判断】，留住划屏视线', badge: '开头' },
            { title: '量化标准可核对', detail: '给出明确的数字门槛、时间周期或 `操作路径`，拒绝空洞正确的废话', badge: '干货' },
            { title: '正反对比防踩坑', detail: '列清常见错误做法与替代方案，再补一条真实适用边界立住专业信任', badge: '避坑' },
            { title: '一页速查促收藏', detail: '尾页浓缩成条件对照表或打勾自查单，看完顺手点击收藏反复翻阅', badge: '转化' }
          ],
          points: [],
          emphasis: '支持【荧光笔高亮】与 `路径胶囊`，随时逐页微调版式与文案'
        },
        {
          layout: 'compare',
          kicker: '避坑对照 · 正反拆解',
          heading: '新手最容易踩的【2组误区】',
          lead: '选对结构比堆砌辞藻重要十倍，先对齐判断标准再动手。',
          items: [
            { title: '❌ 满屏套话无细节', detail: '只写「坚持好习惯、选择适合自己的」，读者看完毫无收获划走', badge: '误区' },
            { title: '✅ 信号+动作+例外', detail: '写清看哪【2个关键信号】、第一步点哪里、什么情况不适用', badge: '正解' },
            { title: '❌ 卡片留白空荡荡', detail: '一页只放两行大字凑张数，信息太散抓不住重点', badge: '误区' },
            { title: '✅ 满版结构化模块', detail: '每页聚焦一个独立子问题，小标题+数据细节上下紧凑呼应', badge: '正解' }
          ],
          points: [],
          emphasis: '点击「AI 提炼干货并拆页」可自动提取正文全部数字与细节'
        }
      ]
    };
  }

  let takeaway = '';
  try {
    if (note.writerJson?.trim()) {
      takeaway = String((JSON.parse(note.writerJson) as { coreTakeaway?: string }).coreTakeaway ?? '').trim();
    }
  } catch { /* ignore */ }

  const leadLine = paragraphs[0].slice(0, 56);
  const bodyLines = paragraphs.slice(1);
  const parsedItems: XhsCardItem[] = (bodyLines.length ? bodyLines : paragraphs).map((line, idx) => {
    const clean = line.replace(/^[\d①②③④⑤⑥一二三四五六]+[.、：:\s)）]+/, '').trim();
    const parsed = parsePointLine(clean);
    if (parsed.title) {
      return { title: parsed.title.slice(0, 18), detail: parsed.detail.slice(0, 88), ...(parsed.badge ? { badge: parsed.badge } : {}) };
    }
    const parts = clean.split(/[，,。；;！!？?]/).filter(Boolean);
    if (parts.length >= 2 && parts[0].length <= 16) {
      return { title: parts[0], detail: parts.slice(1).join('，').slice(0, 88), badge: `要点 0${(idx % 9) + 1}` };
    }
    return { title: `关键要点 0${idx + 1}`, detail: clean.slice(0, 88) };
  });

  if (targetPages === 1) {
    const items = parsedItems.slice(0, 5);
    return {
      style,
      pages: [{
        layout: items.length === 4 ? 'bento' : 'summary',
        kicker: '一页纸干货速查',
        heading: mainTitle.slice(0, 22),
        lead: leadLine,
        items,
        points: items.map(formatCardItemLine),
        emphasis: (takeaway || paragraphs[paragraphs.length - 1] || '').slice(0, 48)
      }]
    };
  }

  const pageTotal = Math.min(Math.max(2, targetPages), Math.max(2, Math.ceil(parsedItems.length / 3)));
  const perPage = Math.max(2, Math.ceil(parsedItems.length / pageTotal));
  const rotation: XhsCardLayout[] = ['bento', 'keypoints', 'steps', 'checklist', 'qa', 'summary'];
  const pages: XhsCardPage[] = [];
  for (let idx = 0; idx < pageTotal; idx += 1) {
    const slice = parsedItems.slice(idx * perPage, (idx + 1) * perPage);
    if (!slice.length) break;
    const isFirst = idx === 0;
    const isLast = idx === pageTotal - 1;
    const layout: XhsCardLayout = isFirst
      ? (slice.length >= 4 ? 'bento' : 'roadmap')
      : isLast
        ? 'summary'
        : rotation[idx % rotation.length];
    pages.push({
      layout,
      kicker: isFirst ? '核心框架总览' : isLast ? '实操核对速查' : `模块 0${idx} · 重点拆解`,
      heading: isFirst ? mainTitle.slice(0, 22) : (slice[0].title || `核心要点 0${idx}`),
      lead: isFirst ? leadLine : '',
      items: slice,
      points: slice.map(formatCardItemLine),
      emphasis: isLast ? (takeaway || leadLine).slice(0, 48) : ''
    });
  }
  return { style, pages };
}
