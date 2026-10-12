export type CaptureObservation = {
  state: 'sampling' | 'blocked';
  appName: string;
  windowTitle: string;
  sampledAt: string;
  message: string;
};

export function describeCaptureObservation(input: {
  appName: string;
  windowTitle: string;
  allowed: boolean;
  blocked: boolean;
  saveUnallowed?: boolean;
  sampledAt: string;
}): CaptureObservation {
  const accepted = Boolean(input.appName) && !input.blocked && (input.allowed || input.saveUnallowed === true);
  const identity = `${input.appName || '未知应用'}${input.windowTitle ? ` · ${input.windowTitle}` : ''}`;
  return {
    state: accepted ? 'sampling' : 'blocked',
    appName: input.appName,
    windowTitle: input.windowTitle,
    sampledAt: input.sampledAt,
    message: accepted
      ? `${input.allowed ? '已采样' : '已保存待确认'}：${identity}`
      : `未采样：${identity}（${input.blocked ? '当前窗口在禁止采集名单中' : '当前应用不在允许采集名单中'}）`
  };
}
