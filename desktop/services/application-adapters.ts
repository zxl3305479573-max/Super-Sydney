export type ApplicationAdapter = 'vscode' | 'terminal' | 'browser' | 'generic';

export function classifyApplication(appName: string, title: string): {
  adapter: ApplicationAdapter;
  note: string;
  summary: string;
} {
  const app = appName.toLowerCase();
  const window = title.trim();
  const identity = window || appName.trim() || '未知应用';
  if (app.includes('code') || app.includes('visual studio')) {
    return { adapter: 'vscode', note: `${appName}：${identity}`, summary: identity };
  }
  if (app.includes('terminal') || app.includes('powershell') || app.includes('cmd')) {
    return { adapter: 'terminal', note: `${appName}：${identity}`, summary: identity };
  }
  if (app.includes('chrome') || app.includes('edge') || app.includes('firefox') || app.includes('browser')) {
    return { adapter: 'browser', note: `${appName}：${identity}`, summary: identity };
  }
  return { adapter: 'generic', note: `${appName || '未知应用'}${window ? `：${window}` : ''}`, summary: identity };
}
