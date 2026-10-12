import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type { ContentDirectionInput, ContentStage, ContentTask } from '../shared';
import type { ImageSlot } from '../services/content-images';
import { applyGeneratedImages, buildImagePrompt, collectTaskAssets, listInlineImages, planCoverAndInlineImages, planImageSlots } from '../services/content-images';
import { coverImagePrompt, imagePromptScope } from '../services/content-api-config';
import { chosenDefaultSubdirectionName, createContentTask, getContentTask, listContentTasks, optionalId, saveTaxonomyTree, updateContentTask } from '../services/content-store';
import { findSubdirection, subdirectionNames } from '../services/content-taxonomy';
import { requestContentStage } from '../services/content-workflow';
import { exportContentArticle, parseContentSources } from '../services/content-export';
import { assertContentDeliverable, assertContentStage, deliverableArticle, isContentPublishable, prepareContentEdit } from '../services/content-policy';
import { DEFAULT_AIGC_FOOTER, makeDigest, normalizeTitle, renderWeChatHtml, toPlainText } from '../services/article-html';
import { ImageJobs, clampImageCount, imageErrorText } from '../services/image-generation';
import { imageThumbnail, prepareWeChatInlineImage, previewImageSource } from '../services/native-image';
import { RequestLock } from '../services/request-lock';
import { WeChatClient, contentTypeFor } from '../services/wechat-publisher';
import { yamlScalar } from '../services/wewrite-config';
import { readWeWriteFiles, syncStyleTopics } from '../services/wewrite-files';
import { assetDirectory, contentApiConfig, generateImageFile, readContentTaxonomy } from './content-support';

/* ── 桌面端原生公众号内容管道 ─────────────────────────────────── */

export function registerContentIpc(ctx: AppContext): void {
  const { db } = ctx;
  const requests = new RequestLock('这篇文章正在处理，请等待当前操作完成');
  const imageJobs = new ImageJobs();
  const weChat = new WeChatClient();

  const update = (id: number, patch: Partial<ContentTask>): ContentTask => {
    const task = updateContentTask(db, id, patch);
    ctx.broadcast();
    return task;
  };
  const assertIdle = (id: number, action: string) => {
    if (requests.has(id)) throw new Error(`文章正在处理，请稍后${action}`);
  };

  /** 生成封面并落盘，返回文件路径。 */
  const generateCover = (task: ContentTask, signal?: AbortSignal): Promise<string> => {
    const scope = imagePromptScope(readContentTaxonomy(ctx), task, readWeWriteFiles().styleText);
    const target = path.join(assetDirectory(ctx, 'content-assets', task.id), `cover-${Date.now()}.png`);
    return generateImageFile(target, coverImagePrompt(task, scope), '1792x1024', signal);
  };

  /**
   * 按位置并发生成正文配图：paths 与 slots 一一对应，失败的位置是 null。
   * 并发是为了让「封面 + 3 张配图」这种一次动作不被串行等待拖到一分多钟。
   */
  const generateInline = async (task: ContentTask, slots: ImageSlot[], stamp: number, signal?: AbortSignal): Promise<{ paths: Array<string | null>; failures: string[] }> => {
    const directory = assetDirectory(ctx, 'content-assets', task.id);
    const scope = imagePromptScope(readContentTaxonomy(ctx), task, readWeWriteFiles().styleText);
    const failures: string[] = [];
    const settled = await Promise.allSettled(slots.map((slot, index) => generateImageFile(
      path.join(directory, `inline-${stamp}-${index + 1}.png`),
      buildImagePrompt({ articleTitle: task.title || task.topic, heading: slot.heading, excerpt: slot.excerpt, direction: scope.direction, audience: scope.audience }),
      '1792x1024',
      signal
    )));
    const paths = settled.map(item => {
      if (item.status === 'fulfilled') return item.value;
      failures.push(imageErrorText(item.reason));
      return null;
    });
    return { paths, failures };
  };

  ipcMain.handle('content:list', () => listContentTasks(db));
  ipcMain.handle('content:taxonomy', () => readContentTaxonomy(ctx));
  /** 保存分类树后，把具体方向名与默认方向回写到 style.yaml。 */
  ipcMain.handle('content:taxonomy:save', (_event, directions: ContentDirectionInput[], defaultSubdirectionId?: number | null) => {
    saveTaxonomyTree(db, directions);
    const saved = readContentTaxonomy(ctx);
    syncStyleTopics(subdirectionNames(saved.directions), chosenDefaultSubdirectionName(saved, defaultSubdirectionId));
    ctx.broadcast();
    return readContentTaxonomy(ctx);
  });
  ipcMain.handle('content:create', (_event, directionId: number | null, subdirectionId: number | null, topic = '') => {
    const task = createContentTask(db, readContentTaxonomy(ctx), directionId, subdirectionId, topic);
    ctx.broadcast();
    return task;
  });
  ipcMain.handle('content:update', (_event, id: number, patch: Partial<ContentTask>) => {
    if (requests.has(id)) throw new Error('文章正在处理，请稍后保存');
    if (patch.subdirectionId !== undefined) {
      const found = findSubdirection(readContentTaxonomy(ctx).directions, optionalId(patch.subdirectionId));
      if (patch.subdirectionId && !found) throw new Error('选择的具体方向已经不存在，请刷新后重试');
      // 一级方向永远由二级方向推导，避免两边指向不同的树。
      patch.directionId = found?.direction.id ?? optionalId(patch.directionId);
    }
    if (patch.sourcesJson !== undefined) {
      const canonical = JSON.stringify({ sources: parseContentSources(patch.sourcesJson) });
      patch.sourcesJson = getContentTask(db, id).sourcesJson === '' && canonical === '{"sources":[]}' ? '' : canonical;
    }
    return update(id, prepareContentEdit(getContentTask(db, id), patch));
  });
  ipcMain.handle('content:generate', async (_event, id: number, stage: ContentStage) => requests.run(id, async () => {
    const task = getContentTask(db, id);
    assertContentStage(task, stage);
    const generated = await requestContentStage(task, stage, contentApiConfig(ctx, task.subdirectionId));
    const patch: Partial<ContentTask> = { ...generated, finalArticle: '', reviewJson: '' };
    if (stage === 'topics') patch.status = 'idea';
    if (stage === 'brief' || stage === 'claims') patch.status = 'brief';
    if (stage === 'draft' || stage === 'revise') patch.status = 'draft';
    if (stage === 'review') {
      const review = JSON.parse(generated.reviewJson || '{}') as { decision?: string };
      patch.reviewJson = generated.reviewJson;
      patch.status = review.decision === 'pass' ? 'ready' : 'review';
      if (review.decision === 'pass') patch.finalArticle = task.draft;
    }
    return update(id, patch);
  }));
  ipcMain.handle('content:cover:choose', async (_event, id: number) => {
    assertIdle(id, '选择封面');
    const result = await dialog.showOpenDialog(ctx.window()!, { properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return update(id, { coverPath: result.filePaths[0] });
  });
  ipcMain.handle('content:export', (_event, id: number, allowUnreviewed = false) => {
    assertIdle(id, '导出');
    const target = exportContentArticle(ctx.settings.read().vaultPath, getContentTask(db, id), { allowUnreviewed });
    return update(id, { exportPath: target });
  });
  /**
   * 直连微信公众号草稿箱（不经任何 CLI）。只创建草稿，绝不群发。
   * 三个硬前置：已配置凭证、有正文、有封面图——微信侧缺少封面素材会直接报错。
   */
  ipcMain.handle('content:publish', async (_event, id: number, allowUnreviewed = false) => requests.run(id, async () => {
    const { configText, styleText } = readWeWriteFiles();
    const appid = yamlScalar(configText, 'appid');
    const secret = yamlScalar(configText, 'secret');
    if (!appid || !secret) throw new Error('请先在「环境与配置」中填写公众号 AppID 与 AppSecret');
    const task = getContentTask(db, id);
    assertContentDeliverable(task, { allowUnreviewed });
    const article = deliverableArticle(task, allowUnreviewed);
    if (!task.coverPath) throw new Error('缺少封面图：请先选择本地图片或生成封面');
    if (!fs.existsSync(task.coverPath)) throw new Error('封面图文件已不存在，请重新选择');

    const title = normalizeTitle(task.title || toPlainText(article).slice(0, 40) || '未命名文章');
    if (!title) throw new Error('请先填写文章标题');
    const author = yamlScalar(configText, 'author') || yamlScalar(styleText, 'author');
    const credentials = { appid, secret };
    // 正文里的本地配图在微信侧无法显示，必须先传上去换成微信图片地址。
    const uploadedImages = new Map<string, string>();
    for (const image of listInlineImages(article)) {
      if (/^https?:\/\//i.test(image.source) || image.source.startsWith('data:')) continue;
      if (!fs.existsSync(image.source)) throw new Error(`正文配图不存在，请重新生成或删除：${path.basename(image.source)}`);
      const prepared = prepareWeChatInlineImage(image.source);
      if (prepared.bytes.length > 1024 * 1024) throw new Error(`正文配图超过微信 1MB 限制，请压缩或重新生成：${path.basename(image.source)}`);
      uploadedImages.set(image.source, await weChat.uploadArticleImage(credentials, prepared));
    }
    const thumbMediaId = await weChat.uploadThumb(credentials, {
      bytes: fs.readFileSync(task.coverPath),
      filename: path.basename(task.coverPath),
      contentType: contentTypeFor(task.coverPath)
    });
    const mediaId = await weChat.createDraft(credentials, {
      title,
      author,
      digest: makeDigest(article),
      html: renderWeChatHtml(article, {
        theme: task.theme,
        aigcFooter: DEFAULT_AIGC_FOOTER,
        resolveImage: source => uploadedImages.get(source) ?? source
      }),
      thumbMediaId
    });
    const saved = update(id, {
      status: 'published',
      publishJson: JSON.stringify({ mediaId, title, author, unreviewed: !isContentPublishable(task), publishedAt: new Date().toISOString() })
    });
    return { ...saved, mediaId };
  }));
  ipcMain.handle('content:cover:generate', async (_event, id: number) => requests.run(id, async () => {
    const task = getContentTask(db, id);
    const signal = imageJobs.begin(id);
    try { return update(id, { coverPath: await generateCover(task, signal) }); }
    finally { imageJobs.end(id); }
  }));
  /**
   * 正文配图：按小节挑位置，逐张生成后插回初稿。
   * 插入图片会改动正文，因此旧审稿与成稿一并失效（和手动改正文一致）。
   */
  ipcMain.handle('content:images:generate', async (_event, id: number, count = 3) => requests.run(id, async () => {
    const task = getContentTask(db, id);
    if (!task.draft.trim()) throw new Error('请先生成或填写正文，再配正文插图');
    const slots = planImageSlots(task.draft, clampImageCount(count));
    if (!slots.length) throw new Error('正文段落太短，暂时找不到合适的配图位置');
    const signal = imageJobs.begin(id);
    try {
      const { paths, failures } = await generateInline(task, slots, Date.now(), signal);
      if (!paths.some(Boolean)) throw new Error(signal.aborted ? '已取消生成' : failures[0] || '正文配图生成失败');
      return update(id, { draft: applyGeneratedImages(task.draft, slots, paths).draft, finalArticle: '', reviewJson: '', status: 'draft' });
    } finally { imageJobs.end(id); }
  }));
  /**
   * 一次动作同时出封面与正文配图：封面和配图并发生成，省掉来回点两次、等两轮。
   *
   * 三条容错规则：
   * 1. 正文为空/太短时只出封面，原因随 imageWarning 回给界面，不当成失败；
   * 2. 部分图片失败不影响已经生成的图片入库，失败原因一并放进 imageWarning；
   * 3. 封面与配图全失败才抛错。
   */
  ipcMain.handle('content:images:generate-all', async (_event, id: number, count = 3) => requests.run(id, async () => {
    const task = getContentTask(db, id);
    const plan = planCoverAndInlineImages(task.draft, clampImageCount(count));
    const signal = imageJobs.begin(id);
    const [cover, inline] = await Promise.all([
      generateCover(task, signal).then(file => ({ path: file, error: '' }))
        .catch(error => ({ path: '', error: imageErrorText(error) })),
      plan.withInline
        ? generateInline(task, plan.slots, Date.now(), signal)
        : Promise.resolve({ paths: [] as Array<string | null>, failures: [] as string[] })
    ]).finally(() => imageJobs.end(id));
    const patch: Partial<ContentTask> = {};
    const warnings: string[] = [];
    if (plan.note) warnings.push(plan.note);
    if (cover.path) patch.coverPath = cover.path;
    else warnings.push(`封面生成失败：${cover.error}`);
    const merged = plan.withInline ? applyGeneratedImages(task.draft, plan.slots, inline.paths) : { draft: task.draft, inserted: 0, failed: 0 };
    if (merged.inserted) {
      patch.draft = merged.draft;
      patch.finalArticle = '';
      patch.reviewJson = '';
      patch.status = 'draft';
    } else if (inline.failures.length) {
      warnings.push(`正文配图生成失败：${inline.failures[0]}`);
    }
    if (merged.inserted && merged.failed) warnings.push(`有 ${merged.failed} 张配图没生成成功`);
    if (!patch.coverPath && !merged.inserted) throw new Error(signal.aborted ? '已取消生成' : warnings.join('；') || '图片生成失败');
    return { ...update(id, patch), imageWarning: warnings.join('；') };
  }));
  /** 中断正在跑的生图：长等待时用户至少能自己退出，不必干等到超时。 */
  ipcMain.handle('content:images:cancel', (_event, id: number) => imageJobs.cancel(id));
  /** 预览走主进程：只有它能读本地图片并转成 data URI 塞进 iframe。 */
  ipcMain.handle('content:preview', (_event, id: number, source: 'draft' | 'final' = 'draft') => {
    const task = getContentTask(db, id);
    const markdown = source === 'final' && task.finalArticle.trim() ? task.finalArticle : task.draft;
    return {
      html: renderWeChatHtml(markdown, {
        theme: task.theme,
        aigcFooter: DEFAULT_AIGC_FOOTER,
        resolveImage: previewImageSource
      })
    };
  });
  /**
   * 前端直接显示封面与正文配图。
   * 传的是几万字节量级的缩略图，不是几 MB 的原图，避免 IPC 和界面被大图拖住。
   */
  ipcMain.handle('content:assets', (_event, id: number) => {
    const assets = collectTaskAssets(getContentTask(db, id));
    return {
      cover: assets.cover ? { path: assets.cover, caption: '封面', thumbnail: imageThumbnail(assets.cover) } : null,
      images: assets.images.map(image => ({ path: image.source, caption: image.caption, thumbnail: imageThumbnail(image.source) }))
    };
  });
}
