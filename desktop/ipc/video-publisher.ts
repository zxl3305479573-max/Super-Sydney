import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type {
  SiteViewBounds,
  VideoPublishItemStatus,
  VideoPublishMode,
  VideoPublishPlatform,
  VideoPublishProgress,
  VideoPublishResult,
  VideoPublishResultItem,
  VideoPublisherViewState
} from '../shared';
import { getVideoProject } from '../services/video-store';
import { isRenderFresh } from '../services/video-pipeline';
import { videoPublishCopy } from '../services/video-publish-copy';
import { VideoPublisherView } from '../services/video-publisher-view';

const PUBLISH_PLATFORMS = new Set<VideoPublishPlatform>(['douyin', 'shipinhao', 'xiaohongshu', 'bilibili']);

export function registerVideoPublisherIpc(ctx: AppContext, view: VideoPublisherView): void {
  const { db } = ctx;
  let running = false;

  ipcMain.handle('video-publish:view:state', (_event, platform: VideoPublishPlatform): VideoPublisherViewState => view.state(platform));
  ipcMain.handle('video-publish:view:open', (_event, platform: VideoPublishPlatform): VideoPublisherViewState => view.show(platform));
  ipcMain.handle('video-publish:view:close', () => view.close());
  ipcMain.handle('video-publish:view:bounds', (_event, bounds: SiteViewBounds | null) => view.setBounds(bounds));
  ipcMain.handle('video-publish:view:navigate', (_event, platform: VideoPublishPlatform, target: { kind?: unknown; value?: unknown }) =>
    view.navigate(platform, target ?? {}));
  ipcMain.handle('video-publish:view:go', (_event, platform: VideoPublishPlatform, action: 'back' | 'reload') =>
    view.go(platform, action === 'back' ? 'back' : 'reload'));
  ipcMain.handle('video-publish:view:external', (_event, platform: VideoPublishPlatform) => view.openExternal(platform));

  ipcMain.handle('video-publish:run', async (
    _event,
    id: number,
    rawPlatforms: VideoPublishPlatform[],
    rawMode: VideoPublishMode
  ): Promise<VideoPublishResult> => {
    if (running) throw new Error('已有一次多平台发布正在进行，请等它结束');
    const platforms = normalizePlatforms(rawPlatforms);
    const mode: VideoPublishMode = 'draft';
    const project = getVideoProject(db, Number(id));
    const video = project.assets.video;
    if (!video || !isRenderFresh(project) || !fs.existsSync(video.path)) {
      throw new Error('当前视频还没有有效成片，请先完成渲染后再发布');
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
      for (const platform of platforms) {
        const copy = videoPublishCopy(project, platform);
        emit(platform, 'pending', '等待开始');
        try {
          const result = await view.fillAndPublish(
            platform,
            { ...copy, videoPath: video.path },
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
            at: new Date().toISOString()
          };
          items.push(item);
          emit(platform, result.status, result.message);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const item: VideoPublishResultItem = {
            jobId,
            projectId: project.id,
            platform,
            status: 'failed',
            message,
            title: copy.title,
            bodyChars: Array.from(copy.body).length,
            videoPath: video.path,
            url: view.state(platform).url,
            at: new Date().toISOString()
          };
          items.push(item);
          emit(platform, 'failed', message);
        }
      }
      return { jobId, projectId: project.id, mode, items };
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
