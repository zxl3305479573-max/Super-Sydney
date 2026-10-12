import type { ContentStage, ContentTask } from '../shared.ts';

export function prepareContentEdit(task: ContentTask, input: Partial<ContentTask>): Partial<ContentTask> {
  const patch: Partial<ContentTask> = {};
  for (const key of ['topic', 'title', 'draft', 'sourcesJson'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new Error('文章字段必须是文本');
      Object.assign(patch, { [key]: input[key] });
    }
  }
  // 分类只影响写作方向，同样会让已有审稿结论失效（换了方向就该重新审）。
  for (const key of ['directionId', 'subdirectionId'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (value !== null && (!Number.isInteger(value) || value <= 0)) throw new Error('内容方向取值不正确');
    Object.assign(patch, { [key]: value });
  }
  const changed = Object.entries(patch).some(([key, value]) => task[key as keyof ContentTask] !== value);
  if (changed) Object.assign(patch, { finalArticle: '', reviewJson: '', status: task.draft || patch.draft ? 'draft' : 'idea' });
  // 排版主题只影响展示，不改变内容，所以放在失效判断之后：换主题不必重新审稿。
  if (input.theme !== undefined) {
    if (typeof input.theme !== 'string') throw new Error('文章字段必须是文本');
    patch.theme = input.theme;
  }
  return patch;
}

export function assertContentStage(task: ContentTask, stage: ContentStage): void {
  if (!['topics', 'brief', 'claims', 'draft', 'review', 'revise'].includes(stage)) throw new Error('未知的创作阶段');
  if (stage !== 'topics' && !(task.title || task.topic).trim()) throw new Error('请先选择选题或填写标题');
  if (stage === 'draft' && !task.briefJson.trim()) throw new Error('请先生成文章任务书');
  if ((stage === 'review' || stage === 'revise') && !task.draft.trim()) throw new Error('请先生成或填写初稿');
  if (stage === 'revise' && !task.reviewJson.trim()) throw new Error('请先执行 AI 审稿，再按审稿意见修改');
}

/** 审稿门槛是否满足：结论 pass、成稿非空且与初稿一致、状态已是成稿/已推送。 */
export function isContentPublishable(task: ContentTask): boolean {
  let review: { decision?: string } = {};
  try { review = JSON.parse(task.reviewJson); } catch { /* 未通过审稿 */ }
  return review.decision === 'pass' && Boolean(task.finalArticle.trim()) && task.finalArticle === task.draft && ['ready', 'published'].includes(task.status);
}

export function assertContentPublishable(task: ContentTask): void {
  if (!isContentPublishable(task)) throw new Error('请先对当前正文完成审稿并通过，修改正文后需要重新审稿');
}

export type ContentDeliveryOptions = { allowUnreviewed?: boolean };

/**
 * 交付（导出 / 推送草稿箱）用的正文。
 *
 * 审稿通过时取成稿；用户显式选择「未通过审稿也交付」时退回当前初稿，
 * 因为这时 finalArticle 还是空的。
 */
export function deliverableArticle(task: ContentTask, allowUnreviewed = false): string {
  return (allowUnreviewed ? task.finalArticle.trim() || task.draft : task.finalArticle).trim();
}

/**
 * 交付的底线：必须有正文。
 *
 * 默认仍要求审稿通过且成稿与初稿一致；只有用户在界面上二次确认「未经审稿直接交付」
 * 时才走 allowUnreviewed 分支——审核意见这时只是建议，不再是硬门槛。
 */
export function assertContentDeliverable(task: ContentTask, options: ContentDeliveryOptions = {}): void {
  if (!options.allowUnreviewed) { assertContentPublishable(task); return; }
  if (!deliverableArticle(task, true)) throw new Error('这篇文章还没有正文，请先生成或填写内容');
}
