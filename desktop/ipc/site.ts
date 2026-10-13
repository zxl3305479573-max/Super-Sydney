import { ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type { SiteEntry, SiteViewBounds } from '../shared';
import type { SiteView } from '../services/site-view';

/* ── 变现 · 站点模块（AI 代充） ─────────────────────────────────
 * 把现成的第三方站点嵌进窗口，可以有一串，同一时刻显示选中的那个。
 * 站点开在主进程的 WebContentsView 里，渲染进程只报位置、发操作；
 * 登录态留在站点自己的会话分区，应用不读它的 cookie、也不注入脚本。
 *
 * 站点状态刻意不进 state:get：它变化频繁（每次导航、每次标题变化），
 * 混进全局状态会让整个界面跟着重拉。
 */
export function registerSiteIpc(ctx: AppContext, siteView: SiteView): void {
  ipcMain.handle('site:state', () => siteView.state());
  ipcMain.handle('site:save', (_event, sites: SiteEntry[], activateId: string | null = null) => siteView.save(sites, activateId));
  ipcMain.handle('site:activate', (_event, id: string) => siteView.activate(id));
  ipcMain.handle('site:open', () => siteView.show());
  ipcMain.handle('site:close', () => { siteView.close(); });
  ipcMain.handle('site:bounds', (_event, bounds: SiteViewBounds | null) => { siteView.setBounds(bounds); });
  ipcMain.handle('site:go', (_event, action: 'back' | 'reload' | 'home') => siteView.go(action));
  ipcMain.handle('site:external', () => { siteView.openExternal(); });
}
