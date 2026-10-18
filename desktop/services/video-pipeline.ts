import type { VideoProject, VideoShot, VideoShotRole, VideoStage } from '../shared.ts';
import {
  VIDEO_SHOT_ROLES, contentHash, imageCoverage, isImageReady, isVoiceReady, normalizeRenderOptions, shotAudio, shotImage, voiceCoverage
} from './video-production.ts';

/**
 * 视频创作流水线：把一条视频任务映射成 8 个显式步骤。
 *
 * 纯函数，不做任何 IO：只根据项目字段推导每一步的状态、阻塞原因与导出门槛。
 * 口播脚本与分镜由模型产出（video-workflow.ts）；配音由 TTS 产出，镜头时长以真实音频为准；
 * 字幕从口播按句切分、画面帧与成片由本地确定性生成（video-compose.ts / video-render.ts）。
 */
export type VideoStepKey = 'topic' | 'script' | 'storyboard' | 'voice' | 'visuals' | 'render' | 'cover' | 'export';
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
  { key: 'script', label: '口播脚本', hint: '先定讲解结构和一句话结论，再写可直接开口的口播稿', stage: 'script' },
  { key: 'storyboard', label: '分镜', hint: '逐镜的作用、画面大字、口播与配图提示词', stage: 'storyboard' },
  { key: 'voice', label: '配音与字幕', hint: '逐镜配音，镜头时长以真实音频为准；字幕按句切分、每行不超过 14 字' },
  { key: 'visuals', label: '画面', hint: '选模板与配图方式，先看每镜一帧的预览再渲染' },
  { key: 'render', label: '成片', hint: '静帧 + 配音 + 背景音乐合成 1080×1920 的 MP4' },
  { key: 'cover', label: '封面', hint: '竖版封面：选本地图片或 AI 生成，导出时一起带走' },
  { key: 'export', label: '制作包', hint: '导出成片、脚本、分镜表、字幕与封面到知识库' }
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

const roleSet = new Set<string>(VIDEO_SHOT_ROLES.map(item => item.value));

/**
 * 分镜 JSON → 镜头数组。
 *
 * 容忍模型输出的常见偏差：缺字段、秒数写成字符串、镜头编号缺失、字段名用了近义词。
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
    const caption = String(record.caption ?? record.key_text ?? record.keyText ?? record.subtitle ?? record.on_screen ?? '').trim();
    if (!narration && !visual) return [];
    const rawIndex = Math.round(Number(record.index ?? record.no));
    const role = String(record.role ?? '').trim();
    return [{
      index: Number.isFinite(rawIndex) && rawIndex > 0 ? rawIndex : position + 1,
      seconds: clampSeconds(record.seconds ?? record.duration ?? record.duration_seconds, 5),
      visual,
      narration,
      caption,
      role: roleSet.has(role) ? role as VideoShotRole : '',
      imagePrompt: String(record.imagePrompt ?? record.image_prompt ?? '').trim()
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
  const totalMillis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

/* ── 字幕切句 ────────────────────────────────────────────────────
 * 参考 VideoLingo 的做法：字幕按长度上限切句，而不是一镜一整段塞满屏幕。
 * 中老年观众看字慢，每行上限 14 个汉字宽，字号才能放到 64px 以上。
 */
export const CAPTION_MAX_WIDTH = 14;

/** 显示宽度：汉字与全角符号算 1，ASCII 字母数字算 0.5。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) < 0x2e80 ? 0.5 : 1;
  return width;
}

const SENTENCE_END = /(?<=[。！？!?；;…\n])/;
const CLAUSE_END = /(?<=[，,、：:])/;
/** 行尾不保留的标点：字幕习惯用断行代替逗号句号；问号叹号保留语气。 */
const TRAILING = /[，,、。．.；;：:\s]+$/;

function hardSplit(text: string, max: number): string[] {
  const chars = Array.from(text);
  const parts = Math.ceil(displayWidth(text) / max);
  if (parts <= 1) return [text];
  // 均分而不是贪心切满：避免 14 + 1 这种只剩一个字的孤行。
  const target = displayWidth(text) / parts;
  const lines: string[] = [];
  let current = '';
  for (const char of chars) {
    if (current && displayWidth(current + char) > target + 0.5 && lines.length < parts - 1) {
      lines.push(current);
      current = '';
    }
    current += char;
  }
  if (current) lines.push(current);
  return lines;
}

export function splitCaptionLines(text: string, max = CAPTION_MAX_WIDTH): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!normalized) return [];
  const lines: string[] = [];
  for (const sentence of normalized.split(SENTENCE_END)) {
    const clean = sentence.replace(/\n/g, '').trim();
    if (!clean.replace(TRAILING, '')) continue;
    let current = '';
    const flush = () => {
      const line = current.replace(TRAILING, '').trim();
      if (line) lines.push(line);
      current = '';
    };
    for (const clause of clean.split(CLAUSE_END)) {
      if (!clause.trim()) continue;
      if (displayWidth((current + clause).replace(TRAILING, '')) <= max) {
        current += clause;
        continue;
      }
      flush();
      const bare = clause.replace(TRAILING, '');
      if (displayWidth(bare) <= max) current = clause;
      else lines.push(...hardSplit(bare, max));
    }
    flush();
  }
  return lines;
}

/* ── 时间轴 ─────────────────────────────────────────────────────
 * 参考 MoneyPrinterTurbo / Pixelle-Video / Hyperframes：镜头时长以真实配音为准，
 * 每镜之后留一小段气口；还没配音（或选了不配音）时用分镜估计的秒数。
 */
export const SHOT_GAP_SECONDS = 0.35;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 每镜实际时长；voiced 表示所有有口播的镜头都用上了真实配音时长。 */
export function shotDurations(project: VideoProject, shots: VideoShot[]): { seconds: number[]; voiced: boolean } {
  const useAudio = project.options.voiceMode === 'tts';
  let voiced = useAudio && shots.some(shot => shot.narration.trim());
  const seconds = shots.map(shot => {
    const audio = useAudio ? shotAudio(project, shot) : null;
    if (audio) return round3(audio.seconds + SHOT_GAP_SECONDS);
    if (shot.narration.trim()) voiced = false;
    return shot.seconds;
  });
  return { seconds, voiced };
}

export type VideoCaptionLine = { shot: number; text: string; start: number; end: number };
export type VideoTimeline = { shots: Array<{ start: number; end: number }>; lines: VideoCaptionLine[]; total: number };

/** 镜头内的字幕行按字数分配时长（句读处多给半个字的停顿），最后一行延续到镜头结束。 */
export function buildTimeline(shots: VideoShot[], seconds: number[]): VideoTimeline {
  let cursor = 0;
  const ranges: VideoTimeline['shots'] = [];
  const lines: VideoCaptionLine[] = [];
  shots.forEach((shot, position) => {
    const start = cursor;
    const end = round3(start + (seconds[position] ?? shot.seconds));
    ranges.push({ start, end });
    const texts = splitCaptionLines(shot.narration);
    const weights = texts.map(text => displayWidth(text) + 0.5);
    const sum = weights.reduce((total, weight) => total + weight, 0);
    let lineStart = start;
    texts.forEach((text, lineIndex) => {
      const lineEnd = lineIndex === texts.length - 1 ? end : round3(lineStart + (end - start) * weights[lineIndex] / sum);
      lines.push({ shot: position, text, start: lineStart, end: lineEnd });
      lineStart = lineEnd;
    });
    cursor = end;
  });
  return { shots: ranges, lines, total: cursor };
}

export function projectTimeline(project: VideoProject): VideoTimeline {
  const shots = parseVideoShots(project.storyboardJson);
  return buildTimeline(shots, shotDurations(project, shots).seconds);
}

/** 字幕行 → SRT。 */
export function buildSrt(lines: VideoCaptionLine[]): string {
  return lines.map((line, position) => `${position + 1}\n${srtTimecode(line.start)} --> ${srtTimecode(line.end)}\n${line.text}\n`).join('\n');
}

/**
 * 分镜口播是否覆盖了脚本：脚本按句拆开，看每句是否出现在拼起来的口播里。
 * 模型拆分镜时最常见的问题是漏句或改写，字幕和配音都从口播来，漏了就真的没了。
 */
export function narrationCoverage(script: string, shots: VideoShot[]): number {
  const strip = (text: string) => text.replace(/[\s，,。．.！!？?；;：:、“”"‘’'（）()《》【】\-—…]/g, '');
  const sentences = script.split(SENTENCE_END).map(strip).filter(Boolean);
  if (!sentences.length) return 1;
  const joined = strip(shots.map(shot => shot.narration).join(''));
  return sentences.filter(sentence => joined.includes(sentence)).length / sentences.length;
}

/** 渲染成片的签名：分镜、时长、配音键、配图键、模板和背景音乐都算进去，任何一项变了成片就过期。 */
export function renderSignature(project: VideoProject): string {
  const shots = parseVideoShots(project.storyboardJson);
  const timeline = buildTimeline(shots, shotDurations(project, shots).seconds);
  return signatureOf({
    kind: 'render',
    frame: frameSignatureInput(project, shots),
    lines: timeline.lines,
    audio: project.options.voiceMode === 'tts' ? shots.map(shot => shotAudio(project, shot)?.key ?? '') : [],
    bgm: project.options.bgmPath ? [project.options.bgmPath, project.options.bgmVolume] : null
  });
}

/** 预览帧的签名：只看画面（模板、标题、画面大字、配图、页脚），不看配音与音乐。 */
export function previewSignature(project: VideoProject): string {
  const shots = parseVideoShots(project.storyboardJson);
  return signatureOf({ kind: 'preview', frame: frameSignatureInput(project, shots), first: shots.map(shot => splitCaptionLines(shot.narration)[0] ?? '') });
}

/** 画面模板的版本：改了模板排版就加一，旧成片和预览随之标成过期。 */
export const FRAME_TEMPLATE_VERSION = 5;

function frameSignatureInput(project: VideoProject, shots: VideoShot[]) {
  const { template, imageMode, footer, ipId } = project.options;
  return {
    version: FRAME_TEMPLATE_VERSION,
    title: project.title.trim() || project.topic.trim(),
    template, imageMode, footer, ipId,
    shots: shots.map(shot => [shot.caption, shot.role ?? '']),
    images: imageMode === 'ai' ? shots.map(shot => shotImage(project, shot)?.key ?? '') : []
  };
}

function signatureOf(value: unknown): string {
  return contentHash(JSON.stringify(value));
}

export function isRenderFresh(project: VideoProject): boolean {
  return Boolean(project.assets.video) && project.assets.video!.signature === renderSignature(project);
}

export function isPreviewFresh(project: VideoProject): boolean {
  return Boolean(project.assets.preview) && project.assets.preview!.signature === previewSignature(project);
}

/** 导出前的检查清单：前两项是硬门槛，其余可选。 */
export function videoExportChecklist(project: VideoProject): Array<{ label: string; ok: boolean; optional?: boolean; detail: string }> {
  const shots = parseVideoShots(project.storyboardJson);
  const { seconds, voiced } = shotDurations(project, shots);
  const total = seconds.reduce((sum, value) => sum + value, 0);
  const target = project.durationSeconds;
  const drift = target > 0 ? Math.round((total - target) / target * 100) : 0;
  const coverage = shots.length ? narrationCoverage(project.script, shots) : 1;
  const video = project.assets.video;
  return [
    { label: '口播脚本已就绪', ok: Boolean(project.script.trim()), detail: project.script.trim() ? `约 ${project.script.replace(/\s/g, '').length} 字` : '先生成或填写口播脚本' },
    {
      label: '分镜已生成',
      ok: shots.length > 0,
      detail: shots.length
        ? `${shots.length} 个镜头 · 共 ${formatDuration(total)}${voiced ? '（按真实配音）' : '（估算）'}${target > 0 && Math.abs(drift) >= 30 ? `，与目标 ${formatDuration(target)} 相差 ${drift > 0 ? '+' : ''}${drift}%` : ''}${coverage < 0.8 ? `；口播只覆盖了脚本 ${Math.round(coverage * 100)}% 的句子` : ''}`
        : '先生成分镜，字幕与制作包都依赖它'
    },
    {
      label: '成片',
      ok: isRenderFresh(project),
      optional: true,
      detail: isRenderFresh(project) ? `${formatDuration(video!.seconds)} · ${video!.path}` : video ? '已过期：分镜、配音或画面改过，导出时不包含旧成片' : '可选：还没渲染成片，制作包里只有脚本、分镜表和字幕'
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
 * 配音、配图与成片是否过期不靠状态，而是靠素材账本的内容哈希（见 video-production.ts）。
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
  if (input.options !== undefined) patch.options = normalizeRenderOptions(input.options, project.options);
  return patch;
}

export function assertVideoExportable(project: VideoProject): void {
  if (!isVideoExportable(project)) {
    const missing = videoExportChecklist(project).filter(item => !item.ok && !item.optional).map(item => item.label);
    throw new Error(`还不能导出制作包：${missing.join('、')}`);
  }
}

/** 渲染成片前缺什么；空数组表示可以渲染。 */
export function renderBlockers(project: VideoProject): string[] {
  const shots = parseVideoShots(project.storyboardJson);
  if (!shots.length) return ['先生成分镜'];
  const blockers: string[] = [];
  if (!isVoiceReady(project, shots)) {
    const coverage = voiceCoverage(project, shots);
    blockers.push(coverage.ready ? `还有 ${coverage.needed - coverage.ready} 个镜头没配音或口播改过` : '先生成配音，或在「配音与字幕」里选择不配音');
  }
  if (!isImageReady(project, shots)) {
    const coverage = imageCoverage(project, shots);
    blockers.push(`AI 配图还差 ${coverage.needed - coverage.ready} 张，或改用纯文字卡片`);
  }
  return blockers;
}

export function buildVideoPipeline(project: VideoProject): VideoStep[] {
  const hasTitle = Boolean((project.title || project.topic).trim());
  const hasScript = Boolean(project.script.trim());
  const shots = parseVideoShots(project.storyboardJson);
  const hasShots = shots.length > 0;
  const confirmed = project.status === 'storyboard' || project.status === 'exported';
  // 导出过、且之后没有改过脚本或分镜（改动会把状态退回 script / storyboard）。
  const exported = Boolean(project.exportPath.trim()) && project.status === 'exported' && isVideoExportable(project);
  const voice = voiceCoverage(project, shots);
  const images = imageCoverage(project, shots);
  const voiceReady = hasShots && isVoiceReady(project, shots);
  const imageReady = hasShots && isImageReady(project, shots);
  const blockers = renderBlockers(project);

  const raw: Record<VideoStepKey, { done: boolean; locked: string; attention: string }> = {
    topic: { done: hasTitle, locked: '', attention: '' },
    script: { done: hasScript, locked: hasTitle ? '' : '先确定选题或填写标题', attention: '' },
    storyboard: {
      done: hasShots && confirmed,
      locked: hasScript ? '' : '先生成或填写口播脚本',
      // 脚本改过之后分镜还在，说明两者已经不同步；不锁死，只提示重做。
      attention: hasShots && !confirmed ? '脚本在分镜之后又改过，建议重新生成分镜' : ''
    },
    voice: {
      done: voiceReady,
      locked: hasShots ? '' : '先生成分镜',
      attention: !voiceReady && project.options.voiceMode === 'tts' && voice.stale > 0 && voice.ready > 0 ? `${voice.stale} 个镜头的口播改过，需要重新配音` : ''
    },
    visuals: {
      done: imageReady,
      locked: hasShots ? '' : '先生成分镜',
      attention: !imageReady && project.options.imageMode === 'ai' && images.stale > 0 && images.ready > 0 ? `${images.stale} 个镜头的配图提示词改过，需要重新配图` : ''
    },
    render: {
      done: isRenderFresh(project),
      locked: blockers.join('；'),
      attention: project.assets.video && !isRenderFresh(project) && !blockers.length ? '分镜、配音或画面改过，需要重新渲染成片' : ''
    },
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

/** 封面与成片是可选项，不计入进度分母，否则只要脚本分镜的视频永远到不了满格。 */
const OPTIONAL_STEPS = new Set<VideoStepKey>(['cover', 'render']);

export function videoPipelineProgress(project: VideoProject): { done: number; total: number } {
  const steps = buildVideoPipeline(project);
  return { done: steps.filter(step => step.state === 'done' && !OPTIONAL_STEPS.has(step.key)).length, total: steps.length - OPTIONAL_STEPS.size };
}

export function nextVideoStepKey(key: VideoStepKey): VideoStepKey | null {
  const index = VIDEO_STEPS.findIndex(step => step.key === key);
  return VIDEO_STEPS[index + 1]?.key ?? null;
}

/** 「自动生成」覆盖的阶段：定好标题后一次跑完脚本与分镜。配音、封面要花钱、导出要写知识库，都留给人确认。 */
export const AUTO_VIDEO_STAGES: VideoStage[] = ['script', 'storyboard'];

export type AutoVideoPlan = { ok: true; stages: VideoStage[] } | { ok: false; reason: string };

export function autoVideoPlan(project: VideoProject): AutoVideoPlan {
  if (!(project.title || project.topic).trim()) return { ok: false, reason: '请先在「选题」里选择或填写标题，再点自动生成' };
  return { ok: true, stages: AUTO_VIDEO_STAGES };
}
