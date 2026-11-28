import fs from 'node:fs';
import path from 'node:path';
import { inspectMp4Faststart } from './mp4-faststart.ts';

/**
 * 本地成片直发（上传视频、封面与中性文案）纯本地文件与封装处理服务。
 *
 * 零 Electron 依赖，主进程通过依赖注入传入 ffmpeg / ffprobe 工具，方便 Node 单测完整覆盖。
 */

export const DIRECT_VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] as const;
export const DIRECT_COVER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export const DIRECT_COPY_EXTENSIONS = ['txt', 'md', 'markdown'] as const;

export const MAX_NEUTRAL_COPY_FILE_BYTES = 512 * 1024;
export const MAX_NEUTRAL_COPY_CHARS = 20_000;

const VIDEO_EXT_SET = new Set<string>(DIRECT_VIDEO_EXTENSIONS.map(ext => `.${ext}`));
const COVER_EXT_SET = new Set<string>(DIRECT_COVER_EXTENSIONS.map(ext => `.${ext}`));
const COPY_EXT_SET = new Set<string>(DIRECT_COPY_EXTENSIONS.map(ext => `.${ext}`));

export function cleanVideoTitleFromFilename(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  const cleaned = base
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || '本地上传视频';
}

export function validateLocalVideoPath(filePath: string): string {
  const raw = String(filePath ?? '').trim();
  if (!raw) throw new Error('请选择要上传的本地视频文件');
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`找不到本地视频文件：${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!VIDEO_EXT_SET.has(ext)) {
    throw new Error(`不支持的视频格式「${ext || '无后缀'}」，请选择 MP4 / MOV / MKV / WebM / M4V / AVI`);
  }
  return resolved;
}

export function validateLocalCoverPath(filePath: string): string {
  const raw = String(filePath ?? '').trim();
  if (!raw) throw new Error('请选择要上传的本地封面图片');
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`找不到本地封面图片：${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!COVER_EXT_SET.has(ext)) {
    throw new Error(`不支持的封面格式「${ext || '无后缀'}」，请选择 PNG / JPG / JPEG / WebP`);
  }
  return resolved;
}

export function readNeutralCopyFile(filePath: string): { path: string; text: string } {
  const raw = String(filePath ?? '').trim();
  if (!raw) throw new Error('请选择要导入的文案文件');
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`找不到文案文件：${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!COPY_EXT_SET.has(ext)) {
    throw new Error(`不支持的文案文件格式「${ext || '无后缀'}」，请选择 TXT 或 MD 文件`);
  }
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_NEUTRAL_COPY_FILE_BYTES) {
    throw new Error('文案文件超过 512 KB 上限，请精简后再导入');
  }
  const text = fs.readFileSync(resolved, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, MAX_NEUTRAL_COPY_CHARS);
  if (!text) throw new Error('导入的文案文件为空');
  return { path: resolved, text };
}

/**
 * 无损快封装参数：仅保留主视频轨与可选首条音轨，跳过 iPhone MOV 的 timecode 等数据轨，
 * 并写入 +faststart（moov 前置），避免小红书报「无视频流信息」或抖音不出表单。
 */
export function buildFaststartRemuxArgs(sourcePath: string, outputPath: string): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    outputPath
  ];
}

/** 当源容器编码不兼容 MP4 无损封装（如 WebM VP9/Opus）时，降级为通用 H.264/AAC + faststart。 */
export function buildCompatTranscodeArgs(sourcePath: string, outputPath: string): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '21',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ];
}

export type DirectVideoProbeResult = {
  seconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

export type DirectUploadPrepareDeps<Tools = unknown> = {
  resolveTools?: () => Promise<Tools>;
  probe?: (tools: Tools, file: string) => Promise<DirectVideoProbeResult>;
  runFfmpeg?: (tools: Tools, args: string[]) => Promise<void>;
  now?: () => number;
};

export type DirectUploadPreparedVideo = {
  videoPath: string;
  sourcePath: string;
  seconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  faststart: boolean | null;
  remuxed: boolean;
  notice: string;
};

/**
 * 检查并准备上传的本地视频：
 * - 已是 faststart 的 MP4：直接原路径关联（零拷贝、零等待）。
 * - 非 faststart 的 MP4 或 MOV/MKV/WebM 等容器：若可用 ffmpeg，自动无损封装（失败时转码）为 +faststart MP4 存入项目素材目录。
 * - 若未安装 ffmpeg：保留原文件并返回清晰提示，不阻断关联。
 */
export async function prepareDirectUploadVideo<Tools>(
  sourcePath: string,
  outputDir: string,
  deps: DirectUploadPrepareDeps<Tools> = {}
): Promise<DirectUploadPreparedVideo> {
  const resolved = validateLocalVideoPath(sourcePath);
  const ext = path.extname(resolved).toLowerCase();
  const isMp4 = ext === '.mp4';
  const sourceFaststart = isMp4 ? inspectMp4Faststart(resolved) : null;

  let tools: Tools | null = null;
  if (deps.resolveTools) {
    try { tools = await deps.resolveTools(); } catch { tools = null; }
  }

  const safeProbe = async (file: string): Promise<DirectVideoProbeResult | null> => {
    if (!tools || !deps.probe) return null;
    try { return await deps.probe(tools, file); } catch { return null; }
  };

  if (isMp4 && sourceFaststart === true) {
    const probed = await safeProbe(resolved);
    return {
      videoPath: resolved,
      sourcePath: resolved,
      seconds: probed?.seconds && probed.seconds > 0 ? probed.seconds : 1,
      width: probed?.width ?? 0,
      height: probed?.height ?? 0,
      hasAudio: probed?.hasAudio ?? true,
      faststart: true,
      remuxed: false,
      notice: ''
    };
  }

  const needsRemux = !isMp4 || sourceFaststart === false;
  if (needsRemux && tools && deps.runFfmpeg) {
    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = deps.now ? deps.now() : Date.now();
    const target = path.join(outputDir, `upload-faststart-${stamp}.mp4`);
    let converted = false;
    try {
      await deps.runFfmpeg(tools, buildFaststartRemuxArgs(resolved, target));
      if (fs.existsSync(target) && fs.statSync(target).size >= 1024 && inspectMp4Faststart(target) !== false) {
        converted = true;
      } else {
        fs.rmSync(target, { force: true });
      }
    } catch {
      fs.rmSync(target, { force: true });
    }

    if (!converted) {
      try {
        await deps.runFfmpeg(tools, buildCompatTranscodeArgs(resolved, target));
        if (fs.existsSync(target) && fs.statSync(target).size >= 1024) {
          converted = true;
        } else {
          fs.rmSync(target, { force: true });
        }
      } catch {
        fs.rmSync(target, { force: true });
      }
    }

    if (converted) {
      const probed = await safeProbe(target);
      return {
        videoPath: target,
        sourcePath: resolved,
        seconds: probed?.seconds && probed.seconds > 0 ? probed.seconds : 1,
        width: probed?.width ?? 0,
        height: probed?.height ?? 0,
        hasAudio: probed?.hasAudio ?? true,
        faststart: inspectMp4Faststart(target),
        remuxed: true,
        notice: isMp4
          ? '检测到原 MP4 缺少 faststart，已自动完成流式快封装（moov 前置）'
          : `已将 ${ext.slice(1).toUpperCase()} 自动封装为流式 MP4（+faststart），兼容全部平台上传`
      };
    }
  }

  const probed = await safeProbe(resolved);
  const notice = isMp4 && sourceFaststart === false
    ? '检测到该 MP4 缺少 faststart 且当前无法自动重封装，上传小红书/抖音可能失败，请安装 ffmpeg 后重新选择视频'
    : !isMp4
      ? `未检测到 ffmpeg，已直接关联原始 ${ext.slice(1).toUpperCase()} 文件（建议安装 ffmpeg 自动转为 faststart MP4）`
      : '';

  return {
    videoPath: resolved,
    sourcePath: resolved,
    seconds: probed?.seconds && probed.seconds > 0 ? probed.seconds : 1,
    width: probed?.width ?? 0,
    height: probed?.height ?? 0,
    hasAudio: probed?.hasAudio ?? true,
    faststart: sourceFaststart,
    remuxed: false,
    notice
  };
}
