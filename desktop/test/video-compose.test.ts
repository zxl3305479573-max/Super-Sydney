import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTER_SECONDS, PUSH_IN, VIDEO_FPS, buildConcatList, buildFfmpegArgs, buildFrameHtml, buildFramePlan, cardFontSize, frameLead, framePlanOptions,
  framePlanStills, karaokeTimes, motionAt, motionStyle, pushOrigin, seededRandom, settledMotion
} from '../services/video-compose.ts';
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
  const timing = { shotStart: 10, shotEnd: 15, pushIn: true, litTimes: [10, 10.5, 11] };
  assert.deepEqual(motionAt(timing, 10.2), motionAt(timing, 10.2));
  const start = motionAt(timing, 10);
  assert.equal(start.enter, 0);
  assert.equal(start.zoom, 1);
  assert.equal(start.lit, 1);
  const settled = motionAt(timing, 10 + ENTER_SECONDS);
  assert.deepEqual([settled.enter, settled.key, settled.bar], [1, 1, 1]);
  assert.equal(motionAt(timing, 10.75).lit, 2);
  assert.equal(motionAt(timing, 15).zoom, 1 + PUSH_IN);
  let previous = 0;
  for (let t = 10; t <= 15; t += 1 / VIDEO_FPS) {
    const { enter, zoom } = motionAt(timing, t);
    assert.ok(enter >= previous && zoom >= 1 && zoom <= 1 + PUSH_IN);
    previous = enter;
  }
  // 纯文字卡片不推近，配图下方大字的变量也不动，免得截出看不出区别的帧。
  const card = motionAt({ ...timing, pushIn: false }, 12);
  assert.deepEqual([card.key, card.zoom], [1, 1]);
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
  // 没有逐字高亮：每镜只有入场的十几帧单独截图，之后一张静帧撑到底。
  const entrance = Math.ceil(ENTER_SECONDS * VIDEO_FPS) + 1;
  assert.ok(framePlanStills(plain) <= 2 * entrance + 1, `${framePlanStills(plain)} stills`);
  const lastStill = plain.segments[2].stills.at(-1)!;
  assert.equal(lastStill.motion.enter, 1);
  assert.ok(lastStill.frames > 30);
  // 片头第一镜不做入场，第一帧就是完整画面；第二镜从空卡片开始入场。
  assert.equal(plain.segments[0].stills[0].motion.enter, 1);
  assert.equal(plain.segments[2].stills[0].motion.enter, 0);
  // 逐字高亮：每亮一个字多一张，字全部亮完。
  const karaoke = buildFramePlan(shots, timeline, { karaoke: true, pushIn: false });
  assert.ok(framePlanStills(karaoke) >= framePlanStills(plain) + 4 && framePlanStills(karaoke) <= framePlanStills(plain) + 6);
  assert.equal(karaoke.segments[0].stills.at(-1)!.motion.lit, 3);
  assert.equal(karaoke.segments[1].stills.at(-1)!.motion.lit, 3);
  // 有静音检测结果时，第一个字等到出声才亮。
  const measured = buildFramePlan(shots, timeline, { karaoke: true, pushIn: false, speech: [{ start: 0.5, end: 3 }, null] });
  const firstLit = measured.segments[0].stills.findIndex(still => still.motion.lit === 1);
  const framesBefore = measured.segments[0].stills.slice(0, firstLit).reduce((sum, still) => sum + still.frames, 0);
  assert.equal(framesBefore, 15);
  // 配图推近：静帧多一些，但远少于逐帧的 180 张。
  const pushed = buildFramePlan(shots, timeline, { karaoke: true, pushIn: true });
  assert.ok(framePlanStills(pushed) > framePlanStills(karaoke) && framePlanStills(pushed) < 140);
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

test('ffmpeg args pad each shot to its duration, use silence where there is no voice, and keep narration level when mixing music', () => {
  const args = buildFfmpegArgs({
    narration: [{ path: 'a.wav', seconds: 2.35 }, { path: '', seconds: 2 }, { path: 'c.mp3', seconds: 3.1 }],
    bgm: { path: 'music.mp3', volume: 0.12 },
    total: 7.45,
    output: 'out.mp4'
  }, 'frames.ffconcat');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-i'), ['frames.ffconcat', 'a.wav', 'c.mp3', 'music.mp3']);
  assert.equal(args[args.indexOf('music.mp3') - 3], '-stream_loop');
  assert.match(graph, /\[1:a\][^;]*apad=whole_dur=2\.350,atrim=end=2\.350[^;]*\[n0\]/);
  assert.match(graph, /anullsrc=[^;]*atrim=end=2\.000[^;]*\[n1\]/);
  assert.match(graph, /\[2:a\][^;]*apad=whole_dur=3\.100[^;]*\[n2\]/);
  assert.match(graph, /\[n0\]\[n1\]\[n2\]concat=n=3:v=0:a=1\[nar\]/);
  assert.match(graph, /\[3:a\][^;]*volume=0\.120[^;]*afade=t=out:st=5\.450:d=2\.000\[bg\]/);
  assert.match(graph, /amix=inputs=2:duration=first:dropout_transition=0:normalize=0\[aout\]/);
  assert.equal(args[args.indexOf('-t') + 1], '7.450');
  assert.equal(args[args.length - 1], 'out.mp4');
});

test('without music the narration track goes straight to the output', () => {
  const args = buildFfmpegArgs({ narration: [{ path: '', seconds: 3 }], bgm: null, total: 3, output: 'out.mp4' }, 'list');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[nar\]anull\[aout\]/);
  assert.ok(!args.includes('-stream_loop'));
  assert.throws(() => buildFfmpegArgs({ narration: [], bgm: null, total: 0, output: 'o' }, 'l'), /没有可合成/);
});
