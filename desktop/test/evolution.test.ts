import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateCodexEventColumns, persistAiMessage } from '../services/codex-event-store.ts';
import { buildInsights, toAiTurns } from '../services/ai-session-insights.ts';
import {
  RULES_END, RULES_START, applyRulePatch, collectRuleEvidence, draftRuleText, getRuleCandidate, insertRules, listRuleCandidates,
  migrateRuleTables, normalizeRuleLines, previewRulePatch, undoRulePatch, updateRuleCandidate, upsertRuleCandidates
} from '../services/evolution-rules.ts';
import { buildNoteUsage, renderNoteUsage, vaultRelative } from '../services/note-usage.ts';
import { markCardEvents, migrateCardColumns, normalizeCards, requestExperienceCards, selectCardEvents, writeExperienceCards } from '../services/experience-cards.ts';
import { writeWeeklySummary } from '../services/obsidian-output.ts';
import { parseJsonObject } from '../services/llm-json.ts';
import type { WorkEvent } from '../shared.ts';

function tmp(prefix: string) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, app_name TEXT NOT NULL DEFAULT '', window_title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '', duration_seconds INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', value_score INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '个人成长', ai_draft_json TEXT NOT NULL DEFAULT '')`);
  migrateCodexEventColumns(db);
  migrateRuleTables(db);
  migrateCardColumns(db);
  return db;
}

function seedFriction(db: DatabaseSync, cwd: string) {
  const turns: Array<[string, string]> = [['改一下登录页样式', '已修改 login.css'], ['还是不行，按钮没变', '已改为内联样式'], ['你改错了文件，是 App.tsx', '已修改 App.tsx'], ['不对，测试也要跑', '测试通过']];
  turns.forEach(([prompt, answer], index) => {
    persistAiMessage(db, 'claude', { id: `p${index}`, role: 'user', text: prompt, turnId: `p${index}`, sessionId: 's1', cwd });
    persistAiMessage(db, 'claude', { id: `p${index}:final`, role: 'assistant', text: answer, turnId: `p${index}`, sessionId: 's1', cwd });
  });
}

const rows = (db: DatabaseSync) => db.prepare('SELECT * FROM events').all() as unknown as WorkEvent[];
const window7 = () => [new Date(Date.now() - 7 * 864e5), new Date(Date.now() + 1000)] as const;

test('friction becomes one rule candidate per project, with the corrected turn as evidence', () => {
  const project = tmp('sydney-proj-');
  try {
    const db = database();
    seedFriction(db, project);
    const insights = buildInsights(rows(db), ...window7());
    const touched = upsertRuleCandidates(db, insights, collectRuleEvidence(db, insights.friction));
    assert.equal(touched.length, 1);
    assert.equal(touched[0].cwd, project);
    assert.equal(touched[0].evidence.length, 3);
    assert.equal(touched[0].evidence[0].previousPrompt, '改一下登录页样式');
    assert.equal(touched[0].evidence[0].previousResponse, '已修改 login.css');
    // Re-running the review extends the same open candidate instead of duplicating it.
    upsertRuleCandidates(db, insights, collectRuleEvidence(db, insights.friction));
    assert.equal(listRuleCandidates(db).length, 1);
    // Rejected evidence does not come back as a new candidate.
    updateRuleCandidate(db, touched[0].id, { status: 'rejected' });
    assert.equal(upsertRuleCandidates(db, insights, collectRuleEvidence(db, insights.friction)).length, 0);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('rule lines are normalised and inserted into a managed block without duplicates', () => {
  assert.deepEqual(normalizeRuleLines('1. 先跑测试\n* 改样式前确认文件\n\n- 已有'), ['- 先跑测试', '- 改样式前确认文件', '- 已有']);
  const first = insertRules('# 项目说明\n', ['- 先跑测试'], '2026-10-12');
  assert.match(first.after, new RegExp(`${RULES_START}[\\s\\S]*- 先跑测试（2026-10-12）\\n${RULES_END}`));
  assert.ok(first.after.startsWith('# 项目说明'));
  const second = insertRules(first.after, ['- 先跑测试', '- 新规则'], '2026-10-13');
  assert.deepEqual(second.added, ['- 新规则']);
  assert.equal(second.after.match(/先跑测试/g)?.length, 1);
  assert.ok(second.after.indexOf('新规则') < second.after.indexOf(RULES_END));
  assert.equal(insertRules(second.after, ['- 新规则'], 'x').added.length, 0);
});

test('preview → apply → undo only touches existing rule files and refuses stale previews', () => {
  const project = tmp('sydney-proj-');
  try {
    const db = database();
    seedFriction(db, project);
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Claude 说明\n', 'utf8');
    const insights = buildInsights(rows(db), ...window7());
    const [candidate] = upsertRuleCandidates(db, insights, collectRuleEvidence(db, insights.friction));
    assert.throws(() => previewRulePatch(candidate), /请先填写/);
    const withText = updateRuleCandidate(db, candidate.id, { ruleText: '- 修改 UI 前先确认要改的文件\n- 改完运行 npm test' });
    const preview = previewRulePatch(withText, '2026-10-12');
    assert.deepEqual(preview.map(item => [path.basename(item.path), item.exists, item.added.length]), [['CLAUDE.md', true, 2]]);

    const stale = previewRulePatch(withText, '2026-10-12');
    fs.appendFileSync(path.join(project, 'CLAUDE.md'), '手动改动\n');
    assert.throws(() => applyRulePatch(stale), /重新预览/);

    const applied = applyRulePatch(previewRulePatch(withText, '2026-10-12'));
    const written = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8');
    assert.match(written, /手动改动/);
    assert.match(written, /改完运行 npm test（2026-10-12）/);
    assert.ok(!fs.existsSync(path.join(project, 'AGENTS.md')));
    const undone = undoRulePatch(applied);
    assert.equal(undone.restored.length, 1);
    assert.equal(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8'), '# Claude 说明\n手动改动\n');
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('without rule files a new AGENTS.md is created and undo removes it; edited files are left alone', () => {
  const project = tmp('sydney-proj-');
  try {
    const db = database();
    seedFriction(db, project);
    const insights = buildInsights(rows(db), ...window7());
    const [candidate] = upsertRuleCandidates(db, insights, collectRuleEvidence(db, insights.friction));
    const preview = previewRulePatch(updateRuleCandidate(db, candidate.id, { ruleText: '- 规则' }));
    assert.equal(path.basename(preview[0].path), 'AGENTS.md');
    assert.equal(preview[0].exists, false);
    const applied = applyRulePatch(preview);
    assert.deepEqual(undoRulePatch(applied).restored, [path.join(project, 'AGENTS.md')]);
    assert.ok(!fs.existsSync(path.join(project, 'AGENTS.md')));
    const again = applyRulePatch(previewRulePatch(getRuleCandidate(db, candidate.id)));
    fs.appendFileSync(path.join(project, 'AGENTS.md'), '我自己加的\n');
    assert.deepEqual(undoRulePatch(again).skipped, [path.join(project, 'AGENTS.md')]);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('rule drafting sends only evidence and parses the JSON reply', async () => {
  const db = database();
  const project = tmp('sydney-proj-');
  try {
    seedFriction(db, project);
    const insights = buildInsights(rows(db), ...window7());
    const [candidate] = upsertRuleCandidates(db, insights, collectRuleEvidence(db, insights.friction));
    let sent = '';
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"rules":"1. 改 UI 前先确认文件\\n2. 改完跑测试","rationale":"多次改错文件"}\n```' } }] }), { status: 200 });
    }) as typeof fetch;
    const result = await draftRuleText(candidate, { apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' }, fakeFetch);
    assert.equal(result.ruleText, '- 改 UI 前先确认文件\n- 改完跑测试');
    assert.equal(result.rationale, '多次改错文件');
    assert.match(sent, /你改错了文件/);
    assert.ok(!sent.includes('sessionFile'));
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
  assert.throws(() => parseJsonObject('not json'), /有效 JSON/);
});

test('note usage maps relative and absolute reads into the vault and finds stale notes', () => {
  const vault = tmp('sydney-vault-');
  try {
    fs.mkdirSync(path.join(vault, '04-工作流'), { recursive: true });
    fs.mkdirSync(path.join(vault, '00-系统'), { recursive: true });
    for (const name of ['04-工作流/发布SOP.md', '04-工作流/旧笔记.md', '00-系统/README.md', '根笔记.md']) fs.writeFileSync(path.join(vault, name), 'x');
    const old = (Date.now() - 120 * 864e5) / 1000;
    fs.utimesSync(path.join(vault, '04-工作流/旧笔记.md'), old, old);
    fs.utimesSync(path.join(vault, '根笔记.md'), old, old);
    const event = (id: number, cwd: string, trace: object) => ({ id, created_at: new Date().toISOString(), window_title: cwd, source: 'claude', status: 'pending', codex_prompt: 'x', codex_response: 'y', ai_trace_json: JSON.stringify({ tools: {}, files: [], durationMs: 0, interrupted: false, ...trace }) }) as unknown as WorkEvent;
    const turns = toAiTurns([
      event(1, vault, { reads: ['04-工作流/发布SOP.md'] }),
      event(2, '/elsewhere', { reads: [path.join(vault, '04-工作流', '发布SOP.md'), '/elsewhere/README.md'] }),
      event(3, vault, { files: ['根笔记.md'] })
    ]);
    const usage = buildNoteUsage(turns, vault, 90);
    assert.deepEqual(usage.used.map(item => [item.note, item.reads, item.edits]), [['04-工作流/发布SOP.md', 2, 0], ['根笔记.md', 0, 1]]);
    assert.deepEqual(usage.stale.map(item => item.note), ['04-工作流/旧笔记.md']);
    assert.equal(usage.totalNotes, 3);
    assert.match(renderNoteUsage(usage), /\[\[04-工作流\/发布SOP\]\] · 读取 2 次/);
    assert.equal(vaultRelative('D:\\Vault\\A\\b.MD', 'C:\\x', 'd:\\vault'), 'A/b.MD');
    assert.equal(vaultRelative('..\\other.md', 'D:\\Vault', 'D:\\Vault'), null);
  } finally { fs.rmSync(vault, { recursive: true, force: true }); }
});

test('experience cards: only approved, uncarded AI events; cards are validated, written, merged and indexed', async () => {
  const db = database();
  persistAiMessage(db, 'codex', { id: 'u1', role: 'user', text: 'Electron 打包后白屏', turnId: 't1', sessionId: 's', cwd: 'D:/app' });
  persistAiMessage(db, 'codex', { id: 'a1', role: 'assistant', text: '把 base 改成 ./ 解决', turnId: 't1', sessionId: 's', cwd: 'D:/app' });
  persistAiMessage(db, 'codex', { id: 'u2', role: 'user', text: '未确认的问题', turnId: 't2', sessionId: 's', cwd: 'D:/app' });
  persistAiMessage(db, 'codex', { id: 'a2', role: 'assistant', text: '答复', turnId: 't2', sessionId: 's', cwd: 'D:/app' });
  db.prepare("UPDATE events SET status='approved' WHERE codex_prompt='Electron 打包后白屏'").run();
  const events = selectCardEvents(db, 30);
  assert.deepEqual(events.map(event => event.codex_prompt), ['Electron 打包后白屏']);

  const reply = { cards: [
    { topic: 'Electron/打包', title: '打包后白屏', pitfall: '资源路径是绝对路径', solution: 'vite base 改成 ./', steps: ['改 base', '重新打包'], applies_when: '打包后页面空白', event_ids: [events[0].id] },
    { topic: '无效', title: '编造的卡片', pitfall: 'x', solution: 'y', event_ids: [999] },
    { topic: '无效', title: '', pitfall: 'x', solution: 'y', event_ids: [events[0].id] }
  ] };
  assert.equal(normalizeCards(reply, new Set([events[0].id])).length, 1);
  const fakeFetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 })) as unknown as typeof fetch;
  const cards = await requestExperienceCards(events, { apiKey: 'k', baseUrl: 'http://x/v1', model: 'm' }, fakeFetch);
  assert.equal(cards[0].topic, 'Electron 打包');

  const vault = tmp('sydney-vault-');
  try {
    const first = writeExperienceCards(vault, cards, events, '2026-10-12');
    assert.equal(first.created.length, 1);
    const cardFile = first.created[0];
    assert.equal(path.relative(vault, cardFile).replace(/\\/g, '/'), '04-工作流/经验卡片/Electron 打包/打包后白屏.md');
    fs.appendFileSync(cardFile, '\n我的补充\n');
    const second = writeExperienceCards(vault, cards, events, '2026-10-20');
    assert.deepEqual(second.updated, [cardFile]);
    const content = fs.readFileSync(cardFile, 'utf8');
    assert.match(content, /- 2026-10-12：Codex 事件/);
    assert.match(content, /- 2026-10-20：Codex 事件/);
    assert.ok(content.indexOf('2026-10-20') < content.indexOf('## 人工确认'));
    assert.match(content, /我的补充/);
    const index = fs.readFileSync(path.join(vault, '04-工作流', '经验卡片', '索引.md'), 'utf8');
    assert.match(index, /## Electron 打包（1）/);
    assert.match(index, /\[\[04-工作流\/经验卡片\/Electron 打包\/打包后白屏\|打包后白屏\]\]/);
  } finally { fs.rmSync(vault, { recursive: true, force: true }); }
  markCardEvents(db, events.map(event => event.id));
  assert.equal(selectCardEvents(db, 30).length, 0);
});

test('weekly summary is filled from the AI review when available', () => {
  const vault = tmp('sydney-vault-');
  const db = database();
  try {
    seedFriction(db, 'D:\\Super-Sydney');
    for (let index = 0; index < 3; index += 1) persistAiMessage(db, 'codex', { id: `r${index}`, role: 'user', text: '把这篇文章改写成公众号风格，适合中老年读者', turnId: `r${index}`, sessionId: `x${index}`, cwd: 'D:\\WeChat' });
    const insights = buildInsights(rows(db), ...window7());
    const reviewNote = path.join(vault, '03-进化记录', 'AI协作复盘-2026-10-12.md');
    const target = writeWeeklySummary(vault, [], { insights, reviewNote, rules: [{ project: 'Super-Sydney', status: 'applied', ruleText: '- 改完跑测试' }] });
    const content = fs.readFileSync(target, 'utf8');
    assert.match(content, /\[\[03-进化记录\/AI协作复盘-2026-10-12\]\]/);
    assert.match(content, /\*\*Super-Sydney\*\* 返工 3 次/);
    assert.match(content, /✅ 已写入 Super-Sydney：改完跑测试/);
    assert.match(content, /重复 3 次 → 做成 skill/);
    assert.match(content, /AI 协作：7 轮/);
    const plain = writeWeeklySummary(vault, []);
    assert.match(fs.readFileSync(plain, 'utf8'), /点击「AI 协作复盘」后重新生成周报可自动填充/);
  } finally { fs.rmSync(vault, { recursive: true, force: true }); }
});
