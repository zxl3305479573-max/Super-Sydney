import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_COVER_RATIOS, COVER_RATIO_SPECS, type VideoCoverRatio } from '../shared.ts';

export { ALL_COVER_RATIOS, COVER_RATIO_SPECS };

export function buildCoverVariantFfmpegArgs(sourcePath: string, targetPath: string, ratio: VideoCoverRatio): string[] {
  const spec = COVER_RATIO_SPECS[ratio];
  if (!spec) throw new Error(`不支持的封面比例：${ratio}`);
  const { width, height } = spec;
  const filter = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=36:2,eq=brightness=-0.06[bg]`,
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`
  ].join(';');

  return [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-frames:v', '1',
    '-filter_complex', filter,
    '-q:v', '3',
    targetPath
  ];
}

function execFfmpeg(ffmpegBin: string, args: string[], timeoutMs = 45_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBin, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).replace(/\s+/g, ' ').trim().slice(-240);
        reject(new Error(`衍生封面生成失败：${detail || error.message}`));
      } else {
        resolve();
      }
    });
  });
}

export async function generateCoverVariants(
  sourcePath: string,
  outputDir: string,
  ffmpegBin: string,
  ratios: VideoCoverRatio[] = ALL_COVER_RATIOS,
  runner: (bin: string, args: string[]) => Promise<void> = execFfmpeg
): Promise<Partial<Record<VideoCoverRatio, string>>> {
  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) {
    throw new Error('源封面文件不存在，请先生成或选择一张主封面');
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const out: Partial<Record<VideoCoverRatio, string>> = {};
  for (const ratio of ratios) {
    const spec = COVER_RATIO_SPECS[ratio];
    const target = path.join(outputDir, spec.fileSlug);
    await runner(ffmpegBin, buildCoverVariantFfmpegArgs(resolvedSource, target, ratio));
    out[ratio] = target;
  }
  return out;
}
