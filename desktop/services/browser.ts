import { shell } from 'electron';
import { openInBrowser } from './open-in-browser';

/** 在浏览器里打开网址：优先 Chrome，没装 Chrome 时用系统默认浏览器（见 open-in-browser.ts）。 */
export function openUrl(url: string): Promise<void> {
  return openInBrowser(url, target => shell.openExternal(target));
}
