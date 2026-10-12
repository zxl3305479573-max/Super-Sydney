import type { ContentStage, ContentTask } from '../shared.ts';

/**
 * 公众号创作流水线：把一篇文章任务映射成 7 个显式步骤。
 * 纯函数，只根据任务字段推导每一步的状态与阻塞原因，不做任何 IO，
 * 门槛规则与 content-policy.ts（assertContentStage / assertContentPublishable）保持一致。
 */
export type PipelineStepKey = 'topic' | 'brief' | 'evidence' | 'draft' | 'review' | 'cover' | 'publish';
export type PipelineStepState = 'done' | 'current' | 'attention' | 'ready' | 'locked';
export type PipelineStep = {
  key: PipelineStepKey;
  index: number;
  label: string;
  hint: string;
  stage?: ContentStage;
  state: PipelineStepState;
  /** locked 时说明缺什么；attention 时说明要处理什么。 */
  reason: string;
};
export type PipelineEnv = { wechatConfigured: boolean };

export const PIPELINE_STEPS: Array<{ key: PipelineStepKey; label: string; hint: string; stage?: ContentStage }> = [
  { key: 'topic', label: '选题', hint: '确定类别与读者问题，可让 AI 给出 5 个候选', stage: 'topics' },
  { key: 'brief', label: '任务书', hint: '目标读者、核心主张、章节结构与边界', stage: 'brief' },
  { key: 'evidence', label: '来源与证据', hint: '补充来源资料，列出待核实主张', stage: 'claims' },
  { key: 'draft', label: '初稿', hint: '按任务书生成正文，可直接编辑与预览', stage: 'draft' },
  { key: 'review', label: 'AI 审稿', hint: '表达、逻辑与健康风险把关，通过才可发布', stage: 'review' },
  { key: 'cover', label: '封面', hint: '选择本地图片或 AI 生成封面' },
  { key: 'publish', label: '导出与发布', hint: '导出到 Obsidian，或人工确认后推送草稿箱' }
];

function reviewDecision(task: ContentTask): string {
  try { return String((JSON.parse(task.reviewJson || '{}') as { decision?: unknown }).decision ?? ''); } catch { return ''; }
}

export function isReviewPassed(task: ContentTask): boolean {
  return Boolean(task.finalArticle.trim()) && task.finalArticle === task.draft && ['ready', 'published'].includes(task.status);
}

/** 推送前的硬门槛清单，界面逐项展示。 */
export function publishChecklist(task: ContentTask, env: PipelineEnv): Array<{ label: string; ok: boolean; detail: string }> {
  const hasBody = Boolean((task.finalArticle.trim() || task.draft).trim());
  const passed = isReviewPassed(task);
  return [
    {
      label: '正文已就绪',
      ok: hasBody,
      detail: !hasBody ? '先生成或填写正文'
        : passed ? '审稿通过，成稿与当前正文一致'
        : '审稿未通过；仍可直接推送草稿箱，建议先按审稿意见修改'
    },
    { label: '已设置封面', ok: Boolean(task.coverPath), detail: task.coverPath || '在「封面」步骤选择或生成' },
    { label: '公众号凭证已配置', ok: env.wechatConfigured, detail: env.wechatConfigured ? 'AppID / AppSecret 已就绪' : '在「环境与配置」填写 AppID 与 AppSecret（仅推送需要）' }
  ];
}

/**
 * 审稿未通过时还挂着的问题，用于「未经审稿直接交付」前的确认文案。
 * 只做概括，不复制审稿原文，避免弹窗过长。
 */
export function reviewOutstanding(task: ContentTask): string[] {
  if (!task.reviewJson.trim()) return ['还没有执行 AI 审稿'];
  let review: Record<string, unknown>;
  try { review = JSON.parse(task.reviewJson) as Record<string, unknown>; } catch { return ['审稿结论无法解析，建议重新审稿']; }
  const items: string[] = [];
  const decision = String(review.decision ?? '');
  if (decision !== 'pass') items.push(`审稿结论：${decision === 'reject' ? '不通过' : decision === 'revise' ? '需修改' : '未知'}`);
  for (const [key, label] of [['required_changes', '必须修改'], ['health_risks', '健康风险'], ['unsupported_claims', '缺乏依据的主张']] as const) {
    const value = review[key];
    if (Array.isArray(value) && value.length) items.push(`${label} ${value.length} 条`);
  }
  if (task.finalArticle.trim() && task.finalArticle !== task.draft) items.push('正文在审稿之后又被修改过');
  return items;
}

export function buildPipeline(task: ContentTask, env: PipelineEnv): PipelineStep[] {
  const hasTopic = Boolean((task.title || task.topic).trim());
  const hasDraft = Boolean(task.draft.trim());
  const passed = isReviewPassed(task);
  const decision = reviewDecision(task);
  const hasBody = Boolean((task.finalArticle.trim() || task.draft).trim());
  // 推送草稿箱是对外动作，发生了就算完成；导出只是快照，正文改动后需要重新审稿才算完成。
  const published = Boolean(task.publishJson.trim()) || (Boolean(task.exportPath.trim()) && passed);

  const raw: Record<PipelineStepKey, { done: boolean; locked: string; attention: string }> = {
    topic: { done: hasTopic, locked: '', attention: '' },
    brief: { done: Boolean(task.briefJson.trim()), locked: hasTopic ? '' : '先确定选题或填写标题', attention: '' },
    evidence: { done: Boolean(task.claimsJson.trim()), locked: hasTopic ? '' : '先确定选题或填写标题', attention: '' },
    draft: { done: hasDraft, locked: task.briefJson.trim() ? '' : '先生成文章任务书', attention: '' },
    review: {
      done: passed,
      locked: hasDraft ? '' : '先生成或填写初稿',
      attention: !passed && task.reviewJson.trim() && (decision === 'revise' || decision === 'reject') ? (decision === 'reject' ? '审稿不通过，建议重写' : '审稿要求修改，改完后重新审稿') : ''
    },
    cover: { done: Boolean(task.coverPath), locked: '', attention: '' },
    publish: {
      done: published,
      locked: hasBody ? '' : '先生成或填写正文',
      attention: hasBody && !passed ? '审稿未通过：可以直接推送草稿箱，建议先按审稿意见修改' : ''
    }
  };

  let currentAssigned = false;
  return PIPELINE_STEPS.map((step, index) => {
    const info = raw[step.key];
    let state: PipelineStepState;
    let reason = '';
    if (info.done) state = 'done';
    else if (info.attention) { state = 'attention'; reason = info.attention; }
    else if (info.locked) { state = 'locked'; reason = info.locked; }
    else state = 'ready';
    if (!currentAssigned && state !== 'done' && state !== 'locked') { if (state === 'ready') state = 'current'; currentAssigned = true; }
    if (step.key === 'publish' && state !== 'locked' && !info.done) {
      const missing = publishChecklist(task, env).filter(item => !item.ok).map(item => item.label);
      if (missing.length) reason = `推送还缺：${missing.join('、')}`;
    }
    return { ...step, index: index + 1, state, reason };
  });
}

/** 任务当前所处步骤：第一个未完成且可操作的步骤；全部完成则落在发布。 */
export function currentStepKey(task: ContentTask, env: PipelineEnv): PipelineStepKey {
  const steps = buildPipeline(task, env);
  return (steps.find(step => step.state === 'current' || step.state === 'attention') ?? steps.find(step => step.state !== 'done') ?? steps[steps.length - 1]).key;
}

export function pipelineProgress(task: ContentTask, env: PipelineEnv): { done: number; total: number } {
  const steps = buildPipeline(task, env);
  return { done: steps.filter(step => step.state === 'done').length, total: steps.length };
}

export function nextStepKey(key: PipelineStepKey): PipelineStepKey | null {
  const index = PIPELINE_STEPS.findIndex(step => step.key === key);
  return PIPELINE_STEPS[index + 1]?.key ?? null;
}

/**
 * 「自动生成」覆盖的阶段：选好标题后一次跑完的 LLM 步骤。
 *
 * 封面、导出与推送不在其中——生成封面上传图片 API 费用、导出会写知识库、
 * 推送是对真实公众号的外部操作，都必须由人先确认。
 */
export const AUTO_GENERATE_STAGES: ContentStage[] = ['brief', 'claims', 'draft', 'review'];

export type AutoGeneratePlan = { ok: true; stages: ContentStage[] } | { ok: false; reason: string };

/** 自动生成的前置条件：必须先有标题，后续阶段才有确定的写作对象。 */
export function autoGeneratePlan(task: ContentTask): AutoGeneratePlan {
  if (!task.title.trim()) return { ok: false, reason: '请先在「选题」里选择或填写标题，再点自动生成' };
  return { ok: true, stages: AUTO_GENERATE_STAGES };
}
