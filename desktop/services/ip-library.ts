import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IpColors, IpModule, IpPose, IpProfile, IpProfilePatch, IpRenderKit } from '../shared.ts';
import { writeFileAtomic } from './atomic-file.ts';

/**
 * IP 库：全应用共用的 IP 形象（名称 / 品牌名、头像、透明底角色动作、配色、口头禅、参考图）。
 * 和统一模型配置一个思路：只在一处管理，公众号、小红书、视频各自选用。
 *
 * 存在 userData/ip-library/：library.json 记资料与各模块的选择，每个 IP 一个子目录放图片。
 * 只依赖 fs，可单测；图片的缩放、读成 data URI 由主进程负责（见 ipc/ip.ts）。
 */

const FILE = 'library.json';
export const IP_MODULES: IpModule[] = ['wechat', 'video'];
export const DEFAULT_IP_COLORS: IpColors = { primary: '#22304D', accent: '#F4E15B', secondary: '#8DBF5A' };
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

type LibraryFile = { ips: IpProfile[]; selections: Record<IpModule, string>; seeded: string[] };

/** 预置 IP：首次启动时从应用自带的素材拷进 IP 库；删掉之后不会再自动加回来。 */
export type IpPreset = {
  key: string;
  name: string;
  tagline: string;
  colors: IpColors;
  avatar: string;
  poses: Array<{ label: string; file: string }>;
  reference: string;
};

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeColors(value: unknown, fallback: IpColors = DEFAULT_IP_COLORS): IpColors {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const pick = (key: keyof IpColors) => {
    const text = String(input[key] ?? '').trim();
    return HEX.test(text) ? text.toUpperCase() : fallback[key];
  };
  return { primary: pick('primary'), accent: pick('accent'), secondary: pick('secondary') };
}

function cleanName(value: unknown): string {
  const name = String(value ?? '').trim().slice(0, 30);
  if (!name) throw new Error('IP 名称不能为空');
  return name;
}

export class IpLibrary {
  readonly root: string;
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'ip-library');
    this.filePath = path.join(this.root, FILE);
  }

  private read(): LibraryFile {
    const empty: LibraryFile = { ips: [], selections: { wechat: '', video: '' }, seeded: [] };
    if (!fs.existsSync(this.filePath)) return empty;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<LibraryFile>;
      const ips = (Array.isArray(parsed.ips) ? parsed.ips : []).filter(item => item && typeof item.id === 'string' && item.id).map(item => ({
        ...item, colors: normalizeColors(item.colors), poses: Array.isArray(item.poses) ? item.poses : [], avatar: item.avatar ?? '', reference: item.reference ?? '', tagline: item.tagline ?? ''
      }));
      const selections = { ...empty.selections };
      for (const module of IP_MODULES) selections[module] = String(parsed.selections?.[module] ?? '');
      return { ips, selections, seeded: Array.isArray(parsed.seeded) ? parsed.seeded.map(String) : [] };
    } catch {
      return empty;
    }
  }

  private write(file: LibraryFile): void {
    fs.mkdirSync(this.root, { recursive: true });
    writeFileAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private mutate(id: string, change: (ip: IpProfile, directory: string) => IpProfile): IpProfile {
    const file = this.read();
    const current = file.ips.find(item => item.id === id);
    if (!current) throw new Error('这个 IP 已经不存在了，请刷新后重试');
    const next = { ...change(current, this.directory(id)), updatedAt: new Date().toISOString() };
    this.write({ ...file, ips: file.ips.map(item => item.id === id ? next : item) });
    return next;
  }

  directory(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('IP 编号不正确');
    return path.join(this.root, id);
  }

  /** IP 目录里某个文件的绝对路径；文件名只认本库写入的那种，防止路径穿越。 */
  filePathOf(id: string, file: string): string {
    if (!file || path.basename(file) !== file) throw new Error('素材文件名不正确');
    return path.join(this.directory(id), file);
  }

  list(): IpProfile[] {
    return this.read().ips;
  }

  get(id: string): IpProfile {
    const found = this.read().ips.find(item => item.id === id);
    if (!found) throw new Error('这个 IP 已经不存在了，请刷新后重试');
    return found;
  }

  /** 选中的 IP 被删了就当作「不使用」。 */
  selections(): Record<IpModule, string> {
    const file = this.read();
    const ids = new Set(file.ips.map(item => item.id));
    return Object.fromEntries(IP_MODULES.map(module => [module, ids.has(file.selections[module]) ? file.selections[module] : ''])) as Record<IpModule, string>;
  }

  select(module: IpModule, id: string): void {
    if (!IP_MODULES.includes(module)) throw new Error('未知的模块');
    const file = this.read();
    const clean = String(id ?? '');
    if (clean && !file.ips.some(item => item.id === clean)) throw new Error('这个 IP 已经不存在了，请刷新后重试');
    this.write({ ...file, selections: { ...file.selections, [module]: clean } });
  }

  create(name: unknown, colors: IpColors = DEFAULT_IP_COLORS, id: string = randomUUID()): IpProfile {
    const file = this.read();
    const clean = cleanName(name);
    if (file.ips.some(item => item.name === clean)) throw new Error('已经有同名的 IP 了，换个名字');
    const now = new Date().toISOString();
    const ip: IpProfile = { id, name: clean, tagline: '', colors: normalizeColors(colors), avatar: '', poses: [], reference: '', createdAt: now, updatedAt: now };
    fs.mkdirSync(this.directory(id), { recursive: true });
    this.write({ ...file, ips: [...file.ips, ip] });
    return ip;
  }

  update(id: string, patch: IpProfilePatch): IpProfile {
    if (patch.name !== undefined) {
      const name = cleanName(patch.name);
      if (this.read().ips.some(item => item.id !== id && item.name === name)) throw new Error('已经有同名的 IP 了，换个名字');
    }
    return this.mutate(id, ip => {
      const labels = new Map((patch.poses ?? []).map(pose => [pose.id, String(pose.label ?? '').trim().slice(0, 12)]));
      return {
        ...ip,
        ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
        ...(patch.tagline !== undefined ? { tagline: String(patch.tagline).trim().slice(0, 60) } : {}),
        ...(patch.colors !== undefined ? { colors: normalizeColors(patch.colors, ip.colors) } : {}),
        poses: ip.poses.map(pose => labels.get(pose.id) ? { ...pose, label: labels.get(pose.id) as string } : pose)
      };
    });
  }

  remove(id: string): void {
    const file = this.read();
    if (!file.ips.some(item => item.id === id)) return;
    const selections = { ...file.selections };
    for (const module of IP_MODULES) if (selections[module] === id) selections[module] = '';
    this.write({ ...file, ips: file.ips.filter(item => item.id !== id), selections });
    fs.rmSync(this.directory(id), { recursive: true, force: true });
  }

  /** 写入一张图片（已由调用方缩放好）；kind 为 pose 时追加一个动作，否则替换头像 / 参考图。 */
  addImage(id: string, kind: 'avatar' | 'pose' | 'reference', bytes: Buffer, extension: string, label = ''): IpProfile {
    const ext = extension.toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) throw new Error('只支持 png / jpg / webp 图片');
    return this.mutate(id, (ip, directory) => {
      fs.mkdirSync(directory, { recursive: true });
      const name = `${kind}-${randomUUID().slice(0, 8)}${ext}`;
      fs.writeFileSync(path.join(directory, name), bytes);
      if (kind === 'pose') {
        const poseLabel = String(label).trim().slice(0, 12) || `动作 ${ip.poses.length + 1}`;
        return { ...ip, poses: [...ip.poses, { id: randomUUID().slice(0, 8), label: poseLabel, file: name }] };
      }
      const old = ip[kind];
      if (old) fs.rmSync(path.join(directory, old), { force: true });
      return { ...ip, [kind]: name };
    });
  }

  removePose(id: string, poseId: string): IpProfile {
    return this.mutate(id, (ip, directory) => {
      const pose = ip.poses.find(item => item.id === poseId);
      if (!pose) return ip;
      fs.rmSync(path.join(directory, pose.file), { force: true });
      return { ...ip, poses: ip.poses.filter(item => item.id !== poseId) };
    });
  }

  /** 预置 IP 每个 key 只拷一次：用户删掉后不会在下次启动时又冒出来。 */
  seed(preset: IpPreset): IpProfile | null {
    const file = this.read();
    if (file.seeded.includes(preset.key)) return null;
    let ip: IpProfile | null = null;
    if (!file.ips.some(item => item.name === preset.name)) {
      const id = preset.key;
      const created = this.create(preset.name, preset.colors, file.ips.some(item => item.id === id) ? randomUUID() : id);
      const copy = (source: string, kind: 'avatar' | 'pose' | 'reference', label?: string) =>
        this.addImage(created.id, kind, fs.readFileSync(source), path.extname(source), label);
      if (preset.avatar) copy(preset.avatar, 'avatar');
      for (const pose of preset.poses) copy(pose.file, 'pose', pose.label);
      if (preset.reference) copy(preset.reference, 'reference');
      ip = this.update(created.id, { tagline: preset.tagline });
    }
    const latest = this.read();
    this.write({ ...latest, seeded: [...latest.seeded, preset.key] });
    return ip;
  }
}

/** 模板渲染资料：品牌名、配色、头像与动作图（调用方把文件读成 data URI 传进来）。 */
export function buildRenderKit(ip: IpProfile, load: (file: string) => string): IpRenderKit {
  return {
    id: ip.id, name: ip.name, tagline: ip.tagline, colors: ip.colors,
    avatar: ip.avatar ? load(ip.avatar) : '',
    poses: ip.poses.map((pose: IpPose) => ({ id: pose.id, label: pose.label, src: load(pose.file) }))
  };
}
