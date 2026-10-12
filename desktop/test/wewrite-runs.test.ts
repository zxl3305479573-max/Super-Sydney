import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRun, normalizeRunStatus, normalizeStepStatus, parseThemes, pickArticlePath, progressOf, readSteps, summarizeRun } from '../services/wewrite-runs.ts';

const state = {
  version: 4,
  run_id: '20261010-120411-0ec3e5',
  created: '2026-10-10T12:04:11+08:00',
  updated: '2026-10-10T12:30:00+08:00',
  status: 'active',
  mode: 'draft',
  permissions: { publish: false },
  topic: { title: '柚子能不能和降压药一起吃', keywords: ['柚子', '降压药'] },
  framework: '痛点型',
  persona: 'elder-health-guide',
  enhance_strategy: 'action_conditions',
  word_count: 1500,
  artifacts: { brief: 'runs/x/brief.yaml', claims: 'runs/x/claims.yaml', draft: 'runs/x/draft.md', article: 'runs/x/article.md', preview: 'runs/x/preview.html' },
  steps: { topic: { status: 'completed' }, write: { status: 'completed' }, review: { status: 'in_progress' } },
  provenance: { verified_sources: 4, unverified_sources: 1, exemplars: [], playbook_rules: [] },
  last_error: null
};

test('summarizeRun maps the CLI state into the frontend summary', () => {
  const summary = summarizeRun(state);
  assert.equal(summary.id, '20261010-120411-0ec3e5');
  assert.equal(summary.title, '柚子能不能和降压药一起吃');
  assert.equal(summary.status, 'active');
  assert.equal(summary.completedSteps, 2);
  assert.equal(summary.totalSteps, 5);
  assert.equal(summary.steps.review, 'in_progress');
  assert.equal(summary.steps.visual, 'pending');
  assert.equal(summary.sourceCount, 5);
  assert.equal(summary.verifiedSourceCount, 4);
  assert.equal(summary.publishAllowed, false);
  assert.equal(summary.lastError, '');
  assert.equal(summary.hasArticle, true);
  assert.equal(summary.hasPreview, true);
});

test('summarizeRun tolerates missing and unknown upstream fields', () => {
  const summary = summarizeRun({ run_id: 'r1' });
  assert.equal(summary.title, '未命名任务');
  assert.equal(summary.status, 'active');
  assert.equal(summary.mode, 'draft');
  assert.equal(summary.completedSteps, 0);
  assert.equal(summary.sourceCount, 0);
  assert.equal(summary.hasArticle, false);
  assert.equal(summarizeRun({}).id, '');
  assert.equal(summarizeRun(null).totalSteps, 5);
});

test('status normalizers reject values outside the known vocabularies', () => {
  assert.equal(normalizeRunStatus('completed'), 'completed');
  assert.equal(normalizeRunStatus('failed'), 'failed');
  assert.equal(normalizeRunStatus('weird'), 'active');
  assert.equal(normalizeRunStatus(undefined), 'active');
  assert.equal(normalizeStepStatus('skipped'), 'skipped');
  assert.equal(normalizeStepStatus('weird'), 'pending');
});

test('readSteps always returns the five canonical steps in order', () => {
  const steps = readSteps({ publish: { status: 'failed' } });
  assert.deepEqual(steps.map(step => step.name), ['topic', 'write', 'review', 'visual', 'publish']);
  assert.deepEqual(steps.map(step => step.status), ['pending', 'pending', 'pending', 'pending', 'failed']);
  assert.equal(steps[4].label, '排版与发布');
  assert.deepEqual(progressOf(steps), { completed: 0, total: 5 });
});

test('pickArticlePath prefers the finished article over the draft', () => {
  assert.equal(pickArticlePath(state.artifacts), 'runs/x/article.md');
  assert.equal(pickArticlePath({ draft: 'runs/x/draft.md' }), 'runs/x/draft.md');
  assert.equal(pickArticlePath({}), '');
  assert.equal(pickArticlePath(undefined), '');
});

test('describeRun exposes the detail fields the panel renders', () => {
  const detail = describeRun(state);
  assert.deepEqual(detail.keywords, ['柚子', '降压药']);
  assert.equal(detail.framework, '痛点型');
  assert.equal(detail.persona, 'elder-health-guide');
  assert.equal(detail.wordCount, 1500);
  assert.equal(detail.runDirectory, 'runs/20261010-120411-0ec3e5');
  assert.equal(detail.stepList.length, 5);
  assert.deepEqual(Object.keys(detail.artifacts).sort(), ['article', 'brief', 'claims', 'draft', 'preview']);
});

test('parseThemes reads the two-column CLI listing', () => {
  const output = [
    '  bauhaus                  包豪斯设计风格：纯白底',
    '  elder-clear              中老年友好主题：18px 正文',
    '  professional-clean       干净专业的企业公众号风格',
    ''
  ].join('\n');
  assert.deepEqual(parseThemes(output), [
    { name: 'bauhaus', description: '包豪斯设计风格：纯白底' },
    { name: 'elder-clear', description: '中老年友好主题：18px 正文' },
    { name: 'professional-clean', description: '干净专业的企业公众号风格' }
  ]);
  assert.deepEqual(parseThemes(''), []);
});
