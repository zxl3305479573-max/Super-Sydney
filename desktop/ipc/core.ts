import fs from 'node:fs';
import path from 'node:path';
import { dialog, ipcMain, shell } from 'electron';
import type { AppContext } from '../app-context';
import type { CaptureMode, CaptureRuntime } from '../capture-runtime';
import type { AiReviewResult, CardExtractResult, EvolutionState, Settings, WorkEvent } from '../shared';
import { buildInsights, toAiTurns, writeAiReview } from '../services/ai-session-insights';
import { buildNoteUsage, renderNoteUsage } from '../services/note-usage';
import { applyRulePatch, collectRuleEvidence, draftRuleText, getRuleCandidate, listRuleCandidates, previewRulePatch, renderRuleSection, undoRulePatch, updateRuleCandidate, upsertRuleCandidates } from '../services/evolution-rules';
import { markCardEvents, requestExperienceCards, selectCardEvents, writeCardIndex, writeExperienceCards } from '../services/experience-cards';
import { applyAiDraft, clearAiDraft, saveAiDraft } from '../services/ai-draft-store';
import { buildDeepSeekInput } from '../services/ai-draft-input';
import { requestEventDraft } from '../services/deepseek';
import { writeConfirmedEvent, writeDailySummary, writeWeeklySummary, writeWorkflowCandidate } from '../services/obsidian-output';
import { aiEventsSince, confirmedEvents, deleteEvent, getApprovedEvent, getEvent, insertEvent, recentEvents, todayStats, updateEvent } from '../services/event-store';

/** 工作事件、设置、复盘与规则进化：Today / 复盘 / 进化 / 设置 四个页面的通道。 */
export function registerCoreIpc(ctx: AppContext, capture: CaptureRuntime): void {
  const { db } = ctx;
  const vaultPath = () => ctx.settings.read().vaultPath;
  const requireLlmEnabled = () => {
    if (!ctx.settings.read().llmEnabled) throw new Error('请先在设置中开启允许发送到 DeepSeek');
  };
  const aiInsightsBetween = (from: Date, to: Date) => buildInsights(aiEventsSince(db, from), from, to);

  ipcMain.handle('state:get', () => ({
    settings: ctx.settings.read(),
    stats: todayStats(db),
    events: recentEvents(db),
    ...capture.snapshot()
  }));

  ipcMain.handle('event:create', (_event, input: Partial<WorkEvent>) => {
    const id = insertEvent(db, input);
    ctx.broadcast();
    return id;
  });
  ipcMain.handle('event:update', (_event, id: number, patch: Partial<WorkEvent>) => {
    updateEvent(db, id, patch);
    if (patch.status === 'approved') {
      const event = getApprovedEvent(db, id);
      if (event && writeConfirmedEvent(vaultPath(), event)) writeDailySummary(vaultPath(), confirmedEvents(db), []);
    }
    ctx.broadcast();
  });
  ipcMain.handle('event:delete', (_event, id: number) => { deleteEvent(db, id); ctx.broadcast(); });
  ipcMain.handle('event:draft', async (_event, id: number) => {
    requireLlmEnabled();
    const event = getEvent(db, id);
    if (!event) throw new Error('事件不存在或已被删除');
    if (event.status !== 'pending') throw new Error('只有待确认事件可以生成 AI 草稿');
    const config = ctx.llmConfig();
    const draft = await requestEventDraft(buildDeepSeekInput(event), config);
    saveAiDraft(db, id, draft, config.model, new Date().toISOString());
    ctx.broadcast();
    return draft;
  });
  ipcMain.handle('event:draft:apply', (_event, id: number) => { applyAiDraft(db, id); ctx.broadcast(); });
  ipcMain.handle('event:draft:clear', (_event, id: number) => { clearAiDraft(db, id); ctx.broadcast(); });

  ipcMain.handle('llm-key:status', () => ctx.secretStore.getStatus());
  ipcMain.handle('llm-key:save', (_event, value: string) => { ctx.secretStore.save(value); return ctx.secretStore.getStatus(); });
  ipcMain.handle('llm-key:delete', () => { ctx.secretStore.remove(); return ctx.secretStore.getStatus(); });

  ipcMain.handle('capture:set', (_event, mode: CaptureMode) => capture.setCapture(mode));
  ipcMain.handle('settings:save', (_event, patch: Partial<Settings>) => {
    const previous = ctx.settings.read();
    const next = { ...previous, ...patch };
    next.vaultPath = ctx.settings.resolveVault(next.vaultPath);
    ctx.settings.write(next);
    capture.applySettings(previous, next);
    ctx.broadcast();
    return next;
  });
  ipcMain.handle('vault:choose', async () => {
    const result = await dialog.showOpenDialog(ctx.window()!, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const next = { ...ctx.settings.read(), vaultPath: ctx.settings.resolveVault(result.filePaths[0]) };
    ctx.settings.write(next); ctx.broadcast(); return next.vaultPath;
  });
  ipcMain.handle('vault:open', () => shell.openPath(vaultPath()));
  ipcMain.handle('files:choose', async () => {
    const result = await dialog.showOpenDialog(ctx.window()!, { properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle('summary:daily', () => writeDailySummary(vaultPath(), confirmedEvents(db)));
  ipcMain.handle('summary:weekly', () => {
    const vault = vaultPath();
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() || 7) - 1));
    monday.setHours(0, 0, 0, 0);
    const insights = aiInsightsBetween(monday, now);
    const reviewDir = path.join(vault, '03-进化记录');
    const mondayDay = monday.toISOString().slice(0, 10);
    const reviewNote = fs.existsSync(reviewDir)
      ? fs.readdirSync(reviewDir).filter(name => /^AI协作复盘-\d{4}-\d{2}-\d{2}\.md$/.test(name) && name.slice(7, 17) >= mondayDay).sort().pop()
      : undefined;
    const rules = listRuleCandidates(db).filter(rule => rule.updatedAt >= monday.toISOString());
    return writeWeeklySummary(vault, confirmedEvents(db), insights.turns ? { insights, reviewNote: reviewNote ? path.join(reviewDir, reviewNote) : undefined, rules } : undefined);
  });
  ipcMain.handle('workflow:generate', () => {
    const rows = confirmedEvents(db).filter(item => item.value_score >= 2 || item.category === '提效方案' || item.category === '内容资产');
    return { target: writeWorkflowCandidate(vaultPath(), rows), count: rows.length };
  });
  ipcMain.handle('ai-review:generate', (_event, days = 7): AiReviewResult => {
    const span = Math.min(90, Math.max(1, Math.round(Number(days) || 7)));
    const to = new Date();
    const from = new Date(to.getTime() - span * 24 * 60 * 60 * 1000);
    const insights = aiInsightsBetween(from, to);
    const touched = upsertRuleCandidates(db, insights, collectRuleEvidence(db, insights.friction));
    const touchedIds = new Set(touched.map(rule => rule.id));
    const projectDirs = new Set(insights.projects.map(stat => stat.cwd));
    const rules = listRuleCandidates(db).filter(rule => touchedIds.has(rule.id) || (projectDirs.has(rule.cwd) && rule.updatedAt >= from.toISOString()));
    // Knowledge reuse looks further back than the review window so "unused" means something.
    const usageDays = Math.max(span, 90);
    const usageFrom = new Date(to.getTime() - usageDays * 24 * 60 * 60 * 1000);
    const vault = vaultPath();
    const usage = buildNoteUsage(toAiTurns(aiEventsSince(db, usageFrom)), vault, usageDays);
    const target = writeAiReview(vault, insights, { rulesSection: renderRuleSection(rules), notesSection: renderNoteUsage(usage) });
    ctx.broadcast();
    return { target, turns: insights.turns, repeats: insights.repeats.length, friction: insights.friction.length, rules: rules.filter(rule => rule.status === 'proposed').length, notesUsed: usage.used.length, staleNotes: usage.stale.length };
  });

  ipcMain.handle('evolution:state', (): EvolutionState => ({
    rules: listRuleCandidates(db),
    pendingCardEvents: selectCardEvents(db, 90, 1_000).length,
    llmEnabled: ctx.settings.read().llmEnabled
  }));
  ipcMain.handle('rules:draft', async (_event, id: number) => {
    requireLlmEnabled();
    const candidate = getRuleCandidate(db, id);
    if (candidate.status !== 'proposed') throw new Error('只有待确认的规则候选可以重新生成');
    const drafted = await draftRuleText(candidate, ctx.llmConfig());
    return updateRuleCandidate(db, id, drafted);
  });
  ipcMain.handle('rules:update', (_event, id: number, ruleText: string) => {
    if (getRuleCandidate(db, id).status !== 'proposed') throw new Error('已写入或已驳回的规则不能再修改');
    return updateRuleCandidate(db, id, { ruleText: String(ruleText ?? '').slice(0, 2_000) });
  });
  ipcMain.handle('rules:preview', (_event, id: number) => previewRulePatch(getRuleCandidate(db, id)).map(({ path: file, exists, added }) => ({ path: file, exists, added })));
  ipcMain.handle('rules:apply', (_event, id: number, targets: string[]) => {
    const candidate = getRuleCandidate(db, id);
    if (candidate.status !== 'proposed') throw new Error('这个规则候选已经处理过了');
    const applied = applyRulePatch(previewRulePatch(candidate, undefined, Array.isArray(targets) ? targets : []));
    return updateRuleCandidate(db, id, { status: 'applied', applied });
  });
  ipcMain.handle('rules:reject', (_event, id: number) => updateRuleCandidate(db, id, { status: 'rejected' }));
  ipcMain.handle('rules:undo', (_event, id: number) => {
    const candidate = getRuleCandidate(db, id);
    if (candidate.status !== 'applied') throw new Error('只有已写入的规则可以撤销');
    const result = undoRulePatch(candidate.applied);
    if (!result.restored.length) throw new Error('目标文件在写入后被修改过，未自动撤销，请手动删除对应规则');
    return { candidate: updateRuleCandidate(db, id, { status: 'proposed', applied: [] }), ...result };
  });
  ipcMain.handle('cards:extract', async (_event, days = 30): Promise<CardExtractResult> => {
    requireLlmEnabled();
    const span = Math.min(180, Math.max(1, Math.round(Number(days) || 30)));
    const events = selectCardEvents(db, span, 20);
    const vault = vaultPath();
    if (!events.length) return { considered: 0, created: [], updated: [], index: writeCardIndex(vault) };
    const cards = await requestExperienceCards(events, ctx.llmConfig());
    const written = writeExperienceCards(vault, cards, events);
    markCardEvents(db, events.map(event => event.id));
    ctx.broadcast();
    return { considered: events.length, ...written, index: writeCardIndex(vault) };
  });
}
