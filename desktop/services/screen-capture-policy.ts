const DEFAULT_SENSITIVE_TITLE_PATTERN = /password|passwd|sign in|login|payment|checkout|bank|1password|keepass|bitwarden|密码|支付|银行卡|私聊|private/i;

export type ScreenCaptureDecision = {
  allowed: boolean;
  reason: 'missing-app' | 'blocked-app' | 'sensitive-window' | 'not-allowed-app' | 'allowed';
};

export function shouldCaptureScreen(input: {
  appName: string;
  windowTitle: string;
  allowedApps: string[];
  blockedApps: string[];
}): ScreenCaptureDecision {
  const appName = input.appName.trim();
  const windowTitle = input.windowTitle.trim();
  if (!appName) return { allowed: false, reason: 'missing-app' };

  const identity = `${appName} ${windowTitle}`.toLowerCase();
  if (input.blockedApps.some(item => identity.includes(item.trim().toLowerCase()))) {
    return { allowed: false, reason: 'blocked-app' };
  }
  if (DEFAULT_SENSITIVE_TITLE_PATTERN.test(windowTitle)) {
    return { allowed: false, reason: 'sensitive-window' };
  }
  if (input.allowedApps.length && !input.allowedApps.some(item => appName.toLowerCase().includes(item.trim().toLowerCase()))) {
    return { allowed: false, reason: 'not-allowed-app' };
  }
  return { allowed: true, reason: 'allowed' };
}
