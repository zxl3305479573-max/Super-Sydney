/**
 * 前台窗口采样 → 活动片段。
 * 同一窗口连续停留只记一条并累计时长；只出现一次采样的窗口（切换途中一闪而过）不入库。
 */

const BROWSER_SUFFIX = /\s+[-—–]\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Firefox|Brave|Opera|Vivaldi|Arc)$/i;
// 终端 / CLI 标题前常带进度转圈或状态符号（✳ ◑ ⠋ ● 等），每次采样都不同，会把同一任务拆成多条。
const LEADING_GLYPHS = /^[\p{S}\s]+/u;
const SELF_WINDOW = /Sydney\s*·\s*个人工作 OS/;

export function normalizeWindowTitle(appName: string, title: string): string {
  let value = title.replace(/\s+/g, ' ').trim().replace(BROWSER_SUFFIX, '');
  const app = appName.trim();
  if (app && value.toLowerCase().endsWith(` - ${app.toLowerCase()}`)) value = value.slice(0, -(app.length + 3));
  value = value.replace(LEADING_GLYPHS, '').trim();
  return value === app ? '' : value;
}

export function isSelfWindow(title: string): boolean {
  return SELF_WINDOW.test(title);
}

export type SegmentAction =
  | { type: 'none' }
  | { type: 'insert'; startedAt: number; durationSeconds: number }
  | { type: 'update'; eventId: number; durationSeconds: number };

export class ActivitySegmenter {
  private current: { key: string; startedAt: number; lastSeenAt: number; eventId?: number } | undefined;

  /** key 为空表示本次采样不记录（被拦截、无应用名等），当前片段就此结束。 */
  observe(key: string | null, now: number, maxGapMs: number): SegmentAction {
    const current = this.current;
    if (!key) { this.current = undefined; return { type: 'none' }; }
    if (!current || current.key !== key || now - current.lastSeenAt > maxGapMs) {
      this.current = { key, startedAt: now, lastSeenAt: now };
      return { type: 'none' };
    }
    current.lastSeenAt = now;
    const durationSeconds = Math.max(1, Math.round((now - current.startedAt) / 1000));
    return current.eventId === undefined ? { type: 'insert', startedAt: current.startedAt, durationSeconds } : { type: 'update', eventId: current.eventId, durationSeconds };
  }

  attach(eventId: number): void {
    if (this.current) this.current.eventId = eventId;
  }

  /** 片段对应的事件已被确认或删除：从现在起重新计一个片段。 */
  restart(now: number): void {
    if (this.current) this.current = { key: this.current.key, startedAt: now, lastSeenAt: now };
  }

  reset(): void {
    this.current = undefined;
  }
}
