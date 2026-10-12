import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain, shell } from 'electron';
import type { AppContext } from '../app-context';
import type { VideoAssetBundle, VideoPlatform, VideoProject, VideoStage } from '../shared';
import { videoCoverPrompt } from '../services/content-api-config';
import { imageThumbnail } from '../services/native-image';
import { RequestLock } from '../services/request-lock';
import { assertVideoExportable, assertVideoStage, parseVideoShots, prepareVideoEdit } from '../services/video-pipeline';
import { createVideoProject, getVideoProject, listVideoProjects, updateVideoProject } from '../services/video-store';
import { requestVideoStage } from '../services/video-workflow';
import { exportVideoPackage } from '../services/video-export';
import { assetDirectory, contentApiConfig, generateImageFile } from './content-support';

/* ── 视频创作流水线 ──────────────────────────────────────────────
 * 与公众号并列的第二条内容流水线。模型只做选题、口播脚本与分镜；
 * 字幕与制作包在本地确定性生成，导出只是写知识库，
 * 模块不渲染成片、也不代替任何平台做发布。
 */

export function registerVideoIpc(ctx: AppContext): void {
  const { db } = ctx;
  const requests = new RequestLock('这条视频正在处理，请等待当前操作完成');

  const update = (id: number, patch: Partial<VideoProject>): VideoProject => {
    const project = updateVideoProject(db, id, patch);
    ctx.broadcast();
    return project;
  };
  const assertIdle = (id: number, action: string) => {
    if (requests.has(id)) throw new Error(`这条视频正在处理，请稍后${action}`);
  };

  ipcMain.handle('video:list', () => listVideoProjects(db));
  ipcMain.handle('video:create', (_event, platform: VideoPlatform, topic = '') => {
    const project = createVideoProject(db, platform, topic);
    ctx.broadcast();
    return project;
  });
  ipcMain.handle('video:update', (_event, id: number, patch: Partial<VideoProject>) => {
    assertIdle(id, '保存');
    return update(id, prepareVideoEdit(getVideoProject(db, id), patch));
  });
  ipcMain.handle('video:assets', (_event, id: number): VideoAssetBundle => {
    const project = getVideoProject(db, id);
    return { cover: project.coverPath ? { path: project.coverPath, caption: '封面', thumbnail: imageThumbnail(project.coverPath) } : null };
  });
  /** 选题 / 口播脚本 / 分镜：每步完成即写库，失败不会回滚已经拿到的结果。 */
  ipcMain.handle('video:generate', async (_event, id: number, stage: VideoStage) => requests.run(id, async () => {
    const project = getVideoProject(db, id);
    assertVideoStage(project, stage);
    const generated = await requestVideoStage(project, stage, contentApiConfig(ctx));
    const patch: Partial<VideoProject> = { ...generated };
    if (stage === 'script') patch.status = 'script';
    if (stage === 'storyboard') patch.status = parseVideoShots(generated.storyboardJson || '').length ? 'storyboard' : project.status;
    return update(id, patch);
  }));
  ipcMain.handle('video:cover:choose', async (_event, id: number) => {
    assertIdle(id, '选择封面');
    const result = await dialog.showOpenDialog(ctx.window()!, { properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return update(id, { coverPath: result.filePaths[0] });
  });
  /**
   * 生成竖版封面（9:16）。
   * 与公众号封面共用同一套图片接口与错误处理，但尺寸不同——竖屏封面的构图和横版不通用。
   */
  ipcMain.handle('video:cover:generate', async (_event, id: number) => requests.run(id, async () => {
    const project = getVideoProject(db, id);
    if (!(project.title || project.topic).trim()) throw new Error('请先确定选题或填写标题，再生成封面');
    const target = path.join(assetDirectory(ctx, 'video-assets', project.id), `cover-${Date.now()}.png`);
    return update(id, { coverPath: await generateImageFile(target, videoCoverPrompt(project), '1024x1792') });
  }));
  /** 导出制作包：写知识库属于本地动作，但会生成一堆文件，所以先过门槛再落盘。 */
  ipcMain.handle('video:export', (_event, id: number) => {
    assertIdle(id, '导出');
    const project = getVideoProject(db, id);
    assertVideoExportable(project);
    const target = exportVideoPackage(ctx.settings.read().vaultPath, project);
    return update(id, { exportPath: target, status: 'exported' });
  });
  ipcMain.handle('video:open-package', async (_event, id: number) => {
    const project = getVideoProject(db, id);
    if (!project.exportPath.trim() || !fs.existsSync(project.exportPath)) throw new Error('还没有可打开的制作包，请先导出');
    return shell.openPath(project.exportPath);
  });
}
