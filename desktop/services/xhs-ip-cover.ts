import type { IpColors, IpRenderKit, XhsIpCoverInput, XhsIpCoverTemplate, XhsNote } from '../shared.ts';
import { escapeHtml, XHS_CARD_HEIGHT, XHS_CARD_WIDTH } from './xhs-cards.ts';
import { ipPalette, mixColor, pickPose, richText, titleFontSize } from './ip-theme.ts';

/**
 * 小红书本地文字 / IP 封面模板引擎 2.0（1080×1440，0 成本离线秒出）：
 *
 * 1. 既支持「纯文字爆款大字封面」（未选 IP，或手动选「不放角色」），也支持「IP 透明底角色融合封面」；
 * 2. 从 3 套扩充为 8 套小红书高点击率封面母版：
 *    实操干货卡 / 黑黄大字报 / 原生备忘录 / 爆款数字清单 / 红黑避坑榜 / 瑞士杂志封 / 人文金句卡 / 暗夜复盘录；
 * 3. 7 套精选封面配色（默认优先跟随账号 IP 配色；无 IP 时默认暖纸焦橙，也可一键切换配色）；
 * 4. 彻底解决「封面空洞、气泡撞脸、字散廉价」：满版内聚画框、结构化看点胶囊、流式安全避让角色区；
 * 5. 严守契约：画面里不放头像与品牌名，所有用户输入严格 HTML 转义。
 */

export const XHS_COVER_THEMES: Array<{ key: string; label: string; colors: IpColors }> = [
  { key: 'warm', label: '暖纸焦橙', colors: { primary: '#221A14', accent: '#F59E0B', secondary: '#D95D24' } },
  { key: 'poster', label: '黑黄大字', colors: { primary: '#141413', accent: '#FDE047', secondary: '#EA580C' } },
  { key: 'swiss', label: '瑞士朱红', colors: { primary: '#18181B', accent: '#FFE17D', secondary: '#D93829' } },
  { key: 'memo', label: '备忘录金', colors: { primary: '#1C1C1E', accent: '#FDE047', secondary: '#C88406' } },
  { key: 'forest', label: '森系松绿', colors: { primary: '#162821', accent: '#FCD34D', secondary: '#1F7A5A' } },
  { key: 'klein', label: '克莱因蓝', colors: { primary: '#151B38', accent: '#FDE047', secondary: '#3B4CCA' } },
  { key: 'rose', label: '温柔杏粉', colors: { primary: '#2D1E22', accent: '#FBCFE8', secondary: '#BE4B5B' } }
];

const THEME_MAP = new Map(XHS_COVER_THEMES.map(item => [item.key, item.colors]));

export function fallbackCoverKit(themeKey = 'warm'): IpRenderKit {
  const colors = THEME_MAP.get(themeKey) ?? XHS_COVER_THEMES[0].colors;
  return { id: 'local-text', name: '', tagline: '', colors, avatar: '', poses: [] };
}

export const XHS_IP_COVER_TEMPLATES: Array<{
  key: XhsIpCoverTemplate;
  label: string;
  hint: string;
  fields: Array<keyof XhsIpCoverInput>;
  poseWords: string[];
  poseIndex: number;
}> = [
  { key: 'tutorial', label: '实操干货卡', hint: '点阵内聚画纸 + 大字结论 + 步骤看点胶囊', fields: ['title', 'sub', 'tag', 'steps'], poseWords: ['打字', '电脑', '工作'], poseIndex: 0 },
  { key: 'bigtype', label: '黑黄大字报', hint: '高反差粗黑条幅 + 荧光笔大字，缩略图一秒抓人', fields: ['title', 'sub', 'tag', 'steps', 'sticker'], poseWords: ['指', '介绍', '打字'], poseIndex: 1 },
  { key: 'memo', label: '原生备忘录', hint: '苹果备忘录顶栏 + 横线纸荧光笔批注，高收藏神图', fields: ['title', 'sub', 'tag', 'steps'], poseWords: ['打字', '工作', '指'], poseIndex: 0 },
  { key: 'list', label: '爆款数字清单', hint: '超大几何数字 + 印章贴纸 + 清单预览条', fields: ['number', 'unit', 'title', 'sub', 'steps', 'sticker'], poseWords: ['指', '介绍'], poseIndex: 1 },
  { key: 'versus', label: '红黑避坑榜', hint: '❌ 常见踩坑 vs ✅ 正确做法强反差对比首图', fields: ['title', 'sub', 'tag', 'steps', 'bubble'], poseWords: ['指', '介绍', '团队'], poseIndex: 1 },
  { key: 'magazine', label: '瑞士杂志封', hint: '国际主义实线网格刊头 + 结构化索引栏', fields: ['title', 'sub', 'tag', 'steps'], poseWords: ['打字', '团队', '指'], poseIndex: 0 },
  { key: 'quote', label: '人文金句卡', hint: '燕麦棉纸 + 宋体大字 + 引号洞察框，故事认知首选', fields: ['title', 'sub', 'tag', 'bubble'], poseWords: ['团队', '合影', '打字'], poseIndex: 2 },
  { key: 'recap', label: '暗夜复盘录', hint: '深色高对比画框 + 气泡金句 + 复盘要点', fields: ['title', 'sub', 'tag', 'steps', 'bubble'], poseWords: ['团队', '合影', '全员'], poseIndex: 2 }
];

const TEMPLATE_KEYS = new Set<string>(XHS_IP_COVER_TEMPLATES.map(item => item.key));
const DEFAULT_TAG: Record<XhsIpCoverTemplate, string> = {
  tutorial: '全流程公开',
  bigtype: '纯干货速存',
  memo: '置顶备忘录',
  list: '建议收藏',
  versus: '避坑必看',
  magazine: '深度拆解',
  quote: '真实感悟',
  recap: '真实复盘'
};
const MAX_STEPS = 5;
const STEP_MARKS = '①②③④⑤';
const SANS_STACK = "'Segoe UI Variable Text','PingFang SC','HarmonyOS Sans SC','Noto Sans SC','Microsoft YaHei UI','Microsoft YaHei',sans-serif";
const SERIF_STACK = "'Source Han Serif SC','Songti SC','STSong','Noto Serif CJK SC','SimSun',serif";

/** 笔记类型 → 默认模板：保持历史契约（list→list，recap/story→recap，tutorial/share→tutorial），避雷用 versus，测评用 bigtype。 */
export function defaultIpCoverTemplate(noteType: string): XhsIpCoverTemplate {
  if (noteType === 'list') return 'list';
  if (noteType === 'recap' || noteType === 'story') return 'recap';
  if (noteType === 'avoid') return 'versus';
  if (noteType === 'review') return 'bigtype';
  return 'tutorial';
}

export function emptyIpCoverInput(template: XhsIpCoverTemplate, title = ''): XhsIpCoverInput {
  return {
    template,
    pose: '',
    title,
    sub: '',
    tag: template === 'list' ? '' : DEFAULT_TAG[template],
    steps: [],
    number: '10',
    unit: '个',
    sticker: '建议|收藏',
    bubble: ''
  };
}

/** 从当前笔记标题、大纲与正文自动提取封面副标和 3–4 条浓缩看点，避免打开模板时只有一行孤零零的标题。 */
export function seedIpCoverFromNote(
  note: Pick<XhsNote, 'title' | 'topic' | 'noteType' | 'body' | 'writerJson' | 'cardsJson'>,
  template?: XhsIpCoverTemplate
): XhsIpCoverInput {
  const tpl = template ?? defaultIpCoverTemplate(note.noteType);
  const rawTitle = (note.title || note.topic || '').trim();
  const base = emptyIpCoverInput(tpl, rawTitle);

  const numMatch = rawTitle.match(/(\d{1,3})\s*([个条步招件套种点天])/);
  if (numMatch) {
    base.number = numMatch[1];
    base.unit = numMatch[2];
  }

  let takeaway = '';
  let outline: string[] = [];
  try {
    if (note.writerJson?.trim()) {
      const meta = JSON.parse(note.writerJson) as { coreTakeaway?: string; outline?: string[] };
      takeaway = String(meta.coreTakeaway ?? '').trim();
      if (Array.isArray(meta.outline)) outline = meta.outline.map(item => String(item).trim()).filter(Boolean);
    }
  } catch { /* ignore */ }

  let cardPoints: string[] = [];
  try {
    if (note.cardsJson?.trim()) {
      const plan = JSON.parse(note.cardsJson) as { pages?: Array<{ heading?: string; items?: Array<{ title?: string }> }> };
      const firstItems = plan.pages?.[0]?.items?.map(item => String(item.title ?? '').trim()).filter(Boolean) ?? [];
      const pageHeads = plan.pages?.slice(0, 4).map(page => String(page.heading ?? '').replace(/[【】]/g, '').trim()).filter(Boolean) ?? [];
      cardPoints = firstItems.length >= 2 ? firstItems : pageHeads;
    }
  } catch { /* ignore */ }

  const bodyLines = (note.body || '')
    .split(/\n+/)
    .map(line => line.replace(/^[\d①②③④⑤一二三四五]+[.、：:\s)）]+/, '').replace(/#[^\s#]+/g, '').trim())
    .filter(line => line.length >= 4);

  const rawSteps = (cardPoints.length ? cardPoints : outline.length ? outline : bodyLines.slice(1, 5))
    .map(line => line.split(/[：:，,。！？!?;；]/)[0].trim().slice(0, 14))
    .filter(line => line.length >= 2)
    .slice(0, 4);

  base.steps = rawSteps;
  const subSource = takeaway || bodyLines[0] || '';
  base.sub = subSource.replace(/[。！!？?]+$/, '').slice(0, 26);
  if (tpl === 'recap' || tpl === 'quote' || tpl === 'versus') {
    base.bubble = (takeaway || rawSteps[0] || '').slice(0, 18);
  }
  return base;
}

const text = (value: unknown, limit: number) => String(value ?? '').trim().slice(0, limit);

/** IPC 进来的输入一律过一遍：未知模板拒绝，字段截断，步骤最多 5 条。 */
export function normalizeIpCoverInput(raw: unknown): XhsIpCoverInput {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const template = String(input.template ?? '');
  if (!TEMPLATE_KEYS.has(template)) throw new Error(`没有这个封面模板：${template || '（空）'}`);
  const steps = (Array.isArray(input.steps) ? input.steps : []).map(step => text(step, 20)).filter(Boolean).slice(0, MAX_STEPS);
  const rawTheme = text(input.theme, 20);
  const validTheme = THEME_MAP.has(rawTheme) ? rawTheme : '';
  return {
    template: template as XhsIpCoverTemplate,
    pose: text(input.pose, 40),
    ...(validTheme ? { theme: validTheme } : {}),
    title: text(input.title, 60),
    sub: text(input.sub, 60),
    tag: text(input.tag, 20),
    steps,
    number: text(input.number, 4),
    unit: text(input.unit, 4),
    sticker: text(input.sticker, 12),
    bubble: text(input.bubble, 24)
  };
}

/** 这个模板这次用哪张角色图：pose==='none' 显式不放角色；用户指定的优先，否则按模板动作词挑。 */
export function ipCoverPose(input: XhsIpCoverInput, kit: IpRenderKit) {
  if (input.pose === 'none') return null;
  const template = XHS_IP_COVER_TEMPLATES.find(item => item.key === input.template) ?? XHS_IP_COVER_TEMPLATES[0];
  return pickPose(kit.poses, input.pose, template.poseWords, template.poseIndex);
}

type Parts = { css: string; body: string };
type Palette = ReturnType<typeof ipPalette>;

function baseCss(p: Palette): string {
  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${XHS_CARD_WIDTH}px;height:${XHS_CARD_HEIGHT}px;overflow:hidden}
body{position:relative;font-family:${SANS_STACK};color:${p.ink};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
mark{background:linear-gradient(transparent 54%,${p.highlight} 54%,${p.highlight} 94%,transparent 94%);color:inherit;padding:0 6px;border-radius:4px}
.tag{display:inline-flex;align-items:center;gap:10px;padding:12px 28px;border-radius:999px;background:${p.ink};color:${p.highlight};font-size:32px;font-weight:850;letter-spacing:1.5px}
.title{font-weight:900;letter-spacing:-1.5px;text-wrap:balance;overflow-wrap:anywhere}
`;
}

const subBlock = (sub: string) => sub ? `<p class="sub">${richText(sub)}</p>` : '';
const tagBlock = (tag: string) => tag ? `<span class="tag">${escapeHtml(tag)}</span>` : '';
const heroBlock = (src: string | undefined) => src ? `<img class="hero" src="${escapeHtml(src)}" alt="">` : '';

/** 1. 实操干货卡：暖白内聚画纸 + 点阵底 + 步骤胶囊栈 + 底部收束线。 */
function tutorial(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  const hasHero = Boolean(hero);
  const size = Math.max(74, titleFontSize(input.title, 880, 114));
  return {
    css: `
body{background:${p.softSecondary};padding:32px}
.frame{position:relative;width:100%;height:100%;border-radius:32px;background:#FFFDF9 radial-gradient(${p.ink}14 2.5px,transparent 3px) 0 0/36px 36px;border:3px solid ${p.ink};box-shadow:0 20px 48px rgba(0,0,0,.08);padding:50px 56px;display:flex;flex-direction:column;gap:30px;overflow:hidden}
.top-bar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:26px;border-bottom:2.5px solid ${p.ink}22}
.meta-pill{font-size:26px;font-weight:800;color:${p.deepSecondary};letter-spacing:1.5px}
.head-zone{flex:none;display:flex;flex-direction:column;gap:24px}
.title{font-size:${size}px;line-height:1.16;color:${p.ink}}
.sub{font-size:39px;font-weight:700;color:${p.deepSecondary};line-height:1.42;padding:20px 28px;border-radius:18px;background:${p.softAccent};border:2px solid ${p.ink}26;max-width:${hasHero && !input.steps.length ? '620px' : '100%'}}
.steps{flex:1;display:flex;flex-direction:column;justify-content:center;gap:20px;max-width:${hasHero ? '545px' : '100%'};z-index:2}
.steps span{display:flex;align-items:center;gap:14px;padding:22px 28px;border-radius:18px;background:#FFFFFF;border:2.5px solid ${p.ink};box-shadow:6px 6px 0 ${p.ink};font-size:35px;font-weight:800;line-height:1.3}
.foot-bar{margin-top:auto;padding-top:26px;border-top:2px solid ${p.ink}22;display:flex;align-items:center;justify-content:space-between;font-size:28px;font-weight:750;color:${p.deepSecondary};max-width:${hasHero ? '520px' : '100%'}}
.foot-dot{display:inline-block;width:48px;height:12px;border-radius:999px;background:${p.secondary};margin-right:14px;vertical-align:middle}
.hero{position:absolute;right:22px;bottom:18px;width:445px;height:600px;object-fit:contain;object-position:right bottom;z-index:1}`,
    body: `<div class="frame">
  <div class="top-bar">${tagBlock(input.tag)}<span class="meta-pill">WORKFLOW · 实操指南</span></div>
  <div class="head-zone">
    <h1 class="title">${richText(input.title)}</h1>
    ${subBlock(input.sub)}
  </div>
  ${input.steps.length
    ? `<div class="steps">${input.steps.map((step, index) => `<span>${STEP_MARKS[index] ?? ''} ${escapeHtml(step)}</span>`).join('')}</div>`
    : `<div class="foot-bar"><span><i class="foot-dot"></i>核心步骤拆解 · 建议先存后看</span></div>`}
  ${heroBlock(hero)}
</div>`
  };
}

/** 2. 黑黄大字报：小红书超高点击率粗黑条幅 + 荧光色块海报，缩略图 120px 依然清晰刺眼。 */
function bigtype(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  const hasHero = Boolean(hero);
  const size = Math.max(78, titleFontSize(input.title, 870, 120));
  return {
    css: `
body{background:${p.highlight};padding:30px}
.frame{position:relative;width:100%;height:100%;background:#FFFDF7;border:4px solid ${p.ink};border-radius:26px;box-shadow:12px 12px 0 ${p.ink};display:flex;flex-direction:column;overflow:hidden}
.banner{flex:none;background:${p.ink};color:${p.highlight};padding:26px 50px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.banner .tag{background:${p.highlight};color:${p.ink};padding:8px 22px;font-size:28px}
.banner-right{display:flex;align-items:center;gap:16px}
.banner-meta{font-size:25px;font-weight:850;letter-spacing:2px;color:#FFFFFF}
.stamp{padding:8px 18px;border-radius:10px;background:${p.highlight};color:${p.ink};font-size:26px;font-weight:900;line-height:1.15;text-align:center}
.stage{flex:1;padding:46px 52px 44px;display:flex;flex-direction:column;gap:28px}
.title{font-size:${size}px;line-height:1.16;color:${p.ink};letter-spacing:-2px}
.title mark{background:${p.highlight};padding:2px 10px;border:2.5px solid ${p.ink};border-radius:10px}
.sub{font-size:39px;font-weight:800;line-height:1.4;color:#FFFFFF;background:${p.ink};padding:20px 28px;border-radius:16px;align-self:stretch;max-width:${hasHero && !input.steps.length ? '640px' : '100%'}}
.points{flex:1;display:flex;flex-direction:column;justify-content:center;gap:20px;max-width:${hasHero ? '560px' : '100%'};z-index:2}
.pt{flex:1;max-height:132px;padding:20px 26px;border-radius:16px;background:${p.softAccent};border:2.5px solid ${p.ink};box-shadow:5px 5px 0 ${p.ink};font-size:35px;font-weight:850;color:${p.ink};display:flex;align-items:center;gap:18px}
.pt b{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:12px;background:${p.ink};color:${p.highlight};font-size:26px;flex:none}
.hero{position:absolute;right:20px;bottom:16px;width:430px;height:570px;object-fit:contain;object-position:right bottom;z-index:1}`,
    body: `<div class="frame">
  <div class="banner">${tagBlock(input.tag || '重点划线')}<div class="banner-right">${input.sticker ? `<span class="stamp">${escapeHtml(input.sticker.replace(/\|/g, ' · '))}</span>` : '<span class="banner-meta">HIGH-DENSITY GUIDE</span>'}</div></div>
  <div class="stage">
    <h1 class="title">${richText(input.title)}</h1>
    ${subBlock(input.sub)}
    ${input.steps.length ? `<div class="points">${input.steps.map((step, idx) => `<div class="pt"><b>0${idx + 1}</b><span>${escapeHtml(step)}</span></div>`).join('')}</div>` : ''}
  </div>
  ${heroBlock(hero)}
</div>`
  };
}

/** 3. 原生备忘录首图：真实 iOS 备忘录顶栏 + 横线纸 + 荧光笔大字 + 核对清单。 */
function memo(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  const hasHero = Boolean(hero);
  const size = Math.max(72, titleFontSize(input.title, 880, 110));
  return {
    css: `
body{background:#E7E5DF;padding:32px}
.sheet{position:relative;width:100%;height:100%;border-radius:32px;background-color:#FFFDF7;background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 55px,#E7E0CE 55px,#E7E0CE 56.5px);background-position:0 120px;border:2px solid #D9D2C0;box-shadow:0 22px 50px rgba(28,25,20,.10);display:flex;flex-direction:column;overflow:hidden}
.nav{flex:none;height:92px;padding:0 48px;background:#FAF6EA;border-bottom:2px solid #E5DEC9;display:flex;align-items:center;justify-content:space-between;font-size:31px;font-weight:800;color:#C88406}
.nav .tag{background:${p.ink};color:${p.highlight};font-size:26px;padding:8px 22px}
.meta{flex:none;padding:24px 56px 0;font-size:26px;font-weight:650;color:#8A8275;letter-spacing:1px}
.main{flex:1;padding:24px 56px 46px;display:flex;flex-direction:column;gap:28px}
.title{font-size:${size}px;line-height:1.2;color:${p.ink}}
mark{background:linear-gradient(transparent 46%,#FDE047 46%,#FDE047 93%,transparent 93%);padding:0 6px}
.sub{font-size:38px;font-weight:650;line-height:1.45;color:#524C42;padding:20px 26px;border-radius:16px;background:#FEF9C3;border:1.5px solid #FDE047}
.memo-list{flex:1;display:flex;flex-direction:column;justify-content:center;gap:14px;max-width:${hasHero ? '560px' : '100%'};z-index:2}
.memo-row{flex:1;max-height:118px;display:flex;align-items:center;gap:20px;font-size:36px;font-weight:780;color:${p.ink};padding:14px 8px;border-bottom:2px dashed #DED6C1}
.chk{width:42px;height:42px;border-radius:50%;border:3px solid #C88406;background:#FEF3C7;color:#92400E;display:inline-flex;align-items:center;justify-content:center;font-size:25px;font-weight:900;flex:none}
.hero{position:absolute;right:24px;bottom:18px;width:420px;height:560px;object-fit:contain;object-position:right bottom;z-index:1}`,
    body: `<div class="sheet">
  <div class="nav"><span>‹ 备忘录 · 置顶干货</span>${tagBlock(input.tag)}</div>
  <div class="meta">已置顶 · 建议截图保存反复对照</div>
  <div class="main">
    <h1 class="title">${richText(input.title)}</h1>
    ${subBlock(input.sub)}
    ${input.steps.length ? `<div class="memo-list">${input.steps.map(step => `<div class="memo-row"><i class="chk">✓</i><span>${escapeHtml(step)}</span></div>`).join('')}</div>` : ''}
  </div>
  ${heroBlock(hero)}
</div>`
  };
}

/** 4. 爆款数字清单：超大几何数字 + 印章贴纸 + 大标题 + 清单条目预览（保留 10<small>个</small> 与 建议<br>收藏 契约）。 */
function list(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  const hasHero = Boolean(hero);
  const size = Math.max(70, titleFontSize(input.title, hasHero && !input.steps.length ? 680 : 860, 106));
  return {
    css: `
body{background:${p.softAccent};padding:34px}
.frame{position:relative;width:100%;height:100%;border-radius:32px;background:#FFFDF9;border:3px solid ${p.ink};box-shadow:0 20px 48px rgba(0,0,0,.08);padding:52px 58px;display:flex;flex-direction:column;overflow:hidden}
.num-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:24px;border-bottom:2.5px solid ${p.ink}22}
.num{font-size:260px;font-weight:950;line-height:.86;color:${p.ink};font-variant-numeric:tabular-nums;letter-spacing:-8px;text-shadow:10px 10px 0 ${p.highlight}}
.num small{font-size:96px;font-weight:900;margin-left:10px;letter-spacing:0;text-shadow:none}
.sticker{padding:22px 30px;border-radius:24px;background:${p.ink};color:${p.highlight};text-align:center;font-size:40px;font-weight:900;line-height:1.2;transform:rotate(6deg);box-shadow:6px 6px 0 ${p.shadow}}
.wrap{margin-top:34px;display:flex;flex-direction:column;gap:24px;max-width:${hasHero && !input.steps.length ? '620px' : '100%'};z-index:2}
.title{font-size:${size}px;line-height:1.18;color:${p.ink}}
.sub{font-size:38px;font-weight:700;color:${p.deepAccent};line-height:1.42}
.chips{margin-top:auto;padding-top:24px;display:flex;flex-direction:column;gap:14px;max-width:${hasHero ? '550px' : '100%'};z-index:2}
.chips span{padding:15px 22px;border-radius:14px;background:${p.softAccent};border:2px solid ${p.ink}30;font-size:31px;font-weight:780;color:${p.ink}}
.hero{position:absolute;right:24px;bottom:18px;width:430px;height:620px;object-fit:contain;object-position:right bottom;z-index:1}`,
    body: `<div class="frame">
  <div class="num-row">
    <div class="num">${escapeHtml(input.number || '10')}<small>${escapeHtml(input.unit)}</small></div>
    ${input.sticker ? `<div class="sticker">${richText(input.sticker)}</div>` : ''}
  </div>
  <div class="wrap">
    <h1 class="title">${richText(input.title)}</h1>
    ${subBlock(input.sub)}
  </div>
  ${input.steps.length ? `<div class="chips">${input.steps.map((step, idx) => `<span>0${idx + 1} · ${escapeHtml(step)}</span>`).join('')}</div>` : ''}
  ${heroBlock(hero)}
</div>`
  };
}

/** 5. 红黑避坑榜：深色警示刊头 + 正反对比条目 + 结论条，拔草与测评利器。 */
function versus(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  const hasHero = Boolean(hero);
  const size = Math.max(72, titleFontSize(input.title, 880, 108));
  const rows = input.steps.length
    ? input.steps
    : ['盲目跟风踩雷浪费预算', '按核心指标逐条核对闭眼入'];
  return {
    css: `
body{background:#EDE9E8;padding:32px}
.frame{position:relative;width:100%;height:100%;border-radius:30px;background:#FFFFFF;border:3px solid ${p.ink};display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 46px rgba(0,0,0,.09)}
.top{flex:none;background:${p.ink};padding:26px 52px;display:flex;align-items:center;justify-content:space-between}
.vs-pill{font-size:28px;font-weight:900;color:#FCA5A5;letter-spacing:2px}
.body{flex:1;padding:42px 52px;display:flex;flex-direction:column;gap:24px}
.title{font-size:${size}px;line-height:1.17;color:${p.ink}}
.sub{font-size:37px;font-weight:680;color:#52525B;line-height:1.42}
.vs-list{flex:1;display:flex;flex-direction:column;justify-content:center;gap:18px;max-width:${hasHero ? '580px' : '100%'};z-index:2}
.vs-card{flex:1;max-height:122px;padding:20px 26px;border-radius:18px;display:flex;align-items:center;gap:18px;font-size:34px;font-weight:820;border:2px solid}
.vs-bad{background:#FFF1F2;border-color:#FDA4AF;color:#9F1239}
.vs-good{background:#ECFDF5;border-color:#6EE7B7;color:#065F46}
.vs-tag{padding:7px 16px;border-radius:10px;font-size:24px;font-weight:900;flex:none}
.vs-bad .vs-tag{background:#E11D48;color:#FFFFFF}
.vs-good .vs-tag{background:#059669;color:#FFFFFF}
.verdict{flex:none;padding:20px 28px;border-radius:16px;background:${p.ink};color:${p.highlight};font-size:32px;font-weight:820;max-width:${hasHero ? '580px' : '100%'};z-index:2}
.hero{position:absolute;right:18px;bottom:16px;width:410px;height:560px;object-fit:contain;object-position:right bottom;z-index:1}`,
    body: `<div class="frame">
  <div class="top">${tagBlock(input.tag || '避坑对照')}<span class="vs-pill">DON'T vs DO</span></div>
  <div class="body">
    <h1 class="title">${richText(input.title)}</h1>
    ${subBlock(input.sub)}
    <div class="vs-list">${rows.map((step, idx) => {
      const clean = step.replace(/^(❌|✅|✗|✓)\s*/, '');
      const isBad = step.startsWith('❌') || (!step.startsWith('✅') && idx % 2 === 0);
      return `<div class="vs-card ${isBad ? 'vs-bad' : 'vs-good'}"><span class="vs-tag">${isBad ? '✗ 踩坑' : '✓ 正解'}</span><span>${escapeHtml(clean)}</span></div>`;
    }).join('')}</div>
    ${input.bubble ? `<div class="verdict">核心结论：${richText(input.bubble)}</div>` : ''}
  </div>
  ${heroBlock(hero)}
</div>`
  };
}

/** 6. 瑞士杂志封：国际主义网格实线 + 社论大字 + 编号目录表。 */
function magazine(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  const hasHero = Boolean(hero);
  const size = Math.max(72, titleFontSize(input.title, 880, 114));
  return {
    css: `
body{background:#E6E3DC;padding:30px}
.sheet{position:relative;width:100%;height:100%;background:#FAF8F4;border:2.5px solid ${p.ink};display:flex;flex-direction:column;overflow:hidden}
.mast{padding:28px 50px;border-bottom:2.5px solid ${p.ink};display:flex;align-items:center;justify-content:space-between}
.issue{font-size:28px;font-weight:900;letter-spacing:3px;color:${p.ink}}
.head{padding:48px 50px 36px;border-bottom:2px solid ${p.ink};display:flex;flex-direction:column;gap:26px}
.title{font-size:${size}px;line-height:1.15;color:${p.ink}}
.sub{font-size:38px;font-weight:650;color:${mixColor(p.ink, '#FFFFFF', 0.28)};line-height:1.42}
.idx-table{flex:1;display:flex;flex-direction:column;justify-content:center;padding:24px 50px 40px;max-width:${hasHero ? '600px' : '100%'};z-index:2}
.idx-row{display:grid;grid-template-columns:86px minmax(0,1fr);align-items:center;padding:22px 0;border-bottom:1.5px solid ${p.ink}33}
.idx-row:last-child{border-bottom:0}
.idx-no{font-size:44px;font-weight:950;color:${p.secondary};font-variant-numeric:tabular-nums}
.idx-txt{font-size:34px;font-weight:800;color:${p.ink};line-height:1.32}
.hero{position:absolute;right:24px;bottom:16px;width:410px;height:560px;object-fit:contain;object-position:right bottom;z-index:1}`,
    body: `<div class="sheet">
  <div class="mast"><span class="issue">EDITORIAL · 深度特辑</span>${tagBlock(input.tag)}</div>
  <div class="head">
    <h1 class="title">${richText(input.title)}</h1>
    ${subBlock(input.sub)}
  </div>
  <div class="idx-table">
    ${(input.steps.length ? input.steps : ['核心底层逻辑拆解', '关键判断标准与门槛', '可直接套用的行动清单']).map((step, idx) => `<div class="idx-row"><span class="idx-no">0${idx + 1}</span><span class="idx-txt">${escapeHtml(step)}</span></div>`).join('')}
  </div>
  ${heroBlock(hero)}
</div>`
  };
}

/** 7. 人文金句卡：燕麦棉纸 + 宋体大标题 + 几何大引号框，故事与观点输出首选。 */
function quote(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  const hasHero = Boolean(hero);
  const size = Math.max(68, titleFontSize(input.title, 860, 106));
  return {
    css: `
body{background:#E8DFD2;padding:34px}
.page{position:relative;width:100%;height:100%;border-radius:20px;background:#FAF5EC;border:2px solid ${p.ink}38;padding:56px 60px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 44px rgba(42,32,24,.08)}
.top{display:flex;align-items:center;justify-content:space-between;padding-bottom:28px;border-bottom:3px double ${p.ink}44}
.qmark{margin-top:34px;font-family:${SERIF_STACK};font-size:150px;line-height:.65;font-weight:900;color:${p.secondary};opacity:.45}
.title{margin-top:16px;font-family:${SERIF_STACK};font-size:${size}px;line-height:1.24;font-weight:900;color:${p.ink};letter-spacing:-.5px}
.sub{margin-top:32px;font-size:38px;font-weight:600;color:${mixColor(p.ink, '#FFFFFF', 0.25)};line-height:1.5;max-width:${hasHero ? '600px' : '100%'}}
.note-box{margin-top:auto;padding:24px 30px;border-radius:14px;background:#F2EAE0;border:1.5px solid ${p.ink}26;font-size:32px;font-weight:750;color:${p.ink};line-height:1.45;max-width:${hasHero ? '560px' : '100%'};z-index:2}
.hero{position:absolute;right:28px;bottom:18px;width:410px;height:560px;object-fit:contain;object-position:right bottom;z-index:1}`,
    body: `<div class="page">
  <div class="top">${tagBlock(input.tag)}<span style="font-size:26px;font-weight:750;letter-spacing:2px;opacity:.65">READING NOTE</span></div>
  <div class="qmark">“</div>
  <h1 class="title">${richText(input.title)}</h1>
  ${subBlock(input.sub)}
  ${input.bubble ? `<div class="note-box">${richText(input.bubble)}</div>` : ''}
  ${heroBlock(hero)}
</div>`
  };
}

/** 8. 暗夜复盘录：深曜石内聚画框 + 琥珀金高对比标题 + 流式避让气泡与角色舞台（绝不撞脸）。 */
function recap(input: XhsIpCoverInput, p: Palette, hero?: string): Parts {
  const hasHero = Boolean(hero);
  const size = Math.max(74, titleFontSize(input.title, 880, 110));
  return {
    css: `
body{background:${p.darkBg};color:${p.onDark};padding:32px}
.stage{position:relative;width:100%;height:100%;border-radius:32px;background:radial-gradient(circle at 85% 14%,${p.secondary}33,transparent 46%),${p.darkBgRaised};border:2px solid rgba(255,255,255,.15);padding:50px 56px;display:flex;flex-direction:column;gap:28px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.42)}
mark{background:linear-gradient(transparent 54%,${p.secondary} 54%,${p.secondary} 93%,transparent 93%);color:#FFFFFF}
.wrap{position:relative;z-index:3;display:flex;flex-direction:column;align-items:flex-start;gap:26px}
.tag{background:${p.highlight};color:${p.darkBg}}
.title{font-size:${size}px;line-height:1.18;color:${p.onDarkTitle}}
.sub{font-size:39px;font-weight:650;color:${p.onDarkMuted};line-height:1.45}
.recap-pts{display:flex;flex-direction:column;gap:16px;width:100%;max-width:${hasHero ? '500px' : '100%'};margin-top:8px;z-index:3}
.recap-pts span{padding:18px 24px;border-radius:16px;background:rgba(255,255,255,.08);border:1.5px solid rgba(255,255,255,.18);font-size:31px;font-weight:780;color:#FFFFFF}
.lower{margin-top:auto;position:relative;z-index:3;display:flex;flex-direction:column;align-items:flex-start;gap:18px;max-width:${hasHero ? '480px' : '100%'}}
.bubble{position:relative;padding:20px 30px;background:#FFFFFF;color:${p.darkBg};border-radius:22px;font-size:34px;font-weight:850;border:3px solid ${p.highlight};box-shadow:0 12px 28px rgba(0,0,0,.32)}
.hero{position:absolute;${input.steps.length ? 'right:16px;bottom:16px;width:500px;height:560px;object-position:right bottom' : 'left:80px;right:80px;bottom:20px;width:840px;height:560px;margin:0 auto;object-position:center bottom'};object-fit:contain;z-index:1}`,
    body: `<div class="stage">
  <div class="wrap">
    ${tagBlock(input.tag)}
    <h1 class="title">${richText(input.title)}</h1>
    ${subBlock(input.sub)}
    ${input.steps.length ? `<div class="recap-pts">${input.steps.map((step, idx) => `<span>0${idx + 1} · ${escapeHtml(step)}</span>`).join('')}</div>` : ''}
  </div>
  ${input.bubble ? `<div class="lower"><div class="bubble">${richText(input.bubble)}</div></div>` : ''}
  ${heroBlock(hero)}
</div>`
  };
}

const RENDERERS: Record<XhsIpCoverTemplate, (input: XhsIpCoverInput, palette: Palette, hero?: string) => Parts> = {
  tutorial, bigtype, memo, list, versus, magazine, quote, recap
};

/** 完整的 HTML 文档，尺寸正好 1080×1440。kit 可为空（无 IP 账号自动使用本地文字封面色板）。 */
export function renderIpCoverDocument(input: XhsIpCoverInput, kit?: IpRenderKit | null): string {
  const render = RENDERERS[input.template];
  if (!render) throw new Error(`没有这个封面模板：${input.template}`);
  const resolvedKit = kit ?? fallbackCoverKit(input.theme || 'warm');
  const colors = (input.theme && THEME_MAP.get(input.theme)) ? THEME_MAP.get(input.theme)! : resolvedKit.colors;
  const palette = ipPalette(colors);
  const parts = render(input, palette, ipCoverPose(input, resolvedKit)?.src);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${baseCss(palette)}${parts.css}</style></head><body>${parts.body}</body></html>`;
}
