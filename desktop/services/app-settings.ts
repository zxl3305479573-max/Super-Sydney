import type { Settings } from '../shared.ts';
import { resolveVaultPath } from './vault-path.ts';

export function defaultSettings(defaultVaultPath: string, projectPath: string): Settings {
  return {
    captureEnabled: false,
    capturePaused: false,
    codexCaptureEnabled: false,
    allowedApps: ['Code', 'Visual Studio Code', 'Obsidian', 'Google Chrome', 'Microsoft Edge', 'Terminal', 'PowerShell'],
    blockedApps: ['1Password', 'KeePass', '微信', 'WhatsApp', 'Telegram'],
    captureIntervalSeconds: 30,
    vaultPath: resolveVaultPath(undefined, defaultVaultPath, projectPath)
  };
}

export function mergeSettings(value: Partial<Settings>, defaultVaultPath: string, projectPath: string): Settings {
  const defaults = defaultSettings(defaultVaultPath, projectPath);
  return { ...defaults, ...value, vaultPath: resolveVaultPath(value.vaultPath, defaultVaultPath, projectPath) };
}
