import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUTO_BGM_TEMPLATE_VERSION } from '../shared.ts';

/**
 * 离线原创 BGM。
 *
 * 产品片首次渲染时在本地合成一段可循环的轻快科技感背景音乐，不访问曲库、不依赖登录，
 * 也不会把第三方音乐混进交付文件。文件名带模板版本；升级编曲后旧成片会自然过期。
 */

const SAMPLE_RATE = 44_100;
const DURATION_SECONDS = 16;
const BPM = 120;
const BEAT_SECONDS = 60 / BPM;
const BAR_SECONDS = BEAT_SECONDS * 4;

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

/** 返回 16 位、44.1kHz、立体声 WAV。纯函数，便于单测和后续替换编曲。 */
export function synthesizeAutoBgmWav(): Buffer {
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

  const chords = [
    [261.63, 329.63, 392.0, 493.88],
    [220.0, 261.63, 329.63, 392.0],
    [174.61, 220.0, 261.63, 329.63],
    [196.0, 246.94, 293.66, 392.0]
  ];
  const mixed = new Float32Array(frames * channels);

  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / SAMPLE_RATE;
    const chord = chords[Math.floor(time / BAR_SECONDS) % chords.length];
    const beat = time / BEAT_SECONDS;
    const beatPhase = (beat % 1) * BEAT_SECONDS;
    const eighthPhase = (time % (BEAT_SECONDS / 2));
    const arpPhase = (time % (BEAT_SECONDS / 2));
    const arpStep = Math.floor(time / (BEAT_SECONDS / 2));

    // 柔和和弦垫：左右各轻微失谐，避免整首听起来像单声道测试音。
    let left = 0;
    let right = 0;
    for (const [index, frequency] of chord.entries()) {
      const weight = 0.022 / (index + 1);
      left += Math.sin(2 * Math.PI * frequency * 0.997 * time) * weight;
      right += Math.sin(2 * Math.PI * frequency * 1.003 * time) * weight;
    }

    // 八分音符拨弦，轮流落在左右声道。
    const pluckFrequency = note(chord, arpStep) * 2;
    const pluckEnvelope = Math.min(1, arpPhase / 0.012) * Math.exp(-9 * arpPhase);
    const pluck = Math.sin(2 * Math.PI * pluckFrequency * time) * pluckEnvelope * 0.085;
    if (arpStep % 2 === 0) left += pluck * 1.15;
    else right += pluck * 1.15;

    // 低音与四拍底鼓给产品节奏，但音量始终给口播让路。
    const bassEnvelope = Math.min(1, beatPhase / 0.015) * Math.exp(-4.2 * beatPhase);
    const bass = Math.sin(2 * Math.PI * (chord[0] / 2) * time) * bassEnvelope * 0.13;
    left += bass;
    right += bass;

    const beatIndex = Math.floor(beat) % 4;
    if (beatIndex === 0 || beatIndex === 2) {
      const kick = Math.sin(2 * Math.PI * (52 + 78 * Math.exp(-22 * beatPhase)) * beatPhase)
        * Math.exp(-16 * beatPhase) * 0.22;
      left += kick;
      right += kick;
    }
    if (beatIndex === 1 || beatIndex === 3) {
      const clap = seededNoise(frame * 17 + beatIndex) * Math.exp(-24 * beatPhase) * 0.09;
      left += clap;
      right += clap * 0.92;
    }

    const hatEnvelope = Math.exp(-55 * eighthPhase);
    const hat = seededNoise(frame * 31 + arpStep) * hatEnvelope * 0.032;
    left += hat * (arpStep % 2 ? 0.7 : 1);
    right += hat * (arpStep % 2 ? 1 : 0.7);

    const fade = Math.min(1, time / 0.12, (DURATION_SECONDS - time) / 0.12);
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

export function autoBgmPath(dataDir: string): string {
  return path.join(dataDir, 'video-bgm', `product-auto-${AUTO_BGM_TEMPLATE_VERSION}.wav`);
}

export function ensureAutoBgm(dataDir: string): string {
  const target = autoBgmPath(dataDir);
  if (fs.existsSync(target) && fs.statSync(target).size > 44) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, synthesizeAutoBgmWav());
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
