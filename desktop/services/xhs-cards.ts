import type { IpColors, IpRenderKit, XhsCardItem, XhsCardLayout, XhsCardPage, XhsCardPlan, XhsMascotMode } from '../shared.ts';
import { XHS_CARD_LAYOUTS, xhsCardStyle, type XhsCardStyleSpec } from './xhs-catalog.ts';

/**
 * 图文卡片本地 HTML 模板引擎 2.0（1080×1440）。
 *
 * 设计目标：解决「模板单调廉价、字大空洞、信息分散、抓不到核心干货」四个痛点：
 * 1. 画中纸 / 窗中窗（Sheet-in-Canvas）：外层窄衬底 + 内聚主画框，彻底去掉大圆圈与散落气泡，视线聚焦在同一张卡片容器内；
 * 2. 四级字号体系：章节角标 23px → 主标题 54px → 条目小标题 33px → 展开细节 27px，单卡可稳定承载 130–230 字结构化干货；
 * 3. 8 种语义分镜母版（roadmap / keypoints / steps / compare / bento / metrics / checklist / summary）+ 6 种容器骨架；
 * 4. 行内视觉锚点：支持【荧光笔高亮】、**加粗重点**、`胶囊路径/数字`；
 * 5. IP 角色与底部总结栏左右共排，不再切走卡片底部 1/4 空白高度。
 *
 * 纯字符串函数：渲染进程用于 iframe 实时预览，主进程用于离屏窗口 1:1 截图导出 PNG。
 */

export const XHS_CARD_WIDTH = 1080;
export const XHS_CARD_HEIGHT = 1440;

const VALID_LAYOUTS = new Set<string>(XHS_CARD_LAYOUTS.map(item => item.key));
const NEGATIVE_RE = /^(❌|✗|×|误区|踩坑|避坑|错误|反例|别做|不要|禁区|雷区|风险)/;
const POSITIVE_RE = /^(✅|✓|正解|正确|做法|建议|替代|正例|推荐|必做|解法)/;

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
 * 按整页实际文字与模块负载计算字号档位（'' | 'dense' | 'denser'）：
 * 内容充实时自动收紧内边距与字号，既允许单页放进 180+ 字干货，又保证不裁切溢出。
 */
export function cardDensity(page: XhsCardPage, cover: boolean, withIp = false): '' | 'dense' | 'denser' {
  const items = resolveCardItems(page);
  const itemLines = items.reduce((total, item) => {
    const chars = plainLength(item.title) + plainLength(item.detail);
    return total + 1.1 + Math.max(1, Math.ceil(chars / 20)) * 1.15 + (item.title && item.detail ? 0.35 : 0);
  }, 0);
  const headLines = Math.ceil(Math.max(1, plainLength(page.heading)) / (cover ? 11 : 13)) * 1.35;
  const extra = (page.lead ? Math.ceil(plainLength(page.lead) / 24) * 1.05 : 0)
    + (page.stats?.length ? 2.1 : 0)
    + (page.emphasis ? 1.35 : 0)
    + (withIp ? 2.2 : 0);
  const score = itemLines + headLines + extra;
  return score > 15.5 ? 'denser' : score > 9.5 ? 'dense' : '';
}

function variantCss(style: XhsCardStyleSpec): string {
  if (style.variant === 'memo') {
    return `
.sheet{border-radius:28px;border:1.5px solid ${style.line};box-shadow:0 18px 44px rgba(28,28,30,.08);background-color:${style.sheet};background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 47px,${style.line}66 47px,${style.line}66 48px);background-position:0 88px}
.sheet-top{background:${style.sheet};border-bottom:1.5px solid ${style.line}}
.chrome-memo{display:inline-flex;align-items:center;gap:8px;color:${style.accent};font-weight:700}
mark{background:${style.mark};padding:1px 6px;border-radius:6px;color:${style.ink}}`;
  }
  if (style.variant === 'bento') {
    return `
.sheet{border-radius:30px;border:1.5px solid ${style.line};box-shadow:0 20px 50px rgba(15,23,42,.08),0 2px 6px rgba(15,23,42,.04)}
.sheet-top{background:${style.surface};border-bottom:1.5px solid ${style.line}}
.win-dots{display:inline-flex;gap:9px;margin-right:8px}
.win-dots i{width:14px;height:14px;border-radius:50%;display:inline-block}
.win-dots i:nth-child(1){background:#FF5F57}.win-dots i:nth-child(2){background:#FEBC2E}.win-dots i:nth-child(3){background:#28C840}
mark{background:linear-gradient(transparent 54%,${style.mark} 54%,${style.mark} 94%,transparent 94%);padding:0 4px;color:inherit}`;
  }
  if (style.variant === 'dark') {
    return `
.card{background:radial-gradient(circle at 86% 12%,${style.accent}22,transparent 42%),${style.bg}}
.sheet{border-radius:28px;border:1.5px solid ${style.line};box-shadow:0 24px 60px rgba(0,0,0,.48)}
.sheet-top{border-bottom:1px solid ${style.line};background:rgba(255,255,255,.02)}
mark{background:${style.mark};color:#FDE68A;padding:1px 7px;border-radius:6px}`;
  }
  if (style.variant === 'editorial') {
    return `
.sheet{border-radius:14px;border:1.5px solid ${style.line};box-shadow:0 12px 32px rgba(44,34,25,.07)}
.sheet-top{border-bottom:3px double ${style.line}}
mark{background:linear-gradient(transparent 58%,${style.mark} 58%,${style.mark} 92%,transparent 92%);padding:0 4px;color:inherit}`;
  }
  if (style.variant === 'notion') {
    return `
.sheet{border-radius:24px;border:1.5px solid ${style.line};box-shadow:0 14px 36px rgba(20,41,34,.06)}
.sheet-top{border-bottom:1.5px solid ${style.line};background:${style.surface}}
mark{background:${style.mark};padding:1px 6px;border-radius:6px;color:inherit}`;
  }
  // swiss（苏黎世网格 / 暖调杂志 / 黑白画报）
  return `
.sheet{border-radius:10px;border:2px solid ${style.line};box-shadow:8px 8px 0 ${style.line}18}
.sheet-top{border-bottom:2px solid ${style.line}}
mark{background:linear-gradient(transparent 56%,${style.mark} 56%,${style.mark} 94%,transparent 94%);padding:0 4px;color:inherit}`;
}

function cardCss(styleKey: string, ipColors?: IpColors | null): string {
  const s = effectiveCardStyle(styleKey, ipColors);
  const dark = s.variant === 'dark';
  const badBg = dark ? '#2D161B' : '#FFF1F2';
  const badLine = dark ? '#7F1D1D' : '#FECDD3';
  const badInk = dark ? '#FCA5A5' : '#BE123C';
  const goodBg = dark ? '#122920' : '#ECFDF5';
  const goodLine = dark ? '#14532D' : '#A7F3D0';
  const goodInk = dark ? '#6EE7B7' : '#047857';
  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:${s.bg};overflow:hidden}
::-webkit-scrollbar{display:none}
body{font-family:${s.font};color:${s.ink};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.card{position:relative;width:${XHS_CARD_WIDTH}px;height:${XHS_CARD_HEIGHT}px;padding:42px;background:${s.bg};overflow:hidden;display:flex}
.sheet{position:relative;width:100%;height:100%;background:${s.sheet};display:flex;flex-direction:column;overflow:hidden}
.sheet-top{flex:none;display:flex;align-items:center;justify-content:space-between;gap:16px;height:74px;padding:0 44px;font-size:23px;font-weight:700;color:${s.muted};letter-spacing:.5px}
.kicker{display:inline-flex;align-items:center;gap:10px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${s.ink}}
.kicker-dot{width:11px;height:11px;border-radius:3px;background:${s.accent};flex:none}
.no{flex:none;display:inline-flex;align-items:center;justify-content:center;padding:6px 18px;border-radius:999px;background:${s.soft};color:${s.accent};font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px}
.sheet-head{flex:none;padding:34px 44px 20px;display:flex;flex-direction:column;gap:14px}
h1{font-family:${s.headingFont};font-size:56px;line-height:1.2;font-weight:850;letter-spacing:-.5px;color:${s.ink};text-wrap:balance}
.cover h1{font-size:60px}
.lead{font-size:27px;line-height:1.48;font-weight:550;color:${s.muted};padding-left:16px;border-left:5px solid ${s.accent}}
code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:.88em;padding:2px 9px;border-radius:7px;background:${s.soft};color:${s.accent};font-weight:700}
strong{font-weight:800;color:${s.ink}}
.sheet-body{flex:1;min-height:0;padding:8px 44px 20px;display:flex;flex-direction:column;gap:16px;justify-content:flex-start}

/* 顶部关键指标看板 */
.stats-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
.stat-box{padding:18px 22px;border-radius:16px;background:${s.surface};border:1.5px solid ${s.line};display:flex;flex-direction:column;gap:4px}
.stat-val{font-size:44px;line-height:1.1;font-weight:900;color:${s.accent};font-variant-numeric:tabular-nums}
.stat-lbl{font-size:23px;line-height:1.35;color:${s.muted};font-weight:600}

/* 结构化要点 & 总览列表 */
.kp-list{list-style:none;display:flex;flex-direction:column;gap:15px}
.kp-item{padding:20px 24px;border-radius:18px;background:${s.surface};border:1.5px solid ${s.line};display:flex;gap:18px;align-items:flex-start}
.kp-idx{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;padding:0 10px;border-radius:12px;background:${s.accent};color:#fff;font-size:23px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:2px}
.kp-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.kp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.kp-title{font-size:33px;line-height:1.3;font-weight:800;color:${s.ink}}
.badge{flex:none;display:inline-flex;align-items:center;padding:4px 13px;border-radius:999px;background:${s.soft};color:${s.accent};font-size:21px;font-weight:750}
.kp-detail{font-size:27px;line-height:1.5;font-weight:500;color:${s.muted}}
.kp-only{font-size:31px;line-height:1.46;font-weight:650;color:${s.ink}}

/* 2×2 Bento 宫格 */
.bento-grid{list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:16px;align-content:start}
.bento-tile{padding:22px 22px;border-radius:20px;background:${s.surface};border:1.5px solid ${s.line};display:flex;flex-direction:column;gap:10px}
.bento-tile.span-2{grid-column:span 2}
.bento-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bento-no{font-size:22px;font-weight:850;color:${s.accent};font-variant-numeric:tabular-nums;letter-spacing:.5px}
.bento-title{font-size:32px;line-height:1.28;font-weight:820;color:${s.ink}}
.bento-detail{font-size:25.5px;line-height:1.48;color:${s.muted};font-weight:500}

/* 步骤实操链路 */
.steps-list{list-style:none;display:flex;flex-direction:column;gap:14px}
.step-row{display:grid;grid-template-columns:86px minmax(0,1fr);gap:16px;align-items:stretch}
.step-rail{display:flex;flex-direction:column;align-items:center}
.step-pill{display:inline-flex;align-items:center;justify-content:center;width:82px;height:40px;border-radius:10px;background:${s.accent};color:#fff;font-size:21px;font-weight:800;font-variant-numeric:tabular-nums}
.step-line{flex:1;width:3px;background:${s.line};margin-top:6px;border-radius:2px}
.step-row:last-child .step-line{display:none}
.step-card{padding:18px 22px;border-radius:16px;background:${s.surface};border:1.5px solid ${s.line};display:flex;flex-direction:column;gap:6px}

/* 正反避坑对比 */
.cmp-list{list-style:none;display:flex;flex-direction:column;gap:14px}
.cmp-card{padding:19px 24px;border-radius:18px;border:1.5px solid ${s.line};background:${s.surface};display:flex;flex-direction:column;gap:6px}
.cmp-card.is-bad{background:${badBg};border-color:${badLine}}
.cmp-card.is-bad .cmp-tag{background:${badLine};color:${badInk}}
.cmp-card.is-good{background:${goodBg};border-color:${goodLine}}
.cmp-card.is-good .cmp-tag{background:${goodLine};color:${goodInk}}
.cmp-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.cmp-tag{padding:3px 12px;border-radius:8px;font-size:21px;font-weight:800;background:${s.soft};color:${s.accent}}

/* 自查行动清单 */
.chk-list{list-style:none;display:flex;flex-direction:column;gap:13px}
.chk-row{padding:18px 22px;border-radius:16px;background:${s.surface};border:1.5px solid ${s.line};display:flex;gap:16px;align-items:flex-start}
.chk-box{flex:none;width:36px;height:36px;margin-top:3px;border-radius:9px;border:2.5px solid ${s.accent};background:${s.soft};color:${s.accent};display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:900}

/* 一页纸速查表（尾页 / 单张一图流） */
.sum-table{list-style:none;border:1.5px solid ${s.line};border-radius:18px;overflow:hidden;background:${s.surface}}
.sum-row{display:grid;grid-template-columns:250px minmax(0,1fr);border-top:1.5px solid ${s.line}}
.sum-row:first-child{border-top:0}
.sum-row.is-single{grid-template-columns:minmax(0,1fr)}
.sum-key{padding:18px 20px;background:${s.soft}66;border-right:1.5px solid ${s.line};display:flex;flex-direction:column;justify-content:center;gap:6px}
.sum-val{padding:18px 22px;font-size:26.5px;line-height:1.48;color:${s.ink};display:flex;align-items:center}

/* 底部收束栏 + IP 角色左右共排（零垂直高度浪费） */
.sheet-foot{flex:none;margin-top:auto;padding:12px 44px 26px;display:flex;align-items:flex-end;gap:18px}
.emphasis{flex:1;min-width:0;padding:18px 24px;border-left:7px solid ${s.accent};background:${s.soft};border-radius:6px 16px 16px 6px;font-size:28px;font-weight:780;line-height:1.38;color:${s.ink}}
.progress{height:6px;width:100%;background:${s.line}44}
.progress i{display:block;height:100%;background:${s.accent}}

/* 高密度自适应档位 */
.card.dense .sheet-head{padding:26px 42px 14px;gap:10px}
.card.dense h1{font-size:48px}
.card.dense .lead{font-size:25px}
.card.dense .sheet-body{gap:12px;padding:6px 42px 14px}
.card.dense .kp-item,.card.dense .cmp-card,.card.dense .chk-row,.card.dense .step-card{padding:15px 20px}
.card.dense .bento-tile{padding:17px 18px;gap:7px}
.card.dense .kp-title,.card.dense .bento-title{font-size:29px}
.card.dense .kp-detail,.card.dense .sum-val{font-size:24.5px;line-height:1.44}
.card.dense .bento-detail{font-size:23.5px;line-height:1.42}
.card.dense .kp-only{font-size:27px}
.card.dense .emphasis{font-size:25px;padding:14px 20px}

.card.denser .sheet-top{height:64px;padding:0 38px;font-size:21px}
.card.denser .sheet-head{padding:20px 38px 10px;gap:8px}
.card.denser h1{font-size:42px}
.card.denser .lead{font-size:23px}
.card.denser .sheet-body{gap:10px;padding:4px 38px 10px}
.card.denser .kp-list,.card.denser .cmp-list,.card.denser .chk-list,.card.denser .steps-list{gap:10px}
.card.denser .kp-item,.card.denser .cmp-card,.card.denser .chk-row,.card.denser .step-card{padding:12px 17px}
.card.denser .bento-grid{gap:11px}
.card.denser .bento-tile{padding:14px 16px;gap:5px}
.card.denser .kp-idx{min-width:36px;height:36px;font-size:20px}
.card.denser .kp-title,.card.denser .bento-title{font-size:26px}
.card.denser .kp-detail,.card.denser .bento-detail,.card.denser .sum-val{font-size:22px;line-height:1.4}
.card.denser .kp-only{font-size:24px}
.card.denser .sum-row{grid-template-columns:215px minmax(0,1fr)}
.card.denser .sum-key,.card.denser .sum-val{padding:12px 16px}
.card.denser .stat-box{padding:13px 16px}
.card.denser .stat-val{font-size:36px}
.card.denser .emphasis{font-size:23px;padding:12px 18px}
.card.denser .sheet-foot{padding:8px 38px 20px}
${variantCss(s)}`;
}

/** 角色的样式只在用到时输出（不带 IP 的卡片无角色节点）；与总结框左右共排，不掏空底部。 */
function mascotCss(kit: IpRenderKit | null | undefined, used: number[]): string {
  const picked = [...new Set(used.filter(item => item >= 0))];
  if (!kit || !picked.length) return '';
  return `.ip-mascot{flex:none;width:148px;height:164px;margin-left:auto;background:right bottom/contain no-repeat}
.card.denser .ip-mascot{width:124px;height:136px}
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
        ${item.title ? `<div class="bento-title">${richCardText(item.title)}</div>` : ''}
        ${item.detail ? `<div class="bento-detail">${richCardText(item.detail)}</div>` : ''}
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
      const tag = item.badge || (bad ? '避坑 / 误区' : '正解 / 做法');
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

  if (layout === 'summary') {
    return `${statsHtml}<ul class="sum-table">${items.map((item, idx) => item.title && item.detail
      ? `<li class="sum-row"><div class="sum-key"><span class="kp-title" style="font-size:28px">${richCardText(item.title)}</span>${item.badge ? `<span class="badge" style="width:fit-content">${escapeHtml(item.badge)}</span>` : ''}</div><div class="sum-val"><span>${richCardText(item.detail)}</span></div></li>`
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
      ${page.emphasis?.trim() ? `<div class="emphasis">${richCardText(page.emphasis.trim())}</div>` : ''}
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
html,body{background:transparent;overflow:auto}
.strip{display:flex;gap:14px;padding:8px;flex-wrap:wrap;justify-content:${focused !== null ? 'center' : 'flex-start'}}
.frame{flex:none;overflow:hidden;border-radius:12px;box-shadow:0 3px 12px rgba(0,0,0,.14)}
</style></head><body><div class="strip">${pages}</div></body></html>`;
}
