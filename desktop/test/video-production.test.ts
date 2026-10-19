import test from 'node:test';
import assert from 'node:assert/strict';
import type { VideoProject } from '../shared.ts';
import { serializeVideoShots } from '../services/video-pipeline.ts';
import {
  VIDEO_RENDER_DEFAULTS, audioKey, contentHash, describeVoiceProfile, emptyRenderAssets, imageCoverage, imageKey, isImageReady, isVoiceReady,
  normalizeRenderOptions, parseRenderAssets, parseRenderOptions, parseVoiceProfile, shotImage, shotImagePrompt, voiceCoverage, voiceProfileOf
} from '../services/video-production.ts';
import { VIDEO_TTS_DEFAULTS } from '../services/video-tts.ts';

function project(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 1, platform: 'douyin', topic: '', title: '控糖早餐', audience: '', durationSeconds: 60, status: 'storyboard',
    topicsJson: '', script: '', storyboardJson: '', coverPath: '', exportPath: '', createdAt: '', updatedAt: '',
    options: { ...VIDEO_RENDER_DEFAULTS }, assets: emptyRenderAssets(), ...patch
  };
}

const shots = [
  { index: 1, seconds: 4, visual: '厨房', narration: '第一句', caption: '要点', imagePrompt: '清晨厨房' },
  { index: 2, seconds: 4, visual: '饭桌', narration: '第二句', caption: '' },
  { index: 3, seconds: 2, visual: '片尾', narration: '', caption: '' }
];

test('render options merge patches and reject values the renderer cannot honour', () => {
  const next = normalizeRenderOptions({ template: 'night', bgmVolume: 250, footer: '  @账号   名  ' });
  assert.equal(next.template, 'night');
  assert.equal(next.bgmVolume, 100);
  assert.equal(next.footer, '@账号 名');
  assert.equal(next.voiceMode, 'tts');
  assert.throws(() => normalizeRenderOptions({ voiceMode: 'robot' }), /配音方式/);
  assert.throws(() => normalizeRenderOptions({ imageMode: 'video' }), /配图方式/);
  assert.throws(() => normalizeRenderOptions({ bgmPath: 3 }), /文本/);
  assert.throws(() => normalizeRenderOptions({ shotImagePromptTemplate: 3 }), /逐镜配图/);
  assert.equal(normalizeRenderOptions({ shotImagePromptTemplate: '' }).shotImagePromptTemplate, VIDEO_RENDER_DEFAULTS.shotImagePromptTemplate);
  assert.equal(normalizeRenderOptions({ coverImagePromptTemplate: '封面 {title}' }).coverImagePromptTemplate, '封面 {title}');
  // 旧任务没有这一列、或者库里存坏了，都按默认值读出来。
  assert.deepEqual(parseRenderOptions(''), VIDEO_RENDER_DEFAULTS);
  assert.deepEqual(parseRenderOptions('{broken'), VIDEO_RENDER_DEFAULTS);
});

test('asset ledger parsing drops malformed entries instead of trusting the database', () => {
  const assets = parseRenderAssets(JSON.stringify({
    voiceProfile: 'p',
    audio: [{ key: 'a', path: 'a.wav', seconds: 2 }, { key: 'b', path: 'b.wav', seconds: 0 }, { path: 'c.wav', seconds: 1 }, 'junk'],
    images: [{ key: 'i', path: 'i.png' }, { key: '', path: 'x.png' }],
    preview: { signature: 's', paths: ['p1.png'] },
    video: { path: 'v.mp4', signature: 'sig', seconds: 'NaN' }
  }));
  assert.deepEqual(assets.audio, [{ key: 'a', path: 'a.wav', seconds: 2 }]);
  assert.deepEqual(assets.images, [{ key: 'i', path: 'i.png' }]);
  assert.deepEqual(assets.preview, { signature: 's', paths: ['p1.png'] });
  assert.equal(assets.video, null);
  assert.deepEqual(parseRenderAssets('not json'), emptyRenderAssets());
});

test('content hash is stable and sensitive to every character', () => {
  assert.equal(contentHash('第一句'), contentHash('第一句'));
  assert.notEqual(contentHash('第一句'), contentHash('第一句。'));
  assert.match(contentHash(''), /^[0-9a-f]{14}$/);
  // 配音键同时取决于声音参数和口播：换声音或改口播都要重配。
  assert.notEqual(audioKey('voice-a', '第一句'), audioKey('voice-b', '第一句'));
  assert.equal(audioKey('voice-a', ' 第一句 '), audioKey('voice-a', '第一句'));
});

test('voice coverage tells missing audio apart from audio that went stale after an edit', () => {
  const profile = voiceProfileOf(VIDEO_TTS_DEFAULTS);
  const base = project({ storyboardJson: serializeVideoShots(shots) });
  assert.deepEqual(voiceCoverage(base, shots), { needed: 2, ready: 0, stale: 0 });
  assert.equal(isVoiceReady(base, shots), false);
  const voiced = project({ assets: { ...emptyRenderAssets(), voiceProfile: profile, audio: [
    { key: audioKey(profile, '第一句'), path: 'a.wav', seconds: 1 },
    { key: audioKey(profile, '第二句'), path: 'b.wav', seconds: 1 }
  ] } });
  assert.equal(isVoiceReady(voiced, shots), true);
  const edited = [shots[0], { ...shots[1], narration: '第二句改了' }, shots[2]];
  assert.deepEqual(voiceCoverage(voiced, edited), { needed: 2, ready: 1, stale: 1 });
  // 选了不配音就不挡渲染。
  assert.equal(isVoiceReady(project({ options: { ...VIDEO_RENDER_DEFAULTS, voiceMode: 'silent' } }), shots), true);
});

test('shot images are keyed by the full prompt so a changed prompt needs a new image', () => {
  const prompt = shotImagePrompt(shots[0], '控糖早餐');
  assert.match(prompt, /清晨厨房/);
  assert.match(prompt, /不要出现任何文字/);
  assert.match(prompt, /一个清晰的主体和一个明确动作/);
  assert.match(prompt, /中国家庭或社区日常场景/);
  // 没有配图提示词时退回画面描述。
  assert.match(shotImagePrompt(shots[1], '控糖早餐'), /饭桌/);
  const withImage = project({ options: { ...VIDEO_RENDER_DEFAULTS, imageMode: 'ai' }, assets: { ...emptyRenderAssets(), images: [{ key: imageKey(prompt), path: 'i.png' }] } });
  assert.equal(shotImage(withImage, shots[0])?.path, 'i.png');
  assert.equal(shotImage(withImage, { ...shots[0], imagePrompt: '换个画面' }), null);
  assert.deepEqual(imageCoverage(withImage, shots), { needed: 3, ready: 1, stale: 2 });
  assert.equal(isImageReady(withImage, shots), false);
  assert.equal(isImageReady(project(), shots), true);
});

test('voice profiles round-trip so missing shots are filled with the same voice later', () => {
  const system = voiceProfileOf({ ...VIDEO_TTS_DEFAULTS, systemVoice: 'Microsoft Huihui Desktop', systemRate: 1 });
  assert.deepEqual(parseVoiceProfile(system), { provider: 'system', voice: 'Microsoft Huihui Desktop', rate: 1 });
  const api = voiceProfileOf({ ...VIDEO_TTS_DEFAULTS, provider: 'openai', model: 'tts-model', voice: 'anna', speed: 0.9 });
  assert.deepEqual(parseVoiceProfile(api), { provider: 'openai', baseUrl: VIDEO_TTS_DEFAULTS.baseUrl, model: 'tts-model', voice: 'anna', speed: 0.9 });
  assert.equal(parseVoiceProfile(''), null);
  assert.equal(parseVoiceProfile('{"provider":"unknown"}'), null);
  assert.match(describeVoiceProfile(parseVoiceProfile(system)), /Huihui.*语速 \+1/);
});
