import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { VideoProject } from '../shared.ts';

const INLINE_HASH_LIMIT = 8 * 1024 * 1024;

function fileSnapshot(file: string): string {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Skill 输入不是文件：${resolved}`);
  let content = '';
  if (stat.size <= INLINE_HASH_LIMIT) {
    content = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
  }
  return [resolved.toLowerCase(), stat.size, Math.round(stat.mtimeMs), content].join(':');
}

function configReferences(source: string): string[] {
  if (path.extname(source).toLowerCase() !== '.json') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch {
    return [];
  }
  const root = path.dirname(source);
  const references = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      if (!value.trim() || /^(?:https?:|data:|file:)/i.test(value)) return;
      const candidate = path.isAbsolute(value) ? value : path.resolve(root, value);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) references.add(candidate);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => visit(item));
      return;
    }
    if (value && typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) visit(child);
    }
  };
  // 浏览器配置中的 shots 是主素材；通用递归也让 cursor_asset 等新增字段自动进入快照。
  visit(parsed);
  return [...references].sort();
}

/**
 * 外部 Skill 输入的内容快照。
 *
 * 视频文件用大小、mtime 和路径判断，避免每次重新读取数 GB 素材；配置、字幕和小图同时哈希内容。
 * 浏览器配置引用的截图也会进入快照，因此换一张页面截图会让旧成片失效。
 */
export function skillInputFingerprint(sourcePath: string): string {
  const source = path.resolve(sourcePath.trim());
  if (!sourcePath.trim()) throw new Error('请先填写 Skill 输入路径');
  if (!fs.existsSync(source)) throw new Error(`找不到 Skill 输入：${source}`);
  const files = [source, ...configReferences(source)];
  const hash = createHash('sha256');
  for (const file of files) hash.update(fileSnapshot(file)).update('\n');
  return hash.digest('hex').slice(0, 40);
}

export function hasStableSkillInput(project: VideoProject): boolean {
  if (project.options.workflow === 'script-to-video' || project.options.workflow === 'product-demo') return true;
  if (!project.options.sourcePath.trim() || !project.options.skillInputSignature) return false;
  try {
    return skillInputFingerprint(project.options.sourcePath) === project.options.skillInputSignature;
  } catch {
    return false;
  }
}

export function assertStableSkillInput(project: VideoProject): void {
  if (project.options.workflow === 'script-to-video' || project.options.workflow === 'product-demo') return;
  if (!hasStableSkillInput(project)) {
    throw new Error('外部素材或浏览器配置已变化，请重新运行当前 Skill 工作流后再导出');
  }
}
