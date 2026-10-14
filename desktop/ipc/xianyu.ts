import { ipcMain } from 'electron';
import type { SiteViewBounds } from '../shared';
import type { XianyuView } from '../services/xianyu-view';

/* ── 变现 · 闲鱼 ─────────────────────────────────────────────
 * 把闲鱼网页版嵌进窗口。页面开在主进程的 WebContentsView 里，渲染进程只报位置、发操作。
 * 状态同样不进 state:get：每次导航、标题变化都会变。
 */
export function registerXianyuIpc(xianyuView: XianyuView): void {
  ipcMain.handle('xianyu:view:state', () => xianyuView.state());
  ipcMain.handle('xianyu:view:open', () => xianyuView.show());
  ipcMain.handle('xianyu:view:close', () => { xianyuView.close(); });
  ipcMain.handle('xianyu:view:bounds', (_event, bounds: SiteViewBounds | null) => { xianyuView.setBounds(bounds); });
  ipcMain.handle('xianyu:view:go', (_event, action: 'back' | 'reload' | 'home') => xianyuView.go(action));
  ipcMain.handle('xianyu:view:external', () => { xianyuView.openExternal(); });
}
