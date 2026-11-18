import { ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type {
  FeishuConfigDraft,
  FeishuConfigView,
  OpsEpisodeInput,
  OpsEpisodeReview,
  OpsEpisodeWithTasks,
  OpsOverviewView,
  OpsPlatform,
  OpsSyncResult,
  OpsTaskPatch,
  OpsTaskState
} from '../shared';
import {
  buildDailyReportCard,
  buildEpisodeReviewCard,
  buildLoginExpiredCard,
  getFeishuConfigView,
  readFeishuSettings,
  resolveFeishuCredentials,
  saveFeishuConfig,
  sendFeishuCard
} from '../services/feishu-notify';
import { syncOpsPlatforms } from '../services/ops-collector';
import { buildEpisodeReview, buildOpsOverview } from '../services/ops-review';
import {
  appendOpsLog,
  deleteOpsEpisode,
  getOpsEpisodeWithTasks,
  hasNotifiedMilestone,
  listEpisodeMetrics,
  listOpsEpisodesWithTasks,
  markMilestoneNotified,
  setOpsPlatformTask,
  upsertOpsEpisode
} from '../services/ops-store';
import type { VideoPublisherView } from '../services/video-publisher-view';

export function registerOpsIpc(ctx: AppContext, publisherView: VideoPublisherView): void {
  const { db } = ctx;
  let syncing = false;

  ipcMain.handle('ops:overview', (): OpsOverviewView => buildOpsOverview(db));

  ipcMain.handle('ops:episode:upsert', (_event, input: OpsEpisodeInput): OpsEpisodeWithTasks => {
    const saved = upsertOpsEpisode(db, input);
    ctx.notifyOpsChanged();
    return saved;
  });

  ipcMain.handle('ops:episode:delete', (_event, id: number): void => {
    deleteOpsEpisode(db, Number(id));
    ctx.notifyOpsChanged();
  });

  ipcMain.handle('ops:task:update', (
    _event,
    episodeId: number,
    platform: OpsPlatform,
    state: OpsTaskState,
    patch: OpsTaskPatch
  ): OpsEpisodeWithTasks => {
    setOpsPlatformTask(db, Number(episodeId), platform, state, patch);
    appendOpsLog(db, Number(episodeId), platform, `手动更新状态 → ${state}`, patch.postUrl || patch.detail || '');
    ctx.notifyOpsChanged();
    return getOpsEpisodeWithTasks(db, Number(episodeId));
  });

  ipcMain.handle('ops:review:get', (_event, episodeId: number, ageDays: number | null): OpsEpisodeReview =>
    buildEpisodeReview(db, Number(episodeId), ageDays ?? undefined));

  ipcMain.handle('ops:sync:run', async (_event, platforms: OpsPlatform[] | null): Promise<OpsSyncResult> => {
    if (syncing) throw new Error('正在同步创作者后台数据，请等待当前同步结束');
    syncing = true;
    try {
      const results = await syncOpsPlatforms(
        db,
        (platform, url, ready, extract) => publisherView.inspectCreatorDom(platform, url, ready, extract),
        platforms
      );

      let notified = false;
      const feishuCfg = readFeishuSettings(ctx.dataDir);
      const creds = resolveFeishuCredentials(ctx.feishuWebhookStore, ctx.feishuSecretStore);

      if (creds.webhookUrl) {
        const expired = results.filter(item => !item.loginOk).map(item => item.platform);
        if (feishuCfg.notifyOnLoginExpired && expired.length > 0) {
          await sendFeishuCard(creds.webhookUrl, buildLoginExpiredCard(expired), { secret: creds.secret })
            .then(() => { notified = true; })
            .catch(err => appendOpsLog(db, null, 'feishu', '登录失效通知失败', err instanceof Error ? err.message : String(err)));
        }

        if (feishuCfg.notifyMilestoneReview) {
          for (const ep of listOpsEpisodesWithTasks(db).slice(0, 8)) {
            if (!listEpisodeMetrics(db, ep.id).length) continue;
            const review = buildEpisodeReview(db, ep.id);
            if ((review.ageDays === 1 || review.ageDays === 3 || review.ageDays === 7)
              && !hasNotifiedMilestone(db, ep.id, review.ageDays)
              && review.totalViews > 0) {
              await sendFeishuCard(creds.webhookUrl, buildEpisodeReviewCard(review), { secret: creds.secret })
                .then(() => {
                  markMilestoneNotified(db, ep.id, review.ageDays);
                  notified = true;
                })
                .catch(err => appendOpsLog(db, ep.id, 'feishu', '里程碑复盘推送失败', err instanceof Error ? err.message : String(err)));
            }
          }
        }
      }

      ctx.notifyOpsChanged();
      return { syncedAt: new Date().toISOString(), results, notified };
    } finally {
      syncing = false;
    }
  });

  ipcMain.handle('ops:feishu:get', (): FeishuConfigView =>
    getFeishuConfigView(ctx.dataDir, ctx.feishuWebhookStore, ctx.feishuSecretStore));

  ipcMain.handle('ops:feishu:save', (_event, draft: FeishuConfigDraft): FeishuConfigView => {
    const view = saveFeishuConfig(ctx.dataDir, ctx.feishuWebhookStore, ctx.feishuSecretStore, draft);
    ctx.notifyOpsChanged();
    return view;
  });

  ipcMain.handle('ops:feishu:test', async (): Promise<void> => {
    const creds = resolveFeishuCredentials(ctx.feishuWebhookStore, ctx.feishuSecretStore);
    if (!creds.webhookUrl) throw new Error('请先填写并保存飞书机器人 Webhook 地址');
    await sendFeishuCard(creds.webhookUrl, {
      title: '✅ Super-Sydney 飞书机器人连通成功',
      color: 'turquoise',
      sections: [
        '这是一条来自 **Super-Sydney 运营中控** 的测试卡片。',
        '启用对应通知开关后，多平台草稿就绪提醒、登录失效告警、每日跨平台日报与第 1/3/7 天同龄复盘都会自动推送到这里。'
      ],
      footer: 'Super-Sydney 运营中控'
    }, { secret: creds.secret });
  });

  ipcMain.handle('ops:feishu:notify-daily', async (): Promise<void> => {
    const creds = resolveFeishuCredentials(ctx.feishuWebhookStore, ctx.feishuSecretStore);
    if (!creds.webhookUrl) throw new Error('请先在「飞书通知」页配置 Webhook 地址');
    const overview = buildOpsOverview(db);
    await sendFeishuCard(creds.webhookUrl, buildDailyReportCard(overview), { secret: creds.secret });
    appendOpsLog(db, null, 'feishu', '手动推送跨平台日报', `总粉丝 ${overview.totalFollowers}`);
    ctx.notifyOpsChanged();
  });

  ipcMain.handle('ops:feishu:notify-review', async (_event, episodeId: number, ageDays: number | null): Promise<void> => {
    const creds = resolveFeishuCredentials(ctx.feishuWebhookStore, ctx.feishuSecretStore);
    if (!creds.webhookUrl) throw new Error('请先在「飞书通知」页配置 Webhook 地址');
    const review = buildEpisodeReview(db, Number(episodeId), ageDays ?? undefined);
    await sendFeishuCard(creds.webhookUrl, buildEpisodeReviewCard(review), { secret: creds.secret });
    appendOpsLog(db, review.episode.id, 'feishu', `推送第 ${review.ageDays} 天同龄复盘`, review.episode.title);
    ctx.notifyOpsChanged();
  });
}
