import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInsights, findRepeats, normalizePrompt, projectName, renderInsightsMarkdown, toAiTurns, writeAiReview } from '../services/ai-session-insights.ts';
import type { WorkEvent } from '../shared.ts';

let nextId = 1;
function event(prompt: string, extra: Partial<WorkEvent> = {}): WorkEvent {
  return {
    id: nextId++, created_at: '2026-10-12T08:00:00.000Z', app_name: 'Claude Code', window_title: 'D:\\Super-Sydney', kind: 'claude', note: prompt,
    duration_seconds: 0, status: 'pending', category: 'AI 工具', value_score: 0, summary: '', source: 'claude', source_session_id: `s-${nextId}`,
    source_message_id: '', codex_prompt: prompt, codex_response: '好的', ai_draft_json: '', ai_draft_model: '', ai_drafted_at: '',
    related_path: '', adapter: '', change_type: '', ...extra
  };
}

test('project name comes from the last cwd segment on either OS', () => {
  assert.equal(projectName('D:\\Super-Sydney\\'), 'Super-Sydney');
  assert.equal(projectName('/home/u/app'), 'app');
  assert.equal(projectName(''), '未知项目');
});

test('normalisation ignores paths, numbers and punctuation', () => {
  assert.equal(normalizePrompt('修复 D:\\a\\b.ts 第 12 行！'), normalizePrompt('修复 D:\\c\\d.ts 第 99 行。'));
});

test('repeated requests across sessions are clustered', () => {
  const turns = toAiTurns([
    event('帮我把这篇文章改写成公众号风格，适合中老年读者'),
    event('把这篇文章改写成公众号风格 适合中老年读者阅读'),
    event('帮我把这篇改写成公众号风格，适合中老年读者'),
    event('解释一下 sqlite 索引')
  ]);
  const repeats = findRepeats(turns);
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].count, 3);
  assert.equal(repeats[0].sessions, 3);
});

test('insights count corrections, interrupts, tools, commands and skip rejected or other sources', () => {
  const trace = (extra: object) => JSON.stringify({ tools: { Edit: 2, Bash: 1 }, files: ['desktop/main.ts'], durationMs: 120_000, interrupted: false, ...extra });
  const events = [
    event('实现 Claude 采集', { ai_trace_json: trace({}) }),
    event('还是不行，测试报错', { ai_trace_json: trace({}) }),
    event('重构 main.ts', { ai_trace_json: trace({ interrupted: true }) }),
    event('/review 当前改动', { source: 'codex', window_title: 'D:/other' }),
    event('不要算我', { status: 'rejected' }),
    event('手动记录', { source: 'desktop' }),
    event('太早了', { created_at: '2026-09-01T00:00:00.000Z' })
  ];
  const insights = buildInsights(events, new Date('2026-10-06T00:00:00Z'), new Date('2026-10-12T23:59:59Z'));
  assert.equal(insights.turns, 4);
  assert.deepEqual(insights.bySource, { claude: 3, codex: 1 });
  const sydney = insights.projects.find(item => item.project === 'Super-Sydney')!;
  assert.equal(sydney.corrections, 1);
  assert.equal(sydney.interrupted, 1);
  assert.equal(sydney.tools.Edit, 6);
  assert.deepEqual(insights.commands, [{ command: '/review', count: 1 }]);
  assert.deepEqual(insights.hotFiles, [{ file: 'desktop/main.ts', count: 3 }]);
  const markdown = renderInsightsMarkdown(insights);
  assert.match(markdown, /纠正 \/ 返工：「还是不行，测试报错」/);
  assert.match(markdown, /中途打断：「重构 main.ts」/);
});

test('review note keeps manual edits outside the generated block', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-vault-'));
  try {
    const insights = buildInsights([event('a')], new Date('2026-10-06T00:00:00Z'), new Date('2026-10-12T23:59:59Z'));
    const target = writeAiReview(vault, insights);
    fs.appendFileSync(target, '\n我的批注\n');
    writeAiReview(vault, insights);
    const content = fs.readFileSync(target, 'utf8');
    assert.match(content, /我的批注/);
    assert.equal(content.match(/SYDNEY:AI-REVIEW:START/g)?.length, 1);
    assert.match(content, /type: evolution-candidate/);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
