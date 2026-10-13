import type {
  XhsAnalyticsView, XhsAuditInput, XhsAuditMetrics, XhsFunnelLayer, XhsFunnelRow, XhsNote, XhsNoteStat, XhsReport, XhsStatMetrics
} from '../shared.ts';
import { normalizeDate, normalizeTitle } from './article-stats.ts';
import { XHS_FUNNEL_LAYERS } from './xhs-catalog.ts';
import type { Table } from './table-file.ts';

/**
 * 小红书笔记数据：创作者中心导出表 → 记录，六层漏斗归因，账号诊断的本地指标。
 *
 * 纯逻辑。漏斗归因只和账号自己的中位数比——没有行业基准，所以结论是「这篇比你平时弱在哪一层」，
 * 而不是「这篇绝对差」。界面与解读都要按这个口径说。
 */

export type XhsStatInput = { title: string; publishDate: string; metrics: XhsStatMetrics };
type MetricKey = keyof XhsStatMetrics;

const TITLE_ALIASES = ['笔记标题', '标题', '笔记名称', '作品标题', '作品名称'];
const DATE_ALIASES = ['首次发布时间', '发布时间', '发布日期', '发布时间点', '日期', '时间'];
export const XHS_METRIC_ALIASES: Record<MetricKey, string[]> = {
  impressions: ['曝光', '曝光量', '曝光数', '展现量', '展示量', '曝光次数'],
  views: ['观看量', '观看', '观看数', '阅读量', '阅读', '浏览量', '浏览', '观看次数', '小眼睛'],
  ctr: ['封面点击率', '点击率', '笔记点击率'],
  avgViewSeconds: ['人均观看时长', '平均观看时长', '平均阅读时长', '人均阅读时长'],
  completion: ['完播率', '平均完播率', '读完率'],
  likes: ['点赞', '点赞数', '点赞量', '获赞'],
  comments: ['评论', '评论数', '评论量'],
  collects: ['收藏', '收藏数', '收藏量'],
  shares: ['分享', '分享数', '分享量', '转发'],
  follows: ['涨粉', '涨粉数', '新增关注', '净增粉丝', '笔记涨粉']
};
const RATE_KEYS = new Set<MetricKey>(['ctr', 'completion']);
const METRIC_KEYS = Object.keys(XHS_METRIC_ALIASES) as MetricKey[];

export function emptyXhsMetrics(): XhsStatMetrics {
  return Object.fromEntries(METRIC_KEYS.map(key => [key, null])) as XhsStatMetrics;
}

function normalizeHeader(value: string): string {
  return value.replace(/[\s（）()【】\[\]：:]/g, '');
}

function findColumn(headers: string[], aliases: string[], taken: Set<number>, allowRate = false): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const exact = normalized.findIndex((header, index) => !taken.has(index) && header === alias);
    if (exact >= 0) return exact;
  }
  for (const alias of aliases) {
    const partial = normalized.findIndex((header, index) => !taken.has(index) && header.includes(alias) && (allowRate || !/率|占比/.test(header)));
    if (partial >= 0) return partial;
  }
  return -1;
}

/** "1,234" / "1.2万" / "1.2w" → 数字；"-"、空 → null。 */
export function parseXhsCount(value: string | undefined): number | null {
  const cleaned = (value ?? '').replace(/[,，\s+]/g, '').toLowerCase();
  if (!cleaned || /^-+$/.test(cleaned)) return null;
  const wan = cleaned.match(/^(\d+(?:\.\d+)?)(万|w)$/);
  if (wan) return Math.round(Number(wan[1]) * 10_000);
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
}

/** "8.5%" → 0.085；"0.085" → 0.085；"8.5"（大于 1 视为百分数）→ 0.085。 */
export function parseRate(value: string | undefined): number | null {
  const cleaned = (value ?? '').replace(/[,，\s]/g, '');
  if (!cleaned || /^-+$/.test(cleaned)) return null;
  const percent = cleaned.match(/^(\d+(?:\.\d+)?)%$/);
  if (percent) return Number(percent[1]) / 100;
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return number > 1 ? number / 100 : number;
}

/** "12秒" / "1分5秒" / "00:01:05" / "65" → 秒。 */
export function parseSeconds(value: string | undefined): number | null {
  const cleaned = (value ?? '').replace(/\s/g, '');
  if (!cleaned || /^-+$/.test(cleaned)) return null;
  const clock = cleaned.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const words = cleaned.match(/^(?:(\d+(?:\.\d+)?)分(?:钟)?)?(?:(\d+(?:\.\d+)?)秒)?$/);
  if (words && (words[1] || words[2])) return Number(words[1] ?? 0) * 60 + Number(words[2] ?? 0);
  return /^\d+(\.\d+)?s?$/.test(cleaned) ? Number(cleaned.replace(/s$/, '')) : null;
}

/** 表头之上常有「笔记数据明细」这类说明行：表头至少要有 3 个非空单元格。 */
function findHeaderRow(table: Table): number {
  for (let index = 0; index < Math.min(table.length, 10); index += 1) {
    if (table[index].filter(cell => cell.trim()).length >= 3 && findColumn(table[index], TITLE_ALIASES, new Set()) >= 0) return index;
  }
  return -1;
}

/** 表格 → 记录。找不到列时报出文件里实际的列名，方便判断是哪种导出没覆盖到。 */
export function tableToXhsStats(table: Table): XhsStatInput[] {
  const headerIndex = findHeaderRow(table);
  if (headerIndex < 0) {
    const preview = (table[0] ?? []).filter(Boolean).slice(0, 12).join('、') || '（空）';
    throw new Error(`没有找到「笔记标题」列。文件首行是：${preview}。请在创作者中心「数据中心 → 笔记数据」导出笔记明细`);
  }
  const headers = table[headerIndex];
  const taken = new Set<number>();
  const titleColumn = findColumn(headers, TITLE_ALIASES, taken);
  taken.add(titleColumn);
  const dateColumn = findColumn(headers, DATE_ALIASES, taken);
  if (dateColumn >= 0) taken.add(dateColumn);
  const columns = {} as Record<MetricKey, number>;
  // 比率列先找（允许匹配带「率」的表头），再找计数列，免得「点击率」被「点击」抢走。
  for (const key of [...METRIC_KEYS].sort((a, b) => Number(RATE_KEYS.has(b)) - Number(RATE_KEYS.has(a)))) {
    const column = findColumn(headers, XHS_METRIC_ALIASES[key], taken, RATE_KEYS.has(key));
    columns[key] = column;
    if (column >= 0) taken.add(column);
  }
  const found = METRIC_KEYS.filter(key => columns[key] >= 0);
  if (!found.length) throw new Error(`没有找到曝光、观看、点赞等数据列。表头是：${headers.filter(Boolean).join('、')}`);
  const merged = new Map<string, XhsStatInput>();
  for (const row of table.slice(headerIndex + 1)) {
    const title = (row[titleColumn] ?? '').trim();
    if (!title || /^(合计|总计|汇总)$/.test(title)) continue;
    const publishDate = dateColumn >= 0 ? normalizeDate(row[dateColumn] ?? '') : '';
    const key = `${normalizeTitle(title)}|${publishDate}`;
    const input = merged.get(key) ?? { title, publishDate, metrics: emptyXhsMetrics() };
    for (const metric of found) {
      const raw = row[columns[metric]];
      const value = RATE_KEYS.has(metric) ? parseRate(raw) : metric === 'avgViewSeconds' ? parseSeconds(raw) : parseXhsCount(raw);
      if (value === null) continue;
      // 同一篇多行视为多次累计快照，取最大值。
      input.metrics[metric] = Math.max(input.metrics[metric] ?? 0, value);
    }
    merged.set(key, input);
  }
  if (!merged.size) throw new Error('文件识别成功，但没有任何笔记数据行');
  return [...merged.values()];
}

/** 记录 ↔ 笔记任务：按标题归一化后精确匹配，多条同名取最近更新的。 */
export function matchXhsNote(title: string, notes: XhsNote[]): XhsNote | null {
  const target = normalizeTitle(title);
  if (!target) return null;
  return notes.filter(note => normalizeTitle(note.title) === target).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/* ── 六层漏斗 ───────────────────────────────────────────────── */

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

function sum(...values: Array<number | null>): number | null {
  return values.every(value => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** 每层取一个值：曝光是绝对数，点击优先用导出的点击率，深度优先用完播率。 */
export function funnelValues(metrics: XhsStatMetrics): Record<XhsFunnelLayer, number | null> {
  return {
    exposure: metrics.impressions,
    click: metrics.ctr ?? ratio(metrics.views, metrics.impressions),
    depth: metrics.completion ?? metrics.avgViewSeconds,
    engagement: ratio(sum(metrics.likes, metrics.comments), metrics.views),
    save: ratio(sum(metrics.collects, metrics.shares), metrics.views),
    follow: ratio(metrics.follows, metrics.views)
  };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 低于中位数这个倍数算「这一层明显偏弱」。 */
export const WEAK_RATIO = 0.6;

/**
 * 归因：每篇按漏斗从上到下，第一个明显低于账号中位数的层就是卡点——
 * 上层卡住时下层数据本来就少，往下看没有意义。
 * 账号级的主要卡点取最近（最多 20 篇）里出现最多的那一层，至少 2 篇才算。
 */
export function buildXhsAnalytics(stats: XhsNoteStat[], latestReport: XhsReport | null = null): XhsAnalyticsView {
  const layers = XHS_FUNNEL_LAYERS.map(item => item.key);
  const valueRows = stats.map(stat => ({ stat, values: funnelValues(stat.metrics) }));
  const medians = Object.fromEntries(layers.map(layer => [layer, median(valueRows.map(row => row.values[layer]).filter((value): value is number => value !== null && value >= 0))])) as Record<XhsFunnelLayer, number | null>;
  const rows: XhsFunnelRow[] = valueRows.map(({ stat, values }) => {
    const ratios = Object.fromEntries(layers.map(layer => {
      const value = values[layer];
      const base = medians[layer];
      return [layer, value === null || base === null || base <= 0 ? null : value / base];
    })) as Record<XhsFunnelLayer, number | null>;
    const weakest: XhsFunnelLayer | '' = stats.length >= 3 ? layers.find(layer => ratios[layer] !== null && (ratios[layer] as number) < WEAK_RATIO) ?? '' : '';
    return { stat, values, ratios, weakest };
  }).sort((a, b) => b.stat.publishDate.localeCompare(a.stat.publishDate));
  const layerCounts = Object.fromEntries(layers.map(layer => [layer, 0])) as Record<XhsFunnelLayer, number>;
  for (const row of rows.slice(0, 20)) if (row.weakest) layerCounts[row.weakest] += 1;
  const top = layers.reduce<XhsFunnelLayer | ''>((best, layer) => (layerCounts[layer] > (best ? layerCounts[best] : 0) ? layer : best), '');
  return { rows, medians, layerCounts, dominant: top && layerCounts[top] >= 2 ? top : '', latestReport };
}

/** 给模型的数据摘要：每层中位数 + 每篇的值、倍数与卡点（最多 30 篇）。 */
export function analyticsDigest(view: XhsAnalyticsView): string {
  const format = (layer: XhsFunnelLayer, value: number | null) => value === null ? '—' : layer === 'exposure' ? String(Math.round(value)) : layer === 'depth' && value > 1 ? `${value.toFixed(0)}秒` : `${(value * 100).toFixed(1)}%`;
  const header = XHS_FUNNEL_LAYERS.map(item => `${item.label}中位数 ${format(item.key, view.medians[item.key])}`).join('；');
  const lines = view.rows.slice(0, 30).map(row => `- 《${row.stat.title}》${row.stat.publishDate || ''}：${XHS_FUNNEL_LAYERS.map(item => `${item.label} ${format(item.key, row.values[item.key])}${row.ratios[item.key] !== null ? `(${(row.ratios[item.key] as number).toFixed(2)}x)` : ''}`).join('，')}；卡点：${row.weakest ? XHS_FUNNEL_LAYERS.find(item => item.key === row.weakest)!.label : '无明显卡点'}`);
  return `共 ${view.rows.length} 篇。${header}\n主要卡点：${view.dominant ? XHS_FUNNEL_LAYERS.find(item => item.key === view.dominant)!.label : '没有集中的卡点'}\n${lines.join('\n')}`;
}

/* ── 账号诊断的本地指标 ─────────────────────────────────────── */

export function auditMetrics(input: XhsAuditInput): XhsAuditMetrics {
  const interactions = input.notes.map(note => note.liked + note.collected + note.comments);
  const middle = median(interactions);
  const average = interactions.length ? interactions.reduce((total, value) => total + value, 0) / interactions.length : 0;
  const dates = input.notes.map(note => normalizeDate(note.date)).filter(Boolean).sort();
  let postsPerWeek: number | null = null;
  let longestGap: number | null = null;
  if (dates.length >= 2) {
    const span = Math.max(1, (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86_400_000);
    postsPerWeek = Math.round(dates.length / span * 7 * 10) / 10;
    longestGap = 0;
    for (let index = 1; index < dates.length; index += 1) longestGap = Math.max(longestGap, Math.round((Date.parse(dates[index]) - Date.parse(dates[index - 1])) / 86_400_000));
  }
  // 爆款：互动 ≥ 中位数 3 倍且至少 100，避免小号里「10 个赞」也算爆款。
  const hitLine = middle === null ? null : Math.max(100, middle * 3);
  return {
    noteCount: input.notes.length,
    avgInteractions: Math.round(average),
    medianInteractions: Math.round(middle ?? 0),
    interactionRate: input.fans > 0 && interactions.length ? Math.round(average / input.fans * 1000) / 1000 : null,
    hitRate: hitLine === null ? null : Math.round(interactions.filter(value => value >= hitLine).length / interactions.length * 100) / 100,
    postsPerWeek,
    longestGapDays: longestGap
  };
}

/** 用户粘贴的笔记列表：每行「标题 | 点赞 | 收藏 | 评论 | 日期」，分隔符可以是 | 、制表符或逗号。 */
export function parseAuditNotes(text: string): XhsAuditInput['notes'] {
  return text.split(/\r?\n/).flatMap(line => {
    const cells = line.split(/\s*[|｜\t]\s*|\s*[,，]\s*(?=\d)/).map(cell => cell.trim());
    const title = cells[0];
    if (!title) return [];
    const count = (index: number) => parseXhsCount(cells[index]) ?? 0;
    const date = cells.slice(1).find(cell => normalizeDate(cell)) ?? '';
    return [{ title, liked: count(1), collected: count(2), comments: count(3), date: normalizeDate(date), isVideo: /视频/.test(line) }];
  });
}
