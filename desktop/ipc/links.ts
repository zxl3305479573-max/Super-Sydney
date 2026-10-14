import { ipcMain, shell } from 'electron';
import type { AppContext } from '../app-context';
import type { LinkInput } from '../shared';
import { createLink, deleteLink, getLink, listLinks, markLinkOpened, updateLink } from '../services/link-store';

/**
 * 成长 · 链接收藏。独立的 links:* 通道，不进 state:get。
 * 打开链接时只认库里存的地址（入库时已限定 http/https），不接收渲染进程直接传来的网址。
 */
export function registerLinksIpc(ctx: AppContext): void {
  const { db } = ctx;
  ipcMain.handle('links:list', () => listLinks(db));
  ipcMain.handle('links:create', (_event, input: LinkInput) => createLink(db, input));
  ipcMain.handle('links:update', (_event, id: number, input: LinkInput) => updateLink(db, Number(id), input));
  ipcMain.handle('links:delete', (_event, id: number) => { deleteLink(db, Number(id)); });
  ipcMain.handle('links:open', async (_event, id: number) => {
    await shell.openExternal(getLink(db, Number(id)).url);
    return markLinkOpened(db, Number(id));
  });
}
