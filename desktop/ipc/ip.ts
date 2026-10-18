import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain, nativeImage } from 'electron';
import type { AppContext } from '../app-context';
import presetAvatar from '../assets/ip-presets/sydney/avatar.png?asset';
import presetPointing from '../assets/ip-presets/sydney/pointing.png?asset';
import presetReference from '../assets/ip-presets/sydney/reference.jpg?asset';
import presetTeam from '../assets/ip-presets/sydney/team.png?asset';
import presetTyping from '../assets/ip-presets/sydney/typing.png?asset';
import type { IpLibraryView, IpModule, IpProfilePatch, IpRenderKit } from '../shared';
import type { ImageReference } from '../services/image-generation';
import { buildRenderKit, IP_MODULES, type IpLibrary } from '../services/ip-library';

/* ── IP 库 ───────────────────────────────────────────────────────
 * 全应用共用的 IP 形象，独立的 ip:* 命名空间，不进 state:get；改动后发 ip:changed 让各模块重新拉取。
 * 图片导入时先缩到够用的尺寸：模板渲染时整张读成 data URI 塞进页面，而 data: 地址有约 2MB 上限。
 */

const IMAGE_FILTERS = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }];
/** 各类图片导入后的最长边。 */
const MAX_EDGE = { avatar: 256, pose: 900, reference: 1400 } as const;

/** 预置的第一个 IP。 */
const SYDNEY_PRESET = {
  key: 'sydney',
  name: '雪梨的一人公司',
  tagline: '一个人 + AI = 一个团队',
  colors: { primary: '#22304D', accent: '#F4E15B', secondary: '#8DBF5A' },
  avatar: presetAvatar,
  poses: [{ label: '打字', file: presetTyping }, { label: '指向', file: presetPointing }, { label: '团队', file: presetTeam }],
  reference: presetReference
};

const dataUriCache = new Map<string, { mtime: number; uri: string }>();

function fileDataUri(file: string): string {
  const mtime = fs.statSync(file).mtimeMs;
  const cached = dataUriCache.get(file);
  if (cached && cached.mtime === mtime) return cached.uri;
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const uri = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  dataUriCache.set(file, { mtime, uri });
  return uri;
}

/** 模板渲染用的 IP 资料；其他模块（小红书、公众号、视频）导出封面时也调它。 */
export function ipRenderKit(library: IpLibrary, id: string): IpRenderKit {
  const ip = library.get(id);
  return buildRenderKit(ip, file => fileDataUri(library.filePathOf(ip.id, file)));
}

/** AI 生图参考图的最长边：够接口看清角色，又不让请求太大。 */
const REFERENCE_EDGE = 1024;
const referenceCache = new Map<string, { mtime: number; reference: ImageReference }>();

/**
 * AI 生图时传给图片接口的 IP 参考图：优先用 IP 的整体参考图，没有就用第一个角色动作。
 * 统一转成不透明的白底 JPEG：透明底 PNG 在 /images/edits 里会被当成「要重画的区域」，角色反而会被原样贴在原位。
 * IP 已被删或没有任何图片时返回 null（照常生图，不带角色）。
 */
export function ipReferenceImage(library: IpLibrary, id: string): ImageReference | null {
  if (!id) return null;
  let ip;
  try { ip = library.get(id); } catch { return null; }
  const file = ip.reference || ip.poses[0]?.file || ip.avatar;
  if (!file) return null;
  const source = library.filePathOf(ip.id, file);
  if (!fs.existsSync(source)) return null;
  const mtime = fs.statSync(source).mtimeMs;
  const cached = referenceCache.get(source);
  if (cached && cached.mtime === mtime) return cached.reference;
  const image = nativeImage.createFromPath(source);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, REFERENCE_EDGE / Math.max(width, height));
  const sized = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : image;
  const size = sized.getSize();
  // 位图是预乘过透明度的 BGRA：叠到白底上就是 颜色 + (255 - alpha)。
  const bitmap = Buffer.from(sized.toBitmap());
  for (let index = 0; index < bitmap.length; index += 4) {
    const rest = 255 - bitmap[index + 3];
    bitmap[index] = Math.min(255, bitmap[index] + rest);
    bitmap[index + 1] = Math.min(255, bitmap[index + 1] + rest);
    bitmap[index + 2] = Math.min(255, bitmap[index + 2] + rest);
    bitmap[index + 3] = 255;
  }
  const flat = nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
  const reference: ImageReference = { bytes: flat.toJPEG(90), filename: 'ip-reference.jpg', contentType: 'image/jpeg' };
  referenceCache.set(source, { mtime, reference });
  return reference;
}

/** 透明底素材的缩略图要保留透明：用 PNG，不用 JPEG。 */
function thumbnail(file: string, edge: number): string {
  try {
    if (!fs.existsSync(file)) return '';
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) return '';
    const { width, height } = image.getSize();
    const scale = Math.min(1, edge / Math.max(width, height));
    const scaled = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : image;
    return `data:image/png;base64,${scaled.toPNG().toString('base64')}`;
  } catch {
    return '';
  }
}

/** 缩到最长边不超过上限；参考图转 JPEG（不需要透明），其余保留 PNG。 */
function prepareImage(source: string, kind: keyof typeof MAX_EDGE): { bytes: Buffer; extension: string } {
  const image = nativeImage.createFromPath(source);
  if (image.isEmpty()) throw new Error('这张图片读不出来，换一张 png / jpg 试试');
  const { width, height } = image.getSize();
  const scale = Math.min(1, MAX_EDGE[kind] / Math.max(width, height));
  const scaled = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : image;
  return kind === 'reference' ? { bytes: scaled.toJPEG(86), extension: '.jpg' } : { bytes: scaled.toPNG(), extension: '.png' };
}

export function libraryView(library: IpLibrary): IpLibraryView {
  return {
    ips: library.list().map(ip => {
      const file = (name: string) => library.filePathOf(ip.id, name);
      return {
        ...ip,
        avatarThumb: ip.avatar ? thumbnail(file(ip.avatar), 120) : '',
        referenceThumb: ip.reference ? thumbnail(file(ip.reference), 360) : '',
        poseThumbs: Object.fromEntries(ip.poses.map(pose => [pose.id, thumbnail(file(pose.file), 220)]))
      };
    }),
    selections: library.selections()
  };
}

export function registerIpIpc(ctx: AppContext): void {
  const library = ctx.ipLibrary;
  try { library.seed(SYDNEY_PRESET); } catch (error) { console.error('预置 IP 写入失败', error); }

  const changed = () => { ctx.notifyIpChanged(); return libraryView(library); };

  ipcMain.handle('ip:list', () => libraryView(library));
  ipcMain.handle('ip:create', (_event, name: string) => { library.create(name); return changed(); });
  ipcMain.handle('ip:update', (_event, id: string, patch: IpProfilePatch) => { library.update(String(id), patch ?? {}); return changed(); });
  ipcMain.handle('ip:delete', (_event, id: string) => { library.remove(String(id)); return changed(); });
  ipcMain.handle('ip:image:add', async (_event, id: string, kind: 'avatar' | 'pose' | 'reference', label?: string) => {
    if (!['avatar', 'pose', 'reference'].includes(kind)) throw new Error('未知的图片类型');
    library.get(String(id));
    const parent = ctx.window();
    const options = { properties: ['openFile' as const], filters: IMAGE_FILTERS };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const source = result.filePaths[0];
    const { bytes, extension } = prepareImage(source, kind);
    const poseLabel = String(label ?? '').trim() || path.basename(source, path.extname(source));
    library.addImage(String(id), kind, bytes, extension, poseLabel);
    return changed();
  });
  ipcMain.handle('ip:pose:remove', (_event, id: string, poseId: string) => { library.removePose(String(id), String(poseId)); return changed(); });
  ipcMain.handle('ip:select', (_event, module: IpModule, id: string) => {
    if (!IP_MODULES.includes(module)) throw new Error('未知的模块');
    library.select(module, String(id ?? ''));
    return changed();
  });
  ipcMain.handle('ip:kit', (_event, id: string) => ipRenderKit(library, String(id)));
}
