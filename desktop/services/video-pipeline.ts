import type { VideoProject, VideoShot, VideoStage } from '../shared.ts';

/**
 * 视频创作流水线：把一条视频任务映射成 6 个显式步骤。
 *
 * 纯函数，不做任何 IO：只根据项目字段推导每一步的状态、阻塞原因与导出门槛。
 * 口播脚本与分镜由模型产出（video-workflow.ts），字幕与制作包由本地确定性生成
 * （video-export.ts）——所以「字幕」这一步在分镜落地后就算完成，不需要再调模型。
 */
export type VideoStepKey = 'topic' | 'script' | 'storyboard' | 'captions' | 'cover' | 'export';
export type VideoStepState = 'done' | 'current' | 'attention' | 'ready' | 'locked';
export type VideoStep = {
  key: VideoStepKey;
  index: number;
  label: string;
  hint: string;
  stage?: VideoStage;
  state: VideoStepState;
  /** locked 时说明缺什么；attention 时说明要处理什么。 */
  reason: string;
};

export const VIDEO_STEPS: Array<{ key: VideoStepKey; label: string; hint: string; stage?: VideoStage }> = [
  { key: 'topic', label: '选题', hint: '锁定平台、标题与目标时长，可让 AI 给出 5 个候选', stage: 'topics' },
  { key: 'script', label: '口播脚本', hint: '按选题生成可直接开拍的口播稿，可以自己改', stage: 'script' },
  { key: 'storyboard', label: '分镜', hint: '逐镜的画面、口播与时长；字幕和制作包都从这里推出来', stage: 'storyboard' },
  { key: 'captions', label: '字幕', hint: '按分镜时长自动排出 SRT，不需要再调模型' },
  { key: 'cover', label: '封面', hint: '竖版封面：选本地图片或 AI 生成，导出时一起带走' },
  { key: 'export', label: '制作包', hint: '导出脚本、分镜表、字幕与封面到知识库' }
];

export const VIDEO_PLATFORMS = [
  { value: 'douyin', label: '抖音' },
  { value: 'shipinhao', label: '视频号' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'bilibili', label: 'B 站' },
  { value: 'general', label: '通用' }
] as const;

export function videoPlatformLabel(value: string): string {
  return VIDEO_PLATFORMS.find(item => item.value === value)?.label ?? '通用';
}

/** 单个镜头时长上限；再长就不像一个短视频镜头，多半是模型把整段塞进了一镜。 */
export const MAX_SHOT_SECONDS = 60;
export const MIN_SHOT_SECONDS = 1;

function clampSeconds(value: unknown, fallback: number): number {
  const raw = Math.round(Number(value));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, raw));
}

/**
 * 分镜 JSON → 镜头数组。
 *
 * 容忍模型输出的常见偏差：缺字段、秒数写成字符串、镜头编号缺失。
 * 无法解析时返回空数组，由上层决定是提示重新生成还是当作「还没分镜」。
 */
export function parseVideoShots(value: string): VideoShot[] {
  if (!value.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : (parsed as { shots?: unknown } | null)?.shots;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item, position) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const narration = String(record.narration ?? record.script ?? record.voiceover ?? '').trim();
    const visual = String(record.visual ?? record.shot ?? record.picture ?? '').trim();
    const caption = String(record.caption ?? record.subtitle ?? record.on_screen ?? '').trim();
    if (!narration && !visual) return [];
    const rawIndex = Math.round(Number(record.index ?? record.no));
    return [{
      index: Number.isFinite(rawIndex) && rawIndex > 0 ? rawIndex : position + 1,
      seconds: clampSeconds(record.seconds ?? record.duration ?? record.duration_seconds, 5),
      visual,
      narration,
      caption
    }];
  });
}

/** 镜头数组 → 写入库里的规范 JSON。 */
export function serializeVideoShots(shots: VideoShot[]): string {
  return shots.length ? JSON.stringify({ shots }) : '';
}

export function shotsTotalSeconds(shots: VideoShot[]): number {
  return shots.reduce((total, shot) => total + shot.seconds, 0);
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** SRT 时间轴：`00:00:05,000`。 */
export function srtTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

/**
 * 由分镜生成 SRT：每镜一条字幕，时间从上一个镜头累加。
 * 字幕文本优先用 caption，没写就退回口播词——这样任何分镜都能出字幕。
 */
export function buildSrt(shots: VideoShot[]): string {
  let cursor = 0;
  const blocks = shots.map((shot, position) => {
    const text = (shot.caption || shot.narration).trim();
    if (!text) return '';
    const start = cursor;
    const end = start + shot.seconds;
    cursor = end;
    return `${position + 1}\n${srtTimecode(start)} --> ${srtTimecode(end)}\n${text}\n`;
  }).filter(Boolean);
  return blocks.join('\n');
}

/** 导出前必须过的两道门槛；封面与字幕都不阻塞导出。 */
export function videoExportChecklist(project: VideoProject): Array<{ label: string; ok: boolean; optional?: boolean; detail: string }> {
  const shots = parseVideoShots(project.storyboardJson);
  const total = shotsTotalSeconds(shots);
  const target = project.durationSeconds;
  const drift = target > 0 ? Math.round((total - target) / target * 100) : 0;
  return [
    { label: '口播脚本已就绪', ok: Boolean(project.script.trim()), detail: project.script.trim() ? `约 ${project.script.replace(/\s/g, '').length} 字` : '先生成或填写口播脚本' },
    {
      label: '分镜已生成',
      ok: shots.length > 0,
      detail: shots.length
        ? `${shots.length} 个镜头 · 共 ${formatDuration(total)}${target > 0 && Math.abs(drift) >= 30 ? `（与目标 ${formatDuration(target)} 相差 ${drift > 0 ? '+' : ''}${drift}%）` : ''}`
        : '先生成分镜，字幕与制作包都依赖它'
    },
    { label: '封面', ok: Boolean(project.coverPath), optional: true, detail: project.coverPath || '可选：未设置时制作包里不含封面图' }
  ];
}

export function isVideoExportable(project: VideoProject): boolean {
  return videoExportChecklist(project).filter(item => !item.optional).every(item => item.ok);
}

export function assertVideoStage(project: VideoProject, stage: VideoStage): void {
  if (!['topics', 'script', 'storyboard'].includes(stage)) throw new Error('未知的视频创作阶段');
  if (stage !== 'topics' && !(project.title || project.topic).trim()) throw new Error('请先确定选题或填写标题');
  if (stage === 'storyboard' && !project.script.trim()) throw new Error('请先生成或填写口播脚本');
}

/** 目标时长上限 10 分钟：再长的内容不该挤在一条短视频任务里。 */
export const MAX_VIDEO_SECONDS = 600;

/**
 * 界面提交的修改 → 数据库补丁。
 *
 * 只有脚本/分镜这类会改变产物的字段才动状态：它们一旦变化，
 * 之前的分镜与制作包就算过时（导出步骤会变成「需要重新导出」），
 * 而改标题、换平台、选封面都不影响已有产物。
 */
export function prepareVideoEdit(project: VideoProject, input: Partial<VideoProject>): Partial<VideoProject> {
  const patch: Partial<VideoProject> = {};
  for (const key of ['topic', 'title', 'audience', 'coverPath'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string') throw new Error('视频字段必须是文本');
    patch[key] = input[key];
  }
  if (input.platform !== undefined) {
    if (!VIDEO_PLATFORMS.some(item => item.value === input.platform)) throw new Error('未知的视频平台');
    patch.platform = input.platform;
  }
  if (input.durationSeconds !== undefined) {
    const seconds = Math.round(Number(input.durationSeconds));
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('目标时长必须是正数秒');
    patch.durationSeconds = Math.min(MAX_VIDEO_SECONDS, seconds);
  }
  if (input.script !== undefined) {
    if (typeof input.script !== 'string') throw new Error('视频字段必须是文本');
    patch.script = input.script;
    if (input.script !== project.script) patch.status = input.script.trim() ? 'script' : 'idea';
  }
  if (input.storyboardJson !== undefined) {
    if (typeof input.storyboardJson !== 'string') throw new Error('视频字段必须是文本');
    const shots = parseVideoShots(input.storyboardJson);
    // 手改 JSON 时最怕写错括号把整份分镜清空：非空内容解析不出镜头就当场拒绝，而不是静默存空。
    if (input.storyboardJson.trim() && !shots.length) throw new Error('分镜 JSON 无法解析或没有有效镜头，请检查格式后再保存');
    patch.storyboardJson = serializeVideoShots(shots);
    if (patch.storyboardJson !== project.storyboardJson) patch.status = shots.length ? 'storyboard' : 'script';
  }
  return patch;
}

export function assertVideoExportable(project: VideoProject): void {
  if (!isVideoExportable(project)) {
    const missing = videoExportChecklist(project).filter(item => !item.ok && !item.optional).map(item => item.label);
    throw new Error(`还不能导出制作包：${missing.join('、')}`);
  }
}

export function buildVideoPipeline(project: VideoProject): VideoStep[] {
  const hasTitle = Boolean((project.title || project.topic).trim());
  const hasScript = Boolean(project.script.trim());
  const shots = parseVideoShots(project.storyboardJson);
  const hasShots = shots.length > 0;
  const confirmed = project.status === 'storyboard' || project.status === 'exported';
  // 导出过、且之后没有改过脚本或分镜（改动会把状态退回 script / storyboard）。
  const exported = Boolean(project.exportPath.trim()) && project.status === 'exported' && isVideoExportable(project);

  const raw: Record<VideoStepKey, { done: boolean; locked: string; attention: string }> = {
    topic: { done: hasTitle, locked: '', attention: '' },
    script: { done: hasScript, locked: hasTitle ? '' : '先确定选题或填写标题', attention: '' },
    storyboard: {
      done: hasShots && confirmed,
      locked: hasScript ? '' : '先生成或填写口播脚本',
      // 脚本改过之后分镜还在，说明两者已经不同步；不锁死，只提示重做。
      attention: hasShots && !confirmed ? '脚本在分镜之后又改过，建议重新生成分镜' : ''
    },
    captions: { done: hasShots, locked: hasShots ? '' : '先生成分镜', attention: '' },
    cover: { done: Boolean(project.coverPath.trim()), locked: '', attention: '' },
    export: {
      done: exported,
      locked: isVideoExportable(project) ? '' : '先完成口播脚本与分镜',
      attention: Boolean(project.exportPath.trim()) && !exported ? '脚本或分镜已变化，需要重新导出制作包' : ''
    }
  };

  let currentAssigned = false;
  return VIDEO_STEPS.map((step, index) => {
    const info = raw[step.key];
    let state: VideoStepState;
    let reason = '';
    if (info.done) state = 'done';
    else if (info.attention) { state = 'attention'; reason = info.attention; }
    else if (info.locked) { state = 'locked'; reason = info.locked; }
    else state = 'ready';
    if (!currentAssigned && state === 'ready') { state = 'current'; currentAssigned = true; }
    return { ...step, index: index + 1, state, reason };
  });
}

/** 当前所处步骤：第一个未完成且可操作的步骤；全部完成则落在导出。 */
export function currentVideoStepKey(project: VideoProject): VideoStepKey {
  const steps = buildVideoPipeline(project);
  return (steps.find(step => step.state === 'current' || step.state === 'attention') ?? steps.find(step => step.state !== 'done') ?? steps[steps.length - 1]).key;
}

export function videoPipelineProgress(project: VideoProject): { done: number; total: number } {
  const steps = buildVideoPipeline(project);
  // 封面是可选项，不计入进度分母，否则一条完成的视频永远停在 5/6。
  return { done: steps.filter(step => step.state === 'done' && step.key !== 'cover').length, total: steps.length - 1 };
}

export function nextVideoStepKey(key: VideoStepKey): VideoStepKey | null {
  const index = VIDEO_STEPS.findIndex(step => step.key === key);
  return VIDEO_STEPS[index + 1]?.key ?? null;
}

/** 「自动生成」覆盖的阶段：定好标题后一次跑完脚本与分镜。封面要花钱、导出要写知识库，都留给人确认。 */
export const AUTO_VIDEO_STAGES: VideoStage[] = ['script', 'storyboard'];

export type AutoVideoPlan = { ok: true; stages: VideoStage[] } | { ok: false; reason: string };

export function autoVideoPlan(project: VideoProject): AutoVideoPlan {
  if (!(project.title || project.topic).trim()) return { ok: false, reason: '请先在「选题」里选择或填写标题，再点自动生成' };
  return { ok: true, stages: AUTO_VIDEO_STAGES };
}
