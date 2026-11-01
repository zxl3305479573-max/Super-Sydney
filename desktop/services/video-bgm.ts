import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUTO_BGM_TEMPLATE_VERSION, type ResolvedVideoBgmStyle } from '../shared.ts';

/**
 * 离线原创 BGM。
 *
 * 首次渲染时在本地合成一段可循环的背景音乐，不访问曲库、不依赖登录，
 * 也不会把第三方音乐混进交付文件。文件名带模板版本；升级编曲后旧成片会自然过期。
 */

const SAMPLE_RATE = 44_100;
const DURATION_SECONDS = 16;

type Arrangement = {
  bpm: number;
  chords: number[][];
  padWeight: number;
  padDetune: number;
  arpSubdivision: number;
  arpOctave: number;
  arpWeight: number;
  arpDecay: number;
  bassWeight: number;
  bassDecay: number;
  kickWeight: number;
  kickPitch: number;
  clapWeight: number;
  hatWeight: number;
  shimmerWeight: number;
};

/**
 * 所有 BPM 都取 15 的倍数，16 秒里正好容纳整数个小节与拍子，循环点不会切在半拍上。
 * 四种编曲共享同一个合成器，但和声、密度和打击乐各不相同。
 */
const ARRANGEMENTS: Record<ResolvedVideoBgmStyle, Arrangement> = {
  tech: {
    bpm: 120,
    chords: [
      [261.63, 329.63, 392.0, 493.88],
      [220.0, 261.63, 329.63, 392.0],
      [174.61, 220.0, 261.63, 329.63],
      [196.0, 246.94, 293.66, 392.0]
    ],
    padWeight: 0.022, padDetune: 0.003,
    arpSubdivision: 0.5, arpOctave: 2, arpWeight: 0.085, arpDecay: 9,
    bassWeight: 0.13, bassDecay: 4.2,
    kickWeight: 0.22, kickPitch: 52, clapWeight: 0.09, hatWeight: 0.032, shimmerWeight: 0
  },
  uplifting: {
    bpm: 135,
    chords: [
      [261.63, 329.63, 392.0, 523.25],
      [196.0, 246.94, 293.66, 392.0],
      [220.0, 261.63, 329.63, 440.0],
      [174.61, 220.0, 261.63, 349.23]
    ],
    padWeight: 0.019, padDetune: 0.002,
    arpSubdivision: 0.5, arpOctave: 2, arpWeight: 0.078, arpDecay: 8,
    bassWeight: 0.11, bassDecay: 4.6,
    kickWeight: 0.18, kickPitch: 64, clapWeight: 0.1, hatWeight: 0.035, shimmerWeight: 0.008
  },
  calm: {
    bpm: 75,
    chords: [
      [174.61, 220.0, 261.63, 349.23],
      [130.81, 196.0, 261.63, 329.63],
      [146.83, 220.0, 293.66, 349.23],
      [116.54, 174.61, 233.08, 293.66]
    ],
    padWeight: 0.03, padDetune: 0.0015,
    arpSubdivision: 1, arpOctave: 1, arpWeight: 0.055, arpDecay: 3.5,
    bassWeight: 0.06, bassDecay: 2.5,
    kickWeight: 0, kickPitch: 0, clapWeight: 0, hatWeight: 0.006, shimmerWeight: 0.012
  },
  cinematic: {
    bpm: 90,
    chords: [
      [146.83, 174.61, 220.0, 293.66],
      [116.54, 146.83, 174.61, 233.08],
      [174.61, 220.0, 261.63, 349.23],
      [130.81, 164.81, 196.0, 261.63]
    ],
    padWeight: 0.028, padDetune: 0.004,
    arpSubdivision: 1, arpOctave: 1, arpWeight: 0.045, arpDecay: 2.8,
    bassWeight: 0.11, bassDecay: 2.5,
    kickWeight: 0.14, kickPitch: 44, clapWeight: 0, hatWeight: 0.01, shimmerWeight: 0.015
  }
};

function seededNoise(seed: number): number {
  let state = seed >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return ((state >>> 0) / 0xffffffff) * 2 - 1;
}

function note(chord: number[], step: number): number {
  return chord[step % chord.length];
}

/** 返回 16 位、44.1kHz、立体声 WAV。纯函数，同一曲风每次输出完全相同。 */
export function synthesizeAutoBgmWav(style: ResolvedVideoBgmStyle = 'tech'): Buffer {
  const arrangement = ARRANGEMENTS[style];
  const beatSeconds = 60 / arrangement.bpm;
  const barSeconds = beatSeconds * 4;
  const arpSeconds = beatSeconds * arrangement.arpSubdivision;
  const frames = Math.round(SAMPLE_RATE * DURATION_SECONDS);
  const channels = 2;
  const dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);

  const mixed = new Float32Array(frames * channels);

  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / SAMPLE_RATE;
    const chord = arrangement.chords[Math.floor(time / barSeconds) % arrangement.chords.length];
    const beat = time / beatSeconds;
    const beatPhase = (beat % 1) * beatSeconds;
    const subdivisionPhase = time % arpSeconds;
    const arpStep = Math.floor(time / arpSeconds);

    // 柔和和弦垫：左右各轻微失谐，避免整首听起来像单声道测试音。
    let left = 0;
    let right = 0;
    for (const [index, frequency] of chord.entries()) {
      const weight = arrangement.padWeight / (index + 1);
      left += Math.sin(2 * Math.PI * frequency * (1 - arrangement.padDetune) * time) * weight;
      right += Math.sin(2 * Math.PI * frequency * (1 + arrangement.padDetune) * time) * weight;
    }

    // 拨弦轮流落在左右声道；舒缓与电影曲风改用四分音符，给口播留空间。
    const pluckFrequency = note(chord, arpStep) * arrangement.arpOctave;
    const pluckEnvelope = Math.min(1, subdivisionPhase / 0.012) * Math.exp(-arrangement.arpDecay * subdivisionPhase);
    const pluck = Math.sin(2 * Math.PI * pluckFrequency * time) * pluckEnvelope * arrangement.arpWeight;
    if (arpStep % 2 === 0) left += pluck * 1.15;
    else right += pluck * 1.15;

    // 低音托住和声；是否加打击乐由曲风决定，旁白闪避在 FFmpeg 混音阶段处理。
    const bassEnvelope = Math.min(1, beatPhase / 0.015) * Math.exp(-arrangement.bassDecay * beatPhase);
    const bass = Math.sin(2 * Math.PI * (chord[0] / 2) * time) * bassEnvelope * arrangement.bassWeight;
    left += bass;
    right += bass;

    const beatIndex = Math.floor(beat) % 4;
    if (arrangement.kickWeight > 0 && (beatIndex === 0 || beatIndex === 2)) {
      const kick = Math.sin(2 * Math.PI * (arrangement.kickPitch + 78 * Math.exp(-22 * beatPhase)) * beatPhase)
        * Math.exp(-16 * beatPhase) * arrangement.kickWeight;
      left += kick;
      right += kick;
    }
    if (arrangement.clapWeight > 0 && (beatIndex === 1 || beatIndex === 3)) {
      const clap = seededNoise(frame * 17 + beatIndex) * Math.exp(-24 * beatPhase) * arrangement.clapWeight;
      left += clap;
      right += clap * 0.92;
    }

    const hatEnvelope = Math.exp(-55 * subdivisionPhase);
    const hat = seededNoise(frame * 31 + arpStep) * hatEnvelope * arrangement.hatWeight;
    left += hat * (arpStep % 2 ? 0.7 : 1);
    right += hat * (arpStep % 2 ? 1 : 0.7);

    if (arrangement.shimmerWeight > 0) {
      const shimmerFrequency = chord[chord.length - 1] * 4;
      const shimmer = Math.sin(2 * Math.PI * shimmerFrequency * time) * arrangement.shimmerWeight
        * (0.55 + 0.45 * Math.sin(2 * Math.PI * time / barSeconds));
      left += shimmer * 0.72;
      right += shimmer;
    }

    // 循环点只做 20ms 防爆音处理；实际片头和片尾淡入淡出由 FFmpeg 统一控制。
    const fade = Math.min(1, time / 0.02, (DURATION_SECONDS - time) / 0.02);
    mixed[frame * 2] = left * fade;
    mixed[frame * 2 + 1] = right * fade;
  }

  let peak = 0;
  for (const value of mixed) peak = Math.max(peak, Math.abs(value));
  const gain = peak > 0 ? 0.88 / peak : 1;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, mixed[frame * channels + channel] * gain));
      wav.writeInt16LE(Math.round(sample * 32767), 44 + (frame * channels + channel) * 2);
    }
  }
  return wav;
}

export function autoBgmPath(dataDir: string, style: ResolvedVideoBgmStyle = 'tech'): string {
  return path.join(dataDir, 'video-bgm', `auto-${style}-${AUTO_BGM_TEMPLATE_VERSION}.wav`);
}

export function ensureAutoBgm(dataDir: string, style: ResolvedVideoBgmStyle = 'tech'): string {
  const target = autoBgmPath(dataDir, style);
  if (fs.existsSync(target) && fs.statSync(target).size > 44) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, synthesizeAutoBgmWav(style));
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      if (!fs.existsSync(target)) throw error;
    }
    return target;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
