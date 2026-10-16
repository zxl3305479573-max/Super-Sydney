import fs from 'node:fs';
import { writeFileAtomic } from './atomic-file.ts';

export type WindowRect = { x: number; y: number; width: number; height: number };
export type WindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean };

export const DEFAULT_WINDOW_SIZE = { width: 1320, height: 860 };
export const MIN_WINDOW_SIZE = { width: 980, height: 680 };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * 把上次保存的窗口状态还原成可用的位置与尺寸。
 *
 * - 尺寸不小于最小窗口、不大于最大的那块显示器工作区；
 * - 位置要让标题栏中段落在某块显示器的工作区里，否则（显示器已拔掉、分辨率变了）丢掉位置，交给系统居中；
 * - 读到的内容不是对象时整份退回默认值。
 */
export function restoreWindowState(raw: unknown, workAreas: WindowRect[]): WindowState {
  const saved = raw && typeof raw === 'object' ? raw as Partial<WindowState> : {};
  const maxWidth = Math.max(MIN_WINDOW_SIZE.width, ...workAreas.map(area => area.width));
  const maxHeight = Math.max(MIN_WINDOW_SIZE.height, ...workAreas.map(area => area.height));
  const clamp = (value: unknown, fallback: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, finite(value) ? value : fallback)));
  const width = clamp(saved.width, DEFAULT_WINDOW_SIZE.width, MIN_WINDOW_SIZE.width, maxWidth);
  const height = clamp(saved.height, DEFAULT_WINDOW_SIZE.height, MIN_WINDOW_SIZE.height, maxHeight);
  const state: WindowState = { width, height, maximized: saved.maximized === true };
  if (finite(saved.x) && finite(saved.y)) {
    const probeX = saved.x + width / 2;
    const probeY = saved.y + 16;
    const visible = workAreas.some(area => probeX >= area.x && probeX <= area.x + area.width && probeY >= area.y && probeY <= area.y + area.height);
    if (visible) Object.assign(state, { x: Math.round(saved.x), y: Math.round(saved.y) });
  }
  return state;
}

/**
 * 关窗时该记下的位置与尺寸。
 * Windows 在非整数缩放（比如 175%）下，按某个尺寸建窗后读回来的边界会多出 1~4px；直接存读回值，
 * 每次启动窗口都会长大一点。所以拿建窗后立即读回的边界做参照：某一项基本没变（用户没拖动、没缩放），
 * 就沿用当初请求的值；变了才记新值。
 */
export function settleWindowBounds(requested: Partial<WindowRect>, reported: WindowRect, current: WindowRect, tolerance = 8): WindowRect {
  const pick = (key: keyof WindowRect) => {
    const asked = requested[key];
    return finite(asked) && Math.abs(current[key] - reported[key]) <= tolerance ? asked : current[key];
  };
  return { x: pick('x'), y: pick('y'), width: pick('width'), height: pick('height') };
}

/** 窗口底色要和界面主题一致，否则启动、缩放窗口时边缘会闪一下另一种底色。 */
export const WINDOW_BACKGROUND = { light: '#f4f5f8', dark: '#111318' } as const;

/** 上次选的主题；没选过返回 null（界面跟随系统）。 */
export function readSavedTheme(file: string): 'light' | 'dark' | null {
  try {
    const theme = (JSON.parse(fs.readFileSync(file, 'utf8')) as { theme?: unknown }).theme;
    return theme === 'dark' || theme === 'light' ? theme : null;
  } catch {
    return null;
  }
}

export function writeSavedTheme(file: string, theme: 'light' | 'dark'): void {
  try { writeFileAtomic(file, JSON.stringify({ theme })); } catch { /* 记不下只影响下次启动的窗口底色 */ }
}

export function readWindowState(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 记下「还原状态」的位置：最大化时 getNormalBounds 给的是还原后的尺寸，下次启动先按它建窗再最大化。 */
export function writeWindowState(file: string, bounds: WindowRect, maximized: boolean): void {
  try { writeFileAtomic(file, JSON.stringify({ ...bounds, maximized })); } catch { /* 记不下位置不影响退出 */ }
}
