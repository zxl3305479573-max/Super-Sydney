import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { VideoTtsSettings } from '../shared.ts';
import { writeFileAtomic } from './atomic-file.ts';
import type { VoiceProfile } from './video-production.ts';

/**
 * 视频配音：全局配音设置、声音参数快照，以及两种配音来源。
 *
 * - 系统语音：Windows 自带的 System.Speech（如 Microsoft Huihui），离线、免费，音质一般；
 * - OpenAI 兼容接口：POST {baseUrl}/audio/speech，OpenAI、硅基流动（CosyVoice / IndexTTS）等网关都走这个格式。
 * 非机密设置存 userData/video-tts.json；接口 key 走系统安全存储（video-tts-api-key.bin）。
 */

const FILE = 'video-tts.json';

export const VIDEO_TTS_DEFAULTS: VideoTtsSettings = {
  provider: 'system',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  speed: 1,
  systemVoice: '',
  systemRate: 0
};

function cleanUrl(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return fallback;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    return text;
  } catch {
    throw new Error(`配音接口地址不是有效的 http(s) 地址：${text}`);
  }
}

function cleanText(value: unknown, fallback: string, max = 100): string {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, max);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 合并补丁并校验；未知字段忽略。 */
export function normalizeVideoTtsSettings(input: Partial<VideoTtsSettings>, base: VideoTtsSettings = VIDEO_TTS_DEFAULTS): VideoTtsSettings {
  if (input.provider !== undefined && input.provider !== 'system' && input.provider !== 'openai') throw new Error('未知的配音来源');
  return {
    provider: input.provider ?? base.provider,
    baseUrl: input.baseUrl === undefined ? base.baseUrl : cleanUrl(input.baseUrl, VIDEO_TTS_DEFAULTS.baseUrl),
    model: input.model === undefined ? base.model : cleanText(input.model, VIDEO_TTS_DEFAULTS.model),
    voice: input.voice === undefined ? base.voice : cleanText(input.voice, VIDEO_TTS_DEFAULTS.voice, 200),
    speed: input.speed === undefined ? base.speed : Math.round(clampNumber(input.speed, 0.5, 2, 1) * 100) / 100,
    systemVoice: input.systemVoice === undefined ? base.systemVoice : String(input.systemVoice ?? '').trim().slice(0, 200),
    systemRate: input.systemRate === undefined ? base.systemRate : Math.round(clampNumber(input.systemRate, -5, 5, 0))
  };
}

/** 文件缺失或损坏时返回默认值（默认用系统语音，不花钱）。 */
export function readVideoTtsSettings(dataDir: string): VideoTtsSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8').replace(/^﻿/, '')) as Partial<VideoTtsSettings>;
    return normalizeVideoTtsSettings(raw && typeof raw === 'object' ? raw : {});
  } catch {
    return { ...VIDEO_TTS_DEFAULTS };
  }
}

export function writeVideoTtsSettings(dataDir: string, patch: Partial<VideoTtsSettings>): VideoTtsSettings {
  const next = normalizeVideoTtsSettings(patch ?? {}, readVideoTtsSettings(dataDir));
  writeFileAtomic(path.join(dataDir, FILE), JSON.stringify(next, null, 2));
  return next;
}

/** OpenAI 兼容的语音合成：一次一镜，返回 MP3 字节。 */
export async function requestSpeech(
  profile: Extract<VoiceProfile, { provider: 'openai' }>, apiKey: string, text: string,
  fetchImpl: typeof fetch = fetch, signal?: AbortSignal
): Promise<Buffer> {
  if (!apiKey.trim()) throw new Error('还没有配置配音接口的 API Key，请在「配音与字幕 → 配音设置」里填写');
  const timeout = AbortSignal.timeout(120_000);
  const response = await fetchImpl(`${profile.baseUrl}/audio/speech`, {
    method: 'POST',
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: profile.model, input: text, voice: profile.voice, response_format: 'mp3', speed: profile.speed })
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`配音接口请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  if ((response.headers.get('content-type') ?? '').includes('json')) throw new Error('配音接口返回的不是音频，请检查模型名和音色是否正确');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('配音接口没有返回音频');
  return bytes;
}

/* ── Windows 系统语音 ──────────────────────────────────────────── */

/**
 * 一次 PowerShell 进程合成全部镜头（每镜单独起进程要多花 1–2 秒）。
 * 文本走 UTF-8 的 JSON 清单而不是命令行参数：中文参数在 Windows 控制台代码页下会乱码。
 * 每合成完一镜打印一行 DONE <序号>，主进程据此报进度。
 */
const SYSTEM_TTS_SCRIPT = `param([string]$Manifest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$job = [System.IO.File]::ReadAllText($Manifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($job.voice) { $synth.SelectVoice([string]$job.voice) }
  $synth.Rate = [int]$job.rate
  $index = 0
  foreach ($item in @($job.items)) {
    $synth.SetOutputToWaveFile([string]$item.out)
    $synth.Speak([string]$item.text)
    $synth.SetOutputToNull()
    Write-Output "DONE $index"
    $index++
  }
} finally { $synth.Dispose() }
`;

const LIST_VOICES_SCRIPT = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Culture.Name + '|' + $_.VoiceInfo.Name } } finally { $synth.Dispose() }
`;

function runPowerShell(script: string, args: string[], timeoutMs: number, onLine?: (line: string) => void): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('系统语音只支持 Windows，请改用 OpenAI 兼容接口'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-tts-'));
  const scriptPath = path.join(directory, 'run.ps1');
  // 带 BOM：Windows PowerShell 5.1 默认按系统代码页读脚本，没有 BOM 时脚本里的中文会乱码。
  fs.writeFileSync(scriptPath, `﻿${script}`, 'utf8');
  return new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const cleanup = () => { clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true }); };
    const timer = setTimeout(() => { child.kill(); reject(new Error('系统语音合成超时')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine?.(line.trim());
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (code === 0) resolve(stdout);
      else reject(new Error(`系统语音合成失败：${stderr.replace(/\s+/g, ' ').trim().slice(0, 200) || `退出码 ${code}`}`));
    });
  });
}

export async function synthesizeSystemSpeech(
  profile: Extract<VoiceProfile, { provider: 'system' }>,
  items: Array<{ text: string; out: string }>,
  onDone?: (index: number) => void
): Promise<void> {
  if (!items.length) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-tts-job-'));
  try {
    const manifest = path.join(directory, 'job.json');
    fs.writeFileSync(manifest, JSON.stringify({ voice: profile.voice, rate: profile.rate, items }), 'utf8');
    await runPowerShell(SYSTEM_TTS_SCRIPT, ['-Manifest', manifest], 60_000 + items.length * 30_000, line => {
      const match = /^DONE (\d+)$/.exec(line);
      if (match) onDone?.(Number(match[1]));
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** 已安装的系统语音，中文语音排在前面；非 Windows 或读取失败时返回空数组。 */
export async function listSystemVoices(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  try {
    const output = await runPowerShell(LIST_VOICES_SCRIPT, [], 20_000);
    const voices = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const [culture, ...name] = line.split('|');
      return { culture, name: name.join('|') };
    }).filter(item => item.name);
    return [...voices.filter(item => item.culture.startsWith('zh')), ...voices.filter(item => !item.culture.startsWith('zh'))].map(item => item.name);
  } catch {
    return [];
  }
}
