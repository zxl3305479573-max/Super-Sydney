const DEFAULT_SENSITIVE_WORDS = [
  'password', 'passwd', 'sign in', 'login', 'payment', 'checkout', 'bank',
  '1password', 'keepass', 'bitwarden', '密码', '支付', '银行卡', '私聊', 'private'
];

function matches(name, candidate) {
  return String(name || '').toLowerCase().includes(String(candidate || '').toLowerCase());
}

function shouldCapture(window, settings) {
  const appName = window?.appName || '';
  if (!appName) return false;
  if ((settings.blockedApps || []).some(item => matches(appName, item))) return false;
  if ((settings.allowedApps || []).length && !(settings.allowedApps || []).some(item => matches(appName, item))) return false;
  return sanitizeWindow(window, settings).capture;
}

function sanitizeWindow(window, settings = {}) {
  const title = String(window?.title || '');
  const sensitiveWords = settings.sensitiveWords || DEFAULT_SENSITIVE_WORDS;
  const sensitive = sensitiveWords.some(word => matches(title, word)) || (settings.blockedApps || []).some(word => matches(title, word));
  if (sensitive) return { capture: false, appName: window?.appName || '', windowTitle: '[敏感窗口已跳过]' };
  return { capture: true, appName: window?.appName || '', windowTitle: title.slice(0, 240) };
}

function retentionCutoff(now = new Date(), hours = 48) {
  return new Date(now.getTime() - Math.max(1, Number(hours) || 48) * 60 * 60 * 1000);
}

module.exports = { DEFAULT_SENSITIVE_WORDS, shouldCapture, sanitizeWindow, retentionCutoff };
