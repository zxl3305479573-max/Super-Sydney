import type { Settings } from '../shared.ts';
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
