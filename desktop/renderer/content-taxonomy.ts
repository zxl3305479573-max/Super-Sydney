import type { ContentDirection, ContentSubdirection, ContentTaxonomy } from '../shared';

/**
 * 渲染进程侧的分类查询：分类树来自主进程（数据库），界面只做展示与选择，不再自己维护一份写死的列表。
 */

export function findDirectionById(directions: ContentDirection[], id: number | null | undefined): ContentDirection | null {
  if (!id) return null;
  return directions.find(item => item.id === id) ?? null;
}

export function findSubdirectionById(directions: ContentDirection[], id: number | null | undefined): { direction: ContentDirection; subdirection: ContentSubdirection } | null {
  if (!id) return null;
  for (const direction of directions) {
    const subdirection = direction.subdirections.find(item => item.id === id);
    if (subdirection) return { direction, subdirection };
  }
  return null;
}

/** 任务列表/标题上展示的分类名：具体方向优先，退化到一级方向，再退化到"未归类"。 */
export function taskScopeLabel(task: { directionName: string; subdirectionName: string }): string {
  return task.subdirectionName || task.directionName || '未归类';
}

/** 新建任务时的默认分类：优先用存下来的默认具体方向，其次第一个可选项。 */
export function defaultSelection(taxonomy: ContentTaxonomy | null): { directionId: number | null; subdirectionId: number | null } {
  if (!taxonomy) return { directionId: null, subdirectionId: null };
  const preferred = findSubdirectionById(taxonomy.directions, taxonomy.defaultSubdirectionId);
  if (preferred) return { directionId: preferred.direction.id, subdirectionId: preferred.subdirection.id };
  for (const direction of taxonomy.directions) {
    const subdirection = direction.subdirections[0];
    if (subdirection) return { directionId: direction.id, subdirectionId: subdirection.id };
  }
  return { directionId: taxonomy.directions[0]?.id ?? null, subdirectionId: null };
}

/** 一级方向下没有任何具体方向时，任务只能挂在一级方向上。 */
export function subdirectionsOf(directions: ContentDirection[], directionId: number | null): ContentSubdirection[] {
  return findDirectionById(directions, directionId)?.subdirections ?? [];
}

/** 进入某份资料时，新建任务预选的具体方向：全局默认落在这份资料里就用它，否则取第一个。 */
export function profileDefaultSubdirection(taxonomy: ContentTaxonomy | null, profileId: number | null): number | null {
  const profile = findDirectionById(taxonomy?.directions ?? [], profileId);
  if (!profile) return null;
  return profile.subdirections.find(item => item.id === taxonomy?.defaultSubdirectionId)?.id ?? profile.subdirections[0]?.id ?? null;
}

/** 启动时的当前资料：上次选过且仍存在就用它，否则用全局默认具体方向所在的资料，再否则第一份。 */
export function initialProfileId(taxonomy: ContentTaxonomy | null, remembered: number | null): number | null {
  const directions = taxonomy?.directions ?? [];
  if (remembered && directions.some(item => item.id === remembered)) return remembered;
  return findSubdirectionById(directions, taxonomy?.defaultSubdirectionId)?.direction.id ?? directions[0]?.id ?? null;
}
