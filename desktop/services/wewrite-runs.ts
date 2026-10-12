import type { WeWriteRunDetail, WeWriteRunStatus, WeWriteRunSummary, WeWriteStepStatus, WeWriteTheme } from '../shared.ts';

/**
 * WeWrite 运行状态的纯映射层：把 CLI 的 JSON 转成前端类型。
 * 上游 schema 仍会演进，因此所有字段读取都按"可能缺失"处理，不假设形状。
 */

export const STEP_ORDER = ['topic', 'write', 'review', 'visual', 'publish'] as const;
export const STEP_LABELS: Record<string, string> = {
  topic: '选题',
  write: '任务书与初稿',
  review: '审稿',
  visual: '配图',
  publish: '排版与发布'
};

const RUN_STATUSES: WeWriteRunStatus[] = ['active', 'failed', 'completed'];
const STEP_STATUSES: WeWriteStepStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'skipped'];

type Raw = Record<string, unknown>;

function raw(value: unknown): Raw {
  return value && typeof value === 'object' ? value as Raw : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function normalizeRunStatus(value: unknown): WeWriteRunStatus {
  const candidate = text(value) as WeWriteRunStatus;
  return RUN_STATUSES.includes(candidate) ? candidate : 'active';
}

export function normalizeStepStatus(value: unknown): WeWriteStepStatus {
  const candidate = text(value) as WeWriteStepStatus;
  return STEP_STATUSES.includes(candidate) ? candidate : 'pending';
}

export function readSteps(value: unknown): Array<{ name: string; label: string; status: WeWriteStepStatus; updated: string }> {
  const source = raw(value);
  return STEP_ORDER.map(name => {
    const entry = raw(source[name]);
    return {
      name,
      label: STEP_LABELS[name] ?? name,
      status: normalizeStepStatus(entry.status),
      updated: text(entry.updated)
    };
  });
}

export function progressOf(steps: Array<{ status: WeWriteStepStatus }>): { completed: number; total: number } {
  return {
    completed: steps.filter(step => step.status === 'completed').length,
    total: steps.length
  };
}

/** 成稿优先于初稿：成稿才是可排版、可发布的那一份。 */
export function pickArticlePath(artifacts: unknown): string {
  const value = raw(artifacts);
  for (const key of ['article', 'draft']) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return '';
}

export function summarizeRun(state: unknown): WeWriteRunSummary {
  const source = raw(state);
  const runId = text(source.run_id);
  const steps = readSteps(source.steps);
  const provenance = raw(source.provenance);
  const permissions = raw(source.permissions);
  const artifacts = raw(source.artifacts);
  const article = pickArticlePath(artifacts);
  const preview = text(artifacts.preview);
  const topic = raw(source.topic);
  return {
    id: runId,
    title: text(topic.title) || '未命名任务',
    status: normalizeRunStatus(source.status),
    mode: text(source.mode) || 'draft',
    createdAt: text(source.created),
    updatedAt: text(source.updated),
    steps: Object.fromEntries(steps.map(step => [step.name, step.status])) as WeWriteRunSummary['steps'],
    completedSteps: progressOf(steps).completed,
    totalSteps: progressOf(steps).total,
    verifiedSourceCount: count(provenance.verified_sources),
    sourceCount: count(provenance.verified_sources) + count(provenance.unverified_sources),
    publishAllowed: permissions.publish === true,
    lastError: text(source.last_error),
    hasArticle: Boolean(article),
    hasPreview: Boolean(preview)
  };
}

export function describeRun(state: unknown): WeWriteRunDetail {
  const source = raw(state);
  const summary = summarizeRun(state);
  const artifacts = raw(source.artifacts);
  const topic = raw(source.topic);
  return {
    ...summary,
    keywords: Array.isArray(topic.keywords) ? topic.keywords.filter((item): item is string => typeof item === 'string') : [],
    framework: text(source.framework),
    persona: text(source.persona) || text(raw(source.provenance).persona),
    enhanceStrategy: text(source.enhance_strategy),
    wordCount: count(source.word_count),
    stepList: readSteps(source.steps),
    artifacts: Object.fromEntries(
      Object.entries(artifacts)
        .map(([key, value]) => [key, text(value)])
        .filter(([, value]) => Boolean(value))
    ) as Record<string, string>,
    // 仅用于界面展示，因此固定用正斜杠，避免 Windows 上出现反斜杠。
    runDirectory: summary.id ? `runs/${summary.id}` : ''
  };
}

/** `wewrite themes` 的文本输出：`  name  说明` 每行一条。 */
export function parseThemes(stdout: string): WeWriteTheme[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.match(/^\s{2}(\S+)\s{2,}(.+?)\s*$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map(match => ({ name: match[1], description: match[2] }));
}
