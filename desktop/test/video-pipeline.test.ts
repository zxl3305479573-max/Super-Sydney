import test from 'node:test';
import assert from 'node:assert/strict';
import type { VideoProject } from '../shared.ts';
import {
  buildSrt, buildTimeline, buildVideoPipeline, currentVideoStepKey, isRenderFresh, isVideoExportable, narrationCoverage, parseVideoShots,
  prepareVideoEdit, renderBlockers, renderSignature, serializeVideoShots, shotDurations, splitCaptionLines, videoExportChecklist, videoPipelineProgress
} from '../services/video-pipeline.ts';
import { VIDEO_RENDER_DEFAULTS, audioKey, emptyRenderAssets } from '../services/video-production.ts';

function project(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 1, platform: 'douyin', topic: '', title: '', audience: '', durationSeconds: 60, status: 'idea',
    topicsJson: '', script: '', storyboardJson: '', coverPath: '', exportPath: '', createdAt: '', updatedAt: '',
    options: { ...VIDEO_RENDER_DEFAULTS }, assets: emptyRenderAssets(), ...patch
  };
}

const states = (value: VideoProject) => Object.fromEntries(buildVideoPipeline(value).map(step => [step.key, step.state]));

test('new video starts at topic and locks the model stages behind it', () => {
  const s = states(project());
  assert.equal(s.topic, 'current');
  assert.equal(s.script, 'locked');
  assert.equal(s.storyboard, 'locked');
  assert.equal(s.voice, 'locked');
  assert.equal(s.render, 'locked');
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

test('voice waits for TTS unless the video is set to go without narration', () => {
  const drafted = project({ title: 'x', script: 'a', status: 'storyboard', storyboardJson: serializeVideoShots([{ index: 1, seconds: 5, visual: 'v', narration: 'n', caption: '' }]) });
  assert.equal(states(drafted).voice, 'current');
  // 纯文字卡片不需要配图，画面这一步不挡路；渲染要等配音。
  assert.equal(states(drafted).visuals, 'done');
  assert.equal(states(drafted).render, 'locked');
  const silent = { ...drafted, options: { ...drafted.options, voiceMode: 'silent' as const } };
  assert.equal(states(silent).voice, 'done');
  assert.equal(states(silent).render, 'current');
});

test('cover and render stay optional and out of the progress denominator', () => {
  const done = project({
    title: '控糖早餐', script: '开场白', status: 'storyboard', options: { ...VIDEO_RENDER_DEFAULTS, voiceMode: 'silent' },
    storyboardJson: serializeVideoShots([{ index: 1, seconds: 60, visual: '厨房', narration: '开场白', caption: '' }])
  });
  assert.equal(states(done).render, 'current');
  assert.equal(states(done).cover, 'ready');
  assert.equal(videoPipelineProgress(done).done, 5);
  assert.equal(videoPipelineProgress(done).total, 6);
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

test('srt comes from the narration line by line, never from the on-screen key text', () => {
  const shots = [
    { index: 1, seconds: 3, visual: 'v1', narration: '第一句', caption: '' },
    { index: 2, seconds: 2.5, visual: 'v2', narration: '第二句', caption: '画面大字' }
  ];
  const srt = buildSrt(buildTimeline(shots, shots.map(shot => shot.seconds)).lines);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:03,000\n第一句/);
  assert.match(srt, /2\n00:00:03,000 --> 00:00:05,500\n第二句/);
  assert.doesNotMatch(srt, /画面大字/);
});

test('captions split at sentence and clause marks and stay within 14 characters', () => {
  assert.deepEqual(splitCaptionLines('早上起床别着急。先在床边坐半分钟，再慢慢站起来！'), ['早上起床别着急', '先在床边坐半分钟', '再慢慢站起来！']);
  // 短分句会并到同一行，行内的逗号保留，行尾的逗号句号去掉。
  assert.deepEqual(splitCaptionLines('喝水，吃饭，散步。'), ['喝水，吃饭，散步']);
  // 问号保留语气。
  assert.deepEqual(splitCaptionLines('你知道为什么吗？'), ['你知道为什么吗？']);
  // 没有标点的长句均分，不留一个字的孤行。
  const long = splitCaptionLines('高血压的人早上起床的时候最容易出现头晕眼花的情况');
  assert.ok(long.every(line => line.length <= 14));
  assert.ok(Math.min(...long.map(line => line.length)) >= 5);
  assert.equal(long.join(''), '高血压的人早上起床的时候最容易出现头晕眼花的情况');
  assert.deepEqual(splitCaptionLines('  \n '), []);
});

test('timeline spreads a shot over its lines by length and ends exactly on the shot boundary', () => {
  const shots = [{ index: 1, seconds: 6, visual: 'v', narration: '短句。这一句要长一些才行。', caption: '' }, { index: 2, seconds: 2, visual: 'v', narration: '', caption: '' }];
  const timeline = buildTimeline(shots, [6, 2]);
  assert.equal(timeline.lines.length, 2);
  assert.equal(timeline.lines[0].start, 0);
  assert.ok(timeline.lines[0].end < 3);
  assert.equal(timeline.lines[1].end, 6);
  // 没有口播的镜头不出字幕，但仍占时长。
  assert.deepEqual(timeline.shots[1], { start: 6, end: 8 });
  assert.equal(timeline.total, 8);
});

test('real voice durations replace the storyboard estimate once every speaking shot is voiced', () => {
  const shots = [{ index: 1, seconds: 10, visual: 'v', narration: '第一句', caption: '' }, { index: 2, seconds: 10, visual: 'v', narration: '第二句', caption: '' }];
  const profile = '{"provider":"system","voice":"","rate":0}';
  const partly = project({ storyboardJson: serializeVideoShots(shots), assets: { ...emptyRenderAssets(), voiceProfile: profile, audio: [{ key: audioKey(profile, '第一句'), path: 'a.wav', seconds: 2 }] } });
  assert.deepEqual(shotDurations(partly, shots), { seconds: [2.35, 10], voiced: false });
  const full = { ...partly, assets: { ...partly.assets, audio: [...partly.assets.audio, { key: audioKey(profile, '第二句'), path: 'b.wav', seconds: 3 }] } };
  assert.deepEqual(shotDurations(full, shots), { seconds: [2.35, 3.35], voiced: true });
  // 改了口播，那一镜的配音就对不上了，退回估算。
  const edited = { ...full, storyboardJson: serializeVideoShots([shots[0], { ...shots[1], narration: '改过的第二句' }]) };
  assert.equal(shotDurations(edited, parseVideoShots(edited.storyboardJson)).voiced, false);
});

test('render is blocked until voiced, then goes stale when anything on screen or in the mix changes', () => {
  const shots = [{ index: 1, seconds: 4, visual: 'v', narration: '第一句', caption: '要点' }];
  const profile = '{"provider":"system","voice":"","rate":0}';
  const draft = project({ title: 't', script: '第一句', status: 'storyboard', storyboardJson: serializeVideoShots(shots) });
  assert.match(renderBlockers(draft).join(), /配音/);
  const voiced = { ...draft, assets: { ...emptyRenderAssets(), voiceProfile: profile, audio: [{ key: audioKey(profile, '第一句'), path: 'a.wav', seconds: 2 }] } };
  assert.deepEqual(renderBlockers(voiced), []);
  const rendered = { ...voiced, assets: { ...voiced.assets, video: { path: 'v.mp4', signature: renderSignature(voiced), seconds: 2.35, renderedAt: '' } } };
  assert.ok(isRenderFresh(rendered));
  assert.equal(states(rendered).render, 'done');
  assert.ok(videoExportChecklist(rendered).find(item => item.label === '成片')?.ok);
  for (const changed of [
    { ...rendered, options: { ...rendered.options, template: 'night' as const } },
    { ...rendered, options: { ...rendered.options, bgmPath: 'music.mp3' } },
    { ...rendered, storyboardJson: serializeVideoShots([{ ...shots[0], caption: '换了要点' }]) }
  ]) assert.equal(isRenderFresh(changed), false);
  // 不影响画面和声音的字段（比如受众）改了，成片仍然有效。
  assert.ok(isRenderFresh({ ...rendered, audience: '换个受众' }));
  const stale = { ...rendered, options: { ...rendered.options, template: 'clean' as const } };
  assert.equal(states(stale).render, 'attention');
});

test('narration coverage catches sentences the storyboard dropped', () => {
  const shots = [{ index: 1, seconds: 3, visual: 'v', narration: '第一句话。', caption: '' }];
  assert.equal(narrationCoverage('第一句话。第二句话。', shots), 0.5);
  assert.equal(narrationCoverage('第一句话', shots), 1);
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
  // 成片选项只合并、校验，不动状态。
  assert.deepEqual(prepareVideoEdit(base, { options: { ...base.options, template: 'night' } }), { options: { ...base.options, template: 'night' } });
  assert.throws(() => prepareVideoEdit(base, { options: { ...base.options, template: 'neon' as never } }), /模板/);
});
