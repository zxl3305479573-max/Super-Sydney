import fs from 'node:fs';
import type { Settings } from '../shared.ts';
import { writeFileAtomic } from './atomic-file.ts';
import { resolveVaultPath } from './vault-path.ts';

export function defaultSettings(defaultVaultPath: string, projectPath: string): Settings {
  return {
    captureEnabled: false,
    capturePaused: false,
    codexCaptureEnabled: false,
    codexIncludeCli: false,
    claudeCaptureEnabled: false,
    claudeExtraRoots: [],
    llmEnabled: false,
    allowedApps: ['Codex', 'Codex Desktop', 'Claude', 'Code', 'Visual Studio Code', 'Obsidian', 'Google Chrome', 'Microsoft Edge', 'Terminal', 'PowerShell'],
    blockedApps: ['1Password', 'KeePass', '微信', 'WhatsApp', 'Telegram'],
    captureIntervalSeconds: 30,
    captureAllPending: true,
    vaultPath: resolveVaultPath(undefined, defaultVaultPath, projectPath),
    screenCaptureEnabled: false,
    screenCaptureIntervalSeconds: 60,
    screenRetentionHours: 24,
    inputWatchEnabled: false,
    inputWatchPaths: []
  };
}

export function mergeSettings(value: Partial<Settings>, defaultVaultPath: string, projectPath: string): Settings {
  const defaults = defaultSettings(defaultVaultPath, projectPath);
  const legacyAllowedApps = ['Code', 'Visual Studio Code', 'Obsidian', 'Google Chrome', 'Microsoft Edge', 'Terminal', 'PowerShell'];
  const configuredApps = Array.isArray(value.allowedApps) ? value.allowedApps : defaults.allowedApps;
  const isLegacyAllowList = legacyAllowedApps.length === configuredApps.length && legacyAllowedApps.every(app => configuredApps.includes(app));
  const allowedApps = isLegacyAllowList ? [...configuredApps, 'Codex', 'Codex Desktop'] : configuredApps;
  return { ...defaults, ...value, allowedApps, vaultPath: resolveVaultPath(value.vaultPath, defaultVaultPath, projectPath) };
}

/**
 * 校验渲染进程提交的设置补丁：只收已知字段，类型必须与默认值一致。
 * 未知字段直接丢弃（不会写进 settings.json）；类型不对时抛错而不是静默写坏配置。
 */
export function sanitizeSettingsPatch(input: unknown, defaults: Settings): Partial<Settings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式不正确');
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(key in defaults)) continue;
    const expected = defaults[key as keyof Settings];
    if (Array.isArray(expected)) {
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error(`设置项 ${key} 必须是文本列表`);
      patch[key] = value.map(item => item.trim()).filter(Boolean);
    } else if (typeof expected === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`设置项 ${key} 必须是非负数字`);
      patch[key] = value;
    } else if (typeof value !== typeof expected) {
      throw new Error(`设置项 ${key} 类型不正确`);
    } else {
      patch[key] = value;
    }
  }
  return patch as Partial<Settings>;
}

/** settings.json 的读写；读失败时回退默认值，写入走原子写。 */
export class SettingsFile {
  private readonly filePath: string;
  private readonly defaultVaultPath: string;
  private readonly projectPath: string;

  constructor(filePath: string, defaultVaultPath: string, projectPath: string) {
    this.filePath = filePath;
    this.defaultVaultPath = defaultVaultPath;
    this.projectPath = projectPath;
  }

  read(): Settings {
    try { return mergeSettings(JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '')) as Partial<Settings>, this.defaultVaultPath, this.projectPath); }
    catch { return defaultSettings(this.defaultVaultPath, this.projectPath); }
  }

  /**
   * 原子写：直接覆盖写一旦在写一半时被杀进程/被同步工具抢锁，
   * 文件会截断，read() 解析失败后会静默回退到默认值——用户看到的就是“配置全没了”。
   */
  write(config: Settings): void {
    writeFileAtomic(this.filePath, JSON.stringify(config, null, 2));
  }

  /** 知识库路径必须与项目目录分离；校验失败直接抛错。 */
  resolveVault(configured: string | undefined): string {
    return resolveVaultPath(configured, this.defaultVaultPath, this.projectPath);
  }
}
