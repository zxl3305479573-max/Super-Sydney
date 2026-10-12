import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type { ArticleStatsImportResult, ArticleStatsView } from '../shared';
import { buildStatsView, tableToStatInputs } from '../services/article-stats';
import { deleteArticleStat, listArticleStats, upsertArticleStats } from '../services/article-stats-store';
import { listContentTasks } from '../services/content-store';
import { readTableFile } from '../services/table-file';

/* ── 公众号文章数据 ─────────────────────────────────────────────
 * 账号未认证，datacube 接口返回 48001，数据只能由用户从后台导出后导入。
 * 这里只做确定性的解析、存储与汇总；"为什么这篇好"的分析交给 agent 侧 skill。
 */

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** profileId 非空时只看这份公众号资料的文章。 */
function currentView(ctx: AppContext, profileId: unknown): ArticleStatsView {
  const id = Number(profileId);
  return buildStatsView(listArticleStats(ctx.db), listContentTasks(ctx.db), Number.isInteger(id) && id > 0 ? id : null);
}

export function registerArticleStatsIpc(ctx: AppContext): void {
  ipcMain.handle('wewrite:stats:list', (_event, profileId: number | null) => currentView(ctx, profileId));

  ipcMain.handle('wewrite:stats:import', async (_event, profileId: number | null): Promise<ArticleStatsImportResult | null> => {
    const parent = ctx.window();
    const options = { properties: ['openFile' as const], filters: [{ name: '数据表', extensions: ['xlsx', 'xls', 'csv', 'tsv', 'txt'] }] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > MAX_IMPORT_BYTES) throw new Error('文件超过 20MB，不像是公众号数据导出');
    const inputs = tableToStatInputs(readTableFile(fs.readFileSync(file), path.basename(file)));
    const { added, updated } = upsertArticleStats(ctx.db, inputs, `import:${path.basename(file)}`);
    return { file: path.basename(file), added, updated, view: currentView(ctx, profileId) };
  });

  ipcMain.handle('wewrite:stats:delete', (_event, id: number, profileId: number | null): ArticleStatsView => {
    deleteArticleStat(ctx.db, Number(id));
    return currentView(ctx, profileId);
  });
}
