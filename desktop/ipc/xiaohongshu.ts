import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain, shell } from 'electron';
import { openUrl } from '../services/browser';
import type { AppContext } from '../app-context';
import type {
  XhsAccount, XhsAnalyticsView, XhsAuditInput, XhsBasis, XhsGenerateStage, XhsHotNote, XhsHotspotQuery, XhsHotspotResult, XhsImageItem,
  XhsNote, XhsNoteAssets, XhsReport, XhsRouterAdvice
} from '../shared';
import { ImageJobs, imageErrorText, withIpInstruction } from '../services/image-generation';
import { imageThumbnail } from '../services/native-image';
import { RequestLock } from '../services/request-lock';
import { readTableFile } from '../services/table-file';
import { XHS_FUNNEL_LAYERS, XHS_PAGE_COUNTS } from '../services/xhs-catalog';
import { renderCardDocument, XHS_CARD_HEIGHT, XHS_CARD_WIDTH } from '../services/xhs-cards';
import { exportXhsPackage } from '../services/xhs-export';
import { normalizeIpCoverInput, renderIpCoverDocument } from '../services/xhs-ip-cover';
import { ipReferenceImage, ipRenderKit } from './ip';
import { hotspotCacheKey, isHttpLink, normalizeHotspotQuery, searchRedfox, type FetchLike } from '../services/xhs-hotspot';
import {
  chainAdvice, deriveXhsStatus, localChecks, mergeCheckItems, prepareXhsEdit, addCandidates, readCandidates, readCardPlan, readCheckReport, readImages, readPositioning,
  readPositioningChat, routeByRules, stampBasis
} from '../services/xhs-pipeline';
import { fitToThreeFour, renderHtmlPages, searchBing } from '../services/xhs-render';
import { analyticsDigest, auditMetrics, buildXhsAnalytics, matchXhsNote, tableToXhsStats } from '../services/xhs-stats';
import {
  createXhsAccount, createXhsNote, createXhsReport, deleteXhsAccount, deleteXhsNote, deleteXhsReport, deleteXhsStat, getXhsAccount, getXhsNote, listXhsAccounts, listXhsNotes,
  listXhsReports, listXhsStats, readHotspotCache, updateXhsAccount, updateXhsNote, upsertXhsStats, writeHotspotCache
} from '../services/xhs-store';
import type { XhsView } from '../services/xhs-view';
import {
  requestPositioningStep, requestRouteChoice, requestXhsAnalyticsInterpretation, requestXhsAudit, requestXhsBody, requestXhsCardPlan,
  requestXhsModelChecks, requestXhsTitles, requestXhsTopicIdeas, xhsCoverPrompt, xhsInfoImagePrompt, type XhsApiConfig
} from '../services/xhs-workflow';
import { requestGeneratedImage } from '../services/image-generation';
import { MODEL_SETTINGS_WHERE, imageApiConfig, writerEndpoint } from '../services/content-api-config';
import { readWeWriteFiles } from '../services/wewrite-files';

/* ── 小红书 ──────────────────────────────────────────────────────
 * 五环节 + 总控。独立的 xhs:* 命名空间，不进 state:get；写库后照常广播，让界面重新拉取。
 * 对外请求只在用户点按钮时发生：红狐（关键词）、必应（关键词）、内容 API 与图片 API（笔记内容）。
 * 不代发布：终点是知识库里的发布包。
 */

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const IMAGE_FILTERS = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }];

export function registerXhsIpc(ctx: AppContext, view: XhsView): void {
  const { db } = ctx;
  const noteLock = new RequestLock('这篇笔记正在处理，请等待当前操作完成');
  const accountLock = new RequestLock('这个账号正在处理，请等待当前操作完成');
  const imageJobs = new ImageJobs();
  const redfox = (apiKey: string) => ({ apiKey, fetch: fetch as unknown as FetchLike });

  /** 内容模型用全应用统一的那一个（「设置 → 模型」）；读者与人设仍只来自小红书定位档案。 */
  const apiConfig = (_account?: XhsAccount): XhsApiConfig => {
    if (!ctx.settings.read().llmEnabled) throw new Error(`请先在${MODEL_SETTINGS_WHERE}里允许调用内容模型`);
    const apiKey = ctx.llmApiKey();
    if (!apiKey) throw new Error(`还没有配置内容模型的 API Key，请先在${MODEL_SETTINGS_WHERE}里填写`);
    return { apiKey, ...writerEndpoint(readWeWriteFiles().configText) };
  };
  const assetDir = (noteId: number) => {
    const directory = path.join(ctx.dataDir, 'xhs-assets', String(noteId));
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  };
  /** 写库前统一按内容重算状态。 */
  const save = (id: number, patch: Partial<XhsNote>): XhsNote => {
    const current = getXhsNote(db, id);
    const next = { ...current, ...patch };
    const note = updateXhsNote(db, id, { ...patch, status: deriveXhsStatus(next) });
    ctx.broadcast();
    return note;
  };
  const assertIdle = (id: number, action: string) => {
    if (noteLock.has(id)) throw new Error(`这篇笔记正在处理，请稍后${action}`);
  };
  const analyticsView = (accountId: number): XhsAnalyticsView =>
    buildXhsAnalytics(listXhsStats(db, accountId), listXhsReports(db, accountId, 'analytics')[0] ?? null);

  /* ── 账号与定位 ─────────────────────────────────────────────── */

  ipcMain.handle('xhs:accounts:list', () => listXhsAccounts(db));
  ipcMain.handle('xhs:accounts:create', (_event, name: string) => {
    const account = createXhsAccount(db, name);
    ctx.broadcast();
    return account;
  });
  ipcMain.handle('xhs:accounts:delete', (_event, id: number) => accountLock.run(id, async () => {
    deleteXhsAccount(db, id);
    // 连同这个账号在小红书窗口里的登录状态一起清掉。
    await view.forget(id);
    ctx.broadcast();
  }));
  ipcMain.handle('xhs:accounts:update', (_event, id: number, patch: Partial<XhsAccount>) => {
    const clean: Partial<XhsAccount> = {};
    if (patch.name !== undefined) clean.name = patch.name;
    if (patch.ipId !== undefined) {
      const ipId = String(patch.ipId ?? '');
      if (ipId) ctx.ipLibrary.get(ipId);
      clean.ipId = ipId;
    }
    if (patch.positioningJson !== undefined) {
      if (String(patch.positioningJson).trim() && !readPositioning({ positioningJson: String(patch.positioningJson) })) throw new Error('定位档案格式不正确');
      clean.positioningJson = String(patch.positioningJson);
    }
    const account = updateXhsAccount(db, id, clean);
    ctx.broadcast();
    return account;
  });

  /** 定位问答：成功后才把这一轮写进记录，失败时用户的回答还留在输入框里，可以直接重试。 */
  ipcMain.handle('xhs:positioning:step', async (_event, accountId: number, answer: string, finish: boolean) => accountLock.run(accountId, async () => {
    const account = getXhsAccount(db, accountId);
    const transcript = readPositioningChat(account);
    const text = String(answer ?? '').trim().slice(0, 2000);
    const last = transcript[transcript.length - 1];
    if (!text && !finish && last?.role === 'coach' && last.questions?.length) throw new Error('请先回答上面的问题，或点「直接生成定位档案」');
    if (text) transcript.push({ role: 'user', text });
    const result = await requestPositioningStep(apiConfig(account), transcript, Boolean(finish));
    transcript.push({ role: 'coach', text: result.coach || (result.done ? '定位档案已生成。' : '继续聊几个问题。'), ...(result.questions.length ? { questions: result.questions } : {}) });
    const patch: Partial<XhsAccount> = { positioningChatJson: JSON.stringify(transcript) };
    if (result.profile) patch.positioningJson = JSON.stringify(result.profile);
    const updated = updateXhsAccount(db, accountId, patch);
    ctx.broadcast();
    return updated;
  }));
  ipcMain.handle('xhs:positioning:reset', (_event, accountId: number) => {
    const account = updateXhsAccount(db, accountId, { positioningChatJson: '' });
    ctx.broadcast();
    return account;
  });
  ipcMain.handle('xhs:positioning:adopt', (_event, accountId: number, indexes: number[]) => {
    const positioning = readPositioning(getXhsAccount(db, accountId));
    if (!positioning) throw new Error('还没有定位档案');
    const existing = new Set(listXhsNotes(db, accountId).map(note => note.topic.trim()));
    let created = 0;
    let skipped = 0;
    for (const index of new Set((Array.isArray(indexes) ? indexes : []).map(Number))) {
      const topic = positioning.firstTopics[index];
      if (!topic) continue;
      if (existing.has(topic.title)) { skipped += 1; continue; }
      createXhsNote(db, accountId, topic.title, null, topic.noteType);
      existing.add(topic.title);
      created += 1;
    }
    ctx.broadcast();
    return { created, skipped };
  });

  /** 向导：规则先给结论；用户写了描述就让模型在三条链路里选，模型不可用时退回规则。 */
  ipcMain.handle('xhs:router:recommend', async (_event, accountId: number, description: string): Promise<XhsRouterAdvice> => {
    const account = getXhsAccount(db, accountId);
    const analytics = analyticsView(accountId);
    const context = { hasPositioning: Boolean(readPositioning(account)), dominantLayer: analytics.dominant, noteCount: listXhsNotes(db, accountId).length, statCount: analytics.rows.length };
    const rule = routeByRules(context);
    const text = String(description ?? '').trim().slice(0, 1000);
    if (!text) return rule;
    try {
      const summary = `${context.hasPositioning ? '已有定位档案' : '还没有定位档案'}；${context.noteCount} 篇笔记任务；${context.statCount} 篇有数据；${analytics.dominant ? `复盘主要卡点：${XHS_FUNNEL_LAYERS.find(item => item.key === analytics.dominant)?.label}` : '没有复盘卡点'}`;
      const choice = await requestRouteChoice(apiConfig(account), text, summary);
      return chainAdvice(choice.chain, choice.layer, choice.reason, 'model');
    } catch (error) {
      return { ...rule, reason: `${rule.reason}（模型分流不可用：${error instanceof Error ? error.message : String(error)}，已按规则推荐）` };
    }
  });

  /* ── 笔记 ───────────────────────────────────────────────────── */

  ipcMain.handle('xhs:notes:list', (_event, accountId: number) => listXhsNotes(db, accountId));
  ipcMain.handle('xhs:notes:create', (_event, accountId: number, topic: string, source: XhsHotNote | null = null) => {
    const note = createXhsNote(db, accountId, topic, source);
    ctx.broadcast();
    return note;
  });
  ipcMain.handle('xhs:notes:update', (_event, id: number, patch: Partial<XhsNote>) => {
    assertIdle(id, '保存');
    return save(id, prepareXhsEdit(getXhsNote(db, id), patch ?? {}));
  });
  ipcMain.handle('xhs:notes:delete', (_event, id: number) => {
    assertIdle(id, '删除');
    deleteXhsNote(db, id);
    // 封面、卡片图、信息图、候选图库都在这个目录里；已导出的发布包在知识库，不受影响。
    fs.rmSync(path.join(ctx.dataDir, 'xhs-assets', String(id)), { recursive: true, force: true });
    ctx.broadcast();
  });
  ipcMain.handle('xhs:notes:confirm', (_event, id: number, key: keyof XhsBasis) => {
    if (!['body', 'title', 'cover', 'cards', 'checks'].includes(String(key))) throw new Error('未知的确认项');
    assertIdle(id, '确认');
    return save(id, { basisJson: stampBasis(getXhsNote(db, id), key) });
  });

  ipcMain.handle('xhs:notes:generate', async (_event, id: number, stage: XhsGenerateStage, options: { pageCount?: number; style?: string } = {}) => noteLock.run(id, async () => {
    const note = getXhsNote(db, id);
    const account = getXhsAccount(db, note.accountId);
    const positioning = readPositioning(account);
    if (stage === 'body' || stage === 'revise') {
      if (!note.topic.trim()) throw new Error('请先填写选题');
      const result = await requestXhsBody(apiConfig(account), note, positioning, stage === 'body' ? 'write' : 'revise');
      const next: XhsNote = { ...note, body: result.body, tagsJson: JSON.stringify(result.tags), writerJson: JSON.stringify(result.meta) };
      return save(id, { body: next.body, tagsJson: next.tagsJson, writerJson: next.writerJson, basisJson: stampBasis(next, 'body') });
    }
    if (stage === 'titles') {
      if (!note.body.trim() && !note.title.trim() && !note.topic.trim()) throw new Error('请先写正文或填写选题');
      const workshop = await requestXhsTitles(apiConfig(account), note, positioning);
      return save(id, { titleCandidatesJson: JSON.stringify(workshop) });
    }
    if (stage === 'checks') {
      if (!note.body.trim() || !note.title.trim()) throw new Error('正文和标题都有了才能检测');
      let modelError = '';
      let modelItems: Awaited<ReturnType<typeof requestXhsModelChecks>> = [];
      try { modelItems = await requestXhsModelChecks(apiConfig(account), note, positioning); }
      catch (error) { modelError = error instanceof Error ? error.message : String(error); }
      const report = { items: mergeCheckItems(localChecks(note), modelItems), checkedAt: new Date().toISOString(), modelError };
      const next = { ...note, checksJson: JSON.stringify(report) };
      return save(id, { checksJson: next.checksJson, basisJson: stampBasis(next, 'checks') });
    }
    if (stage === 'cards') {
      if (!note.body.trim()) throw new Error('请先写好正文，再拆图文卡片');
      const count = XHS_PAGE_COUNTS.includes(Number(options.pageCount)) ? Number(options.pageCount) : 6;
      const plan = await requestXhsCardPlan(apiConfig(account), note, count, String(options.style ?? readCardPlan(note)?.style ?? ''));
      return save(id, { cardsJson: JSON.stringify(plan) });
    }
    throw new Error('未知的生成步骤');
  }));

  /* ── 视觉 ───────────────────────────────────────────────────── */

  /**
   * 生成一张 3:4 图：接口出 2:3 竖图后补边成 3:4（不裁切，内容不会被切掉）。
   * 账号选了 IP 时把 IP 角色当参考图传给接口，让角色融进画面（不写品牌名、不加头像）。
   */
  const generateThreeFour = async (target: string, prompt: string, signal: AbortSignal, accountId: number) => {
    const config = imageApiConfig(readWeWriteFiles().configText);
    const ip = ipReferenceImage(ctx.ipLibrary, getXhsAccount(db, accountId).ipId);
    fs.writeFileSync(target, ip
      ? await requestGeneratedImage(config, withIpInstruction(prompt), '1024x1536', signal, [ip])
      : await requestGeneratedImage(config, prompt, '1024x1536', signal));
    return fitToThreeFour(target);
  };
  const withImageJob = async <T>(id: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const signal = imageJobs.begin(id);
    try { return await run(signal); }
    catch (error) { throw new Error(imageErrorText(error)); }
    finally { imageJobs.end(id); }
  };

  ipcMain.handle('xhs:cover:generate', async (_event, id: number, brief: string) => noteLock.run(id, async () => {
    const note = getXhsNote(db, id);
    if (!note.title.trim()) throw new Error('请先选定标题：封面上要放标题');
    const account = getXhsAccount(db, note.accountId);
    const prompt = xhsCoverPrompt(note, readPositioning(account), String(brief ?? '').slice(0, 500));
    const target = path.join(assetDir(id), `cover-${Date.now()}.png`);
    await withImageJob(id, signal => generateThreeFour(target, prompt, signal, note.accountId));
    const next = { ...note, coverPath: target };
    // 旧封面不丢：它和新封面都留在候选图库里，可以随时换回去。
    return save(id, { coverPath: target, candidatesJson: addCandidates(note, [{ path: target, source: 'cover', caption: 'AI 封面' }]), basisJson: stampBasis(next, 'cover') });
  }));
  ipcMain.handle('xhs:cover:choose', async (_event, id: number) => {
    assertIdle(id, '选择封面');
    const parent = ctx.window();
    const options = { properties: ['openFile' as const], filters: IMAGE_FILTERS };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const source = result.filePaths[0];
    // 拷进应用目录：原图之后被移动或删除，也不影响导出。
    const target = path.join(assetDir(id), `cover-local-${Date.now()}${path.extname(source).toLowerCase() || '.png'}`);
    fs.copyFileSync(source, target);
    const note = getXhsNote(db, id);
    return save(id, { coverPath: target, candidatesJson: addCandidates(note, [{ path: target, source: 'cover', caption: path.basename(source) }]), basisJson: stampBasis({ ...note, coverPath: target }, 'cover') });
  });

  /**
   * 用账号当前 IP 的封面模板本地排版出封面，不调图片接口；和其他封面一样进候选图库、盖封面指纹。
   * 品牌名、头像、配色、角色图都取自 IP 库（见 ipc/ip.ts）。
   */
  ipcMain.handle('xhs:ip-cover:render', async (_event, id: number, raw: unknown) => noteLock.run(id, async () => {
    const note = getXhsNote(db, id);
    const account = getXhsAccount(db, note.accountId);
    if (!account.ipId) throw new Error('这个账号还没有选用 IP（在封面区或「账号定位」里选）');
    const kit = ipRenderKit(ctx.ipLibrary, account.ipId);
    const input = normalizeIpCoverInput(raw);
    if (!input.title) throw new Error('封面标题不能为空');
    const target = path.join(assetDir(id), `cover-ip-${Date.now()}.png`);
    await renderHtmlPages([renderIpCoverDocument(input, kit)], XHS_CARD_WIDTH, XHS_CARD_HEIGHT, [target]);
    const next = { ...note, coverPath: target };
    return save(id, { coverPath: target, candidatesJson: addCandidates(note, [{ path: target, source: 'cover', caption: `IP 模板 · ${kit.name}` }]), basisJson: stampBasis(next, 'cover') });
  }));

  /**
   * 新生成的一批先替换图组里同来源的旧图（卡片图紧跟封面，信息图排在后面），省得每次手动挑；
   * 被替换下来的旧图仍留在候选图库里，可以再挑回来。
   */
  const replaceImages = (note: XhsNote, source: XhsImageItem['source'], fresh: XhsImageItem[]): string => {
    const others = readImages(note).filter(item => item.source !== source);
    return JSON.stringify(source === 'card' ? [...fresh, ...others] : [...others, ...fresh]);
  };

  ipcMain.handle('xhs:cards:render', async (_event, id: number) => noteLock.run(id, async () => {
    const note = getXhsNote(db, id);
    const plan = readCardPlan(note);
    if (!plan?.pages.length) throw new Error('请先拆好图文卡片的分页内容');
    const title = note.title.trim() || note.topic.trim();
    const stamp = Date.now();
    const targets = plan.pages.map((_, index) => path.join(assetDir(id), `card-${stamp}-${String(index + 1).padStart(2, '0')}.png`));
    await renderHtmlPages(plan.pages.map((_, index) => renderCardDocument(plan, index, title)), XHS_CARD_WIDTH, XHS_CARD_HEIGHT, targets);
    const fresh = targets.map((file, index) => ({ path: file, source: 'card' as const, caption: plan.pages[index].heading }));
    const next = { ...note, imagesJson: replaceImages(note, 'card', fresh) };
    return save(id, { imagesJson: next.imagesJson, candidatesJson: addCandidates(note, fresh), basisJson: stampBasis(next, 'cards') });
  }));

  /** 逐张生成，中途失败时保留已经生成的那几张再报错，不白花钱。 */
  ipcMain.handle('xhs:info:generate', async (_event, id: number, mode: 'single' | 'pages') => noteLock.run(id, async () => {
    const note = getXhsNote(db, id);
    const plan = readCardPlan(note);
    if (!plan?.pages.length) throw new Error('信息图按卡片分页出图：请先在「图文卡片」里拆好分页');
    const indexes: Array<number | null> = mode === 'single' ? [null] : plan.pages.map((_, index) => index);
    const stamp = Date.now();
    const fresh: XhsImageItem[] = [];
    let failure = '';
    await withImageJob(id, async signal => {
      for (const index of indexes) {
        const target = path.join(assetDir(id), `info-${stamp}-${index === null ? 'all' : String(index + 1).padStart(2, '0')}.png`);
        try {
          await generateThreeFour(target, xhsInfoImagePrompt(note, plan.pages, index), signal, note.accountId);
          fresh.push({ path: target, source: 'info', caption: index === null ? '总览信息图' : plan.pages[index].heading });
        } catch (error) {
          failure = imageErrorText(error);
          break;
        }
      }
    });
    if (!fresh.length) throw new Error(failure || '信息图生成失败');
    const next = { ...note, imagesJson: replaceImages(note, 'info', fresh) };
    const saved = save(id, { imagesJson: next.imagesJson, candidatesJson: addCandidates(note, fresh), basisJson: stampBasis(next, 'cards') });
    if (failure) throw new Error(`已生成 ${fresh.length}/${indexes.length} 张后中断：${failure}。已生成的图片保留在图组和候选图库里`);
    return saved;
  }));
  ipcMain.handle('xhs:images:cancel', (_event, id: number) => imageJobs.cancel(id));
  ipcMain.handle('xhs:images:add-local', async (_event, id: number) => {
    assertIdle(id, '添加图片');
    const parent = ctx.window();
    const options = { properties: ['openFile' as const, 'multiSelections' as const], filters: IMAGE_FILTERS };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return null;
    const note = getXhsNote(db, id);
    const added = result.filePaths.slice(0, 18).map((source, index) => {
      const target = path.join(assetDir(id), `local-${Date.now()}-${index + 1}${path.extname(source).toLowerCase() || '.png'}`);
      fs.copyFileSync(source, target);
      return { path: target, source: 'local' as const, caption: path.basename(source) };
    });
    return save(id, { imagesJson: JSON.stringify([...readImages(note), ...added]), candidatesJson: addCandidates(note, added) });
  });
  ipcMain.handle('xhs:images:arrange', (_event, id: number, paths: string[]) => {
    assertIdle(id, '调整图组');
    const note = getXhsNote(db, id);
    // 图组里的图只能来自当前图组或候选图库：界面传来的路径不在其中就忽略，不会把任意文件放进发布包。
    const pool = new Map<string, XhsImageItem>();
    for (const item of readCandidates(note)) pool.set(item.path, { path: item.path, source: item.source === 'cover' ? 'local' : item.source, caption: item.caption });
    for (const item of readImages(note)) pool.set(item.path, item);
    const ordered = (Array.isArray(paths) ? paths : []).flatMap(file => pool.has(String(file)) ? [pool.get(String(file)) as XhsImageItem] : []);
    const images = [...new Map(ordered.map(item => [item.path, item])).values()].filter(item => item.path !== note.coverPath);
    return save(id, { imagesJson: JSON.stringify(images) });
  });
  ipcMain.handle('xhs:candidates:use-cover', (_event, id: number, file: string) => {
    assertIdle(id, '更换封面');
    const note = getXhsNote(db, id);
    const picked = readCandidates(note).find(item => item.path === String(file));
    if (!picked) throw new Error('这张图不在候选图库里');
    if (!fs.existsSync(picked.path)) throw new Error('图片文件已经不在了，请重新生成');
    // 封面不再同时出现在图组里，避免发布包里第 1 张和后面某张重复。
    const images = readImages(note).filter(item => item.path !== picked.path);
    const next = { ...note, coverPath: picked.path, imagesJson: JSON.stringify(images) };
    return save(id, { coverPath: picked.path, imagesJson: next.imagesJson, basisJson: stampBasis(next, 'cover') });
  });
  ipcMain.handle('xhs:candidates:remove', (_event, id: number, file: string) => {
    assertIdle(id, '整理候选图');
    const note = getXhsNote(db, id);
    const target = String(file);
    if (target === note.coverPath) throw new Error('这张图正用作封面，先换一张封面再删除');
    if (readImages(note).some(item => item.path === target)) throw new Error('这张图在发布图组里，先移出图组再删除');
    const candidates = readCandidates(note);
    if (!candidates.some(item => item.path === target)) throw new Error('这张图不在候选图库里');
    // 只删应用目录里的副本：本地图片在添加时就拷进来了，原图不受影响。
    const owned = path.resolve(target).startsWith(path.resolve(assetDir(id)) + path.sep);
    if (owned) fs.rmSync(target, { force: true });
    return save(id, { candidatesJson: JSON.stringify(candidates.filter(item => item.path !== target)) });
  });
  ipcMain.handle('xhs:assets', (_event, id: number): XhsNoteAssets => {
    const note = getXhsNote(db, id);
    const inGroup = new Set(readImages(note).map(item => item.path));
    return {
      cover: note.coverPath ? { path: note.coverPath, caption: '封面', thumbnail: imageThumbnail(note.coverPath, 420) } : null,
      images: readImages(note).map(item => ({ path: item.path, caption: item.caption, source: item.source, thumbnail: imageThumbnail(item.path, 260) })),
      candidates: readCandidates(note).filter(item => fs.existsSync(item.path)).map(item => ({
        ...item, thumbnail: imageThumbnail(item.path, 200), inGroup: inGroup.has(item.path), isCover: item.path === note.coverPath
      }))
    };
  });

  ipcMain.handle('xhs:export', (_event, id: number) => {
    assertIdle(id, '导出');
    const note = getXhsNote(db, id);
    const target = exportXhsPackage(ctx.settings.read().vaultPath, note);
    const next = { ...note, exportPath: target };
    return save(id, { exportPath: target, basisJson: stampBasis(next, 'package') });
  });
  ipcMain.handle('xhs:open-package', async (_event, id: number) => {
    const note = getXhsNote(db, id);
    if (!note.exportPath.trim() || !fs.existsSync(note.exportPath)) throw new Error('还没有可打开的发布包，请先导出');
    return shell.openPath(note.exportPath);
  });

  /* ── 热点选题 ───────────────────────────────────────────────── */

  /**
   * 数据源按优先级降级：红狐（有 key 时）→ 联网搜索（必应）。
   * 同样的查询 24 小时内走缓存：红狐每天只更新一次，重查没有新数据还费额度。
   */
  ipcMain.handle('xhs:hotspot:search', async (_event, query: XhsHotspotQuery): Promise<XhsHotspotResult> => {
    const source = query?.source ?? 'auto';
    const normalized = normalizeHotspotQuery(query ?? { keyword: '' });
    const apiKey = ctx.redfoxApiKey();
    let notice = '';
    if (source === 'redfox' || (source === 'auto' && apiKey)) {
      const key = hotspotCacheKey(normalized, 'redfox');
      const cached = query.refresh ? null : readHotspotCache(db, key);
      if (cached) return cached;
      try {
        const result = await searchRedfox(query, redfox(apiKey));
        writeHotspotCache(db, key, result);
        return result;
      } catch (error) {
        if (source === 'redfox') throw error;
        notice = `红狐不可用（${error instanceof Error ? error.message : String(error)}），已改用联网搜索`;
      }
    } else if (source === 'auto') {
      notice = '还没有配置红狐 API Key，已改用联网搜索';
    }
    if (!normalized.keyword) throw new Error(`${notice ? `${notice}；` : ''}联网搜索需要关键词，全站热门只有红狐支持`);
    const key = hotspotCacheKey(normalized, 'web');
    const cached = query.refresh ? null : readHotspotCache(db, key);
    if (cached) return { ...cached, notice: notice || cached.notice };
    const notes = await searchBing(normalized.keyword);
    const result: XhsHotspotResult = {
      source: 'web', keyword: normalized.keyword, startDate: '', endDate: '', total: notes.length, notes: notes.slice(0, normalized.pageSize), latest: [],
      relatedSearches: [], hotTopics: [], fetchedAt: new Date().toISOString(), cached: false, notice,
      tips: '联网搜索结果来自公开网页，没有互动数据：只能看标题钩子、内容形态和方向有没有人写，互动量级、账号量级与热度趋势都需要配置数据源，结论未经互动数据验证。'
    };
    writeHotspotCache(db, key, result);
    return result;
  });
  ipcMain.handle('xhs:hotspot:suggest', async (_event, accountId: number, keyword: string) => accountLock.run(accountId, async () => {
    const account = getXhsAccount(db, accountId);
    const references: string[] = [];
    const word = String(keyword ?? '').trim();
    if (word) {
      const normalized = normalizeHotspotQuery({ keyword: word });
      for (const source of ['redfox', 'web'] as const) {
        const cached = readHotspotCache(db, hotspotCacheKey(normalized, source));
        if (cached) references.push(...cached.notes.map(note => note.title));
      }
    }
    return requestXhsTopicIdeas(apiConfig(account), readPositioning(account), word, references);
  }));

  /* ── 账号诊断与笔记复盘 ─────────────────────────────────────── */

  ipcMain.handle('xhs:audit:run', async (_event, accountId: number, input: XhsAuditInput): Promise<XhsReport> => accountLock.run(accountId, async () => {
    const account = getXhsAccount(db, accountId);
    const number = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0; };
    const clean: XhsAuditInput = {
      target: input?.target === 'competitor' ? 'competitor' : 'self',
      name: String(input?.name ?? '').trim().slice(0, 60),
      bio: String(input?.bio ?? '').trim().slice(0, 300),
      fans: number(input?.fans), follows: number(input?.follows), likesAndCollects: number(input?.likesAndCollects),
      coverNote: String(input?.coverNote ?? '').trim().slice(0, 500),
      notes: (Array.isArray(input?.notes) ? input.notes : []).slice(0, 60).map(note => ({
        title: String(note?.title ?? '').trim().slice(0, 100), liked: number(note?.liked), collected: number(note?.collected), comments: number(note?.comments),
        date: String(note?.date ?? '').trim().slice(0, 20), isVideo: Boolean(note?.isVideo)
      })).filter(note => note.title)
    };
    if (!clean.name && !clean.notes.length) throw new Error('请至少填写账号名称或近期笔记');
    const metrics = auditMetrics(clean);
    const result = await requestXhsAudit(apiConfig(account), clean, metrics, readPositioning(account));
    const report = createXhsReport(db, accountId, 'audit', `${clean.target === 'self' ? '自己' : '竞品'} · ${clean.name || '未命名账号'}`, clean, result);
    ctx.broadcast();
    return report;
  }));
  ipcMain.handle('xhs:reports:list', (_event, accountId: number, kind: XhsReport['kind']) => listXhsReports(db, accountId, kind === 'analytics' ? 'analytics' : 'audit'));
  ipcMain.handle('xhs:reports:delete', (_event, id: number) => {
    deleteXhsReport(db, Number(id));
    ctx.broadcast();
  });

  ipcMain.handle('xhs:analytics:get', (_event, accountId: number) => analyticsView(accountId));
  ipcMain.handle('xhs:stats:import', async (_event, accountId: number) => {
    getXhsAccount(db, accountId);
    const parent = ctx.window();
    const options = { properties: ['openFile' as const], filters: [{ name: '数据表', extensions: ['xlsx', 'xls', 'csv', 'tsv', 'txt'] }] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > MAX_IMPORT_BYTES) throw new Error('文件超过 20MB，不像是笔记数据导出');
    const inputs = tableToXhsStats(readTableFile(fs.readFileSync(file), path.basename(file)));
    const notes = listXhsNotes(db, accountId);
    const { added, updated } = upsertXhsStats(db, accountId, inputs, title => matchXhsNote(title, notes)?.id ?? null);
    ctx.broadcast();
    return { file: path.basename(file), added, updated, view: analyticsView(accountId) };
  });
  ipcMain.handle('xhs:stats:delete', (_event, id: number) => {
    const accountId = deleteXhsStat(db, Number(id));
    if (accountId === null) throw new Error('这条数据不存在');
    ctx.broadcast();
    return analyticsView(accountId);
  });
  ipcMain.handle('xhs:analytics:interpret', async (_event, accountId: number) => accountLock.run(accountId, async () => {
    const account = getXhsAccount(db, accountId);
    const view = analyticsView(accountId);
    if (view.rows.length < 3) throw new Error('至少需要 3 篇笔记的数据才能横向对比');
    const digest = analyticsDigest(view);
    const interpretation = await requestXhsAnalyticsInterpretation(apiConfig(account), digest);
    createXhsReport(db, accountId, 'analytics', `复盘 · ${view.rows.length} 篇`, { digest }, interpretation);
    ctx.broadcast();
    return analyticsView(accountId);
  }));

  /* ── 应用内小红书窗口 ───────────────────────────────────────── */

  ipcMain.handle('xhs:view:state', () => view.state());
  ipcMain.handle('xhs:view:open', (_event, accountId: number) => view.show(accountId));
  ipcMain.handle('xhs:view:close', () => view.close());
  ipcMain.handle('xhs:view:bounds', (_event, bounds: unknown) => view.setBounds(bounds));
  ipcMain.handle('xhs:view:navigate', (_event, target: { kind?: unknown; value?: unknown }) => view.navigate(target ?? {}));
  ipcMain.handle('xhs:view:go', (_event, action: 'back' | 'reload') => view.go(action === 'back' ? 'back' : 'reload'));
  ipcMain.handle('xhs:view:read', () => view.read());

  /* ── 红狐 Key 与链接 ───────────────────────────────────────── */

  /** 没存 key 但设置了环境变量时也算已配置（搜索本身就会用它），免得界面误报「没有 Key」。 */
  const redfoxStatus = () => {
    const status = ctx.redfoxKeyStore.getStatus();
    return !status.configured && (process.env.REDFOX_API_KEY ?? '').trim() ? { ...status, configured: true, masked: '（来自环境变量 REDFOX_API_KEY）' } : status;
  };
  ipcMain.handle('xhs:redfox-key:status', () => redfoxStatus());
  ipcMain.handle('xhs:redfox-key:save', (_event, value: string) => { ctx.redfoxKeyStore.save(value); return redfoxStatus(); });
  ipcMain.handle('xhs:redfox-key:delete', () => { ctx.redfoxKeyStore.remove(); return redfoxStatus(); });
  /** 最小查询（全站热门 1 条、不重试）验证 key；不写缓存。 */
  ipcMain.handle('xhs:redfox-key:test', async () => {
    const result = await searchRedfox({ keyword: '', pageSize: 1 }, { ...redfox(ctx.redfoxApiKey()), maxRetries: 1 });
    return { total: result.total };
  });
  ipcMain.handle('xhs:open-link', async (_event, url: string) => {
    if (!isHttpLink(url)) throw new Error('只能打开 http / https 链接');
    await openUrl(url);
  });
}
