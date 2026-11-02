import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTER_SECONDS, PUSH_IN, VIDEO_FPS, buildConcatList, buildExternalBgmArgs, buildFfmpegArgs, buildFrameHtml, buildFramePlan, cardFontSize, frameLead, framePlanOptions,
  framePlanStills, karaokeTimes, motionAt, motionStyle, pushOrigin, seededRandom, settledMotion
} from '../services/video-compose.ts';
import { LANDSCAPE_FRAME, VERTICAL_FRAME, videoFrameSpec } from '../services/video-frame-spec.ts';
import { buildTimeline } from '../services/video-pipeline.ts';

const frame = { template: 'warm' as const, title: '控糖早餐', keyText: '先吃蛋', subtitle: '早上先吃一个鸡蛋', imageUrl: '', shotNumber: 2, shotCount: 4, footer: '健康科普 · 不替代医生诊疗', role: '' as const, lead: '', motion: settledMotion('', { karaoke: false, pushIn: false }) };

test('frame html escapes every piece of text it receives', () => {
  const html = buildFrameHtml({ ...frame, title: '<script>alert(1)</script>', subtitle: '血压 < 140 & "正常"', footer: '' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  // 字幕逐字包一层，每个字单独转义。
  assert.match(html, /<span style="--i:3">&lt;<\/span>/);
  assert.match(html, /<span style="--i:9">&amp;<\/span><span style="--i:10"> <\/span><span style="--i:11">&quot;<\/span>/);
  // 页脚留空时不出现页脚元素。
  assert.doesNotMatch(html, /class="footer"/);
});

test('frame html shows either the AI image with a key-text band or a big text card', () => {
  const card = buildFrameHtml(frame);
  assert.match(card, /class="card"/);
  assert.match(card, />先吃蛋</);
  assert.doesNotMatch(card, /<img/);
  // 进度条：第 2 镜共 4 镜，第 1 格点亮，第 2 格随 --bar 填满，后两格空着。
  assert.equal((card.match(/<i class="on"><\/i>/g) ?? []).length, 1);
  assert.equal((card.match(/<i class="now"><\/i>/g) ?? []).length, 1);
  assert.equal((card.match(/<i><\/i>/g) ?? []).length, 2);
  const withImage = buildFrameHtml({ ...frame, imageUrl: 'file:///C:/assets/a%20b.png' });
  assert.match(withImage, /<img src="file:\/\/\/C:\/assets\/a%20b.png"/);
  assert.match(withImage, /class="key">先吃蛋</);
  // 画面大字为空时卡片退回显示标题，不留一块空白。
  assert.match(buildFrameHtml({ ...frame, keyText: '' }), /<p style="font-size:\d+px">控糖早餐<\/p>/);
});

test('platform frame specs drive portrait and landscape layouts', () => {
  assert.deepEqual(videoFrameSpec('douyin'), VERTICAL_FRAME);
  assert.deepEqual(videoFrameSpec('xiaohongshu'), VERTICAL_FRAME);
  assert.deepEqual(videoFrameSpec('bilibili'), LANDSCAPE_FRAME);
  assert.deepEqual(videoFrameSpec('general'), LANDSCAPE_FRAME);
  const html = buildFrameHtml({ ...frame, frame: LANDSCAPE_FRAME, platform: 'bilibili' });
  assert.match(html, /html,body\{width:1920px;height:1080px/);
  assert.match(html, /\.visual\{position:absolute;left:104px;top:250px;width:1112px;height:680px/);
  assert.match(html, /\.subtitle\{position:absolute;left:1210px;right:104px/);
});

test('product frames show the captured website in contain mode with the brand logo and accent', () => {
  const html = buildFrameHtml({
    ...frame,
    imageUrl: 'file:///C:/site.png',
    productMode: true,
    logoUrl: 'file:///C:/logo.png',
    brandColors: ['#1463D8']
  });
  assert.match(html, /class="visual product"/);
  assert.match(html, /object-fit:contain/);
  assert.match(html, /class="brand-logo" src="file:\/\/\/C:\/logo.png"/);
  assert.match(html, /#1463d8/);
  assert.equal(framePlanOptions({ voiceMode: 'tts', imageMode: 'none', workflow: 'product-demo', productScreenshots: ['site.png'] }).pushIn, true);
});

test('big card text picks the largest size that avoids a one-character orphan line', () => {
  // 7 个字在 120px 下一行放不下，退到 104px 一行放完，而不是 6 + 1 折成两行。
  assert.equal(cardFontSize('记住三个半分钟'), 104);
  assert.equal(cardFontSize('起床别太急'), 120);
  // 12 个字一行放不下时用两行大字，交给 text-wrap: balance 均分。
  assert.equal(cardFontSize('头晕频繁一定要去医院看'), 120);
  assert.ok(cardFontSize('这是一段被手动改得特别特别长的画面大字内容，远远超过了十二个字') <= 72);
});

test('card style follows the shot role and steps are numbered when there are several', () => {
  assert.match(buildFrameHtml({ ...frame, role: 'hook' }), /class="card solid"/);
  assert.match(buildFrameHtml({ ...frame, role: 'cta', lead: '提醒您' }), /class="card solid"><span>提醒您<\/span>/);
  assert.match(buildFrameHtml({ ...frame, role: 'problem' }), /class="card"><p/);
  const shots = [
    { index: 1, seconds: 2, visual: 'v', narration: 'a', caption: '', role: 'hook' as const },
    { index: 2, seconds: 2, visual: 'v', narration: 'b', caption: '', role: 'step' as const },
    { index: 3, seconds: 2, visual: 'v', narration: 'c', caption: '', role: 'step' as const },
    { index: 4, seconds: 2, visual: 'v', narration: 'd', caption: '', role: 'problem' as const },
    { index: 5, seconds: 2, visual: 'v', narration: 'e', caption: '' }
  ];
  assert.deepEqual(shots.map((_, position) => frameLead(shots, position)), ['', '第 1 步', '第 2 步', '为什么会这样', '']);
  assert.equal(frameLead([shots[1]], 0), '怎么做');
});

test('frame html carries the motion as css variables and wraps every subtitle character for karaoke', () => {
  const html = buildFrameHtml({ ...frame, subtitle: '血压<140', motion: { enter: 0.5, key: 1, bar: 0.25, zoom: 1.01, lit: 3 } });
  assert.match(html, /<html lang="zh-CN" style="--enter:0\.5;--key:1;--bar:0\.25;--zoom:1\.01;--lit:3">/);
  assert.match(html, /<span style="--i:0">血<\/span><span style="--i:1">压<\/span><span style="--i:2">&lt;<\/span>/);
  assert.equal((html.match(/<span style="--i:/g) ?? []).length, 6);
  // 不用 CSS 动画、不跑脚本：画面只由变量决定。
  assert.doesNotMatch(html, /@keyframes|animation|transition|<script/);
  assert.equal(motionStyle({ enter: 1, key: 1, bar: 1, zoom: 1, lit: 0 }), '--enter:1;--key:1;--bar:1;--zoom:1;--lit:0');
});

test('motion is a pure function of time: entrance eases in, push-in creeps, characters light up in order', () => {
  const timing = { shotStart: 10, shotEnd: 15, pushIn: true, litTimes: [10, 10.5, 11], preset: 'push-in' as const };
  assert.deepEqual(motionAt(timing, 10.2), motionAt(timing, 10.2));
  const start = motionAt(timing, 10);
  assert.equal(start.enter, 0);
  assert.equal(start.zoom, 1);
  assert.equal(start.lit, 1);
  const settled = motionAt(timing, 10 + ENTER_SECONDS);
  assert.equal(settled.enter, 1);
  assert.ok(settled.key > 0.95);
  assert.ok(settled.bar > 0 && settled.bar < 1);
  assert.equal(motionAt(timing, 10.75).lit, 2);
  assert.equal(motionAt(timing, 15).zoom, 1.12);
  let previous = 0;
  for (let t = 10; t <= 15; t += 1 / VIDEO_FPS) {
    const { enter, zoom } = motionAt(timing, t);
    assert.ok(enter >= previous && zoom >= 1 && zoom <= 1.12);
    previous = enter;
  }
  // 纯文字卡片不推近，配图下方大字的变量也不动，免得截出看不出区别的帧。
  const card = motionAt({ ...timing, pushIn: false }, 12);
  assert.equal(card.key, 1);
  assert.ok(card.zoom >= 1 && card.zoom <= 1.12);
});

test('karaoke times spread a shot over its spoken span and pause on punctuation and between lines', () => {
  const [first, second] = karaokeTimes(['先吃蛋，再喝粥', '记住了'], 0.2, 3.4);
  assert.equal(first.length, 7);
  assert.equal(second.length, 3);
  const all = [...first, ...second];
  assert.equal(all[0], 0.2);
  assert.ok(all.every((at, index) => index === 0 || at > all[index - 1]));
  assert.ok(all.at(-1)! < 3.4);
  const beat = first[1] - first[0];
  // 逗号和换行处各停两个字的时间，跟实测的系统语音停顿差不多。
  assert.ok(Math.abs(first[4] - first[3] - 2 * beat) < 0.002);
  assert.ok(Math.abs(second[0] - first[6] - 3 * beat) < 0.002);
});

test('seeded randomness repeats exactly and varies between shots', () => {
  const a = seededRandom('控糖早餐#1');
  const b = seededRandom('控糖早餐#1');
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.equal(pushOrigin('控糖早餐#2'), pushOrigin('控糖早餐#2'));
  assert.notEqual(pushOrigin('控糖早餐#1'), pushOrigin('控糖早餐#2'));
  assert.match(pushOrigin('x'), /^\d+\.\d% \d+\.\d%$/);
});

test('frame plan covers every frame, renders motion frame by frame and merges the still stretches', () => {
  const shots = [
    { index: 1, seconds: 4, visual: 'v', narration: '第一句。第二句。', caption: '' },
    { index: 2, seconds: 2, visual: 'v', narration: '', caption: '片尾' }
  ];
  const timeline = buildTimeline(shots, [4, 2]);
  const plain = buildFramePlan(shots, timeline, { karaoke: false, pushIn: false });
  assert.deepEqual(plain.segments.map(segment => [segment.shot, segment.subtitle]), [[0, '第一句'], [0, '第二句'], [1, '']]);
  assert.equal(plain.frames, 180);
  assert.equal(plain.segments.flatMap(segment => segment.stills).reduce((sum, still) => sum + still.frames, 0), 180);
  // 自动运镜持续覆盖镜头主体，不会在入场后退化成静态图。
  assert.ok(framePlanStills(plain) > 120, `${framePlanStills(plain)} stills`);
  const lastStill = plain.segments[2].stills.at(-1)!;
  assert.equal(lastStill.motion.enter, 1);
  assert.equal(lastStill.frames, 1);
  // 片头第一镜不做入场，第一帧就是完整画面；第二镜从空卡片开始入场。
  assert.equal(plain.segments[0].stills[0].motion.enter, 1);
  assert.equal(plain.segments[2].stills[0].motion.enter, 0);
  // 逐字高亮：每亮一个字多一张，字全部亮完。
  const karaoke = buildFramePlan(shots, timeline, { karaoke: true, pushIn: false });
  assert.ok(framePlanStills(karaoke) >= framePlanStills(plain));
  assert.equal(karaoke.segments[0].stills.at(-1)!.motion.lit, 3);
  assert.equal(karaoke.segments[1].stills.at(-1)!.motion.lit, 3);
  // 有静音检测结果时，第一个字等到出声才亮。
  const measured = buildFramePlan(shots, timeline, { karaoke: true, pushIn: false, speech: [{ start: 0.5, end: 3 }, null] });
  const firstLit = measured.segments[0].stills.findIndex(still => still.motion.lit === 1);
  const framesBefore = measured.segments[0].stills.slice(0, firstLit).reduce((sum, still) => sum + still.frames, 0);
  assert.equal(framesBefore, 15);
  // 有逐字字幕和镜头运动时，按真实时间轴逐帧更新。
  const pushed = buildFramePlan(shots, timeline, { karaoke: true, pushIn: true });
  assert.ok(framePlanStills(pushed) >= 180);
  assert.deepEqual(buildFramePlan(shots, timeline, { karaoke: true, pushIn: true }), pushed);
  assert.deepEqual(framePlanOptions({ voiceMode: 'silent', imageMode: 'ai' }), { karaoke: false, pushIn: true });
});

test('concat list quotes paths, escapes quotes, keeps durations on the frame grid and repeats the last still', () => {
  const list = buildConcatList([{ path: 'C:\\video\\a.jpg', frames: 45 }, { path: "C:\\video\\it's.jpg", frames: 60 }]);
  assert.equal(list, "ffconcat version 1.0\nfile 'C:/video/a.jpg'\nduration 1.500000\nfile 'C:/video/it'\\''s.jpg'\nduration 2.000000\nfile 'C:/video/it'\\''s.jpg'\n");
  // 1800 张一帧的静帧加起来正好 60 秒，不会因为 1/30 秒取整而漂移。
  const many = buildConcatList(Array.from({ length: 1800 }, (_, index) => ({ path: `${index}.jpg`, frames: 1 })));
  const sum = [...many.matchAll(/duration (\d+\.\d+)/g)].reduce((total, match) => total + Math.round(Number(match[1]) * 1e6), 0);
  assert.equal(sum, 60_000_000);
  assert.throws(() => buildConcatList([]), /没有可合成/);
});

test('ffmpeg args pad shots, fade music, and duck it against narration without lowering the voice', () => {
  const args = buildFfmpegArgs({
    narration: [{ path: 'a.wav', seconds: 2.35 }, { path: '', seconds: 2 }, { path: 'c.mp3', seconds: 3.1 }],
    bgm: { path: 'music.mp3', volume: 0.12, ducking: true, fadeIn: 0.6, fadeOut: 2 },
    total: 7.45,
    output: 'out.mp4'
  }, 'frames.ffconcat');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /scale=1080:1920:flags=lanczos/);
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-i'), ['frames.ffconcat', 'a.wav', 'c.mp3', 'music.mp3']);
  assert.equal(args[args.indexOf('music.mp3') - 3], '-stream_loop');
  assert.match(graph, /\[1:a\][^;]*apad=whole_dur=2\.350,atrim=end=2\.350[^;]*\[n0\]/);
  assert.match(graph, /anullsrc=[^;]*atrim=end=2\.000[^;]*\[n1\]/);
  assert.match(graph, /\[2:a\][^;]*apad=whole_dur=3\.100[^;]*\[n2\]/);
  assert.match(graph, /\[n0\]\[n1\]\[n2\]concat=n=3:v=0:a=1\[nar\]/);
  assert.match(graph, /\[3:a\][^;]*volume=0\.120[^;]*afade=t=in:st=0:d=0\.600,afade=t=out:st=5\.450:d=2\.000\[bg\]/);
  assert.match(graph, /\[nar\]asplit=2\[narout\]\[narside\]/);
  assert.match(graph, /\[bg\]\[narside\]sidechaincompress=threshold=0\.025:ratio=8:attack=20:release=320:makeup=1\[bgducked\]/);
  assert.match(graph, /\[nar\]\[bgducked\]amix=inputs=2:duration=first:dropout_transition=0:normalize=0\[aout\]/);
  assert.equal(args[args.indexOf('-t') + 1], '7.450');
  assert.equal(args[args.length - 1], 'out.mp4');
});

test('motion presets stay deterministic and audio effects are delayed and mixed', () => {
  const timing = { shotStart: 0, shotEnd: 4, pushIn: false, litTimes: [], preset: 'pan-right' as const };
  assert.deepEqual(motionAt(timing, 0.4), motionAt(timing, 0.4));
  assert.ok((motionAt(timing, 0.4).pan ?? 0) > 0);
  const args = buildFfmpegArgs({
    narration: [{ path: 'voice.wav', seconds: 4 }],
    soundEffects: [{ path: 'pop.wav', at: 1.25, duration: 0.18, volume: 0.24 }],
    bgm: null, total: 4, output: 'out.mp4'
  }, 'list');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /adelay=1250\|1250/);
  assert.match(graph, /\[nar\]\[sfx0\]amix=inputs=2/);
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-i'), ['list', 'voice.wav', 'pop.wav']);
});

test('auto motion continuously moves the whole shot and staggers content layers', () => {
  const timing = { shotStart: 0, shotEnd: 5, pushIn: true, litTimes: [], preset: 'auto' as const, shotIndex: 2 };
  const start = motionAt(timing, 0.1);
  const middle = motionAt(timing, 2.5);
  const end = motionAt(timing, 4.9);
  assert.ok(start.zoom <= middle.zoom && middle.zoom <= end.zoom);
  assert.ok((start.bodyIn ?? 0) < (middle.bodyIn ?? 0) && (middle.bodyIn ?? 0) <= (end.bodyIn ?? 0));
  assert.ok((start.titleIn ?? 0) > (start.leadIn ?? 0) && (start.leadIn ?? 0) >= (start.bodyIn ?? 0));
  assert.ok(framePlanStills(buildFramePlan(
    [{ index: 1, seconds: 5, visual: 'v', narration: '内容持续展开。', caption: '逐层揭示' }],
    buildTimeline([{ index: 1, seconds: 5, visual: 'v', narration: '内容持续展开。', caption: '逐层揭示' }], [5]),
    { karaoke: false, pushIn: true }
  )) > VIDEO_FPS * 4);
});

test('ffmpeg args honor the supplied landscape canvas', () => {
  const args = buildFfmpegArgs({
    frame: LANDSCAPE_FRAME,
    narration: [{ path: '', seconds: 3 }],
    bgm: null,
    total: 3,
    output: 'landscape.mp4'
  }, 'list');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /scale=1920:1080:flags=lanczos/);
  assert.doesNotMatch(graph, /scale=1080:1920/);
});

test('music can bypass sidechain ducking while keeping the same mix level', () => {
  const args = buildFfmpegArgs({
    narration: [{ path: 'voice.wav', seconds: 3 }],
    bgm: { path: 'music.mp3', volume: 0.12, ducking: false, fadeIn: 0, fadeOut: 0 },
    total: 3,
    output: 'out.mp4'
  }, 'list');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.doesNotMatch(graph, /sidechaincompress|asplit/);
  assert.match(graph, /\[nar\]\[bg\]amix=inputs=2:duration=first:dropout_transition=0:normalize=0\[aout\]/);
});

test('without music the narration track goes straight to the output', () => {
  const args = buildFfmpegArgs({ narration: [{ path: '', seconds: 3 }], bgm: null, total: 3, output: 'out.mp4' }, 'list');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[nar\]anull\[aout\]/);
  assert.ok(!args.includes('-stream_loop'));
  assert.throws(() => buildFfmpegArgs({ narration: [], bgm: null, total: 0, output: 'o' }, 'l'), /没有可合成/);
});

test('external skill video keeps its picture stream while music is mixed and ducked', () => {
  const args = buildExternalBgmArgs({
    video: 'skill.mp4',
    music: 'music.wav',
    volumePercent: 12,
    ducking: true,
    fadeIn: 0.6,
    fadeOut: 2,
    total: 8,
    output: 'final.mp4',
    hasSourceAudio: true
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.match(graph, /\[0:a\][^;]*\[voice\]/);
  assert.match(graph, /volume=0\.120[^;]*afade=t=in:st=0:d=0\.600,afade=t=out:st=6\.000:d=2\.000\[bg\]/);
  assert.match(graph, /\[bg\]\[voiceside\]sidechaincompress=/);
  assert.equal(args[args.indexOf('-t') + 1], '8.000');
});

test('external silent video receives music without requiring a source audio stream', () => {
  const args = buildExternalBgmArgs({
    video: 'screen.mp4',
    music: 'music.wav',
    volumePercent: 20,
    ducking: true,
    fadeIn: 0,
    fadeOut: 0,
    total: 3,
    output: 'final.mp4',
    hasSourceAudio: false
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.doesNotMatch(graph, /\[0:a\]|sidechain/);
  assert.match(graph, /\[bg\]anull\[aout\]/);
});
