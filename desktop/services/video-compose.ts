import type { VideoRenderOptions, VideoShot, VideoShotRole, VideoTemplate } from '../shared.ts';
import { SHOT_GAP_SECONDS, displayWidth, type VideoTimeline } from './video-pipeline.ts';
import { contentHash } from './video-production.ts';

/**
 * 成片合成的纯函数：画面帧的 HTML 模板、镜头内动效、帧计划与 ffmpeg 参数。
 *
 * 画面用 HTML 模板排版再截图（参考 Pixelle-Video 的 HTML 帧模板、Hyperframes 的「写 HTML 出视频」），
 * 每一帧只由输入和时间决定，同样的输入永远渲染出同样的画面。
 * 版式按中老年观众定：标题 64px、字幕 66px、画面大字 72–120px，重要内容都在
 * 抖音 / 视频号底部信息栏（约 1540px 以下）之上。
 */

export const FRAME_WIDTH = 1080;
export const FRAME_HEIGHT = 1920;
export const VIDEO_FPS = 30;

type Palette = { bg: string; ink: string; accent: string; panel: string; track: string; muted: string };

const PALETTES: Record<VideoTemplate, Palette> = {
  warm: { bg: '#F3EBDD', ink: '#2B1E14', accent: '#B4472C', panel: '#FBF6EE', track: '#E2D5C3', muted: '#7D6B5B' },
  clean: { bg: '#FFFFFF', ink: '#17212B', accent: '#1C7A57', panel: '#EEF4F0', track: '#DCE5E0', muted: '#5E6C76' },
  night: { bg: '#111B2A', ink: '#F4EFE6', accent: '#F0B443', panel: '#1B2940', track: '#2A3A52', muted: '#9BA8B8' }
};

/* ── 镜头内动效 ──────────────────────────────────────────────────
 * 每一帧只由时间决定：给定时刻 t，motionAt 算出这一刻的动效参数，写成 <html> 上的 CSS 变量，
 * 样式表用 calc() 把变量换成透明度、缩放和字幕颜色。页面不跑脚本、不用 CSS 动画，同一时刻永远截出同一张图；
 * 需要随机的地方（配图推近的落点）用标题和镜头序号做种子。
 * 动效按中老年观众收着做：画面主体入场（淡入 + 由 92% 推近到 100%）、配图整镜缓慢推近 4%、
 * 进度条新的一格填满、字幕逐字变色；标题、页脚和卡片底色始终不动，不让整屏东西一起往外浮。
 */

/** 入场时长：大字、引导语、配图淡入推近，进度条填满，都在镜头开头这 0.6 秒里完成。 */
export const ENTER_SECONDS = 0.6;
/** 配图下方的大字比配图晚一点出来，先看图再看字。 */
const KEY_DELAY = 0.15;
/** 配图整镜推近的幅度。 */
export const PUSH_IN = 0.04;
/** 推近倍数按 1/800 取整：配图边缘每步最多挪 0.75px 看不出跳，相邻帧却常常完全相同，可以合并成一张静帧。 */
const PUSH_STEPS = 800;

export type FrameMotion = {
  /** 画面主体入场进度 0–1（已缓动）。 */
  enter: number;
  /** 配图下方大字的入场进度 0–1；纯文字卡片恒为 1。 */
  key: number;
  /** 进度条当前这一格的填充比例 0–1。 */
  bar: number;
  /** 配图的推近倍数，从 1 开始；纯文字卡片恒为 1。 */
  zoom: number;
  /** 字幕这一行已经读到第几个字（逐字高亮）；不配音时恒为 0。 */
  lit: number;
};

export type FramePlanOptions = {
  /** 字幕逐字高亮：只在有真实配音时开，不配音的视频没有可跟的语速。 */
  karaoke: boolean;
  /** 配图镜头整镜缓慢推近。 */
  pushIn: boolean;
  /**
   * 每镜配音里真正出声的区间（相对镜头开头的秒数），由渲染前对配音做静音检测得到；
   * 缺省或为 null 时按整镜减去末尾气口估计。系统语音句首、句尾各带一段静音，不扣掉的话高亮会落后声音大半秒。
   */
  speech?: Array<{ start: number; end: number } | null>;
};

export function framePlanOptions(options: Pick<VideoRenderOptions, 'voiceMode' | 'imageMode'>): FramePlanOptions {
  return { karaoke: options.voiceMode === 'tts', pushIn: options.imageMode === 'ai' };
}

/** 动效参数 → <html> 的 style 属性；截图时逐帧改写它。 */
export function motionStyle(motion: FrameMotion): string {
  return `--enter:${motion.enter};--key:${motion.key};--bar:${motion.bar};--zoom:${motion.zoom};--lit:${motion.lit}`;
}

function sameMotion(a: FrameMotion, b: FrameMotion): boolean {
  return a.enter === b.enter && a.key === b.key && a.bar === b.bar && a.zoom === b.zoom && a.lit === b.lit;
}

/** 缓出（三次方）：开头快、收尾慢，停下来时不顿。取三位小数，相邻帧比较时不受浮点误差影响。 */
function easeOut(progress: number): number {
  const x = Math.min(1, Math.max(0, progress));
  return Math.round((1 - (1 - x) ** 3) * 1000) / 1000;
}

/** 固定种子的伪随机数（mulberry32）：种子相同，序列永远相同。 */
export function seededRandom(seed: string): () => number {
  let state = Number.parseInt(contentHash(seed).slice(-8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 配图推近的落点：每镜不同、每次渲染相同；落在画面中部，推近时主体不会被推出画外。 */
export function pushOrigin(seed: string): string {
  const random = seededRandom(seed);
  return `${(35 + random() * 30).toFixed(1)}% ${(35 + random() * 25).toFixed(1)}%`;
}

const PAUSE_MARK = /[，,、。．.！!？?；;：:…—]/;
/** 停顿的长度，按「几个字」算：实测系统语音在逗号、句号处停 0.45 秒左右，约两个字的时间。 */
const PAUSE_WEIGHT = 2;

/**
 * 字幕逐字高亮的时刻：一镜的几行字在配音出声的 [start, end) 里按显示宽度分配，
 * 标点和行与行之间（切行时去掉了行尾标点）各算一次停顿。返回每行每个字亮起的时刻，第一个字在出声时亮起。
 * 没有逐字时间戳，按整镜匀速估计；整镜一起分配，比每行各自匀速更贴近真实语速。
 */
export function karaokeTimes(lines: string[], start: number, end: number): number[][] {
  const weights = lines.map(line => Array.from(line).map(char => (PAUSE_MARK.test(char) ? PAUSE_WEIGHT : displayWidth(char))));
  const total = weights.reduce((sum, line) => sum + line.reduce((a, b) => a + b, 0), 0) + PAUSE_WEIGHT * Math.max(0, lines.length - 1) || 1;
  let before = 0;
  return weights.map((line, index) => {
    if (index > 0) before += PAUSE_WEIGHT;
    return line.map(weight => {
      const at = round3(start + (end - start) * before / total);
      before += weight;
      return at;
    });
  });
}

export type MotionTiming = {
  shotStart: number; shotEnd: number; pushIn: boolean; litTimes: number[];
  /** 入场从哪一刻开始；缺省为镜头开头。片头第一镜提前到开头之前，第一帧就是完整画面。 */
  enterAt?: number;
};

/** 时刻 t 的动效参数：纯函数，只看镜头起止、是否推近和这一行每个字亮起的时刻。 */
export function motionAt(timing: MotionTiming, t: number): FrameMotion {
  const local = t - timing.shotStart;
  const entering = t - (timing.enterAt ?? timing.shotStart);
  const length = Math.max(timing.shotEnd - timing.shotStart, 1e-3);
  const push = timing.pushIn ? Math.round(PUSH_IN * PUSH_STEPS * Math.min(1, Math.max(0, local / length))) / PUSH_STEPS : 0;
  return {
    enter: easeOut(entering / ENTER_SECONDS),
    key: timing.pushIn ? easeOut((entering - KEY_DELAY) / (ENTER_SECONDS - KEY_DELAY)) : 1,
    bar: easeOut(entering / ENTER_SECONDS),
    zoom: Math.round((1 + push) * 100000) / 100000,
    lit: timing.litTimes.filter(at => at <= t + 1e-9).length
  };
}

/** 预览用的画面：入场已完成、推近到一半；有配音时亮一半字，能同时看到两种字幕颜色。 */
export function settledMotion(subtitle: string, options: FramePlanOptions): FrameMotion {
  return {
    enter: 1, key: 1, bar: 1,
    zoom: options.pushIn ? 1 + PUSH_IN / 2 : 1,
    lit: options.karaoke ? Math.ceil(Array.from(subtitle).length / 2) : 0
  };
}

export type FrameInput = {
  template: VideoTemplate;
  title: string;
  /** 画面大字；空串时纯文字卡片退回显示标题。 */
  keyText: string;
  /** 当前这一行字幕；空串表示这一帧没有口播。 */
  subtitle: string;
  /** 配图的 file:// 地址；空串表示纯文字卡片。 */
  imageUrl: string;
  shotNumber: number;
  shotCount: number;
  footer: string;
  /** 镜头作用：开场、结论、行动建议用实底强调色卡片，其余用浅色卡片，画面跟着讲解的节奏变。 */
  role: VideoShotRole | '';
  /** 画面大字上方的一行引导语（「为什么会这样」「第 2 步」），空串不显示。 */
  lead: string;
  /** 页面载入时的动效参数；之后逐帧改写 <html> 的 style。 */
  motion: FrameMotion;
  /**
   * IP 角色（在标题右侧，不压画面主体和字幕）；null 表示不带。不放头像和品牌名。
   * 图片是 file:// 地址，和配图一样由 loadFile 读取。
   */
  ip?: { heroUrl: string } | null;
};

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ROLE_LEADS: Record<VideoShotRole, string> = {
  hook: '',
  problem: '为什么会这样',
  concept: '先弄明白',
  step: '怎么做',
  evidence: '举个例子',
  takeaway: '记住这一点',
  cta: '提醒您'
};

/** 实底卡片的镜头：开场抓人、结论和提醒要压得住，其余镜头用浅色卡片。 */
const SOLID_ROLES = new Set<string>(['hook', 'takeaway', 'cta']);

/** 引导语：步骤镜头不止一个时编号（第 N 步），让观众知道讲到哪了。 */
export function frameLead(shots: VideoShot[], position: number): string {
  const role = shots[position]?.role;
  if (!role) return '';
  if (role === 'step') {
    const steps = shots.filter(shot => shot.role === 'step');
    if (steps.length > 1) return `第 ${steps.indexOf(shots[position]) + 1} 步`;
  }
  return ROLE_LEADS[role];
}

/** 卡片内文字可用宽度：卡片 900px 减去左右各 72px 内边距。 */
const CARD_TEXT_WIDTH = 756;

/**
 * 画面大字的字号：优先找一行放得下的最大字号（不小于 92px）；放不下就用多行大字，
 * 由 text-wrap: balance 均分各行，不会出现「记住三个半分 / 钟」这种单字孤行。
 */
export function cardFontSize(text: string): number {
  const width = Math.max(1, displayWidth(text));
  const lines = (size: number) => Math.ceil(width / Math.floor(CARD_TEXT_WIDTH / size));
  for (const size of [120, 104, 92]) if (lines(size) === 1) return size;
  for (const size of [120, 104, 92, 84, 72]) if (lines(size) <= (size >= 104 ? 2 : 3)) return size;
  return 64;
}

/** 字幕逐字包一层，每个字带序号 --i；样式表按 --lit 决定它是已读的强调色还是未读的正文色。 */
function karaokeMarkup(subtitle: string): string {
  return Array.from(subtitle).map((char, index) => `<span style="--i:${index}">${escapeHtml(char)}</span>`).join('');
}

/** 只在带 IP 角色时输出这段样式：不带 IP 的帧和以前逐字节相同。 */
const IP_HERO_CSS = `.ip-hero{position:absolute;right:60px;top:84px;width:220px;height:236px;object-fit:contain;object-position:right bottom}
.title{right:300px}`;

export function buildFrameHtml(input: FrameInput): string {
  const color = PALETTES[input.template] ?? PALETTES.warm;
  const hero = input.ip?.heroUrl ?? '';
  const title = escapeHtml(input.title.trim());
  const key = input.keyText.trim();
  const solid = SOLID_ROLES.has(input.role);
  const lead = input.lead.trim() ? `<span>${escapeHtml(input.lead.trim())}</span>` : '';
  // 已讲完的镜头点亮，当前镜头那一格随 --bar 从左往右填满。
  const progress = Array.from({ length: Math.max(1, input.shotCount) }, (_, index) => {
    const state = index < input.shotNumber - 1 ? 'on' : index === input.shotNumber - 1 ? 'now' : '';
    return `<i${state ? ` class="${state}"` : ''}></i>`;
  }).join('');
  const visual = input.imageUrl
    ? `<div class="visual"><img src="${escapeHtml(input.imageUrl)}" alt=""></div>${key ? `<div class="key">${escapeHtml(key)}</div>` : ''}`
    : `<div class="card${solid ? ' solid' : ''}">${lead}<p style="font-size:${cardFontSize(key || input.title)}px">${escapeHtml(key || input.title.trim())}</p></div>`;
  return `<!doctype html>
<html lang="zh-CN" style="${motionStyle(input.motion)}"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${FRAME_WIDTH}px;height:${FRAME_HEIGHT}px;overflow:hidden;background:${color.bg};color:${color.ink};font-family:"Microsoft YaHei","PingFang SC","Noto Sans SC","Source Han Sans SC",sans-serif}
.title{position:absolute;left:90px;right:90px;top:120px;height:180px;display:flex;align-items:flex-end;font-size:64px;line-height:1.35;font-weight:800;letter-spacing:2px;overflow:hidden;text-wrap:balance}
.progress{position:absolute;left:90px;right:90px;top:328px;height:10px;display:flex;gap:10px}
.progress i{position:relative;flex:1;border-radius:5px;overflow:hidden;background:${color.track}}
.progress i.on{background:${color.accent}}
.progress i.now::after{content:"";position:absolute;left:0;top:0;bottom:0;width:calc(var(--bar) * 100%);background:${color.accent}}
.visual{position:absolute;left:90px;top:380px;width:900px;height:700px;border-radius:28px;overflow:hidden;background:${color.panel}}
.visual img{display:block;width:100%;height:100%;object-fit:cover;opacity:var(--enter);transform:scale(var(--zoom));transform-origin:${pushOrigin(`${input.title}#${input.shotNumber}`)}}
.key{position:absolute;left:90px;right:90px;top:1100px;height:84px;font-size:64px;line-height:84px;font-weight:800;color:${color.accent};text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:min(1,calc(var(--key) * 1.6));transform:scale(calc(.92 + .08 * var(--key)))}
.card{position:absolute;left:90px;top:380px;width:900px;height:800px;padding:72px;border-radius:28px;background:${color.panel};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:36px}
.card span{font-size:44px;font-weight:700;letter-spacing:4px;color:${color.muted};opacity:min(1,calc(var(--enter) * 1.6))}
.card p{line-height:1.3;font-weight:800;text-align:center;color:${color.accent};overflow-wrap:anywhere;text-wrap:balance;opacity:min(1,calc(var(--enter) * 1.6));transform:scale(calc(.92 + .08 * var(--enter)))}
.card.solid{background:${color.accent}}
.card.solid span{color:${color.panel};opacity:min(.8,calc(var(--enter) * 1.3))}
.card.solid p{color:${color.panel}}
.subtitle{position:absolute;left:70px;right:70px;top:1220px;height:200px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:66px;line-height:1.35;font-weight:800}
.subtitle p{text-wrap:balance}
.subtitle span{color:color-mix(in srgb,${color.accent} calc(clamp(0,var(--lit) - var(--i),1) * 100%),${color.ink})}
.footer{position:absolute;left:90px;right:90px;top:1470px;font-size:32px;letter-spacing:2px;text-align:center;color:${color.muted}}
${hero ? IP_HERO_CSS : ''}
</style></head><body>
${hero ? `<img class="ip-hero" src="${escapeHtml(hero)}" alt="">` : ''}
<div class="title">${title}</div>
<div class="progress">${progress}</div>
${visual}
<div class="subtitle"><p>${karaokeMarkup(input.subtitle)}</p></div>
${input.footer.trim() ? `<div class="footer">${escapeHtml(input.footer.trim())}</div>` : ''}
</body></html>`;
}

export type FrameStill = { motion: FrameMotion; frames: number };
/** 一段画面：同一镜头、同一行字幕，排版一次 HTML；stills 是这一段里依次出现的静帧和各自持续的帧数。 */
export type FrameSegment = { shot: number; subtitle: string; stills: FrameStill[] };
export type FramePlan = { frames: number; segments: FrameSegment[] };

/**
 * 帧计划：按 30fps 的格子逐帧算出这一刻的画面（哪一段、动效参数），相邻帧画面完全相同就合并成一张静帧加帧数。
 * 结果是只在有动效的地方逐帧截图——镜头开头 0.6 秒入场、字幕每亮一个字、配图推近每走一步——
 * 其余时间一张静帧撑到底，60 秒的视频几百张图就够，而不是 1800 张。
 * 每行字幕一段，持续到下一行开始；没有口播的镜头整镜一段、不带字幕。
 */
export function buildFramePlan(shots: VideoShot[], timeline: VideoTimeline, options: FramePlanOptions): FramePlan {
  const parts = shots.flatMap((_, position) => {
    const range = timeline.shots[position];
    if (!range) return [];
    // 片头第一镜不做入场：第一帧常被平台当作预览图，不能是一张空卡片。
    const enterAt = position === 0 ? range.start - ENTER_SECONDS : range.start;
    const base = { shot: position, shotStart: range.start, shotEnd: range.end, enterAt, pushIn: options.pushIn };
    const lines = timeline.lines.filter(line => line.shot === position);
    if (!lines.length) return [{ ...base, subtitle: '', end: range.end, litTimes: [] as number[] }];
    // 出声区间：有静音检测结果就用它；没有时按整镜减去末尾气口估计。
    const speech = options.speech?.[position];
    const spoken = speech
      ? { start: range.start + speech.start, end: Math.min(range.end, range.start + speech.end) }
      : { start: range.start, end: range.end - Math.min(SHOT_GAP_SECONDS, (range.end - range.start) * 0.4) };
    const times = options.karaoke ? karaokeTimes(lines.map(line => line.text), spoken.start, spoken.end) : [];
    return lines.map((line, index) => ({ ...base, subtitle: line.text, end: line.end, litTimes: times[index] ?? [] }));
  });
  const total = Math.round(timeline.total * VIDEO_FPS);
  const segments: FrameSegment[] = parts.map(part => ({ shot: part.shot, subtitle: part.subtitle, stills: [] }));
  let current = 0;
  for (let frame = 0; frame < total && parts.length; frame += 1) {
    const t = frame / VIDEO_FPS;
    while (current < parts.length - 1 && t >= parts[current].end - 1e-9) current += 1;
    const motion = motionAt(parts[current], t);
    const stills = segments[current].stills;
    const last = stills[stills.length - 1];
    if (last && sameMotion(last.motion, motion)) last.frames += 1;
    else stills.push({ motion, frames: 1 });
  }
  return { frames: total, segments: segments.filter(segment => segment.stills.length) };
}

/** 计划里要截图的静帧张数（渲染耗时主要由它决定）。 */
export function framePlanStills(plan: FramePlan): number {
  return plan.segments.reduce((sum, segment) => sum + segment.stills.length, 0);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** ffconcat 里的路径用单引号包住；路径本身的单引号按 ffmpeg 规则写成 '\''。 */
function concatPath(file: string): string {
  return `'${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

/**
 * 静帧的 concat 清单。时长由帧数换成微秒：按累计帧数取整再相减，几百段 1/30 秒相加也不会漂移，
 * 每张静帧都正好落在 30fps 的格子上，口播和画面到片尾仍然对齐。
 * 最后一张要再写一遍：concat 分离器会忽略最后一项的 duration。
 */
export function buildConcatList(stills: Array<{ path: string; frames: number }>): string {
  if (!stills.length) throw new Error('没有可合成的画面帧');
  const lines = ['ffconcat version 1.0'];
  let elapsed = 0;
  let previous = 0;
  for (const still of stills) {
    elapsed += still.frames;
    const until = Math.round(elapsed * 1_000_000 / VIDEO_FPS);
    lines.push(`file ${concatPath(still.path)}`, `duration ${((until - previous) / 1_000_000).toFixed(6)}`);
    previous = until;
  }
  lines.push(`file ${concatPath(stills[stills.length - 1].path)}`);
  return `${lines.join('\n')}\n`;
}

export type ComposeInput = {
  /** 每镜一段口播：path 为空表示这一镜静音（选了不配音或这一镜没有口播）。 */
  narration: Array<{ path: string; seconds: number }>;
  bgm: { path: string; volume: number } | null;
  total: number;
  output: string;
};

const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';

/**
 * ffmpeg 参数：输入 0 是静帧清单，之后是各镜口播，最后是可选的背景音乐（循环到够长）。
 * 每镜口播补静音到镜头时长再首尾相接，保证声音和画面逐镜对齐；
 * 背景音乐按音量压低、结尾 2 秒淡出，用 normalize=0 混音，口播音量不被摊薄。
 */
export function buildFfmpegArgs(input: ComposeInput, listPath: string): string[] {
  if (!input.narration.length) throw new Error('没有可合成的镜头');
  const total = input.total.toFixed(3);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath];
  const graph = [`[0:v]fps=${VIDEO_FPS},scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:flags=lanczos,setsar=1,format=yuv420p[vout]`];
  let inputIndex = 1;
  input.narration.forEach((segment, position) => {
    const seconds = segment.seconds.toFixed(3);
    if (segment.path) {
      args.push('-i', segment.path);
      graph.push(`[${inputIndex}:a]aresample=44100,${AUDIO_FORMAT},apad=whole_dur=${seconds},atrim=end=${seconds},asetpts=N/SR/TB[n${position}]`);
      inputIndex += 1;
    } else {
      graph.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=end=${seconds},${AUDIO_FORMAT}[n${position}]`);
    }
  });
  graph.push(`${input.narration.map((_, position) => `[n${position}]`).join('')}concat=n=${input.narration.length}:v=0:a=1[nar]`);
  if (input.bgm) {
    args.push('-stream_loop', '-1', '-i', input.bgm.path);
    const fade = Math.min(2, input.total);
    graph.push(`[${inputIndex}:a]aresample=44100,${AUDIO_FORMAT},volume=${input.bgm.volume.toFixed(3)},atrim=end=${total},afade=t=out:st=${Math.max(0, input.total - fade).toFixed(3)}:d=${fade.toFixed(3)}[bg]`);
    graph.push('[nar][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]');
  } else {
    graph.push('[nar]anull[aout]');
  }
  args.push(
    '-filter_complex', graph.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(VIDEO_FPS), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart', '-t', total, input.output
  );
  return args;
}
