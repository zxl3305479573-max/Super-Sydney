import type { VideoAudioAsset, VideoImageAsset, VideoProject, VideoRenderAssets, VideoRenderOptions, VideoShot, VideoShotRole, VideoTtsSettings } from '../shared.ts';

/**
 * 成片相关的纯函数：渲染选项、素材账本、内容哈希与新鲜度。
 *
 * 配音和配图都按内容哈希登记（参考 Hyperframes 的素材账本、Toonflow 的按镜头登记素材）：
 * 改了某一镜的口播，只有这一镜的配音键变了，其它镜头原样复用，不重复花钱。
 * 渲染进程也要用这些函数判断步骤状态，所以不依赖 node:crypto 或文件系统——文件是否还在由主进程另查。
 */

export const VIDEO_TEMPLATES = [
  { value: 'warm', label: '暖米', hint: '米色底、深棕字，温和亲切' },
  { value: 'clean', label: '素白', hint: '白底、墨绿强调色，干净清楚' },
  { value: 'night', label: '深夜', hint: '深蓝底、暖黄强调色，对比最强' }
] as const;

export const VIDEO_SHOT_ROLES: Array<{ value: VideoShotRole; label: string }> = [
  { value: 'hook', label: '开场钩子' },
  { value: 'problem', label: '讲问题' },
  { value: 'concept', label: '讲概念' },
  { value: 'step', label: '步骤 / 要点' },
  { value: 'evidence', label: '证据 / 例子' },
  { value: 'takeaway', label: '结论' },
  { value: 'cta', label: '行动建议' }
];

export function shotRoleLabel(role: string | undefined): string {
  return VIDEO_SHOT_ROLES.find(item => item.value === role)?.label ?? '';
}

export const DEFAULT_VIDEO_FOOTER = '健康科普 · 不替代医生诊疗';

export const VIDEO_RENDER_DEFAULTS: VideoRenderOptions = {
  voiceMode: 'tts',
  template: 'warm',
  imageMode: 'none',
  bgmPath: '',
  bgmVolume: 12,
  footer: DEFAULT_VIDEO_FOOTER,
  ipId: ''
};

/** 合并补丁并校验；未知字段忽略。非法取值抛错，而不是悄悄换成默认值。 */
export function normalizeRenderOptions(input: unknown, base: VideoRenderOptions = VIDEO_RENDER_DEFAULTS): VideoRenderOptions {
  if (!input || typeof input !== 'object') return { ...base };
  const value = input as Partial<Record<keyof VideoRenderOptions, unknown>>;
  const next = { ...base };
  if (value.voiceMode !== undefined) {
    if (value.voiceMode !== 'tts' && value.voiceMode !== 'silent') throw new Error('未知的配音方式');
    next.voiceMode = value.voiceMode;
  }
  if (value.template !== undefined) {
    if (!VIDEO_TEMPLATES.some(item => item.value === value.template)) throw new Error('未知的画面模板');
    next.template = value.template as VideoRenderOptions['template'];
  }
  if (value.imageMode !== undefined) {
    if (value.imageMode !== 'none' && value.imageMode !== 'ai') throw new Error('未知的配图方式');
    next.imageMode = value.imageMode;
  }
  if (value.bgmPath !== undefined) {
    if (typeof value.bgmPath !== 'string') throw new Error('背景音乐路径必须是文本');
    next.bgmPath = value.bgmPath.trim();
  }
  if (value.bgmVolume !== undefined) {
    const volume = Math.round(Number(value.bgmVolume));
    if (!Number.isFinite(volume)) throw new Error('背景音乐音量必须是数字');
    next.bgmVolume = Math.min(100, Math.max(0, volume));
  }
  if (value.footer !== undefined) {
    if (typeof value.footer !== 'string') throw new Error('页脚必须是文本');
    next.footer = value.footer.replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  if (value.ipId !== undefined) {
    if (typeof value.ipId !== 'string') throw new Error('IP 编号必须是文本');
    next.ipId = value.ipId.trim().slice(0, 60);
  }
  return next;
}

/** 库里的 JSON → 渲染选项；缺失或损坏时用默认值（旧任务没有这一列）。 */
export function parseRenderOptions(json: string): VideoRenderOptions {
  try {
    return normalizeRenderOptions(json.trim() ? JSON.parse(json) : {});
  } catch {
    return { ...VIDEO_RENDER_DEFAULTS };
  }
}

export function emptyRenderAssets(): VideoRenderAssets {
  return { voiceProfile: '', audio: [], images: [], preview: null, video: null };
}

/** 账本由主进程写，但库文件可能被手改或来自旧版本：逐项校验，坏的条目直接丢掉。 */
export function parseRenderAssets(json: string): VideoRenderAssets {
  let raw: Record<string, unknown>;
  try {
    raw = json.trim() ? JSON.parse(json) as Record<string, unknown> : {};
  } catch {
    return emptyRenderAssets();
  }
  if (!raw || typeof raw !== 'object') return emptyRenderAssets();
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const list = (value: unknown) => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  const audio: VideoAudioAsset[] = list(raw.audio).flatMap(item => {
    const seconds = Number(item.seconds);
    return text(item.key) && text(item.path) && Number.isFinite(seconds) && seconds > 0 ? [{ key: text(item.key), path: text(item.path), seconds }] : [];
  });
  const images: VideoImageAsset[] = list(raw.images).flatMap(item => text(item.key) && text(item.path) ? [{ key: text(item.key), path: text(item.path) }] : []);
  const preview = raw.preview && typeof raw.preview === 'object' ? raw.preview as Record<string, unknown> : null;
  const video = raw.video && typeof raw.video === 'object' ? raw.video as Record<string, unknown> : null;
  const videoSeconds = Number(video?.seconds);
  return {
    voiceProfile: text(raw.voiceProfile),
    audio,
    images,
    preview: preview && text(preview.signature) && Array.isArray(preview.paths)
      ? { signature: text(preview.signature), paths: preview.paths.map(text) }
      : null,
    video: video && text(video.path) && text(video.signature) && Number.isFinite(videoSeconds)
      ? { path: text(video.path), signature: text(video.signature), seconds: videoSeconds, renderedAt: text(video.renderedAt) }
      : null
  };
}

/**
 * 内容哈希（cyrb53）：素材账本的键，不用于任何安全场景。
 * 渲染进程没有 node:crypto，这里用纯 JS 实现，主进程和界面算出来的键一致。
 */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * 声音参数快照：点「生成配音」时写进素材账本。之后补配缺失镜头仍按它合成，
 * 一条视频前后是同一个声音；改了全局设置要「全部重新配音」才会换。
 */
export type VoiceProfile =
  | { provider: 'system'; voice: string; rate: number }
  | { provider: 'openai'; baseUrl: string; model: string; voice: string; speed: number };

export function voiceProfileOf(settings: VideoTtsSettings): string {
  const profile: VoiceProfile = settings.provider === 'system'
    ? { provider: 'system', voice: settings.systemVoice, rate: settings.systemRate }
    : { provider: 'openai', baseUrl: settings.baseUrl, model: settings.model, voice: settings.voice, speed: settings.speed };
  return JSON.stringify(profile);
}

export function parseVoiceProfile(value: string): VoiceProfile | null {
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (raw?.provider === 'system') return { provider: 'system', voice: String(raw.voice ?? ''), rate: Number(raw.rate) || 0 };
    if (raw?.provider === 'openai' && typeof raw.baseUrl === 'string' && typeof raw.model === 'string') {
      return { provider: 'openai', baseUrl: raw.baseUrl, model: raw.model, voice: String(raw.voice ?? ''), speed: Number(raw.speed) || 1 };
    }
  } catch { /* 损坏的快照当作没有 */ }
  return null;
}

export function describeVoiceProfile(profile: VoiceProfile | null): string {
  if (!profile) return '未配音';
  if (profile.provider === 'system') return `系统语音 ${profile.voice || '（系统默认）'} · 语速 ${profile.rate > 0 ? '+' : ''}${profile.rate}`;
  return `${profile.model} · ${profile.voice} · ${profile.speed}×`;
}

/** 配音的键：声音参数 + 口播文本。口播为空的镜头不需要配音。 */
export function audioKey(voiceProfile: string, narration: string): string {
  return contentHash(`audio\n${voiceProfile}\n${narration.trim()}`);
}

/** 逐镜配图的尺寸：画面区接近方形，用各家接口都支持的 1024×1024。 */
export const SHOT_IMAGE_SIZE = '1024x1024';

/**
 * 逐镜配图的完整提示词：分镜给的 imagePrompt（没有就用画面描述）+ 固定的风格与禁忌。
 * 禁忌和封面一致：画面里不要文字（文字由模板排版）、不要医疗符号、不要夸大疗效。
 */
/**
 * 选了 IP 的视频，配图的键里带上 IP：换 IP 后旧配图自然算过期、会重新生成；
 * 没选 IP 时键和以前一样，已有配图不受影响。提示词本身不变，角色由参考图带进画面。
 */
export function shotImagePrompt(shot: VideoShot, title: string): string {
  const subject = (shot.imagePrompt || shot.visual || shot.caption || title).trim();
  return `竖版短视频配图，主题「${title.trim()}」。画面：${subject}。面向中老年观众，温暖写实、自然光、主体清楚、背景简洁；画面里不要出现任何文字、数字或标志，不要医疗器械特写，不要夸张表情或惊吓画面。`;
}

export function imageKey(prompt: string, ipId = ''): string {
  return contentHash(ipId ? `image\n${SHOT_IMAGE_SIZE}\nip:${ipId}\n${prompt}` : `image\n${SHOT_IMAGE_SIZE}\n${prompt}`);
}

function projectTitle(project: VideoProject): string {
  return project.title.trim() || project.topic.trim() || '健康科普';
}

/** 这一镜当前有效的配音（账本里键对得上）；口播为空或从没配过音时为 null。 */
export function shotAudio(project: VideoProject, shot: VideoShot): VideoAudioAsset | null {
  if (!shot.narration.trim() || !project.assets.voiceProfile) return null;
  const key = audioKey(project.assets.voiceProfile, shot.narration);
  return project.assets.audio.find(item => item.key === key) ?? null;
}

export function shotImage(project: VideoProject, shot: VideoShot): VideoImageAsset | null {
  const key = imageKey(shotImagePrompt(shot, projectTitle(project)), project.options.ipId);
  return project.assets.images.find(item => item.key === key) ?? null;
}

export type CoverageSummary = { needed: number; ready: number; stale: number };

/**
 * 配音覆盖情况：needed 是有口播的镜头数，ready 是配音键对得上的，
 * stale 是「配过音但口播又改了」——这时提示重配而不是当作从没配过。
 */
export function voiceCoverage(project: VideoProject, shots: VideoShot[]): CoverageSummary {
  const speaking = shots.filter(shot => shot.narration.trim());
  const ready = speaking.filter(shot => shotAudio(project, shot)).length;
  const missing = speaking.length - ready;
  return { needed: speaking.length, ready, stale: project.assets.audio.length ? missing : 0 };
}

export function imageCoverage(project: VideoProject, shots: VideoShot[]): CoverageSummary {
  const ready = shots.filter(shot => shotImage(project, shot)).length;
  return { needed: shots.length, ready, stale: project.assets.images.length ? shots.length - ready : 0 };
}

/** 配音这一步是否已经满足渲染条件：选了不配音，或者每个有口播的镜头都有对得上的配音。 */
export function isVoiceReady(project: VideoProject, shots: VideoShot[]): boolean {
  if (project.options.voiceMode === 'silent') return true;
  const coverage = voiceCoverage(project, shots);
  return coverage.needed > 0 && coverage.ready === coverage.needed;
}

export function isImageReady(project: VideoProject, shots: VideoShot[]): boolean {
  if (project.options.imageMode === 'none') return true;
  const coverage = imageCoverage(project, shots);
  return coverage.needed > 0 && coverage.ready === coverage.needed;
}
