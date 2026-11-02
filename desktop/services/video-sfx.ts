import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VideoSoundEffect } from '../shared.ts';

const RATE = 44_100;
const DURATIONS: Record<Exclude<VideoSoundEffect, 'none'>, number> = {
  'soft-pop': 0.18, whoosh: 0.42, click: 0.12, tick: 0.1, impact: 0.3
};

function writeWav(samples: Float32Array): Buffer {
  const dataBytes = samples.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF'); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) wav.writeInt16LE(Math.max(-1, Math.min(1, samples[i])) * 32767, 44 + i * 2);
  return wav;
}

export function synthesizeSoundEffect(effect: Exclude<VideoSoundEffect, 'none'>): Buffer {
  const seconds = DURATIONS[effect];
  const samples = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / RATE;
    const progress = t / seconds;
    const envelope = Math.min(1, t / 0.008) * Math.max(0, 1 - progress) ** (effect === 'whoosh' ? 1.3 : 2);
    const frequency = effect === 'click' ? 1400 : effect === 'tick' ? 880 : effect === 'impact' ? 90 + 180 * Math.max(0, 1 - progress) : effect === 'whoosh' ? 240 + 900 * progress : 420 + 520 * progress;
    const tone = Math.sin(2 * Math.PI * frequency * t) * envelope;
    const noise = effect === 'whoosh' ? Math.sin(2 * Math.PI * 37 * t) * Math.sin(2 * Math.PI * 7 * t) * envelope * 0.35 : 0;
    samples[i] = (tone + noise) * (effect === 'impact' ? 0.62 : 0.28);
  }
  return writeWav(samples);
}

export function ensureSoundEffect(dataDir: string, effect: VideoSoundEffect): string {
  if (effect === 'none') return '';
  const target = path.join(dataDir, 'video-sfx', `${effect}-v1.wav`);
  if (fs.existsSync(target) && fs.statSync(target).size > 44) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, synthesizeSoundEffect(effect));
    try { fs.renameSync(temp, target); } catch (error) { if (!fs.existsSync(target)) throw error; }
    return target;
  } finally { fs.rmSync(temp, { force: true }); }
}

export function soundEffectDuration(effect: VideoSoundEffect): number {
  return effect === 'none' ? 0 : DURATIONS[effect];
}
