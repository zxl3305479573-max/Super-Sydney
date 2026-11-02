import fs from 'node:fs';
import { nativeImage } from 'electron';
import { padToThreeFour, XHS_COVER_SIZE } from './xhs-image-fit';

/**
 * 依赖 Electron 的小红书图像工具：生成图补边成 3:4。
 */

/**
 * 生图接口通常给 2:3 竖图，小红书按 3:4 展示：先在短边补边，再统一缩放到 1080×1440。
 * 不裁切——以前居中裁成 3:4 会把顶部的标题、底部的要点切掉一截；统一尺寸也避免不同
 * 网关返回 1024×1365、1152×1536 或 1536×2048 时，预览和发布包里出现不同比例体验。
 */
export function fitToThreeFour(file: string): string {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error('生成的图片无法读取');
  const { width, height } = image.getSize();
  const padded = padToThreeFour({ data: image.toBitmap(), width, height });
  if (padded.width === width && padded.height === height
    && width === XHS_COVER_SIZE.width && height === XHS_COVER_SIZE.height) return file;
  const normalized = nativeImage.createFromBitmap(padded.data, { width: padded.width, height: padded.height })
    .resize({ ...XHS_COVER_SIZE, quality: 'best' });
  fs.writeFileSync(file, normalized.toPNG());
  return file;
}
