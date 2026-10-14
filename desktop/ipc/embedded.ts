import { ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type { EmbeddedSiteKey, SiteViewBounds } from '../shared';
import { EMBEDDED_SITES, EmbeddedView, embeddedSite } from '../services/embedded-view';

/* ── 变现 · 固定嵌入的站点（闲鱼、16688 …） ───────────────────────
 * 每个站点一个 EmbeddedView，按 key 区分；渲染进程只报位置、发操作。
 * 状态不进 state:get：每次导航、标题变化都会变，变化走 embed:changed（带 key）。
 */
export function registerEmbeddedIpc(ctx: AppContext): { dispose(): void } {
  const views = new Map<EmbeddedSiteKey, EmbeddedView>();
  for (const site of Object.values(EMBEDDED_SITES)) views.set(site.key, new EmbeddedView(ctx, site));
  const view = (key: unknown) => views.get(embeddedSite(key).key) as EmbeddedView;

  ipcMain.handle('embed:state', (_event, key: EmbeddedSiteKey) => view(key).state());
  ipcMain.handle('embed:open', (_event, key: EmbeddedSiteKey) => view(key).show());
  ipcMain.handle('embed:close', (_event, key: EmbeddedSiteKey) => { view(key).close(); });
  ipcMain.handle('embed:bounds', (_event, key: EmbeddedSiteKey, bounds: SiteViewBounds | null) => { view(key).setBounds(bounds); });
  ipcMain.handle('embed:go', (_event, key: EmbeddedSiteKey, action: 'back' | 'reload' | 'home') => view(key).go(action === 'back' || action === 'home' ? action : 'reload'));
  ipcMain.handle('embed:external', (_event, key: EmbeddedSiteKey) => { view(key).openExternal(); });

  return { dispose: () => { for (const item of views.values()) item.dispose(); } };
}
