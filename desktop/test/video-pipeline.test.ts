import test from 'node:test';
import assert from 'node:assert/strict';
import type { VideoProject } from '../shared.ts';
import { buildSrt, buildVideoPipeline, currentVideoStepKey, isVideoExportable, parseVideoShots, prepareVideoEdit, serializeVideoShots, videoExportChecklist, videoPipelineProgress } from '../services/video-pipeline.ts';

function project(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 1, platform: 'douyin', topic: '', title: '', audience: '', durationSeconds: 60, status: 'idea',
    topicsJson: '', script: '', storyboardJson: '', coverPath: '', exportPath: '', createdAt: '', updatedAt: '', ...patch
  };
}

const states = (value: VideoProject) => Object.fromEntries(buildVideoPipeline(value).map(step => [step.key, step.state]));

test('new video starts at topic and locks the model stages behind it', () => {
  const s = states(project());
  assert.equal(s.topic, 'current');
  assert.equal(s.script, 'locked');
  assert.equal(s.storyboard, 'locked');
  assert.equal(s.captions, 'locked');
  assert.equal(s.export, 'locked');
  assert.equal(currentVideoStepKey(project()), 'topic');
});

test('script and storyboard unlock in order and confirm the storyboard stage', () => {
  assert.equal(currentVideoStepKey(project({ title: '控糖早餐' })), 'script');
  assert.equal(currentVideoStepKey(project({ title: '控糖早餐', script: '开场白' })), 'storyboard');
  const drafted = project({ title: '控糖早餐', script: '开场白', storyboardJson: serializeVideoShots([{ index: 1, seconds: 5, visual: '厨房', narration: '开场白', caption: '' }]) });
  // 分镜已存在但状态还停在 script：说明脚本在分镜之后又改过。
  assert.equal(states(drafted).storyboard, 'attention');
  assert.equal(states({ ...drafted, status: 'storyboard' }).storyboard, 'done');
});

test('captions complete from the storyboard without another model call', () => {
  const s = states(project({ title: 'x', script: 'a', status: 'storyboard', storyboardJson: serializeVideoShots([{ index: 1, seconds: 5, visual: 'v', narration: 'n', caption: '' }]) }));
  assert.equal(s.captions, 'done');
});

test('cover stays optional and out of the progress denominator', () => {
  const done = project({
    title: '控糖早餐', script: '开场白', status: 'storyboard',
    storyboardJson: serializeVideoShots([{ index: 1, seconds: 60, visual: '厨房', narration: '开场白', caption: '' }])
  });
  assert.equal(states(done).cover, 'current');
  assert.equal(videoPipelineProgress(done).done, 4);
  assert.equal(videoPipelineProgress(done).total, 5);
  assert.ok(isVideoExportable(done));
  assert.ok(videoExportChecklist(done).filter(item => item.optional).every(item => !item.ok));
});

test('editing the script after export flags the stale package instead of hiding it', () => {
  const exported = project({
    title: '控糖早餐', script: '开场白', status: 'exported', exportPath: '/vault/07-视频/x',
    storyboardJson: serializeVideoShots([{ index: 1, seconds: 60, visual: '厨房', narration: '开场白', caption: '' }])
  });
  assert.equal(states(exported).export, 'done');
  // 改动脚本会把状态退回 script，导出的制作包随即变成「需要重新导出」。
  assert.equal(states({ ...exported, script: '改过的开场白', status: 'script' }).export, 'attention');
});

test('shot parsing tolerates model drift and drops empty shots', () => {
  const shots = parseVideoShots(JSON.stringify({
    shots: [
      { no: '2', duration: '7', visual: '厨房台面', narration: '先说结论', on_screen: '先说结论' },
      { seconds: 0, narration: '秒数非法时按默认值', visual: '特写' },
      { caption: '', narration: '', visual: '' }
    ]
  }));
  assert.equal(shots.length, 2);
  assert.equal(shots[0].index, 2);
  assert.equal(shots[0].seconds, 7);
  assert.equal(shots[0].caption, '先说结论');
  assert.equal(shots[1].seconds, 5);
  assert.deepEqual(parseVideoShots('not json'), []);
  assert.deepEqual(parseVideoShots(''), []);
});

test('srt timeline accumulates shot durations and falls back to the narration', () => {
  const srt = buildSrt([
    { index: 1, seconds: 3, visual: 'v1', narration: '第一句', caption: '' },
    { index: 2, seconds: 2.5, visual: 'v2', narration: '第二句', caption: '屏幕字幕' }
  ]);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:03,000\n第一句/);
  assert.match(srt, /2\n00:00:03,000 --> 00:00:05,500\n屏幕字幕/);
});

test('export checklist reports the duration drift against the target', () => {
  const long = project({
    title: 'x', script: 'a', status: 'storyboard', durationSeconds: 60,
    storyboardJson: serializeVideoShots([{ index: 1, seconds: 60, visual: 'v', narration: 'n', caption: '' }, { index: 2, seconds: 60, visual: 'v', narration: 'n', caption: '' }])
  });
  const detail = videoExportChecklist(long)[1].detail;
  assert.match(detail, /2 个镜头/);
  assert.match(detail, /\+100%/);
});

test('edits only invalidate the downstream products that depend on them', () => {
  const base = project({ title: '控糖早餐', script: '旧脚本', status: 'storyboard', storyboardJson: serializeVideoShots([{ index: 1, seconds: 5, visual: 'v', narration: 'n', caption: '' }]) });
  // 改标题、换平台、选封面都不影响已有脚本与分镜。
  assert.deepEqual(prepareVideoEdit(base, { title: '新标题' }), { title: '新标题' });
  assert.deepEqual(prepareVideoEdit(base, { platform: 'bilibili' }), { platform: 'bilibili' });
  assert.deepEqual(prepareVideoEdit(base, { coverPath: 'c.png' }), { coverPath: 'c.png' });
  // 改脚本会把状态退回 script，导出的制作包随之过时。
  assert.deepEqual(prepareVideoEdit(base, { script: '新脚本' }), { script: '新脚本', status: 'script' });
  assert.deepEqual(prepareVideoEdit(base, { script: '' }), { script: '', status: 'idea' });
  // 分镜重新写入后状态回到 storyboard；清空分镜退到 script。
  assert.equal(prepareVideoEdit(base, { storyboardJson: serializeVideoShots([{ index: 1, seconds: 3, visual: 'v', narration: 'n', caption: '' }]) }).status, 'storyboard');
  assert.equal(prepareVideoEdit(base, { storyboardJson: '' }).status, 'script');
  assert.deepEqual(prepareVideoEdit(base, { durationSeconds: 9999 }), { durationSeconds: 600 });
  // 手改分镜时写坏 JSON 会被拒绝，而不是把分镜静默清空。
  assert.throws(() => prepareVideoEdit(base, { storyboardJson: '{"shots":[{' }), /无法解析/);
  assert.throws(() => prepareVideoEdit(base, { storyboardJson: '{"shots":[{"visual":""}]}' }), /有效镜头/);
  assert.throws(() => prepareVideoEdit(base, { platform: 'kuaishou' as VideoProject['platform'] }), /平台/);
  assert.throws(() => prepareVideoEdit(base, { title: 7 as unknown as string }), /文本/);
});
