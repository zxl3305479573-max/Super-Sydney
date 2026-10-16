import test from 'node:test';
import assert from 'node:assert/strict';
import type { VideoProject } from '../shared.ts';
import { parseVideoResponse, requestVideoStage } from '../services/video-workflow.ts';
import { VIDEO_RENDER_DEFAULTS, emptyRenderAssets } from '../services/video-production.ts';

function project(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 3, platform: 'douyin', topic: '控糖早餐', title: '控糖早餐怎么吃', audience: '中老年读者', durationSeconds: 60, status: 'idea',
    topicsJson: '', script: '', storyboardJson: '', coverPath: '', exportPath: '', createdAt: '', updatedAt: '',
    options: { ...VIDEO_RENDER_DEFAULTS }, assets: emptyRenderAssets(), ...patch
  };
}

const config = { apiKey: 'key', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };

test('topic stage returns candidates and keeps the platform guide in the prompt', async () => {
  let body = '';
  const result = await requestVideoStage(project(), 'topics', config, async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: [{ title: '早餐别只喝粥', hook: '你的早餐够蛋白吗？', angle: '蛋白质', risk_note: '不要给具体剂量' }] }) } }] }), { status: 200 });
  });
  const topics = JSON.parse(String(result.topicsJson)) as { topics: Array<{ title: string }> };
  assert.equal(topics.topics[0].title, '早餐别只喝粥');
  assert.match(body, /抖音/);
  // 健康合规规则必须随每次调用一起下发，不能依赖模型记忆。
  assert.match(body, /不诊断、不开药方/);
  assert.match(body, /没有联网核实能力/);
});

test('script stage sends the target length and returns plain script text', async () => {
  let body = '';
  const result = await requestVideoStage(project(), 'script', config, async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"script":"第一句。\\n第二句。"}\n```' } }] }), { status: 200 });
  });
  assert.match(String(result.script), /第一句。/);
  assert.match(body, /240 字左右/);
});

test('storyboard stage normalizes shots and refuses an empty result', async () => {
  let body = '';
  const result = await requestVideoStage(project({ script: '开场白' }), 'storyboard', config, async (_url, init) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: [{ no: 1, seconds: 5, role: 'hook', caption: '早餐吃对', visual: '厨房', narration: '开场白', image_prompt: '清晨厨房' }, { no: 2, role: 'weird', visual: '碗', narration: '第二句' }] }) } }] }), { status: 200 });
  });
  const shots = JSON.parse(String(result.storyboardJson)) as { shots: Array<{ index: number; role: string; imagePrompt: string }> };
  assert.equal(shots.shots.length, 2);
  assert.equal(shots.shots[0].index, 1);
  assert.equal(shots.shots[0].role, 'hook');
  assert.equal(shots.shots[0].imagePrompt, '清晨厨房');
  // 不认识的作用丢掉，不让脏值流进画面和导出。
  assert.equal(shots.shots[1].role, '');
  // 提示词要求逐镜给出作用、画面大字与配图提示词。
  assert.match(body, /image_prompt/);
  assert.match(body, /不超过 12 字/);
  await assert.rejects(() => requestVideoStage(project({ script: 'x' }), 'storyboard', config, async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '{"shots":[]}' } }] }), { status: 200 })), /有效镜头/);
});

test('rejects before fetch when the API key is missing and surfaces HTTP errors', async () => {
  let called = false;
  await assert.rejects(() => requestVideoStage(project(), 'topics', { ...config, apiKey: '' }, async () => {
    called = true;
    return new Response('{}');
  }), /API Key/);
  assert.equal(called, false);
  await assert.rejects(() => requestVideoStage(project(), 'script', config, async () => new Response('{}', { status: 401 })), /401/);
});

test('topic responses must carry at least one usable title', () => {
  assert.throws(() => parseVideoResponse('{"topics":[]}', 'topics'), /候选列表/);
  assert.throws(() => parseVideoResponse('{"topics":[{"angle":"没有标题"}]}', 'topics'), /有效标题/);
  assert.throws(() => parseVideoResponse('not json', 'script'), /JSON/);
});
