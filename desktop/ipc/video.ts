import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, dialog, ipcMain, shell } from 'electron';
import type { AppContext } from '../app-context';
import type {
  VideoAssetBundle, VideoPlatform, VideoProgress, VideoProject, VideoRenderAssets, VideoStage, VideoTtsSettings, VideoTtsStatus,
  VideoTopicSearchQuery, VideoTopicSearchResult
} from '../shared';
import { videoCoverPrompt } from '../services/video-image-prompts';
import { imageThumbnail } from '../services/native-image';
import { RequestLock } from '../services/request-lock';
import {
  assertVideoExportable, assertVideoStage, buildTimeline, parseVideoShots, prepareVideoEdit, previewSignature,
  renderBlockers, renderSignature, shotDurations, splitCaptionLines
} from '../services/video-pipeline';
import { SHOT_IMAGE_SIZE, audioKey, imageKey, parseVoiceProfile, shotAudio, shotImage, shotImagePrompt, voiceProfileOf } from '../services/video-production';
import {
  buildConcatList, buildFfmpegArgs, buildFramePlan, buildFrameHtml, frameLead, framePlanOptions, framePlanStills, motionStyle, settledMotion,
  type FrameMotion
} from '../services/video-compose';
import { probeDuration, renderFrameFiles, resolveFfmpeg, runFfmpeg, speechSpan } from '../services/video-render';
import { listSystemVoices, readVideoTtsSettings, requestSpeech, synthesizeSystemSpeech, writeVideoTtsSettings } from '../services/video-tts';
import { createVideoProject, deleteVideoProject, getVideoProject, listVideoProjects, updateVideoProject } from '../services/video-store';
import { pickPose } from '../services/ip-theme';
import { normalizeVideoIpCoverInput, renderVideoIpCover, VIDEO_COVER_SIZE } from '../services/video-ip-cover';
import { renderHtmlPages } from '../services/xhs-render';
import { ipReferenceImage, ipRenderKit } from './ip';
import { requestVideoStage } from '../services/video-workflow';
import { copyRenderedVideoTo, exportVideoPackage, suggestedMp4Name } from '../services/video-export';
import { searchVideoTopicHotspots } from '../services/video-topic-search';
import { assetDirectory, contentApiConfig, generateImageFile, removeAssetDirectory } from './content-support';

/* ── 视频创作流水线 ──────────────────────────────────────────────
 * 与公众号并列的第二条内容流水线。模型做选题、口播脚本与分镜（和可选的逐镜配图）；
 * 配音走 TTS，镜头时长以真实音频为准；字幕、画面帧与成片在本地确定性生成。
 * 花钱的动作（配音接口、AI 配图、封面）都要用户点按钮，导出只是写知识库，
 * 模块不代替任何平台做发布。
 */

/** 只删应用素材目录里的文件：账本里的路径来自库，删之前确认它确实在这条视频的目录下。 */
function removeInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

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
  const progress = (payload: VideoProgress) => ctx.window()?.webContents.send('video:progress', payload);

  ipcMain.handle('video:list', () => listVideoProjects(db));
  /** 按发布平台路由选题数据源：对应红狐接口优先，没有 key 或失败时改用平台化联网搜索。 */
  ipcMain.handle('video:topics:search', async (_event, query: VideoTopicSearchQuery): Promise<VideoTopicSearchResult> =>
    searchVideoTopicHotspots(db, query, ctx.redfoxApiKey()));
  ipcMain.handle('video:create', (_event, platform: VideoPlatform, topic = '') => {
    let project = createVideoProject(db, platform, topic);
    // 新视频默认带上视频模块上次选的 IP；之后每条视频各自记着自己的。
    const ipId = ctx.ipLibrary.selections().video;
    if (ipId) project = updateVideoProject(db, project.id, { options: { ...project.options, ipId } });
    ctx.broadcast();
    return project;
  });
  /** 删除视频：处理中不能删；连同应用目录里的封面、配音、配图与成片一起清掉，已导出的制作包不受影响。 */
  ipcMain.handle('video:delete', (_event, id: number) => {
    assertIdle(id, '删除');
    deleteVideoProject(db, id);
    removeAssetDirectory(ctx, 'video-assets', id);
    ctx.broadcast();
  });
  ipcMain.handle('video:update', (_event, id: number, patch: Partial<VideoProject>) => {
    assertIdle(id, '保存');
    return update(id, prepareVideoEdit(getVideoProject(db, id), patch));
  });
  ipcMain.handle('video:assets', (_event, id: number): VideoAssetBundle => {
    const project = getVideoProject(db, id);
    const shots = parseVideoShots(project.storyboardJson);
    const thumb = (file: string | undefined) => (file && fs.existsSync(file) ? imageThumbnail(file, 240) : '');
    const video = project.assets.video;
    return {
      cover: project.coverPath ? { path: project.coverPath, caption: '封面', thumbnail: imageThumbnail(project.coverPath) } : null,
      shotImages: shots.map(shot => thumb(shotImage(project, shot)?.path)),
      preview: (project.assets.preview?.paths ?? []).map(thumb),
      videoPath: video && fs.existsSync(video.path) ? video.path : ''
    };
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
  /** 用这条视频选的 IP 本地排版出竖版封面，不调图片接口。 */
  ipcMain.handle('video:ip-cover:render', async (_event, id: number, raw: unknown) => requests.run(id, async () => {
    const project = getVideoProject(db, id);
    if (!project.options.ipId) throw new Error('这条视频还没有选用 IP：在「画面」步骤或这里选一个');
    const input = normalizeVideoIpCoverInput(raw);
    if (!input.title) throw new Error('封面标题不能为空');
    const target = path.join(assetDirectory(ctx, 'video-assets', project.id), `cover-ip-${Date.now()}.png`);
    await renderHtmlPages([renderVideoIpCover(input, ipRenderKit(ctx.ipLibrary, project.options.ipId))], VIDEO_COVER_SIZE.width, VIDEO_COVER_SIZE.height, [target]);
    return update(id, { coverPath: target });
  }));
  ipcMain.handle('video:cover:generate', async (_event, id: number) => requests.run(id, async () => {
    const project = getVideoProject(db, id);
    if (!(project.title || project.topic).trim()) throw new Error('请先确定选题或填写标题，再生成封面');
    const target = path.join(assetDirectory(ctx, 'video-assets', project.id), `cover-${Date.now()}.png`);
    return update(id, {
      coverPath: await generateImageFile(
        target,
        videoCoverPrompt(project, project.options.coverImagePromptTemplate),
        '1024x1792',
        undefined,
        ipReferenceImage(ctx.ipLibrary, project.options.ipId)
      )
    });
  }));

  /* ── 配音 ──────────────────────────────────────────────────────
   * 逐镜合成，镜头时长取真实音频（参考 MoneyPrinterTurbo / Pixelle-Video）。
   * 账本按「声音参数 + 口播」登记：只补缺失或口播改过的镜头；force 时按当前设置全部重配。
   * 每合成完一镜就写库，中途失败也保住已经拿到的配音。
   */
  ipcMain.handle('video:voice', async (_event, id: number, force?: boolean) => requests.run(id, async () => {
    let project = getVideoProject(db, id);
    const shots = parseVideoShots(project.storyboardJson);
    if (!shots.length) throw new Error('请先生成分镜，再配音');
    if (project.options.voiceMode === 'silent') throw new Error('当前选择了「不配音」，切换到「AI 配音」后再生成');
    const reuse = force !== true && parseVoiceProfile(project.assets.voiceProfile);
    const profileText = reuse ? project.assets.voiceProfile : voiceProfileOf(readVideoTtsSettings(ctx.dataDir));
    const profile = parseVoiceProfile(profileText)!;
    const root = assetDirectory(ctx, 'video-assets', id);
    const directory = path.join(root, 'audio');
    fs.mkdirSync(directory, { recursive: true });
    const wanted = new Map(shots.filter(shot => shot.narration.trim()).map(shot => [audioKey(profileText, shot.narration), shot.narration.trim()]));
    const kept = force === true ? [] : project.assets.audio.filter(item => wanted.has(item.key) && fs.existsSync(item.path));
    // 用不上的配音文件一并删掉，素材目录不随着改稿无限长。
    for (const item of project.assets.audio) if (!kept.includes(item)) removeInside(root, item.path);
    let assets: VideoRenderAssets = { ...project.assets, voiceProfile: profileText, audio: kept };
    project = update(id, { assets });
    const pending = [...wanted].filter(([key]) => !kept.some(item => item.key === key));
    if (!pending.length) return project;

    const tools = await resolveFfmpeg();
    const total = pending.length;
    const record = async (key: string, file: string) => {
      const seconds = await probeDuration(tools, file);
      assets = { ...assets, audio: [...assets.audio, { key, path: file, seconds }] };
      project = update(id, { assets });
    };
    progress({ id, task: 'voice', done: 0, total, message: '正在配音…' });
    if (profile.provider === 'system') {
      const items = pending.map(([key, text]) => ({ key, text, out: path.join(directory, `${key}.wav`) }));
      const finished: number[] = [];
      try {
        await synthesizeSystemSpeech(profile, items.map(({ text, out }) => ({ text, out })), index => {
          finished.push(index);
          progress({ id, task: 'voice', done: finished.length, total, message: `已配好 ${finished.length}/${total} 个镜头` });
        });
      } finally {
        // 只登记确认合成完的镜头：进程中途退出时，最后一个 WAV 可能只写了一半。
        for (const index of finished) await record(items[index].key, items[index].out);
      }
    } else {
      const apiKey = ctx.videoTtsKeyStore.read();
      for (const [index, [key, text]] of pending.entries()) {
        const file = path.join(directory, `${key}.mp3`);
        fs.writeFileSync(file, await requestSpeech(profile, apiKey, text));
        await record(key, file);
        progress({ id, task: 'voice', done: index + 1, total, message: `已配好 ${index + 1}/${total} 个镜头` });
      }
    }
    return project;
  }));

  /** 逐镜 AI 配图：复用公众号的图片接口；按提示词哈希登记，只补缺失或提示词改过的镜头。 */
  ipcMain.handle('video:images', async (_event, id: number, force?: boolean) => requests.run(id, async () => {
    let project = getVideoProject(db, id);
    const shots = parseVideoShots(project.storyboardJson);
    if (!shots.length) throw new Error('请先生成分镜，再配图');
    const title = project.title.trim() || project.topic.trim() || '健康科普';
    // 这条视频选了 IP 时，配图里融入 IP 角色（参考图传给接口）；IP 进了配图的键，换 IP 会重新生成。
    const ipId = project.options.ipId;
    const ip = ipReferenceImage(ctx.ipLibrary, ipId);
    const root = assetDirectory(ctx, 'video-assets', id);
    const directory = path.join(root, 'images');
    fs.mkdirSync(directory, { recursive: true });
    const wanted = new Map(shots.map(shot => {
      const prompt = shotImagePrompt(shot, title, project.options.shotImagePromptTemplate);
      return [imageKey(prompt, ipId), prompt] as const;
    }));
    const kept = force === true ? [] : project.assets.images.filter(item => wanted.has(item.key) && fs.existsSync(item.path));
    for (const item of project.assets.images) if (!kept.includes(item)) removeInside(root, item.path);
    let assets: VideoRenderAssets = { ...project.assets, images: kept };
    project = update(id, { assets });
    const pending = [...wanted].filter(([key]) => !kept.some(item => item.key === key));
    for (const [index, [key, prompt]] of pending.entries()) {
      progress({ id, task: 'images', done: index, total: pending.length, message: `正在生成第 ${index + 1}/${pending.length} 张配图…` });
      const file = await generateImageFile(path.join(directory, `${key}.png`), prompt, SHOT_IMAGE_SIZE, undefined, ip);
      assets = { ...assets, images: [...assets.images, { key, path: file }] };
      project = update(id, { assets });
    }
    return project;
  }));

  /**
   * 帧里的 IP 角色：用 IP 库里文件的 file:// 地址（帧页面走 loadFile，读得到本地文件）。不放头像和品牌名。
   * 选的 IP 已被删掉或没有角色图就不带，不让渲染失败。
   */
  const frameIp = (ipId: string) => {
    if (!ipId) return null;
    try {
      const ip = ctx.ipLibrary.get(ipId);
      const url = (file: string) => pathToFileURL(ctx.ipLibrary.filePathOf(ip.id, file)).href;
      const hero = pickPose(ip.poses, '', ['指', '介绍', '打字'], 1);
      return hero ? { heroUrl: url(hero.file) } : null;
    } catch {
      return null;
    }
  };

  /**
   * 把若干段画面排版成 HTML，再逐张截出各段的静帧（.png 或 .jpg）；
   * 返回图片路径，顺序是各段静帧依次展开。
   */
  const renderFrames = async (
    project: VideoProject, segments: Array<{ shot: number; subtitle: string; stills: Array<{ motion: FrameMotion }> }>,
    directory: string, task: VideoProgress['task'], extension: 'png' | 'jpg'
  ) => {
    const shots = parseVideoShots(project.storyboardJson);
    const title = project.title.trim() || project.topic.trim() || '健康科普';
    const pad = (value: number) => String(value).padStart(4, '0');
    const ip = frameIp(project.options.ipId);
    const jobs = segments.map((segment, position) => {
      const shot = shots[segment.shot];
      const image = project.options.imageMode === 'ai' ? shotImage(project, shot) : null;
      const html = path.join(directory, `frame-${pad(position + 1)}.html`);
      fs.writeFileSync(html, buildFrameHtml({
        template: project.options.template, title, keyText: shot.caption, subtitle: segment.subtitle,
        imageUrl: image && fs.existsSync(image.path) ? pathToFileURL(image.path).href : '',
        shotNumber: segment.shot + 1, shotCount: shots.length, footer: project.options.footer,
        role: shot.role ?? '', lead: frameLead(shots, segment.shot), motion: segment.stills[0].motion, ip
      }), 'utf8');
      const stills = segment.stills.map((still, index) => ({ style: motionStyle(still.motion), target: path.join(directory, `frame-${pad(position + 1)}-${pad(index + 1)}.${extension}`) }));
      return { html, stills };
    });
    const total = jobs.reduce((sum, job) => sum + job.stills.length, 0);
    await renderFrameFiles(jobs, done => {
      if (done % 10 === 0 || done === total) progress({ id: project.id, task, done, total, message: `正在渲染画面 ${done}/${total}` });
    });
    for (const job of jobs) fs.rmSync(job.html, { force: true });
    return jobs.flatMap(job => job.stills.map(still => still.target));
  };

  /** 每镜一帧的预览（参考 Hyperframes 渲染前先看关键帧拼图）：不调接口、不花钱，几秒钟就能看出版式问题。 */
  ipcMain.handle('video:preview', async (_event, id: number) => requests.run(id, async () => {
    const project = getVideoProject(db, id);
    const shots = parseVideoShots(project.storyboardJson);
    if (!shots.length) throw new Error('请先生成分镜，再预览画面');
    const root = assetDirectory(ctx, 'video-assets', id);
    const directory = path.join(root, `preview-${Date.now()}`);
    fs.mkdirSync(directory, { recursive: true });
    try {
      const options = framePlanOptions(project.options);
      const segments = shots.map((shot, index) => {
        const subtitle = splitCaptionLines(shot.narration)[0] ?? '';
        return { shot: index, subtitle, stills: [{ motion: settledMotion(subtitle, options) }] };
      });
      const paths = await renderFrames(project, segments, directory, 'preview', 'png');
      const previous = project.assets.preview?.paths[0];
      const next = update(id, { assets: { ...project.assets, preview: { signature: previewSignature(project), paths } } });
      if (previous) removeInside(root, path.dirname(previous));
      return next;
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }));

  /**
   * 渲染成片：先预检（参考 MoneyPrinterTurbo 的 preflight），缺什么当场报错；
   * 帧计划只在有动效的地方逐帧截图、其余时间一张静帧加时长，ffmpeg 按帧数拼接并合入口播与背景音乐。
   * 输出先写临时文件，成功后再改名；中间帧无论成败都清掉。
   */
  ipcMain.handle('video:render', async (_event, id: number) => requests.run(id, async () => {
    const project = getVideoProject(db, id);
    const blockers = renderBlockers(project);
    if (blockers.length) throw new Error(`还不能渲染成片：${blockers.join('；')}`);
    const shots = parseVideoShots(project.storyboardJson);
    const { voiceMode, imageMode, bgmPath, bgmVolume } = project.options;
    // 账本对得上但文件被删了也算没准备好：宁可报错，也不渲染出缺声音、缺画面的视频。
    if (voiceMode === 'tts' && shots.some(shot => shot.narration.trim() && !fs.existsSync(shotAudio(project, shot)?.path ?? ''))) {
      throw new Error('有镜头的配音文件找不到了，请在「配音与字幕」里重新生成');
    }
    if (imageMode === 'ai' && shots.some(shot => !fs.existsSync(shotImage(project, shot)?.path ?? ''))) {
      throw new Error('有镜头的配图文件找不到了，请在「画面」里重新生成');
    }
    if (bgmPath && !fs.existsSync(bgmPath)) throw new Error('背景音乐文件不存在，请重新选择或清除');
    const tools = await resolveFfmpeg();
    const { seconds } = shotDurations(project, shots);
    const timeline = buildTimeline(shots, seconds);
    // 逐字高亮跟着配音里真正出声的那一段走（扣掉语音自带的句首、句尾静音）。
    const speech = await Promise.all(shots.map(async shot => {
      const audio = voiceMode === 'tts' ? shotAudio(project, shot) : null;
      return audio ? speechSpan(tools, audio.path, audio.seconds) : null;
    }));
    const plan = buildFramePlan(shots, timeline, { ...framePlanOptions(project.options), speech });
    const root = assetDirectory(ctx, 'video-assets', id);
    const stamp = Date.now();
    const work = path.join(root, `render-${stamp}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      const frames = await renderFrames(project, plan.segments, work, 'render', 'jpg');
      const stills = framePlanStills(plan);
      progress({ id, task: 'render', done: stills, total: stills, message: '正在合成视频…' });
      const listPath = path.join(work, 'frames.ffconcat');
      const durations = plan.segments.flatMap(segment => segment.stills.map(still => still.frames));
      fs.writeFileSync(listPath, buildConcatList(frames.map((file, index) => ({ path: file, frames: durations[index] }))), 'utf8');
      const temp = path.join(work, 'video.tmp.mp4');
      await runFfmpeg(tools, buildFfmpegArgs({
        narration: shots.map((shot, index) => ({ path: voiceMode === 'tts' ? shotAudio(project, shot)?.path ?? '' : '', seconds: seconds[index] })),
        bgm: bgmPath ? { path: bgmPath, volume: bgmVolume / 100 } : null,
        total: timeline.total,
        output: temp
      }, listPath));
      const output = path.join(root, `video-${stamp}.mp4`);
      fs.renameSync(temp, output);
      const previous = project.assets.video?.path;
      const next = update(id, { assets: { ...project.assets, video: { path: output, signature: renderSignature(project), seconds: timeline.total, renderedAt: new Date().toISOString() } } });
      if (previous && previous !== output) removeInside(root, previous);
      return next;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }));

  ipcMain.handle('video:bgm:choose', async (_event, id: number) => {
    assertIdle(id, '选择背景音乐');
    const result = await dialog.showOpenDialog(ctx.window()!, { properties: ['openFile'], filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const project = getVideoProject(db, id);
    return update(id, { options: { ...project.options, bgmPath: result.filePaths[0] } });
  });
  ipcMain.handle('video:open-video', async (_event, id: number) => {
    const video = getVideoProject(db, id).assets.video;
    if (!video || !fs.existsSync(video.path)) throw new Error('还没有可打开的成片，请先渲染');
    return shell.openPath(video.path);
  });
  /** 直接把当前有效成片另存为 .mp4；保存位置由用户确认。 */
  ipcMain.handle('video:save-mp4', async (_event, id: number) => {
    assertIdle(id, '导出 MP4');
    const project = getVideoProject(db, id);
    if (!project.assets.video || !fs.existsSync(project.assets.video.path)) throw new Error('还没有可导出的成片，请先渲染');
    const result = await dialog.showSaveDialog(ctx.window()!, {
      title: '导出 MP4 视频',
      defaultPath: path.join(app.getPath('videos'), suggestedMp4Name(project)),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory']
    });
    if (result.canceled || !result.filePath) return null;
    return copyRenderedVideoTo(project, result.filePath);
  });

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

  /* ── 配音设置（全局）──────────────────────────────────────────── */
  let voices: Promise<string[]> | null = null;
  const ttsStatus = async (): Promise<VideoTtsStatus> => {
    // 列系统语音要起一次 PowerShell（约 1 秒），读到一次就缓存；读不到下次再试。
    voices ??= listSystemVoices().then(list => { if (!list.length) voices = null; return list; });
    return { settings: readVideoTtsSettings(ctx.dataDir), key: ctx.videoTtsKeyStore.getStatus(), systemVoices: await voices };
  };
  ipcMain.handle('video:tts:status', () => ttsStatus());
  ipcMain.handle('video:tts:save', (_event, patch: Partial<VideoTtsSettings>) => {
    if (!patch || typeof patch !== 'object') throw new Error('配音设置格式不正确');
    writeVideoTtsSettings(ctx.dataDir, patch);
    return ttsStatus();
  });
  ipcMain.handle('video:tts:key:save', (_event, value: unknown) => {
    ctx.videoTtsKeyStore.save(String(value ?? ''));
    return ttsStatus();
  });
  ipcMain.handle('video:tts:key:delete', () => {
    ctx.videoTtsKeyStore.remove();
    return ttsStatus();
  });
}
