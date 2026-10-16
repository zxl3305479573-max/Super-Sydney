import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AppTheme } from '../shared';

/**
 * 浅色 / 深色主题。
 * 选择存在本机 localStorage（index.html 里的内联脚本在首帧前就按它设好 data-theme，不会先闪一下浅色），
 * 同时告诉主进程：窗口底色、右键菜单这些系统部件跟着换。没选过时跟随系统。
 */
const THEME_KEY = 'sydney.theme';

export function currentTheme(): AppTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function remember(theme: AppTheme): void {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 存不下只影响下次启动的默认值 */ }
}

function apply(theme: AppTheme, onApplied?: () => void): void {
  document.documentElement.dataset.theme = theme;
  onApplied?.();
  remember(theme);
}

/** 通知主进程换系统部件的主题。这一步会让窗口和嵌入网页整体重新应用配色，很重，不能和动画抢同一段时间。 */
function syncNative(theme: AppTheme): void {
  void window.sydney.setTheme(theme).catch(() => undefined);
}

/** 连点时只让最后一次切换做收尾，前一次的收尾不能清掉正在进行的这次的状态。 */
let switching = 0;

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> } };

const REVEAL_MS = 600;
const REVEAL_EASING = 'cubic-bezier(.33, 0, .2, 1)';
const NEW_VIEW = '::view-transition-new(root)';

/**
 * 切换主题：新主题从 origin（开关的位置）以圆形扩散盖满整个界面。
 *
 * 用 View Transitions：浏览器截下旧画面，换主题，再把新画面按扩大的圆形裁切显示。
 * 实测（真实数据，六千多个节点）换主题那一帧的样式重算要 100ms 左右；如果动画在这之前就开始计时，
 * 第一帧画出来时圆已经扩到一半，看上去像从顶部扫下来。所以：
 *   1. 新画面先被 CSS 裁成半径 0（styles.css 的 theme-hold，同时撑住过渡不提前结束）；
 *   2. 重活那一帧过去之后（ready + 一帧）才从 0 开始放大；
 *   3. 收尾的重活（恢复元素过渡、通知主进程换系统主题）推迟到动画结束之后一段时间，不和最后一帧挤在一起。
 * 不支持或用户要求减少动效时直接切换。
 */
export function switchTheme(next: AppTheme, origin?: { x: number; y: number }, onApplied?: () => void): void {
  const doc = document as ViewTransitionDocument;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!doc.startViewTransition || reduce || !origin) { apply(next, onApplied); syncNative(next); return; }
  const { x, y } = origin;
  const radius = Math.ceil(Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)));
  const root = document.documentElement;
  const turn = ++switching;
  const transition = doc.startViewTransition(() => {
    // 圆心变量、关掉元素过渡、换主题放在同一次更新里：只触发一次全量样式重算。
    root.style.setProperty('--reveal-x', `${x}px`);
    root.style.setProperty('--reveal-y', `${y}px`);
    root.dataset.themeSwitching = '';
    apply(next, onApplied);
  });
  void transition.ready.then(() => requestAnimationFrame(() => {
    const reveal = root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: REVEAL_MS, easing: REVEAL_EASING, fill: 'forwards', pseudoElement: NEW_VIEW }
    );
    // 扩散放完后撤掉撑场的 theme-hold，过渡随之结束。
    void reveal.finished.then(() => {
      for (const animation of document.getAnimations()) {
        if (animation instanceof CSSAnimation && animation.animationName === 'theme-hold') animation.cancel();
      }
    }).catch(() => undefined);
  })).catch(() => undefined);
  void transition.finished.catch(() => undefined).then(() => {
    window.setTimeout(() => {
      if (turn === switching) delete root.dataset.themeSwitching;
      syncNative(next);
    }, 250);
  });
}

export function useTheme(): [AppTheme, (origin?: { x: number; y: number }) => void] {
  const [theme, setTheme] = useState<AppTheme>(currentTheme);
  // 启动时把首帧用的主题同步给主进程（第一次运行时主进程还不知道系统偏好下选了哪个）。
  useEffect(() => { void window.sydney.setTheme(currentTheme()).catch(() => undefined); }, []);
  const toggle = useCallback((origin?: { x: number; y: number }) => {
    const next: AppTheme = currentTheme() === 'dark' ? 'light' : 'dark';
    // 开关的图标在回调里同步更新：旧画面的截图里还是旧状态，新画面里才是新状态。
    switchTheme(next, origin, () => flushSync(() => setTheme(next)));
  }, []);
  return [theme, toggle];
}
