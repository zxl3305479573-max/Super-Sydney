import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain, shell } from 'electron';
import type { AppContext } from '../app-context';
import type { ContentDirectionInput, ContentStage, ContentTask, DirectionNoteSuggestion, ImageCandidateBundle, ImageCandidateGroup, ImageCandidateOption, ImageCandidateScope } from '../shared';
import type { ImageSlot } from '../services/content-images';
import { COVER_CANDIDATE_KEY, applyGeneratedImages, articleLeadExcerpt, buildImagePrompt, classifyAssetFile, collectTaskAssets, listInlineImages, mergeCandidateOptions, placeImages, replaceInlineImage, planCoverAndInlineImages, planImageSlots, resolveCandidatePicks, slotCandidateKey } from '../services/content-images';
import { coverImagePrompt, imagePromptScope } from '../services/content-api-config';
import { chosenDefaultSubdirectionName, createContentTask, deleteContentTask, getContentTask, listContentTasks, optionalId, saveTaxonomyTree, updateContentTask } from '../services/content-store';
import { findSubdirection, subdirectionNames } from '../services/content-taxonomy';
import { requestContentStage } from '../services/content-workflow';
import { normalizeDirectionNoteRequest, requestDirectionNote } from '../services/direction-note';
import { normalizeImageStyleRequest, requestImageStyle } from '../services/image-style-note';
import { exportContentArticle, parseContentSources } from '../services/content-export';
import { assertContentDeliverable, assertContentStage, deliverableArticle, isContentPublishable, prepareContentEdit } from '../services/content-policy';
import { DEFAULT_AIGC_FOOTER, makeDigest, normalizeTitle, renderWeChatHtml, toPlainText } from '../services/article-html';
import { appendEvidenceSection } from '../services/evidence-section';
import { ImageJobs, clampCandidateCount, clampImageCount, imageErrorText } from '../services/image-generation';
import { imageThumbnail, prepareWeChatInlineImage, previewImageSource } from '../services/native-image';
import { RequestLock } from '../services/request-lock';
import { WeChatClient, contentTypeFor } from '../services/wechat-publisher';
import { yamlScalar } from '../services/wewrite-config';
import { readWeWriteFiles, syncStyleTopics } from '../services/wewrite-files';
import { assetDirectory, contentApiConfig, generateImageFile, readContentTaxonomy, removeAssetDirectory } from './content-support';
import { normalizeWechatIpCoverInput, renderWechatIpCover, WECHAT_COVER_SIZE, WECHAT_SHARE_SIZE } from '../services/wechat-ip-cover';
import { renderHtmlPages } from '../services/xhs-render';
import { ipReferenceImage, ipRenderKit } from './ip';

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

  /** 公众号选用的 IP 角色参考图：AI 生图时把角色融进画面；没选 IP 时为 null，照原样生图。 */
  const wechatIp = () => ipReferenceImage(ctx.ipLibrary, ctx.ipLibrary.selections().wechat);

  /** 生成封面并落盘，返回文件路径。 */
  const generateCover = (task: ContentTask, signal?: AbortSignal): Promise<string> => {
    const scope = imagePromptScope(readContentTaxonomy(ctx), task, readWeWriteFiles().styleText);
    const target = path.join(assetDirectory(ctx, 'content-assets', task.id), `cover-${Date.now()}.png`);
    return generateImageFile(target, coverImagePrompt(task, scope), '1792x1024', signal, wechatIp());
  };

  /**
   * 按位置并发生成正文配图：paths 与 slots 一一对应，失败的位置是 null。
   * 并发是为了让「封面 + 3 张配图」这种一次动作不被串行等待拖到一分多钟。
   */
  const generateInline = async (task: ContentTask, slots: ImageSlot[], stamp: number, signal?: AbortSignal): Promise<{ paths: Array<string | null>; failures: string[] }> => {
    const directory = assetDirectory(ctx, 'content-assets', task.id);
    const scope = imagePromptScope(readContentTaxonomy(ctx), task, readWeWriteFiles().styleText);
    const failures: string[] = [];
    const ip = wechatIp();
    const settled = await Promise.allSettled(slots.map((slot, index) => generateImageFile(
      path.join(directory, `inline-${stamp}-${index + 1}.png`),
      buildImagePrompt({ articleTitle: task.title || task.topic, heading: slot.heading, excerpt: slot.excerpt, direction: scope.direction, style: scope.style }),
      '1792x1024',
      signal,
      ip
    )));
    const paths = settled.map(item => {
      if (item.status === 'fulfilled') return item.value;
      failures.push(imageErrorText(item.reason));
      return null;
    });
    return { paths, failures };
  };

  /**
   * 候选图：AI 一次容易出一堆差不多的图，与其直接插进正文再删，不如先生成再让用户挑。
   * 候选只放在内存里——它是「这一次挑哪张」的临时状态，重启后重新生成即可。
   * draft 是生成那一刻的正文快照：挑图期间正文改过就不能再按旧行号插回去。
   */
  const pendingCandidates = new Map<number, { draft: string; slots: ImageSlot[] }>();

  /** 候选面板最多回传多少张缩略图：历史图再多也只列最近的这些，避免 IPC 塞满大 base64。 */
  const HISTORY_LIMIT = 9;
  /** 候选缩略图比正文配图墙小一号：面板一次要列十几张。 */
  const CANDIDATE_THUMBNAIL_WIDTH = 360;

  /** 同一句提示词要 N 张候选：并发生成，个别失败就少几张，成功的仍然给用户挑。 */
  const generateOptions = async (target: (index: number) => string, prompt: string, candidates: number, signal?: AbortSignal): Promise<{ paths: string[]; failures: string[] }> => {
    const ip = wechatIp();
    const settled = await Promise.allSettled(Array.from({ length: candidates }, (_item, index) =>
      generateImageFile(target(index), prompt, '1792x1024', signal, ip)));
    const paths: string[] = [];
    const failures: string[] = [];
    for (const item of settled) {
      if (item.status === 'fulfilled') paths.push(item.value);
      else failures.push(imageErrorText(item.reason));
    }
    return { paths, failures };
  };

  /**
   * 这篇文章已经生成过的图：按修改时间倒序，封面与正文配图分开。
   * 历史图就躺在任务的配图目录里，所以「以前生成的图能不能再挑」不需要额外落库。
   */
  const assetHistory = (directory: string): { cover: string[]; inline: string[] } => {
    const found: Array<{ path: string; kind: 'cover' | 'inline'; mtime: number }> = [];
    for (const name of fs.readdirSync(directory)) {
      const kind = classifyAssetFile(name);
      if (!kind) continue;
      const target = path.join(directory, name);
      try {
        const stat = fs.statSync(target);
        if (stat.isFile()) found.push({ path: target, kind, mtime: stat.mtimeMs });
      } catch { /* 文件正好被删掉就跳过，不影响其它候选 */ }
    }
    found.sort((left, right) => right.mtime - left.mtime);
    const take = (kind: 'cover' | 'inline') => found.filter(item => item.kind === kind).slice(0, HISTORY_LIMIT).map(item => item.path);
    return { cover: take('cover'), inline: take('inline') };
  };

  /** 界面回传的路径不可信：只认这篇文章配图目录里真实存在的文件。 */
  const isOwnAsset = (id: number, target: string) => {
    const directory = path.resolve(assetDirectory(ctx, 'content-assets', id));
    const resolvedTarget = path.resolve(target);
    return resolvedTarget.startsWith(`${directory}${path.sep}`) && fs.existsSync(resolvedTarget);
  };

  /** 本次候选在前、历史图在后；缩略图统一在这里生成。 */
  const candidateOptions = (fresh: string[], history: string[]) =>
    mergeCandidateOptions(fresh, history).map(option => ({ ...option, thumbnail: imageThumbnail(option.path, CANDIDATE_THUMBNAIL_WIDTH) }));

  const coverGroup = (fresh: string[], history: string[], excerpt: string): ImageCandidateGroup => ({
    key: COVER_CANDIDATE_KEY, label: '封面', excerpt, options: candidateOptions(fresh, history)
  });

  const slotGroup = (index: number, slot: ImageSlot, fresh: string[], history: string[]): ImageCandidateGroup => ({
    key: slotCandidateKey(index), label: `第 ${index + 1} 处 · ${slot.heading}`, excerpt: slot.excerpt, options: candidateOptions(fresh, history)
  });

  ipcMain.handle('content:list', () => listContentTasks(db));
  ipcMain.handle('content:taxonomy', () => readContentTaxonomy(ctx));
  /** 保存分类树后，把具体方向名与默认方向回写到 style.yaml。 */
  ipcMain.handle('content:taxonomy:save', (_event, directions: ContentDirectionInput[], defaultSubdirectionId?: number | null) => {
    saveTaxonomyTree(db, directions);
    const saved = readContentTaxonomy(ctx);
    // style.yaml 镜像默认具体方向所在的那份资料：agent 侧 skill 只认这一份，和应用里的默认资料保持一致。
    const defaultName = chosenDefaultSubdirectionName(saved, defaultSubdirectionId);
    const owner = saved.directions.find(direction => direction.subdirections.some(sub => sub.name === defaultName));
    syncStyleTopics(subdirectionNames(saved.directions), defaultName, undefined, owner ? {
      name: owner.accountName, industry: owner.industry, author: owner.author,
      targetAudience: owner.audience, tone: owner.tone, voice: owner.voice,
      persona: owner.persona, theme: owner.theme, wordCount: owner.wordCount, contentStyle: owner.contentStyle,
      blacklistWords: owner.blacklistWords, blacklistTopics: owner.blacklistTopics
    } : undefined);
    ctx.broadcast();
    return readContentTaxonomy(ctx);
  });
  /** 只返回建议文本，由用户在界面上确认采用后随分类一起保存。 */
  ipcMain.handle('content:direction-note:optimize', async (_event, request: unknown): Promise<DirectionNoteSuggestion> =>
    requestDirectionNote(normalizeDirectionNoteRequest(request), contentApiConfig(ctx)));
  ipcMain.handle('content:image-style:optimize', async (_event, request: unknown): Promise<DirectionNoteSuggestion> =>
    requestImageStyle(normalizeImageStyleRequest(request), contentApiConfig(ctx)));
  /** 删除文章：生成、生图进行中不能删；连同应用目录里的配图一起清掉，已导出到知识库的文章不受影响。 */
  ipcMain.handle('content:delete', (_event, id: number) => {
    assertIdle(id, '删除');
    deleteContentTask(db, id);
    removeAssetDirectory(ctx, 'content-assets', id);
    ctx.broadcast();
  });
  ipcMain.handle('content:create', (_event, directionId: number | null, subdirectionId: number | null, topic = '') => {
    const taxonomy = readContentTaxonomy(ctx);
    const created = createContentTask(db, taxonomy, directionId, subdirectionId, topic);
    // 新任务的排版主题取所属资料的默认主题；之后在编辑器里单篇切换。
    const theme = findSubdirection(taxonomy.directions, created.subdirectionId)?.direction.theme;
    const task = theme ? updateContentTask(db, created.id, { theme }) : created;
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
  /**
   * 用公众号当前选用的 IP 本地排版出图，不调图片接口：2.35:1 的写成这篇的封面（推草稿时就用它），
   * 1:1 的分享图另存在素材目录（微信草稿接口只收一张封面，分享图由用户自行取用）。
   */
  ipcMain.handle('content:ip-cover:render', async (_event, id: number, raw: unknown) => requests.run(id, async () => {
    const ipId = ctx.ipLibrary.selections().wechat;
    if (!ipId) throw new Error('公众号还没有选用 IP：先在封面步骤里选一个');
    const input = normalizeWechatIpCoverInput(raw);
    if (!input.title) throw new Error('封面标题不能为空');
    const kit = ipRenderKit(ctx.ipLibrary, ipId);
    const directory = assetDirectory(ctx, 'content-assets', id);
    const stamp = Date.now();
    const cover = path.join(directory, `cover-ip-${stamp}.png`);
    const share = path.join(directory, `share-ip-${stamp}.png`);
    await renderHtmlPages([renderWechatIpCover(input, kit, 'cover')], WECHAT_COVER_SIZE.width, WECHAT_COVER_SIZE.height, [cover]);
    await renderHtmlPages([renderWechatIpCover(input, kit, 'share')], WECHAT_SHARE_SIZE.width, WECHAT_SHARE_SIZE.height, [share]);
    return { task: update(id, { coverPath: cover }), share: { path: share, thumbnail: imageThumbnail(share, 360) } };
  }));
  /** 只认这篇文章自己素材目录里的文件，免得渲染进程借它打开任意路径。 */
  ipcMain.handle('content:asset:reveal', (_event, id: number, file: string) => {
    const directory = path.resolve(assetDirectory(ctx, 'content-assets', id));
    const target = path.resolve(String(file ?? ''));
    if (path.dirname(target) !== directory || !fs.existsSync(target)) throw new Error('文件不存在或不属于这篇文章');
    shell.showItemInFolder(target);
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
    // 推送的正文同样在末尾带上来源与证据，和预览、导出保持一致。
    const articleWithEvidence = appendEvidenceSection(article, task);
    if (!task.coverPath) throw new Error('缺少封面图：请先选择本地图片或生成封面');
    if (!fs.existsSync(task.coverPath)) throw new Error('封面图文件已不存在，请重新选择');

    const title = normalizeTitle(task.title || toPlainText(article).slice(0, 40) || '未命名文章');
    if (!title) throw new Error('请先填写文章标题');
    // 署名优先用文章所属资料的；资料没填才用全局的草稿默认署名。
    const profileAuthor = findSubdirection(readContentTaxonomy(ctx).directions, task.subdirectionId)?.direction.author ?? '';
    const author = profileAuthor || yamlScalar(configText, 'author') || yamlScalar(styleText, 'author');
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
      html: renderWeChatHtml(articleWithEvidence, {
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
    pendingCandidates.delete(id);
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
    pendingCandidates.delete(id);
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
    pendingCandidates.delete(id);
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
  /**
   * 候选图：每处并发出 candidates 张，只落盘不成文，返回带缩略图的分组交给界面挑。
   * scope 决定出哪几处：封面、正文配图，或一次都出（和「生成即插入」入口一一对应）。
   */
  ipcMain.handle('content:images:candidates', async (_event, id: number, scope: ImageCandidateScope = 'both', count = 3, candidates = 1) => requests.run(id, async () => {
    const task = getContentTask(db, id);
    const perSlot = clampCandidateCount(candidates);
    if (perSlot < 2) throw new Error('候选图至少要 2 张，1 张请直接用「生成即插入」');
    const plan = planCoverAndInlineImages(task.draft, clampImageCount(count));
    if (scope === 'inline' && !plan.withInline) throw new Error(task.draft.trim() ? '正文段落太短，暂时找不到合适的配图位置' : '请先生成或填写正文，再配正文插图');
    const slots = scope === 'cover' ? [] : plan.slots;
    const directory = assetDirectory(ctx, 'content-assets', task.id);
    const promptScope = imagePromptScope(readContentTaxonomy(ctx), task, readWeWriteFiles().styleText);
    const stamp = Date.now();
    const signal = imageJobs.begin(id);
    try {
      const [cover, perSlotResults] = await Promise.all([
        scope === 'inline'
          ? Promise.resolve({ paths: [] as string[], failures: [] as string[] })
          : generateOptions(index => path.join(directory, `cover-${stamp}-${index + 1}.png`), coverImagePrompt(task, promptScope), perSlot, signal),
        Promise.all(slots.map((slot, index) => generateOptions(
          candidate => path.join(directory, `inline-${stamp}-${index + 1}-${candidate + 1}.png`),
          buildImagePrompt({ articleTitle: task.title || task.topic, heading: slot.heading, excerpt: slot.excerpt, direction: promptScope.direction, style: promptScope.style }),
          perSlot,
          signal
        ).then(result => ({ slot, ...result }))))
      ]);
      const failures = [cover.failures, ...perSlotResults.map(item => item.failures)].flat();
      // 全失败的位置不留空组，免得界面出现「这个位置 0 张可选」的死按钮。
      const slotCandidates = perSlotResults.map(({ slot, paths }) => ({ slot, options: paths })).filter(item => item.options.length);
      // 历史图一起列出来：上次那批里没选中的，这次仍然能挑。
      const history = assetHistory(directory);
      const coverExcerpt = articleLeadExcerpt(task.draft || task.finalArticle || '');
      const groups: ImageCandidateGroup[] = [
        ...(cover.paths.length ? [coverGroup(cover.paths, history.cover, coverExcerpt)] : []),
        ...slotCandidates.map((item, index) => slotGroup(index, item.slot, item.options, history.inline))
      ];
      if (!groups.length) throw new Error(signal.aborted ? '已取消生成' : failures[0] || '候选图生成失败');
      pendingCandidates.set(id, { draft: task.draft, slots: slotCandidates.map(item => item.slot) });
      const warnings = [scope === 'cover' ? '' : plan.note, failures.length ? `有 ${failures.length} 张候选没生成成功` : ''].filter(Boolean);
      return { taskId: id, groups, warning: warnings.join('；') } satisfies ImageCandidateBundle;
    } finally {
      imageJobs.end(id);
    }
  }));
  /**
   * 「以前生成的图」面板：不打接口、不花钱，直接把这篇任务已经生成过的图按位置列出来。
   * 位置沿用当前正文的配图计划，所以历史图也能插到这次的小节下。
   */
  ipcMain.handle('content:images:library', (_event, id: number, scope: ImageCandidateScope = 'both') => {
    const task = getContentTask(db, id);
    const directory = assetDirectory(ctx, 'content-assets', task.id);
    const history = assetHistory(directory);
    const plan = planCoverAndInlineImages(task.draft, 3);
    const slots = scope === 'cover' || !plan.withInline ? [] : plan.slots;
    const groups: ImageCandidateGroup[] = [
      ...(scope !== 'inline' && history.cover.length ? [coverGroup([], history.cover, articleLeadExcerpt(task.draft || task.finalArticle || ''))] : []),
      ...(history.inline.length ? slots.map((slot, index) => slotGroup(index, slot, [], history.inline)) : [])
    ];
    if (!groups.length) {
      // 正文太短时历史配图其实还在，只是没有可以插进去的位置，得把原因说清楚。
      const stuck = scope !== 'cover' && history.inline.length > 0;
      return {
        taskId: id, groups: [],
        warning: stuck
          ? '正文段落太短，暂时找不到可以插入配图的位置'
          : `这篇文章还没有生成过${scope === 'cover' ? '封面' : scope === 'inline' ? '正文配图' : '图片'}，先点「AI 生成」出几张再来挑`
      } satisfies ImageCandidateBundle;
    }
    pendingCandidates.set(id, { draft: task.draft, slots });
    return { taskId: id, groups, warning: '' } satisfies ImageCandidateBundle;
  });
  /**
   * 采用挑好的候选：封面进 coverPath，正文配图按位置插回初稿。
   * 两道保险：只认这篇文章自己配图目录里的文件（界面回传的路径不能当可信输入，
   * 但历史图也算，换图不必重新生成），正文在挑图期间改过就拒绝插入——旧行号插回去会打乱文章结构。
   */
  ipcMain.handle('content:images:candidates:apply', (_event, id: number, picks: Array<{ key: string; path: string }>) => requests.run(id, async () => {
    const pending = pendingCandidates.get(id);
    if (!pending) throw new Error('没有待选用的候选图，请先生成候选');
    const task = getContentTask(db, id);
    if (task.draft !== pending.draft) throw new Error('正文在挑图期间有改动，配图位置已经不准了，请重新生成候选');
    if (!Array.isArray(picks) || !picks.length) throw new Error('还没有选择要用的图');
    const resolved = resolveCandidatePicks(pending.slots, picks);
    const ownAsset = (target: string) => isOwnAsset(id, target);
    const patch: Partial<ContentTask> = {};
    if (resolved.cover) {
      if (!ownAsset(resolved.cover)) throw new Error('选的封面不是这篇文章生成的图，请重新选择');
      patch.coverPath = resolved.cover;
    }
    if (resolved.images.length) {
      if (!resolved.images.every(image => ownAsset(image.path))) throw new Error('选的配图不是这篇文章生成的图，请重新选择');
      patch.draft = placeImages(task.draft, resolved.images);
      patch.finalArticle = '';
      patch.reviewJson = '';
      patch.status = 'draft';
    }
    pendingCandidates.delete(id);
    return update(id, patch);
  }));
  /**
   * 预览里「文章配图」逐张换图用的图库：这篇文章生成过的封面与正文配图，不打接口、不花钱。
   * 和候选面板不同，它不依赖配图计划，正文里已有的每一张都能单独换。
   */
  ipcMain.handle('content:images:history', (_event, id: number) => {
    const history = assetHistory(assetDirectory(ctx, 'content-assets', getContentTask(db, id).id));
    const options = (paths: string[]): ImageCandidateOption[] =>
      paths.map(target => ({ path: target, origin: 'history', thumbnail: imageThumbnail(target, CANDIDATE_THUMBNAIL_WIDTH) }));
    return { cover: options(history.cover), inline: options(history.inline) };
  });
  /**
   * 把正文里第 index 张配图换成用户挑的那张（或 index 为 'cover' 时换封面）。
   * 只认这篇文章自己配图目录里的文件；换正文配图会改动正文，旧审稿与成稿随之失效。
   */
  ipcMain.handle('content:images:swap', (_event, id: number, index: number | 'cover', target: string, expected?: string) => requests.run(id, async () => {
    const task = getContentTask(db, id);
    if (typeof target !== 'string' || !isOwnAsset(id, target)) throw new Error('选的图不是这篇文章生成的图，请重新选择');
    if (index === 'cover') return update(id, { coverPath: path.resolve(target) });
    if (!Number.isInteger(index) || index < 0) throw new Error('配图位置不对，请刷新后重试');
    const draft = replaceInlineImage(task.draft, index, path.resolve(target), typeof expected === 'string' ? expected : undefined);
    if (draft === null) throw new Error('正文里找不到这张配图，可能刚改过正文，请刷新后重试');
    if (draft === task.draft) return task;
    return update(id, { draft, finalArticle: '', reviewJson: '', status: 'draft' });
  }));
  ipcMain.handle('content:images:candidates:discard', (_event, id: number) => { pendingCandidates.delete(id); });
  /** 中断正在跑的生图：长等待时用户至少能自己退出，不必干等到超时。 */
  ipcMain.handle('content:images:cancel', (_event, id: number) => imageJobs.cancel(id));
  /** 预览走主进程：只有它能读本地图片并转成 data URI 塞进 iframe。 */
  ipcMain.handle('content:preview', (_event, id: number, source: 'draft' | 'final' = 'draft') => {
    const task = getContentTask(db, id);
    const markdown = source === 'final' && task.finalArticle.trim() ? task.finalArticle : task.draft;
    return {
      // 来源与证据追加在正文末尾，预览与推送、导出看到的是同一段。
      html: renderWeChatHtml(appendEvidenceSection(markdown, task), {
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
