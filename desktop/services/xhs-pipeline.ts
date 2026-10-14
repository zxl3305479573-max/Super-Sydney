import type {
  XhsAccount, XhsBasis, XhsCardPlan, XhsCheckItem, XhsCheckReport, XhsCandidate, XhsFunnelLayer, XhsImageItem, XhsNote, XhsNoteStatus,
  XhsPositioning, XhsPositioningTurn, XhsRouterAdvice, XhsStepKey, XhsTitleWorkshop, XhsWriterMeta
} from '../shared.ts';
import {
  XHS_BODY_LIMIT, XHS_CHECKS, XHS_FUNNEL_LAYERS, XHS_NOTE_TYPES, XHS_RISK_EXCEPTIONS, XHS_RISK_WORDS, XHS_TAG_RANGE, XHS_TITLE_LIMIT, xhsCardStyle
} from './xhs-catalog.ts';

/**
 * 小红书笔记流水线的纯规则：内容指纹、步骤状态、失效规则、本地检测、导出门槛、向导规则。
 *
 * 没有任何 IO。「上游改过、下游需复核」靠内容指纹判断：每个产物生成时记下它依据的内容指纹
 * （basisJson），之后上游内容一变，指纹对不上就标「需处理」——不用在每次编辑时手动清状态。
 */

export type XhsStepState = 'done' | 'current' | 'attention' | 'ready' | 'locked';
export type XhsStep = { key: XhsStepKey; index: number; label: string; hint: string; state: XhsStepState; reason: string };

export const XHS_STEPS: Array<{ key: XhsStepKey; label: string; hint: string }> = [
  { key: 'topic', label: '选题', hint: '确定选题、笔记类型，补充你自己的经验素材' },
  { key: 'body', label: '正文', hint: '7 种笔记类型的结构：开头 3 行、分段骨架、结尾互动、标签组合' },
  { key: 'title', label: '标题', hint: '15 种标题方法批量出候选，逐条评分、标合规风险、给 A/B 建议' },
  { key: 'visual', label: '视觉', hint: '3:4 封面 + 图文卡片或生图信息图，组成发布图组' },
  { key: 'checks', label: '发布前检测', hint: '14 项检测：9 项本地规则 + 5 项模型判断，可一键按意见回改' },
  { key: 'package', label: '发布包', hint: '标题、正文、标签与图组导出到知识库，由你手动发布' }
];

/* ── 指纹与解析 ─────────────────────────────────────────────── */

/** FNV-1a 32 位：只用来判断内容变没变，不做安全用途。 */
export function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parse<T>(value: string, fallback: T): T {
  if (!value.trim()) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function readTags(note: Pick<XhsNote, 'tagsJson'>): string[] {
  const value = parse<unknown>(note.tagsJson, []);
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
}
export function readBasis(note: Pick<XhsNote, 'basisJson'>): XhsBasis {
  const value = parse<unknown>(note.basisJson, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value as XhsBasis : {};
}
export function readImages(note: Pick<XhsNote, 'imagesJson'>): XhsImageItem[] {
  const value = parse<unknown>(note.imagesJson, []);
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const path = String(record.path ?? '').trim();
    const source = ['card', 'info', 'local'].includes(String(record.source)) ? record.source as XhsImageItem['source'] : 'local';
    return path ? [{ path, source, caption: String(record.caption ?? '') }] : [];
  });
}
/**
 * 候选图库：存下来的候选 + 当前封面与图组（老笔记没有候选图库，正在用的图也要出现在库里），按路径去重。
 * 新的批次在前；同一批次内保持生成顺序。
 */
export function readCandidates(note: Pick<XhsNote, 'imagesJson' | 'coverPath'> & { candidatesJson?: string }): XhsCandidate[] {
  const value = parse<unknown>(note.candidatesJson ?? '', []);
  const stored = (Array.isArray(value) ? value : []).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const path = String(record.path ?? '').trim();
    const source = ['card', 'info', 'local', 'cover'].includes(String(record.source)) ? record.source as XhsCandidate['source'] : 'local';
    return path ? [{ path, source, caption: String(record.caption ?? ''), batch: String(record.batch ?? '') || path, createdAt: String(record.createdAt ?? '') }] : [];
  });
  const legacy: XhsCandidate[] = [
    ...(note.coverPath.trim() ? [{ path: note.coverPath, source: 'cover' as const, caption: '封面', batch: 'in-use-cover', createdAt: '' }] : []),
    ...readImages(note).map(item => ({ ...item, batch: `in-use-${item.source}`, createdAt: '' }))
  ];
  const seen = new Set<string>();
  return [...stored, ...legacy].filter(item => !seen.has(item.path) && Boolean(seen.add(item.path)));
}

/** 把一批新图放到候选图库最前面。 */
export function addCandidates(note: Pick<XhsNote, 'imagesJson' | 'coverPath'> & { candidatesJson?: string }, fresh: Array<Omit<XhsCandidate, 'batch' | 'createdAt'>>): string {
  const createdAt = new Date().toISOString();
  const batch = `${fresh[0]?.source ?? 'local'}-${Date.now()}`;
  const added = fresh.map(item => ({ ...item, batch, createdAt }));
  const paths = new Set(added.map(item => item.path));
  return JSON.stringify([...added, ...readCandidates(note).filter(item => !paths.has(item.path))]);
}

export function readWriterMeta(note: Pick<XhsNote, 'writerJson'>): XhsWriterMeta | null {
  const value = parse<Partial<XhsWriterMeta> | null>(note.writerJson, null);
  if (!value || typeof value !== 'object') return null;
  return {
    opening: Array.isArray(value.opening) ? value.opening.map(String) : [],
    outline: Array.isArray(value.outline) ? value.outline.map(String) : [],
    interaction: String(value.interaction ?? '')
  };
}
export function readTitleWorkshop(note: Pick<XhsNote, 'titleCandidatesJson'>): XhsTitleWorkshop | null {
  const value = parse<XhsTitleWorkshop | null>(note.titleCandidatesJson, null);
  return value && Array.isArray(value.candidates) ? value : null;
}
export function readCheckReport(note: Pick<XhsNote, 'checksJson'>): XhsCheckReport | null {
  const value = parse<XhsCheckReport | null>(note.checksJson, null);
  return value && Array.isArray(value.items) ? value : null;
}
export function readCardPlan(note: Pick<XhsNote, 'cardsJson'>): XhsCardPlan | null {
  const value = parse<XhsCardPlan | null>(note.cardsJson, null);
  if (!value || !Array.isArray(value.pages)) return null;
  return {
    style: xhsCardStyle(String(value.style ?? '')).key,
    pages: value.pages.flatMap(page => {
      if (!page || typeof page !== 'object') return [];
      const heading = String(page.heading ?? '').trim();
      const points = Array.isArray(page.points) ? page.points.map(item => String(item).trim()).filter(Boolean) : [];
      return heading || points.length ? [{ heading, points, emphasis: String(page.emphasis ?? '').trim() }] : [];
    })
  };
}
export function readPositioning(account: Pick<XhsAccount, 'positioningJson'>): XhsPositioning | null {
  const value = parse<XhsPositioning | null>(account.positioningJson, null);
  return value && typeof value === 'object' && typeof value.statement === 'string' ? value : null;
}
export function readPositioningChat(account: Pick<XhsAccount, 'positioningChatJson'>): XhsPositioningTurn[] {
  const value = parse<unknown>(account.positioningChatJson, []);
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && typeof (item as XhsPositioningTurn).text === 'string') as XhsPositioningTurn[] : [];
}

/* ── 各产物依据的指纹 ───────────────────────────────────────── */

/** 正文骨架依据笔记类型；标题依据正文；封面依据标题；卡片依据正文；检测依据标题 + 正文 + 标签。 */
export function currentBasis(note: XhsNote): Required<XhsBasis> {
  const tags = readTags(note).join('|');
  const images = readImages(note).map(item => item.path).join('|');
  return {
    body: note.noteType,
    title: fingerprint(note.body),
    cover: fingerprint(note.title),
    cards: fingerprint(note.body),
    checks: fingerprint(`${note.title}\n${note.body}\n${tags}`),
    package: fingerprint(`${note.title}\n${note.body}\n${tags}\n${note.coverPath}\n${images}`)
  };
}

/** 盖上某个产物的当前指纹。 */
export function stampBasis(note: XhsNote, ...keys: Array<keyof XhsBasis>): string {
  const basis = readBasis(note);
  const current = currentBasis(note);
  for (const key of keys) basis[key] = current[key];
  return JSON.stringify(basis);
}

/** 某个产物是否「依据的上游内容已经变了」。没有记录过指纹的产物不算过时。 */
export function xhsStale(note: XhsNote, key: keyof XhsBasis): boolean {
  const recorded = readBasis(note)[key];
  return recorded !== undefined && recorded !== currentBasis(note)[key];
}

/* ── 状态与步骤 ─────────────────────────────────────────────── */

export function deriveXhsStatus(note: XhsNote): XhsNoteStatus {
  if (note.exportPath.trim() && !xhsStale(note, 'package')) return 'packaged';
  if (note.coverPath.trim() && note.title.trim() && note.body.trim()) return 'visual';
  if (note.title.trim() && note.body.trim()) return 'title';
  if (note.body.trim()) return 'body';
  return 'idea';
}

/** 检测结果：没跑过为 null；有任何 error 级未通过为 false。 */
export function checksPassed(note: XhsNote): boolean | null {
  const report = readCheckReport(note);
  if (!report) return null;
  return !report.items.some(item => item.ok === false && item.level === 'error');
}

export function buildXhsPipeline(note: XhsNote): XhsStep[] {
  const hasTopic = Boolean(note.topic.trim());
  const hasBody = Boolean(note.body.trim());
  const hasTitle = Boolean(note.title.trim());
  const hasCover = Boolean(note.coverPath.trim());
  const report = readCheckReport(note);
  const steps = XHS_STEPS.map((item, position): XhsStep => {
    let state: XhsStepState = 'ready';
    let reason = '';
    if (item.key === 'topic') {
      state = hasTopic ? 'done' : 'ready';
    } else if (item.key === 'body') {
      if (!hasTopic) { state = 'locked'; reason = '先填写选题'; }
      else if (!hasBody) state = 'ready';
      else if (xhsStale(note, 'body')) { state = 'attention'; reason = '笔记类型改过，正文骨架需要按新类型重写'; }
      else state = 'done';
    } else if (item.key === 'title') {
      if (!hasBody) { state = 'locked'; reason = '先写好正文：标题要基于正文做搜索词覆盖与收藏动机'; }
      else if (!hasTitle) state = 'ready';
      else if (xhsStale(note, 'title')) { state = 'attention'; reason = '正文改过，标题需要复核是否仍然贴合'; }
      else state = 'done';
    } else if (item.key === 'visual') {
      if (!hasTitle) { state = 'locked'; reason = '先定标题：封面上要放标题'; }
      else if (!hasCover) state = 'ready';
      else if (xhsStale(note, 'cover')) { state = 'attention'; reason = '标题改过，封面上的标题字需要复核'; }
      else if (readImages(note).some(image => image.source !== 'local') && xhsStale(note, 'cards')) { state = 'attention'; reason = '正文改过，图文卡片 / 信息图需要重新生成'; }
      else state = 'done';
    } else if (item.key === 'checks') {
      if (!hasBody || !hasTitle) { state = 'locked'; reason = '正文与标题都有了才能检测'; }
      else if (!report) state = 'ready';
      else if (xhsStale(note, 'checks')) { state = 'attention'; reason = '标题、正文或标签改过，需要重新检测'; }
      else if (checksPassed(note) === false) { state = 'attention'; reason = '有未通过的检测项，处理后再导出'; }
      else state = 'done';
    } else {
      const gate = xhsExportChecklist(note).filter(entry => !entry.optional).every(entry => entry.ok);
      if (!gate) { state = 'locked'; reason = '正文、标题、封面都齐了才能导出'; }
      else if (!note.exportPath.trim()) state = 'ready';
      else if (xhsStale(note, 'package')) { state = 'attention'; reason = '导出后内容又改过，需要重新导出发布包'; }
      else state = 'done';
    }
    return { key: item.key, index: position + 1, label: item.label, hint: item.hint, state, reason };
  });
  const first = steps.find(step => step.state === 'ready' || step.state === 'attention');
  if (first && first.state === 'ready') first.state = 'current';
  return steps;
}

export function currentXhsStepKey(note: XhsNote): XhsStepKey {
  const steps = buildXhsPipeline(note);
  return (steps.find(step => step.state === 'current' || step.state === 'attention') ?? steps[steps.length - 1]).key;
}

export function xhsPipelineProgress(note: XhsNote): { done: number; total: number } {
  const steps = buildXhsPipeline(note);
  return { done: steps.filter(step => step.state === 'done').length, total: steps.length };
}

/** 导出门槛：正文、标题、封面是硬门槛；检测通过是建议项。 */
export function xhsExportChecklist(note: XhsNote): Array<{ label: string; ok: boolean; detail: string; optional?: boolean }> {
  const passed = checksPassed(note);
  const images = readImages(note);
  return [
    { label: '正文', ok: Boolean(note.body.trim()), detail: note.body.trim() ? `${countChars(note.body)} 字` : '还没有正文' },
    { label: '标题', ok: Boolean(note.title.trim()), detail: note.title.trim() || '还没有选定标题' },
    { label: '封面', ok: Boolean(note.coverPath.trim()), detail: note.coverPath.trim() ? '已设置 3:4 封面' : '还没有封面' },
    { label: '图组', ok: images.length > 0, detail: images.length ? `封面之后还有 ${images.length} 张` : '只有封面也能发，图文笔记通常 6 张以上', optional: true },
    { label: '发布前检测', ok: passed === true && !xhsStale(note, 'checks'), detail: passed === null ? '还没检测' : xhsStale(note, 'checks') ? '检测后内容改过' : passed ? '全部硬性项通过' : '有未通过的硬性项', optional: true }
  ];
}

export function assertXhsExportable(note: XhsNote): void {
  if (!note.body.trim()) throw new Error('请先写好正文，再导出发布包');
  if (!note.title.trim()) throw new Error('请先选定标题，再导出发布包');
  if (!note.coverPath.trim()) throw new Error('请先设置封面，再导出发布包');
}

/**
 * 编辑补丁：只放行可编辑字段，并按新内容重算状态。
 * 选定标题时顺手盖上「标题依据当前正文」的指纹——人选的标题就是对当前正文的确认。
 */
export function prepareXhsEdit(note: XhsNote, patch: Partial<XhsNote>): Partial<XhsNote> {
  const allowed: Array<keyof XhsNote> = ['topic', 'noteType', 'material', 'title', 'body', 'tagsJson', 'writerJson', 'cardsJson'];
  const result: Partial<XhsNote> = {};
  for (const key of allowed) if (patch[key] !== undefined) (result as Record<string, unknown>)[key] = patch[key];
  if (result.noteType !== undefined && !XHS_NOTE_TYPES.some(item => item.value === result.noteType)) throw new Error('未知的笔记类型');
  if (result.tagsJson !== undefined) result.tagsJson = JSON.stringify(normalizeTags(parse<unknown>(String(result.tagsJson), [])));
  if (result.cardsJson !== undefined && String(result.cardsJson).trim()) {
    const plan = readCardPlan({ cardsJson: String(result.cardsJson) });
    if (!plan) throw new Error('图文卡片内容格式不正确');
    result.cardsJson = JSON.stringify(plan);
  }
  const next: XhsNote = { ...note, ...result };
  if (result.title !== undefined && result.title.trim() && result.title !== note.title) result.basisJson = stampBasis(next, 'title');
  next.basisJson = result.basisJson ?? note.basisJson;
  result.status = deriveXhsStatus(next);
  return result;
}

export function normalizeTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，、#]+/);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of list) {
    const tag = String(item).replace(/^#+/, '').replace(/\s+/g, '').trim().slice(0, 20);
    if (tag && !seen.has(tag)) { seen.add(tag); tags.push(tag); }
  }
  return tags.slice(0, 15);
}

/* ── 本地检测（9 项） ────────────────────────────────────────── */

/** 中文按字、emoji 按 1 个计；小红书的字数统计接近这个口径。 */
export function countChars(value: string): number {
  return [...value.replace(/\s/g, '')].length;
}

const EMOJI = /\p{Extended_Pictographic}/gu;

export function findRiskWords(value: string): Array<{ word: string; reason: string }> {
  let text = value;
  for (const exception of XHS_RISK_EXCEPTIONS) text = text.split(exception).join('');
  return XHS_RISK_WORDS.filter(item => text.includes(item.word));
}

const CONTACT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /https?:\/\/|www\.[a-z0-9-]+\.[a-z]/i, label: '外部链接' },
  { pattern: /(微信|vx|v信|wx|薇信|威信)\s*[:：号]?\s*[a-z0-9_-]{5,}/i, label: '微信号' },
  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/, label: '手机号' },
  { pattern: /(qq|扣扣)\s*[:：号]?\s*\d{5,}/i, label: 'QQ 号' },
  { pattern: /私信我|加我|戳我主页|主页领取|评论区领取|找我领/, label: '引流话术' }
];

export function localChecks(note: Pick<XhsNote, 'title' | 'body' | 'tagsJson'>): XhsCheckItem[] {
  const title = note.title.trim();
  const body = note.body.trim();
  const tags = readTags(note);
  const def = (id: string) => XHS_CHECKS.find(item => item.id === id)!;
  const item = (id: string, ok: boolean, level: XhsCheckItem['level'], detail: string): XhsCheckItem => ({ id, label: def(id).label, ok, level, detail, source: 'local' });
  const titleLength = countChars(title);
  const bodyLength = countChars(body);
  const emojis = (body.match(EMOJI) ?? []).length;
  const density = bodyLength ? emojis / bodyLength * 100 : 0;
  const risky = findRiskWords(`${title}\n${body}\n${tags.join(' ')}`);
  const contacts = CONTACT_PATTERNS.filter(entry => entry.pattern.test(`${title}\n${body}`)).map(entry => entry.label);
  const longParagraphs = body.split(/\n+/).filter(paragraph => countChars(paragraph) > 120).length;
  const rawTags = (() => { const value = parse<unknown>(note.tagsJson, []); return Array.isArray(value) ? value.map(String) : []; })();
  const dirtyTags = rawTags.filter(tag => /[\s#，,。.!！?？]/.test(tag.trim()) || !tag.trim());
  const duplicated = rawTags.length !== new Set(rawTags.map(tag => tag.trim())).size;
  return [
    item('title_length', Boolean(title) && titleLength <= XHS_TITLE_LIMIT, 'error', title ? `${titleLength} 字${titleLength > XHS_TITLE_LIMIT ? `，超出 ${titleLength - XHS_TITLE_LIMIT} 字` : ''}` : '还没有标题'),
    item('body_length', bodyLength <= XHS_BODY_LIMIT, 'error', `${bodyLength} 字${bodyLength > XHS_BODY_LIMIT ? `，超出 ${bodyLength - XHS_BODY_LIMIT} 字` : ''}`),
    item('body_min', bodyLength >= 150, 'warn', bodyLength >= 150 ? `${bodyLength} 字` : `只有 ${bodyLength} 字`),
    item('tag_count', tags.length >= XHS_TAG_RANGE.min && tags.length <= XHS_TAG_RANGE.max, 'warn', `${tags.length} 个标签`),
    item('tag_format', !dirtyTags.length && !duplicated, 'warn', dirtyTags.length ? `需要清理：${dirtyTags.join('、')}` : duplicated ? '有重复标签' : '格式正常'),
    item('emoji_density', density <= 4, 'warn', `${emojis} 个 emoji，每 100 字约 ${density.toFixed(1)} 个`),
    item('risk_words', !risky.length, 'error', risky.length ? risky.map(entry => `「${entry.word}」${entry.reason}`).join('；') : '未发现'),
    item('contact', !contacts.length, 'error', contacts.length ? `发现：${contacts.join('、')}` : '未发现'),
    item('paragraph', longParagraphs === 0, 'warn', longParagraphs ? `${longParagraphs} 段超过 120 字，手机上会显得很长` : '段落长度合适')
  ];
}

/** 模型那 5 项缺失时补成「未检测」，保证报告总是完整的 14 项、顺序固定。 */
export function mergeCheckItems(local: XhsCheckItem[], model: XhsCheckItem[]): XhsCheckItem[] {
  return XHS_CHECKS.map(def => {
    if (def.source === 'local') return local.find(item => item.id === def.id) ?? { id: def.id, label: def.label, ok: null, level: 'warn', detail: '未检测', source: 'local' };
    return model.find(item => item.id === def.id) ?? { id: def.id, label: def.label, ok: null, level: 'warn', detail: '模型未检测', source: 'model' };
  });
}

/* ── 向导规则 ───────────────────────────────────────────────── */

/**
 * 规则优先：没有定位档案 → 链路 A；复盘找到主要卡点 → 链路 C 对应环节；其余 → 链路 B。
 * 只有用户写了自由描述时，才由模型在三条链路里选一条（见 xhs-workflow）。
 */
export function routeByRules(input: { hasPositioning: boolean; dominantLayer: XhsFunnelLayer | ''; noteCount: number; statCount: number }): XhsRouterAdvice {
  if (!input.hasPositioning) return chainAdvice('A', '', '还没有定位档案：先把「做什么方向、给谁看、靠什么活下去」定下来，再开始产出。', 'rule');
  if (input.dominantLayer) {
    const layer = XHS_FUNNEL_LAYERS.find(item => item.key === input.dominantLayer)!;
    return chainAdvice('C', input.dominantLayer, `笔记复盘显示多数笔记卡在「${layer.label}」层。${layer.remedy}。`, 'rule');
  }
  if (input.noteCount >= 5 && input.statCount === 0) return chainAdvice('C', '', '已经写了几篇但还没导入数据：先导入创作者中心的笔记数据，看卡在漏斗哪一层。', 'rule');
  return chainAdvice('B', '', '定位已经有了，按日常产出节奏走：找热点 → 写正文 → 起标题 → 做视觉 → 发布。', 'rule');
}

export function chainAdvice(chain: 'A' | 'B' | 'C', layer: XhsFunnelLayer | '', reason: string, source: 'rule' | 'model'): XhsRouterAdvice {
  if (chain === 'A') {
    return { chain, layer, reason, source, title: '链路 A · 从零起号', steps: [
      { tab: 'positioning', label: '账号定位' }, { tab: 'hotspot', label: '热点选题' }, { tab: 'notes', label: '正文 → 标题 → 视觉 → 发布包' }
    ] };
  }
  if (chain === 'B') {
    return { chain, layer, reason, source, title: '链路 B · 日常产出', steps: [
      { tab: 'hotspot', label: '热点选题' }, { tab: 'notes', label: '正文 → 标题 → 视觉 → 发布包' }
    ] };
  }
  const target = XHS_FUNNEL_LAYERS.find(item => item.key === layer);
  return { chain, layer, reason, source, title: '链路 C · 诊断改进', steps: [
    { tab: 'analytics', label: '笔记复盘（定位卡点）' },
    ...(target ? [{ tab: target.tab, label: target.remedy.split('：')[1] ?? target.label }] : [{ tab: 'audit' as const, label: '账号诊断' }])
  ] };
}
