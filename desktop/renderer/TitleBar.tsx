import { useEffect, useState, type ReactNode } from 'react';
import type { AppTheme, WindowChromeState, WindowControl } from '../shared';

const INITIAL: WindowChromeState = { maximized: false, fullscreen: false, focused: true, platform: 'win32' };

/** 窗口的最大化 / 焦点状态，主进程在变化时推过来。 */
export function useWindowChrome(): WindowChromeState {
  const [chrome, setChrome] = useState(INITIAL);
  useEffect(() => {
    let alive = true;
    void window.sydney.getWindowChrome().then(next => { if (alive) setChrome(next); });
    const off = window.sydney.onWindowChromeChanged(setChrome);
    return () => { alive = false; off(); };
  }, []);
  return chrome;
}

/* Windows 11 风格的标题栏按钮字形：10px 方格、1px 线。 */
const GLYPHS: Record<'minimize' | 'maximize' | 'restore' | 'close', ReactNode> = {
  minimize: <path d="M0 5.5h10" />,
  maximize: <rect x=".5" y=".5" width="9" height="9" rx="1.5" />,
  restore: <><rect x=".5" y="2.5" width="7" height="7" rx="1.3" /><path d="M2.5 2.5v-.7A1.3 1.3 0 0 1 3.8.5h4.4a1.3 1.3 0 0 1 1.3 1.3v4.4a1.3 1.3 0 0 1-1.3 1.3h-.7" /></>,
  close: <path d="m.5.5 9 9m0-9-9 9" />
};

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">{GLYPHS[name]}</svg>;
}

/**
 * 浅色 / 深色开关。点下去时把滑块中心交出去，新主题从这里扩散开。
 * 用 role="switch"：读屏读出「深色模式 开/关」。
 */
function ThemeSwitch({ theme, onToggle }: { theme: AppTheme; onToggle: (origin: { x: number; y: number }) => void }) {
  const dark = theme === 'dark';
  return <button type="button" role="switch" aria-checked={dark} aria-label="深色模式" title={dark ? '切换到浅色' : '切换到深色'}
    className={`theme-switch ${dark ? 'is-dark' : ''}`}
    onClick={event => {
      const knob = (event.currentTarget.querySelector('.theme-switch-knob') ?? event.currentTarget).getBoundingClientRect();
      onToggle({ x: knob.left + knob.width / 2, y: knob.top + knob.height / 2 });
    }}>
    <span className="theme-switch-knob" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {dark
          ? <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" />
          : <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" /></>}
      </svg>
    </span>
  </button>;
}

/**
 * 自绘标题栏：整条可拖动（双击最大化由系统处理），左边是当前位置，右边是窗口按钮。
 * macOS 用系统红绿灯，不画按钮。
 */
export function TitleBar({ crumbs, chrome, scrolled, theme, onToggleTheme }: {
  crumbs: string[]; chrome: WindowChromeState; scrolled: boolean;
  theme: AppTheme; onToggleTheme: (origin: { x: number; y: number }) => void;
}) {
  const control = (action: WindowControl) => void window.sydney.windowControl(action);
  return <header className={`titlebar ${scrolled ? 'is-scrolled' : ''}`}>
    <div className="titlebar-crumbs" aria-label="当前位置">
      {crumbs.map((crumb, index) => <span key={crumb} className={index === crumbs.length - 1 ? 'is-current' : ''}>{crumb}</span>)}
    </div>
    <div className="titlebar-tools">
      <ThemeSwitch theme={theme} onToggle={onToggleTheme} />
    </div>
    {chrome.platform !== 'darwin' && <div className="window-controls">
      <button type="button" className="window-control" title="最小化" aria-label="最小化" onClick={() => control('minimize')}><Glyph name="minimize" /></button>
      <button type="button" className="window-control" title={chrome.maximized ? '向下还原' : '最大化'} aria-label={chrome.maximized ? '向下还原' : '最大化'} onClick={() => control('toggle-maximize')}><Glyph name={chrome.maximized ? 'restore' : 'maximize'} /></button>
      <button type="button" className="window-control is-close" title="关闭" aria-label="关闭" onClick={() => control('close')}><Glyph name="close" /></button>
    </div>}
  </header>;
}
