import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type {
  SiteViewBounds,
  VideoCoverVariantView,
  VideoPublishItemStatus,
  VideoPublishMode,
  VideoPublishPackPatch,
  VideoPublishPackView,
  VideoPublishPlatform,
  VideoPublishProgress,
  VideoPublishResult,
  VideoPublishResultItem,
  VideoPublisherViewState
} from '../shared';
import {
  buildDraftReadyCard,
  buildLoginExpiredCard,
  readFeishuSettings,
  resolveFeishuCredentials,
  sendFeishuCard
} from '../services/feishu-notify';
import { imageThumbnail } from '../services/native-image';
import {
  appendOpsLog,
  findOpsEpisodeBySource,
  getOpsEpisodeWithTasks,
  getOpsPlatformTask,
  isOpsStateLocked,
  setOpsPlatformTask,
  upsertOpsEpisode
} from '../services/ops-store';
import { ALL_COVER_RATIOS, COVER_RATIO_SPECS, generateCoverVariants } from '../services/video-cover-variants';
import { isRenderFresh } from '../services/video-pipeline';
import {
  generateAiVideoPublishPack,
  getVideoPublishPack,
  saveVideoPublishPack
} from '../services/video-publish-pack';
import {
  composePlatformBody,
  validateVideoPublishPack
} from '../services/video-publish-validate';
import { inspectMp4Faststart } from '../services/mp4-faststart';
import { VideoPublisherView } from '../services/video-publisher-view';
import { resolveFfmpeg } from '../services/video-render';
import { getVideoProject } from '../services/video-store';
import { assetDirectory, videoApiConfig } from './content-support';

const PUBLISH_PLATFORMS = new Set<VideoPublishPlatform>(['douyin', 'shipinhao', 'xiaohongshu', 'bilibili']);

function buildPackView(ctx: AppContext, projectId: number): VideoPublishPackView {
  const project = getVideoProject(ctx.db, Number(projectId));
  const pack = getVideoPublishPack(ctx.db, project);
  const videoPath = project.assets.video && fs.existsSync(project.assets.video.path) ? project.assets.video.path : '';
  const validation = validateVideoPublishPack(pack, { faststart: videoPath ? inspectMp4Faststart(videoPath) : null });
  const coverVariants: VideoCoverVariantView[] = [];
  for (const ratio of ALL_COVER_RATIOS) {
    const file = pack.variants[ratio];
    if (file && fs.existsSync(file)) {
      coverVariants.push({
        ratio,
        label: COVER_RATIO_SPECS[ratio].label,
        path: file,
        thumbnail: imageThumbnail(file, 260)
      });
    }
  }
  const existingEpisode = findOpsEpisodeBySource(ctx.db, 'video', project.id);
  const episode = existingEpisode ? getOpsEpisodeWithTasks(ctx.db, existingEpisode.id) : null;
  return { pack, coverVariants, validation, episode };
}

export function registerVideoPublisherIpc(ctx: AppContext, view: VideoPublisherView): void {
  const { db } = ctx;
  let running = false;

  ipcMain.handle('video-publish:view:state', (_event, platform: VideoPublishPlatform): VideoPublisherViewState => view.state(platform));
  ipcMain.handle('video-publish:view:open', (_event, platform: VideoPublishPlatform): VideoPublisherViewState => view.show(platform));
  ipcMain.handle('video-publish:view:close', () => view.close());
  ipcMain.handle('video-publish:view:bounds', (_event, bounds: SiteViewBounds | null) => view.setBounds(bounds));
  ipcMain.handle('video-publish:view:navigate', (_event, platform: VideoPublishPlatform, target: { kind?: unknown; value?: unknown }) =>
    view.navigate(platform, target));
  ipcMain.handle('video-publish:view:go', (_event, platform: VideoPublishPlatform, action: 'back' | 'reload') =>
    view.go(platform, action === 'back' ? 'back' : 'reload'));
  ipcMain.handle('video-publish:view:external', (_event, platform: VideoPublishPlatform) => view.openExternal(platform));

  ipcMain.handle('video-publish:pack:get', (_event, id: number): VideoPublishPackView => buildPackView(ctx, id));

  ipcMain.handle('video-publish:pack:save', (_event, id: number, patch: VideoPublishPackPatch): VideoPublishPackView => {
    const project = getVideoProject(db, Number(id));
    const saved = saveVideoPublishPack(db, project, patch);
    if (patch.scheduledAt !== undefined) {
      upsertOpsEpisode(db, {
        sourceType: 'video',
        sourceId: project.id,
        title: project.title.trim() || project.topic.trim() || '未命名视频',
        scheduledAt: saved.scheduledAt
      });
      ctx.notifyOpsChanged();
    }
    return buildPackView(ctx, project.id);
  });

  ipcMain.handle('video-publish:pack:generate', async (_event, id: number): Promise<VideoPublishPackView> => {
    if (!ctx.settings.read().llmEnabled) {
      throw new Error('请先在「设置 → 模型」开启「允许调用内容模型」');
    }
    const llm = videoApiConfig(ctx);
    if (!llm.apiKey || !llm.baseUrl || !llm.model) {
      throw new Error('请先在「设置 → 模型」配置完整的内容模型地址、模型名与 API Key');
    }
    const project = getVideoProject(db, Number(id));
    const copies = await generateAiVideoPublishPack(project, llm);
    saveVideoPublishPack(db, project, { copies });
    return buildPackView(ctx, project.id);
  });

  ipcMain.handle('video-publish:pack:variants', async (_event, id: number): Promise<VideoPublishPackView> => {
    const project = getVideoProject(db, Number(id));
    if (!project.coverPath.trim() || !fs.existsSync(project.coverPath)) {
      throw new Error('请先在「封面」步骤生成或选择一张主封面，再生成多比例衍生封面');
    }
    const tools = await resolveFfmpeg();
    const outDir = path.join(assetDirectory(ctx, 'video-assets', project.id), 'cover-variants');
    const variants = await generateCoverVariants(project.coverPath, outDir, tools.ffmpeg);
    saveVideoPublishPack(db, project, { variants });
    return buildPackView(ctx, project.id);
  });

  ipcMain.handle('video-publish:run', async (
    _event,
    id: number,
    rawPlatforms: VideoPublishPlatform[],
    rawMode: VideoPublishMode
  ): Promise<VideoPublishResult> => {
    if (running) throw new Error('已有一次多平台发布正在进行，请等它结束');
    const platforms = normalizePlatforms(rawPlatforms);
    const force = rawMode === 'draft-force';
    const mode: VideoPublishMode = 'draft';
    const project = getVideoProject(db, Number(id));
    const video = project.assets.video;
    if (!video || !isRenderFresh(project) || !fs.existsSync(video.path)) {
      throw new Error('当前视频还没有有效成片，请先完成渲染后再发布');
    }

    let pack = getVideoPublishPack(db, project);
    const activePlatforms = platforms.filter(platform => !pack.copies[platform]?.skip);
    if (!activePlatforms.length) {
      throw new Error('所选平台在发布包中均被标为「跳过」，请至少启用一个平台');
    }

    const validation = validateVideoPublishPack(pack, {
      faststart: inspectMp4Faststart(video.path),
      targetPlatforms: activePlatforms
    });
    if (!validation.ok) {
      const firstErrors = validation.issues
        .filter(item => item.level === 'error')
        .slice(0, 3)
        .map(item => item.message)
        .join('；');
      throw new Error(`发布前硬校验未通过：${firstErrors}`);
    }

    running = true;
    const jobId = randomUUID();
    const items: VideoPublishResultItem[] = [];
    const emit = (platform: VideoPublishPlatform, status: VideoPublishItemStatus, message: string) => {
      const progress: VideoPublishProgress = {
        jobId,
        projectId: project.id,
        platform,
        status,
        message,
        at: new Date().toISOString()
      };
      ctx.window()?.webContents.send('video-publish:progress', progress);
    };

    try {
      if (project.coverPath.trim() && fs.existsSync(project.coverPath)) {
        const missingRatios = [...new Set(activePlatforms.map(p => pack.copies[p].coverRatio))]
          .filter(ratio => !pack.variants[ratio] || !fs.existsSync(pack.variants[ratio]!));
        if (missingRatios.length) {
          try {
            const tools = await resolveFfmpeg();
            const outDir = path.join(assetDirectory(ctx, 'video-assets', project.id), 'cover-variants');
            const generated = await generateCoverVariants(project.coverPath, outDir, tools.ffmpeg, missingRatios);
            pack = saveVideoPublishPack(db, project, { variants: generated });
          } catch { /* ffmpeg 不可用时退回原封面 */ }
        }
      }

      const episode = upsertOpsEpisode(db, {
        sourceType: 'video',
        sourceId: project.id,
        title: project.title.trim() || project.topic.trim() || '未命名视频',
        scheduledAt: pack.scheduledAt,
        platforms: activePlatforms
      });

      const loginFailedPlatforms: VideoPublishPlatform[] = [];

      for (const platform of activePlatforms) {
        const copy = pack.copies[platform];
        const fullBody = composePlatformBody(copy);
        const existingTask = getOpsPlatformTask(db, episode.id, platform);

        if (!force && isOpsStateLocked(existingTask?.state)) {
          const lockedStatus: VideoPublishItemStatus = existingTask?.state === 'published' ? 'published' : 'draft';
          const msg = `防重保护：该平台已处于「${existingTask?.state === 'published' ? '已发布' : '已填草稿/定时'}」，已跳过重复上传（勾选强制重填可覆盖）`;
          const item: VideoPublishResultItem = {
            jobId,
            projectId: project.id,
            platform,
            status: lockedStatus,
            message: msg,
            title: existingTask?.filledTitle || copy.title,
            bodyChars: Array.from(fullBody).length,
            videoPath: video.path,
            url: existingTask?.postUrl || view.state(platform).url,
            locked: true,
            at: new Date().toISOString()
          };
          items.push(item);
          emit(platform, lockedStatus, msg);
          appendOpsLog(db, episode.id, platform, '防重跳过', msg);
          continue;
        }

        const coverPath = pack.variants[copy.coverRatio] && fs.existsSync(pack.variants[copy.coverRatio]!)
          ? pack.variants[copy.coverRatio]!
          : project.coverPath && fs.existsSync(project.coverPath)
            ? project.coverPath
            : undefined;

        emit(platform, 'pending', '等待开始');
        try {
          const result = await view.fillAndPublish(
            platform,
            { title: copy.title, body: fullBody, videoPath: video.path, coverPath },
            mode,
            (status, message) => emit(platform, status, message)
          );
          const item: VideoPublishResultItem = {
            jobId,
            projectId: project.id,
            platform,
            status: result.status,
            message: result.message,
            title: result.title,
            bodyChars: result.bodyChars,
            videoPath: result.videoPath,
            url: result.url,
            coverUploaded: result.coverUploaded,
            at: new Date().toISOString()
          };
          items.push(item);
          setOpsPlatformTask(db, episode.id, platform, 'draft', {
            filledTitle: result.title,
            detail: result.message
          });
          appendOpsLog(db, episode.id, platform, '填入草稿', result.message);
          emit(platform, result.status, result.message);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isLoginIssue = /登录/.test(message);
          if (isLoginIssue) loginFailedPlatforms.push(platform);
          const item: VideoPublishResultItem = {
            jobId,
            projectId: project.id,
            platform,
            status: 'failed',
            message,
            title: copy.title,
            bodyChars: Array.from(fullBody).length,
            videoPath: video.path,
            url: view.state(platform).url,
            at: new Date().toISOString()
          };
          items.push(item);
          setOpsPlatformTask(db, episode.id, platform, isLoginIssue ? 'not_logged_in' : 'failed', {
            filledTitle: copy.title,
            detail: message
          });
          appendOpsLog(db, episode.id, platform, '草稿失败', message);
          emit(platform, 'failed', message);
        }
      }

      ctx.notifyOpsChanged();

      const feishuCfg = readFeishuSettings(ctx.dataDir);
      const creds = resolveFeishuCredentials(ctx.feishuWebhookStore, ctx.feishuSecretStore);
      if (creds.webhookUrl) {
        const actuallyRan = items.some(item => !item.locked);
        if (feishuCfg.notifyOnDraft && actuallyRan) {
          await sendFeishuCard(creds.webhookUrl, buildDraftReadyCard(episode.title, items), { secret: creds.secret })
            .catch(err => appendOpsLog(db, episode.id, 'feishu', '推送草稿卡片失败', err instanceof Error ? err.message : String(err)));
        }
        if (feishuCfg.notifyOnLoginExpired && loginFailedPlatforms.length > 0) {
          await sendFeishuCard(creds.webhookUrl, buildLoginExpiredCard(loginFailedPlatforms), { secret: creds.secret })
            .catch(err => appendOpsLog(db, episode.id, 'feishu', '推送登录提醒失败', err instanceof Error ? err.message : String(err)));
        }
      }

      return { jobId, projectId: project.id, mode: rawMode, items };
    } finally {
      running = false;
    }
  });
}

function normalizePlatforms(input: unknown): VideoPublishPlatform[] {
  if (!Array.isArray(input)) throw new Error('请选择至少一个发布平台');
  const unique: VideoPublishPlatform[] = [];
  for (const value of input) {
    if (!PUBLISH_PLATFORMS.has(value)) throw new Error('发布平台列表里有不支持的平台');
    if (!unique.includes(value)) unique.push(value);
  }
  if (!unique.length) throw new Error('请选择至少一个发布平台');
  return unique;
}
