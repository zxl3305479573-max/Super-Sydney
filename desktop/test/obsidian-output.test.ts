import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeConfirmedEvent, writeDailySummary, writeWeeklySummary, writeWorkflowCandidate } from '../services/obsidian-output.ts';
import type { WorkEvent } from '../shared.ts';

function tempVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-vault-'));
}

function event(overrides: Partial<WorkEvent> = {}): WorkEvent {
  return {
    id: 7,
    created_at: '2026-10-06T09:30:00.000Z',
    app_name: 'Code',
    window_title: 'main.ts',
    kind: 'manual',
    note: '完成 Obsidian 自动沉淀',
    duration_seconds: 1800,
    status: 'approved',
    category: '提效方案',
    value_score: 3,
    summary: '确认事件后自动生成知识页',
    source: 'desktop',
    source_session_id: '',
    source_message_id: '',
    codex_prompt: '',
    codex_response: '',
    ai_draft_json: '',
    ai_draft_model: '',
    ai_drafted_at: '',
    related_path: '',
    adapter: '',
    change_type: '',
    ...overrides
  };
}

test('confirmed event links an associated vault file as an Obsidian wikilink', () => {
  const vault = tempVault();
  const target = writeConfirmedEvent(vault, event({ related_path: path.join(vault, '01-输入', '素材.md') }));
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /\[\[01-输入\/素材\]\]/);
  assert.match(content, /状态：approved（人工确认）/);
});

test('daily, weekly, and workflow outputs are written into their dedicated folders', () => {
  const vault = tempVault();
  const rows = [event(), event({ id: 8, category: '内容资产', note: '整理公众号选题' })];
  const daily = writeDailySummary(vault, rows);
  const weekly = writeWeeklySummary(vault, rows);
  const workflow = writeWorkflowCandidate(vault, rows);
  assert.equal(path.dirname(daily), path.join(vault, '02-每日总结'));
  assert.equal(path.dirname(weekly), path.join(vault, '03-进化记录'));
  assert.equal(path.dirname(workflow), path.join(vault, '04-工作流'));
  assert.match(fs.readFileSync(daily, 'utf8'), /内容与工作流候选/);
  assert.match(fs.readFileSync(weekly, 'utf8'), /本周完成/);
  assert.match(fs.readFileSync(workflow, 'utf8'), /人工确认/);
});
