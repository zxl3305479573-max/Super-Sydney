import type { ArticleMetricKey, ArticleMetrics, ArticleStatGroup, ArticleStatRecord, ArticleStatsView, ContentTask } from '../shared.ts';
import type { Table } from './table-file.ts';

/**
 * 公众号文章数据的纯逻辑：表格 → 记录、记录 ↔ 创作任务匹配、派生指标与分组汇总。
 *
 * 数据来源与这里无关：现在是用户从公众号后台导出的表格，以后若账号认证、能调
 * datacube 接口，只需要另写一个来源把结果转成 ArticleStatInput，后面全部复用。
 */

export type ArticleStatInput = { title: string; publishDate: string; metrics: ArticleMetrics };

/**
 * 列名别名。后台不同页面、不同时期导出的列名不一致，这里按"包含/等于"匹配。
 * 顺序有意义：先放更具体的名字，避免"阅读人数"被"阅读"之类的宽泛别名抢走。
 */
const TITLE_ALIASES = ['文章标题', '内容标题', '标题'];
const DATE_ALIASES = ['发表时间', '发布时间', '群发时间', '发表日期', '发布日期', '日期', '时间'];
const CHANNEL_ALIASES = ['传播渠道', '渠道'];
export const METRIC_ALIASES: Record<ArticleMetricKey, string[]> = {
  readUsers: ['阅读人数', '图文阅读人数', '总阅读人数'],
  reads: ['阅读次数', '图文阅读次数', '总阅读次数', '阅读量', '阅读数'],
  shareUsers: ['分享人数', '分享转发人数', '转发人数'],
  shares: ['分享次数', '分享转发次数', '转发次数', '分享数', '分享'],
  likes: ['点赞人数', '点赞次数', '点赞数', '点赞'],
  wows: ['在看人数', '在看次数', '在看数', '在看'],
  favorites: ['收藏人数', '收藏次数', '收藏数', '收藏'],
  comments: ['留言人数', '留言次数', '留言数', '评论数', '留言'],
  delivered: ['送达人数', '送达数'],
  follows: ['阅读后关注人数', '新增关注人数']
};

export const METRIC_LABELS: Record<ArticleMetricKey, string> = {
  readUsers: '阅读人数', reads: '阅读次数', shareUsers: '分享人数', shares: '分享次数', likes: '点赞',
  wows: '在看', favorites: '收藏', comments: '留言', delivered: '送达人数', follows: '阅读后关注'
};

export const METRIC_KEYS = Object.keys(METRIC_ALIASES) as ArticleMetricKey[];

function normalizeHeader(value: string): string {
  return value.replace(/[\s（）()【】\[\]：:]/g, '');
}

function findColumn(headers: string[], aliases: string[], taken: Set<number>): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const exact = normalized.findIndex((header, index) => !taken.has(index) && header === alias);
    if (exact >= 0) return exact;
  }
  for (const alias of aliases) {
    // 比例列（"阅读人数占比"、"完读率"）不是计数，宽泛匹配时排除，免得被当成阅读人数。
    const partial = normalized.findIndex((header, index) => !taken.has(index) && header.includes(alias) && !/占比|率/.test(header));
    if (partial >= 0) return partial;
  }
  return -1;
}

/**
 * 后台的「数据趋势」导出把几张表左右并排放在同一个工作表里，中间隔一列空表头。
 * 只在标题列所在的那张表里找其他列，否则会把账号级趋势表的"阅读人数"错配给单篇。
 */
function columnsOutsideBlock(headers: string[], column: number): Set<number> {
  let start = column;
  let end = column;
  while (start > 0 && headers[start - 1]?.trim()) start -= 1;
  while (end + 1 < headers.length && headers[end + 1]?.trim()) end += 1;
  const outside = new Set<number>();
  for (let index = 0; index < headers.length; index += 1) if (index < start || index > end) outside.add(index);
  return outside;
}

/** 后台导出常有标题行、说明行在表头之上：取前 10 行里第一行能找到"标题"列的作为表头。 */
function findHeaderRow(table: Table): number {
  const limit = Math.min(table.length, 10);
  for (let index = 0; index < limit; index += 1) {
    if (findColumn(table[index], TITLE_ALIASES, new Set()) >= 0) return index;
  }
  return -1;
}

/** 支持 2026-10-11 / 2026/10/11 / 20261011 / 2026年10月11日（可带时间）以及 Excel 日期序号。 */
export function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/) ?? trimmed.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return '';
  }
  // Excel 序号：1900 体系，25569 = 1970-01-01；只接受合理区间，防止把阅读量当日期。
  if (/^\d{5}(\.\d+)?$/.test(trimmed)) {
    const serial = Number(trimmed);
    if (serial > 36_526 && serial < 73_051) return new Date(Math.round((serial - 25_569) * 86_400_000)).toISOString().slice(0, 10);
  }
  return '';
}

/** "1,234" → 1234；"-"、空、非数字 → null（区分"没有这一列/没数据"和真正的 0）。 */
export function parseCount(value: string | undefined): number | null {
  const cleaned = (value ?? '').replace(/[,，\s]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '--') return null;
  const wan = cleaned.match(/^(\d+(?:\.\d+)?)万$/);
  if (wan) return Math.round(Number(wan[1]) * 10_000);
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Math.round(Number(cleaned)) : null;
}

export function emptyMetrics(): ArticleMetrics {
  return Object.fromEntries(METRIC_KEYS.map(key => [key, null])) as ArticleMetrics;
}

/**
 * 表格 → 统计记录。找不到必需的列时报错并列出文件里实际的列名，
 * 方便用户（和我们）知道是哪种导出格式没覆盖到，而不是静默导入一堆空值。
 */
export function tableToStatInputs(table: Table): ArticleStatInput[] {
  const headerIndex = findHeaderRow(table);
  if (headerIndex < 0) {
    const preview = (table[0] ?? []).filter(Boolean).slice(0, 12).join('、') || '（空）';
    throw new Error(`没有找到"标题"列。文件首行是：${preview}。请导出「内容分析」里的单篇文章数据明细`);
  }
  const headers = table[headerIndex];
  const titleColumn = findColumn(headers, TITLE_ALIASES, new Set());
  const taken = columnsOutsideBlock(headers, titleColumn);
  taken.add(titleColumn);
  const block = headers.filter((_, index) => !taken.has(index) || index === titleColumn);
  const dateColumn = findColumn(headers, DATE_ALIASES, taken);
  if (dateColumn >= 0) taken.add(dateColumn);
  const channelColumn = findColumn(headers, CHANNEL_ALIASES, taken);
  if (channelColumn >= 0) taken.add(channelColumn);
  const metricColumns = {} as Record<ArticleMetricKey, number>;
  for (const key of METRIC_KEYS) {
    const column = findColumn(headers, METRIC_ALIASES[key], taken);
    metricColumns[key] = column;
    if (column >= 0) taken.add(column);
  }
  const found = METRIC_KEYS.filter(key => metricColumns[key] >= 0);
  if (dateColumn < 0 || !found.length) {
    const missing = [dateColumn < 0 ? '发表时间' : '', found.length ? '' : '阅读/分享等数据列'].filter(Boolean).join('、');
    throw new Error(`缺少${missing}列。标题所在的表里的列是：${block.filter(Boolean).join('、')}`);
  }

  // 同一篇文章会出现多行，合并规则取决于多行的含义：
  //   - 按渠道拆分（有"传播渠道"列）：有"全部"行就用它，没有就把各渠道相加；
  //   - 否则视为同一篇的多次累计快照，取最大值——求和会把累计数重复相加。
  type Bucket = { input: ArticleStatInput; total: ArticleMetrics | null };
  const merged = new Map<string, Bucket>();
  for (const row of table.slice(headerIndex + 1)) {
    const title = (row[titleColumn] ?? '').trim();
    const publishDate = normalizeDate(row[dateColumn] ?? '');
    if (!title || !publishDate || /^(合计|总计|汇总)$/.test(title)) continue;
    const key = `${normalizeTitle(title)}|${publishDate}`;
    const bucket = merged.get(key) ?? { input: { title, publishDate, metrics: emptyMetrics() }, total: null };
    const channel = channelColumn >= 0 ? (row[channelColumn] ?? '').trim() : '';
    const isTotal = channelColumn >= 0 && /^(全部|合计|总计)$/.test(channel);
    if (isTotal) bucket.total = emptyMetrics();
    for (const metric of found) {
      const value = parseCount(row[metricColumns[metric]]);
      if (value === null) continue;
      if (isTotal) bucket.total![metric] = value;
      else if (channelColumn >= 0) bucket.input.metrics[metric] = (bucket.input.metrics[metric] ?? 0) + value;
      else bucket.input.metrics[metric] = Math.max(bucket.input.metrics[metric] ?? 0, value);
    }
    merged.set(key, bucket);
  }
  if (!merged.size) {
    throw new Error('文件格式识别成功，但单篇文章表是空的：统计期内还没有已发表的文章。推进草稿箱的文章需要在后台发表或群发后才会有数据');
  }
  return [...merged.values()].map(({ input, total }) => (total ? { ...input, metrics: total } : input));
}

/** 标题比对时忽略空白、标点和大小写：后台展示的标题常被去掉首尾空格或换掉全半角符号。 */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function publishedDate(task: ContentTask): string {
  try {
    const parsed = JSON.parse(task.publishJson || '{}') as { publishedAt?: unknown };
    return typeof parsed.publishedAt === 'string' ? parsed.publishedAt.slice(0, 10) : '';
  } catch {
    return '';
  }
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * 统计记录 → 创作任务。只按标题匹配（导出里没有 media_id），同标题多个任务时
 * 优先选"推草稿日期在发表日期之前且最接近"的那个——草稿总是先于群发。
 */
export function matchTask(record: { title: string; publishDate: string }, tasks: ContentTask[]): ContentTask | null {
  const target = normalizeTitle(record.title);
  if (!target) return null;
  const candidates = tasks.filter(task => normalizeTitle(task.title) === target);
  if (candidates.length <= 1) return candidates[0] ?? null;
  const scored = candidates.map(task => {
    const pushed = publishedDate(task);
    const gap = pushed ? dayDiff(pushed, record.publishDate) : Number.POSITIVE_INFINITY;
    return { task, score: gap >= 0 ? gap : 10_000 - gap };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored[0].task;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

/** 阅读基数：优先人数（去重后更能反映覆盖），没有时用次数。 */
export function readBase(metrics: ArticleMetrics): number | null {
  return metrics.readUsers ?? metrics.reads;
}

export type StoredStat = { id: number; title: string; publishDate: string; metrics: ArticleMetrics; source: string; importedAt: string };

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** 汇总成界面直接渲染的视图：每篇的派生比率、按具体方向分组、整体中位数。 */
export function buildStatsView(stored: StoredStat[], tasks: ContentTask[]): ArticleStatsView {
  const records: ArticleStatRecord[] = stored.map(stat => {
    const task = matchTask(stat, tasks);
    const base = readBase(stat.metrics);
    return {
      ...stat,
      taskId: task?.id ?? null,
      directionName: task?.directionName ?? '',
      subdirectionName: task?.subdirectionName ?? '',
      shareRate: ratio(stat.metrics.shareUsers ?? stat.metrics.shares, base),
      engageRate: ratio(sumPresent(stat.metrics.likes, stat.metrics.wows, stat.metrics.favorites), base),
      openRate: ratio(stat.metrics.readUsers, stat.metrics.delivered)
    };
  }).sort((a, b) => b.publishDate.localeCompare(a.publishDate) || a.title.localeCompare(b.title));

  const groups = new Map<string, ArticleStatRecord[]>();
  for (const record of records) {
    const key = record.subdirectionName ? `${record.directionName} / ${record.subdirectionName}` : '未关联创作任务';
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const groupViews: ArticleStatGroup[] = [...groups.entries()].map(([name, items]) => ({
    name,
    count: items.length,
    medianReads: median(items.map(item => readBase(item.metrics)).filter((value): value is number => value !== null)),
    meanShareRate: mean(items.map(item => item.shareRate).filter((value): value is number => value !== null)),
    meanEngageRate: mean(items.map(item => item.engageRate).filter((value): value is number => value !== null))
  })).sort((a, b) => (b.medianReads ?? -1) - (a.medianReads ?? -1));

  const reads = records.map(record => readBase(record.metrics)).filter((value): value is number => value !== null);
  return {
    records,
    groups: groupViews,
    overview: {
      articles: records.length,
      matched: records.filter(record => record.taskId !== null).length,
      medianReads: median(reads),
      totalReads: reads.length ? reads.reduce((sum, value) => sum + value, 0) : null,
      meanShareRate: mean(records.map(record => record.shareRate).filter((value): value is number => value !== null))
    },
    availableMetrics: METRIC_KEYS.filter(key => records.some(record => record.metrics[key] !== null)),
    lastImportedAt: stored.reduce((latest, stat) => (stat.importedAt > latest ? stat.importedAt : latest), '')
  };
}

function sumPresent(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}
