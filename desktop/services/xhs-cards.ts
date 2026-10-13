import type { XhsCardPage, XhsCardPlan } from '../shared.ts';
import { xhsCardStyle } from './xhs-catalog.ts';

/**
 * 图文卡片的本地 HTML 模板。
 *
 * 模型只给分页内容（标题、要点、强调句），版式全在这里：排版稳定、风格可控，也不会让模型写的 HTML 进到页面里。
 * 纯字符串函数：渲染进程拿它做预览（iframe srcdoc），主进程拿它逐页截图导出 PNG。
 */

export const XHS_CARD_WIDTH = 1080;
export const XHS_CARD_HEIGHT = 1440;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cardCss(styleKey: string): string {
  const style = xhsCardStyle(styleKey);
  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:${style.bg};overflow:hidden}
::-webkit-scrollbar{display:none}
body{font-family:${style.font};color:${style.ink};-webkit-font-smoothing:antialiased}
.card{position:relative;width:${XHS_CARD_WIDTH}px;height:${XHS_CARD_HEIGHT}px;padding:110px 96px 120px;background:${style.bg};overflow:hidden;display:flex;flex-direction:column;gap:44px}
.card::before{content:"";position:absolute;right:-140px;top:-140px;width:420px;height:420px;border-radius:50%;background:${style.soft}}
.card::after{content:"";position:absolute;left:-110px;top:54%;width:200px;height:200px;border-radius:50%;background:${style.soft};opacity:.7}
.top{position:relative;display:flex;align-items:center;justify-content:space-between;font-size:30px;color:${style.accent};font-weight:700;letter-spacing:2px}
.no{display:inline-flex;align-items:center;justify-content:center;min-width:92px;height:56px;padding:0 22px;border-radius:28px;background:${style.accent};color:#fff;font-size:30px}
h1{position:relative;font-size:84px;line-height:1.18;font-weight:800;letter-spacing:1px;text-wrap:balance}
.cover h1{font-size:104px}
ul{position:relative;list-style:none;display:flex;flex-direction:column;gap:30px}
li{display:flex;gap:24px;align-items:flex-start;padding:30px 34px;border-radius:28px;background:#ffffffcc;box-shadow:0 6px 0 ${style.soft};font-size:46px;line-height:1.42;font-weight:600}
li b{flex:none;display:inline-flex;align-items:center;justify-content:center;width:58px;height:58px;margin-top:2px;border-radius:50%;background:${style.soft};color:${style.accent};font-size:32px}
.emphasis{position:relative;margin-top:auto;padding:28px 36px;border-left:12px solid ${style.accent};background:${style.soft};border-radius:0 24px 24px 0;font-size:48px;font-weight:800;line-height:1.35}
.card.dense{gap:34px}
.card.dense h1{font-size:72px}
.card.dense ul{gap:20px}
.card.dense li{padding:22px 28px;font-size:38px}
.card.denser{gap:26px}
.card.denser h1{font-size:62px}
.card.denser ul{gap:14px}
.card.denser li{padding:16px 24px;font-size:32px}
.card.denser li b{width:46px;height:46px;font-size:26px}
.card.denser .emphasis{font-size:38px;padding:20px 28px}
.foot{position:absolute;left:96px;right:96px;bottom:54px;display:flex;justify-content:space-between;font-size:26px;color:${style.ink};opacity:.45}
`;
}

/** 单页卡片的内部结构；第一页按封面式排版（大标题），其余是要点列表。 */
/**
 * 内容多的页自动缩小字号：按每条约 15 字一行估算总行数（加上标题行），超出版面就换小一档。
 * 估算偏保守，宁可字小一点，也不让最后一条被裁掉。
 */
export function cardDensity(page: XhsCardPage, cover: boolean): '' | 'dense' | 'denser' {
  const lines = page.points.reduce((total, point) => total + Math.max(1, Math.ceil([...point].length / 15)), 0)
    + Math.ceil([...page.heading].length / (cover ? 8 : 10)) * 1.6 + (page.emphasis ? 1.5 : 0);
  return lines > 13 ? 'denser' : lines > 9.5 ? 'dense' : '';
}

export function renderCardPage(page: XhsCardPage, index: number, total: number, title: string): string {
  const cover = index === 0;
  const density = cardDensity(page, cover);
  const points = page.points.map((point, position) => `<li><b>${position + 1}</b><span>${escapeHtml(point)}</span></li>`).join('');
  return `<section class="card${cover ? ' cover' : ''}${density ? ` ${density}` : ''}">
  <div class="top"><span>${escapeHtml(cover ? '建议收藏' : title.slice(0, 18))}</span><span class="no">${index + 1}/${total}</span></div>
  <h1>${escapeHtml(page.heading || title)}</h1>
  ${points ? `<ul>${points}</ul>` : ''}
  ${page.emphasis ? `<div class="emphasis">${escapeHtml(page.emphasis)}</div>` : ''}
  <div class="foot"><span>${escapeHtml(title.slice(0, 24))}</span><span>${index + 1} / ${total}</span></div>
</section>`;
}

/** 导出用：一页一个文档，尺寸正好 1080×1440。 */
export function renderCardDocument(plan: XhsCardPlan, index: number, title: string): string {
  const page = plan.pages[index];
  if (!page) throw new Error(`第 ${index + 1} 页不存在`);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${cardCss(plan.style)}</style></head><body>${renderCardPage(page, index, plan.pages.length, title)}</body></html>`;
}

/** 预览用：所有页缩小后横向排开，放进 iframe srcdoc。 */
export function renderCardsPreview(plan: XhsCardPlan, title: string, scale = 0.24): string {
  const width = Math.round(XHS_CARD_WIDTH * scale);
  const height = Math.round(XHS_CARD_HEIGHT * scale);
  const pages = plan.pages.map((page, index) => `<div class="frame" style="width:${width}px;height:${height}px"><div style="transform:scale(${scale});transform-origin:0 0">${renderCardPage(page, index, plan.pages.length, title)}</div></div>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${cardCss(plan.style)}
html,body{background:transparent}
.strip{display:flex;gap:14px;padding:4px;flex-wrap:wrap}
.frame{flex:none;overflow:hidden;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.18)}
</style></head><body><div class="strip">${pages}</div></body></html>`;
}
