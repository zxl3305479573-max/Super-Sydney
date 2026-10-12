import type { ContentDirection, ContentDirectionInput, ContentSubdirection, ContentSubdirectionInput, ContentTaxonomy } from '../shared.ts';

/**
 * 内容方向的纯逻辑：归一化、查表、旧数据映射。
 *
 * 应用不再假设账号只写中老年健康科普——分类完全由用户维护，
 * 这里只负责保证形状干净（去空格、去空项、同层不重名）。
 */

/**
 * 首次启动时写入的默认方向，等于把原来的 4 个固定类目挪成二级方向。
 *
 * 健康合规约束从全局常量搬到了这个方向的 note 里：只有选中这个方向时才会注入提示词，
 * 换成别的方向（比如科技、育儿）就不会再被"不诊疗、不宣称疗效"这类规则绑住。
 */
export const DEFAULT_DIRECTION_NAME = '中老年健康科普';
export const DEFAULT_DIRECTION_NOTE = [
  '面向中老年读者及其子女，语言平和、短句、少术语，不制造恐慌。',
  '严格健康科普：不诊断、不开药方、不提供剂量疗程，不宣称根治、抗癌、排毒或替代医嘱。',
  '区分事实、推断与意见；未核实来源不能写成已证实结论。',
  '涉及慢性病、服药、相互作用、特殊人群时，提醒咨询医生或药师。',
  '配图与封面不要出现文字、字母、数字、水印、器械或医疗符号，不要出现痛苦、夸张的表情。',
  '不编造亲身经历、患者案例、医生采访、数字或来源。'
].join('\n');
export const DEFAULT_SUBDIRECTIONS = ['饮食营养与蔬果利弊', '身心健康与作息', '长辈晚辈关系处理', '综合健康科普'];

/** 旧任务表里的 category 值 → 默认二级方向名，用于数据迁移。 */
export const LEGACY_CATEGORY_NAMES: Record<string, string> = {
  nutrition: '饮食营养与蔬果利弊',
  wellbeing: '身心健康与作息',
  family: '长辈晚辈关系处理',
  general: '综合健康科普'
};

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function assertUnique(names: string[], scope: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`${scope}里有重复的名称：${name}`);
    seen.add(name);
  }
}

/**
 * 归一化用户提交的分类树：
 * 去掉空名称与空二级方向、按输入顺序重排、同层不允许重名。
 * 至少保留一个方向与一个具体方向，否则新建任务没有可选值。
 */
export function normalizeTaxonomyInput(input: unknown): Array<{ id?: number; name: string; note: string; subdirections: Array<{ id?: number; name: string; note: string }> }> {
  if (!Array.isArray(input)) throw new Error('内容方向必须是数组');
  const directions = input.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 个内容方向格式不正确`);
    const record = raw as ContentDirectionInput;
    const name = cleanText(record.name);
    if (!name) throw new Error(`第 ${index + 1} 个内容方向还没有名称`);
    const rawSubs = Array.isArray(record.subdirections) ? record.subdirections : [];
    const subdirections = rawSubs.map((item, subIndex) => {
      if (!item || typeof item !== 'object') throw new Error(`「${name}」下第 ${subIndex + 1} 个具体方向格式不正确`);
      const sub = item as ContentSubdirectionInput;
      const subName = cleanText(sub.name);
      if (!subName) throw new Error(`「${name}」下第 ${subIndex + 1} 个具体方向还没有名称`);
      return {
        ...(Number.isInteger(sub.id) && Number(sub.id) > 0 ? { id: Number(sub.id) } : {}),
        name: subName,
        note: cleanText(sub.note)
      };
    });
    assertUnique(subdirections.map(item => item.name), `「${name}」的具体方向`);
    return {
      ...(Number.isInteger(record.id) && Number(record.id) > 0 ? { id: Number(record.id) } : {}),
      name,
      note: cleanText(record.note),
      subdirections
    };
  });
  if (!directions.length) throw new Error('至少保留一个内容方向');
  assertUnique(directions.map(item => item.name), '内容方向');
  if (!directions.some(item => item.subdirections.length)) throw new Error('至少给一个内容方向加一个具体方向');
  if (directions.length > 40) throw new Error('内容方向最多 40 个');
  for (const direction of directions) {
    if (direction.subdirections.length > 60) throw new Error(`「${direction.name}」下的具体方向最多 60 个`);
  }
  return directions;
}

/** 按 id 找具体方向，并带上它所属的一级方向。 */
export function findSubdirection(directions: ContentDirection[], id: number | null): { direction: ContentDirection; subdirection: ContentSubdirection } | null {
  if (!id) return null;
  for (const direction of directions) {
    const subdirection = direction.subdirections.find(item => item.id === id);
    if (subdirection) return { direction, subdirection };
  }
  return null;
}

export function findDirection(directions: ContentDirection[], id: number | null): ContentDirection | null {
  if (!id) return null;
  return directions.find(item => item.id === id) ?? null;
}

/** 所有二级方向名，按树序去重：写回 style.yaml 的 topics 用。 */
export function subdirectionNames(directions: ContentDirection[]): string[] {
  const names: string[] = [];
  for (const direction of directions) {
    for (const subdirection of direction.subdirections) {
      if (!names.includes(subdirection.name)) names.push(subdirection.name);
    }
  }
  return names;
}

/** 默认具体方向：优先用存下来的 id，其次按名字匹配（写回 style.yaml 的 default_topic），最后取第一个。 */
export function resolveDefaultSubdirection(taxonomy: ContentTaxonomy, preferredName = ''): { directionId: number | null; subdirectionId: number | null; name: string } {
  const byId = findSubdirection(taxonomy.directions, taxonomy.defaultSubdirectionId);
  if (byId) return { directionId: byId.direction.id, subdirectionId: byId.subdirection.id, name: byId.subdirection.name };
  const wanted = preferredName.trim();
  if (wanted) {
    for (const direction of taxonomy.directions) {
      const subdirection = direction.subdirections.find(item => item.name === wanted);
      if (subdirection) return { directionId: direction.id, subdirectionId: subdirection.id, name: subdirection.name };
    }
  }
  for (const direction of taxonomy.directions) {
    const subdirection = direction.subdirections[0];
    if (subdirection) return { directionId: direction.id, subdirectionId: subdirection.id, name: subdirection.name };
  }
  return { directionId: null, subdirectionId: null, name: '' };
}

/** 提示词用的分类描述：名字 + 该层的写作约束，缺一不可为空。 */
export function describeDirection(input: { name: string; note: string } | null | undefined): string {
  if (!input || !input.name.trim()) return '';
  return input.note.trim() ? `${input.name.trim()}\n${input.note.trim()}` : input.name.trim();
}
