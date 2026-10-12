import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { WeWriteTheme } from '../shared.ts';
import { writeFileAtomic } from './atomic-file.ts';
import { parseStyleSummary, serializeStyleConfig, weWriteHome, yamlScalar } from './wewrite-config.ts';

/**
 * ~/.wewrite 下 style.yaml / config.yaml 的读写。
 * 这两份文件是原生管道与 agent 侧 skill 共用的配置；解析逻辑在 wewrite-config.ts。
 */

export type WeWriteFiles = { styleText: string | null; configText: string | null };

function readTextFile(target: string): string | null {
  try { return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null; } catch { return null; }
}

export function readWeWriteFiles(home = weWriteHome()): WeWriteFiles {
  return { styleText: readTextFile(path.join(home, 'style.yaml')), configText: readTextFile(path.join(home, 'config.yaml')) };
}

/** 配置里有密钥：原子写，并在 Windows 上把权限收紧为仅当前用户可读写。 */
export function writeWeWriteFile(target: string, content: string): void {
  writeFileAtomic(target, content, { mode: 0o600 });
  if (process.platform === 'win32') {
    const identity = `${process.env.USERDOMAIN || process.env.COMPUTERNAME || ''}\\${process.env.USERNAME || ''}`;
    if (identity.endsWith('\\')) return;
    spawnSync('icacls', [target, '/inheritance:r', '/grant:r', `${identity}:F`], { windowsHide: true, stdio: 'ignore' });
  }
}

/** 面板默认主题取 style.yaml 的 theme。 */
export function defaultWeWriteTheme(styleText: string | null): string {
  return yamlScalar(styleText, 'theme') || 'professional-clean';
}

/** 内置两套主题 + 本机 ~/wewrite 仓库与 ~/.wewrite/themes 下的自定义主题。 */
export function listLocalWeWriteThemes(homeDir: string, home = weWriteHome()): WeWriteTheme[] {
  const themes = new Map<string, string>([['elder-clear', '中老年友好大字号'], ['professional-clean', '简洁排版']]);
  for (const directory of [path.join(homeDir, 'wewrite', 'src', 'wewrite', 'toolkit', 'themes'), path.join(home, 'themes')]) {
    if (!fs.existsSync(directory)) continue;
    for (const filename of fs.readdirSync(directory)) {
      if (!filename.endsWith('.yaml')) continue;
      const source = readTextFile(path.join(directory, filename));
      themes.set(filename.slice(0, -5), yamlScalar(source, 'description'));
    }
  }
  return [...themes].map(([name, description]) => ({ name, description }));
}

/**
 * 内容方向是 style.yaml 里 topics / default_topic 的唯一来源：
 * 两份配置各写一份必然漂移，这里在保存分类时统一回写，agent 侧的 WeWrite 流程也能读到。
 */
export function syncStyleTopics(topics: string[], defaultTopic: string, home = weWriteHome()): void {
  try {
    const { styleText } = readWeWriteFiles(home);
    if (styleText === null) return;
    // 其余字段原样带回去，只替换 topics / default_topic，绝不动用户填过的内容。
    const style = parseStyleSummary(styleText);
    writeWeWriteFile(path.join(home, 'style.yaml'), serializeStyleConfig({ ...style, topics, defaultTopic }));
  } catch {
    // style.yaml 缺失或不可写时不影响分类本身落库。
  }
}
