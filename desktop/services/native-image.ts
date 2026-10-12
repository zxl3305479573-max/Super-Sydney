import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { contentTypeFor } from './wechat-publisher.ts';

/**
 * 依赖 Electron nativeImage 的图片处理：缩略图、微信正文图压缩、预览 data URI。
 * 单独成模块是因为它只能在 Electron 主进程里跑，纯 Node 单测无法加载。
 */

const PREVIEW_IMAGE_LIMIT = 4 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const THUMBNAIL_WIDTH = 560;

/** 给界面用的缩略图；文件缺失或不是图片时返回空串，由前端显示占位。 */
export function imageThumbnail(source: string): string {
  try {
    if (!source || !fs.existsSync(source)) return '';
    const image = nativeImage.createFromPath(source);
    if (image.isEmpty()) return '';
    const { width, height } = image.getSize();
    const scaled = width > THUMBNAIL_WIDTH
      ? image.resize({ width: THUMBNAIL_WIDTH, height: Math.max(1, Math.round(height * THUMBNAIL_WIDTH / width)), quality: 'good' })
      : image;
    return `data:image/jpeg;base64,${scaled.toJPEG(78).toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * 微信正文图片上限 1MB，而图像接口给的 PNG 经常超标（虽然封面走素材接口能到 10MB）。
 * 这里用 Electron 自带的 nativeImage 缩到 1080 宽并转 JPEG，省掉一个图像处理依赖；
 * 转码之后反而更大就保留原图。
 */
export function prepareWeChatInlineImage(source: string): { bytes: Buffer; filename: string; contentType: string } {
  const raw = fs.readFileSync(source);
  try {
    const image = nativeImage.createFromBuffer(raw);
    if (image.isEmpty()) return { bytes: raw, filename: path.basename(source), contentType: contentTypeFor(source) };
    const { width, height } = image.getSize();
    const maxWidth = 1080;
    const scaled = width > maxWidth ? image.resize({ width: maxWidth, height: Math.max(1, Math.round(height * maxWidth / width)), quality: 'good' }) : image;
    const jpeg = scaled.toJPEG(82);
    if (jpeg.length >= raw.length && raw.length <= 1024 * 1024) {
      return { bytes: raw, filename: path.basename(source), contentType: contentTypeFor(source) };
    }
    return { bytes: jpeg, filename: `${path.basename(source, path.extname(source))}.jpg`, contentType: 'image/jpeg' };
  } catch {
    return { bytes: raw, filename: path.basename(source), contentType: contentTypeFor(source) };
  }
}

/** 预览用的图片地址：远程地址原样返回，本地文件转 data URI（过大则保持原路径）。 */
export function previewImageSource(source: string): string {
  if (/^https?:\/\//i.test(source) || source.startsWith('data:')) return source;
  try {
    if (!fs.existsSync(source)) return source;
    if (fs.statSync(source).size > PREVIEW_IMAGE_LIMIT) return source;
    const mime = MIME_BY_EXTENSION[path.extname(source).toLowerCase()] ?? 'image/png';
    return `data:${mime};base64,${fs.readFileSync(source).toString('base64')}`;
  } catch {
    return source;
  }
}
