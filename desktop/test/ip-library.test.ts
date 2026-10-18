import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_IP_COLORS, IpLibrary, buildRenderKit, normalizeColors } from '../services/ip-library.ts';
import { ipPalette, mixColor, pickPose, richText, titleFontSize } from '../services/ip-theme.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-ip-'));
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('新建、改名、改配色、删除；同名拒绝', () => {
  const library = new IpLibrary(tempDir());
  const ip = library.create(' 雪梨 ');
  assert.equal(ip.name, '雪梨');
  assert.deepEqual(ip.colors, DEFAULT_IP_COLORS);
  assert.throws(() => library.create('雪梨'), /同名/);
  assert.throws(() => library.create('  '), /不能为空/);
  const other = library.create('小橙');
  assert.throws(() => library.update(other.id, { name: '雪梨' }), /同名/);
  const updated = library.update(ip.id, { tagline: ' 一个人 + AI ', colors: { primary: '#abcdef', accent: 'red', secondary: '#000000' } });
  assert.equal(updated.tagline, '一个人 + AI');
  assert.deepEqual(updated.colors, { primary: '#ABCDEF', accent: DEFAULT_IP_COLORS.accent, secondary: '#000000' });
  library.remove(ip.id);
  assert.deepEqual(library.list().map(item => item.name), ['小橙']);
  assert.ok(!fs.existsSync(library.directory(ip.id)), '删 IP 连素材目录一起删');
  assert.throws(() => library.get(ip.id), /不存在/);
});

test('图片：头像替换旧文件，动作可增删改名，文件名不能穿越目录', () => {
  const library = new IpLibrary(tempDir());
  const ip = library.create('雪梨');
  const first = library.addImage(ip.id, 'avatar', PNG, '.png');
  const second = library.addImage(ip.id, 'avatar', PNG, '.PNG');
  assert.notEqual(first.avatar, second.avatar);
  assert.ok(!fs.existsSync(library.filePathOf(ip.id, first.avatar)), '旧头像文件被删掉');
  assert.ok(fs.existsSync(library.filePathOf(ip.id, second.avatar)));
  assert.throws(() => library.addImage(ip.id, 'pose', PNG, '.gif'), /只支持/);
  library.addImage(ip.id, 'pose', PNG, '.png', '打字');
  const withPoses = library.addImage(ip.id, 'pose', PNG, '.png', '');
  assert.deepEqual(withPoses.poses.map(pose => pose.label), ['打字', '动作 2']);
  const renamed = library.update(ip.id, { poses: [{ id: withPoses.poses[1].id, label: ' 指向 ' }] });
  assert.equal(renamed.poses[1].label, '指向');
  const removed = library.removePose(ip.id, withPoses.poses[0].id);
  assert.deepEqual(removed.poses.map(pose => pose.label), ['指向']);
  assert.ok(!fs.existsSync(library.filePathOf(ip.id, withPoses.poses[0].file)));
  assert.throws(() => library.filePathOf(ip.id, '../library.json'), /文件名不正确/);
  assert.throws(() => library.directory('../x'), /编号不正确/);
});

test('模块选择：记住各模块选的 IP，IP 被删后当作不使用', () => {
  const library = new IpLibrary(tempDir());
  const ip = library.create('雪梨');
  assert.deepEqual(library.selections(), { wechat: '', video: '' });
  library.select('wechat', ip.id);
  library.select('video', ip.id);
  assert.deepEqual(library.selections(), { wechat: ip.id, video: ip.id });
  library.select('video', '');
  assert.throws(() => library.select('wechat', 'nope'), /不存在/);
  assert.throws(() => library.select('xhs' as 'wechat', ip.id), /未知的模块/);
  library.remove(ip.id);
  assert.deepEqual(library.selections(), { wechat: '', video: '' });
});

test('预置 IP 只拷一次：删掉后不会自动回来；同名已存在时不重复建', () => {
  const dir = tempDir();
  const source = path.join(dir, 'src.png');
  fs.writeFileSync(source, PNG);
  const preset = { key: 'sydney', name: '雪梨的一人公司', tagline: '一个人 + AI', colors: DEFAULT_IP_COLORS, avatar: source, poses: [{ label: '打字', file: source }, { label: '团队', file: source }], reference: source };
  const library = new IpLibrary(dir);
  const seeded = library.seed(preset);
  assert.ok(seeded);
  assert.equal(seeded.id, 'sydney');
  assert.equal(seeded.tagline, '一个人 + AI');
  assert.deepEqual(seeded.poses.map(pose => pose.label), ['打字', '团队']);
  assert.ok(seeded.avatar && seeded.reference);
  assert.equal(library.seed(preset), null);
  library.remove('sydney');
  assert.equal(library.seed(preset), null);
  assert.equal(library.list().length, 0);

  const other = new IpLibrary(tempDir());
  other.create('雪梨的一人公司');
  assert.equal(other.seed(preset), null);
  assert.equal(other.list().length, 1);
});

test('库文件损坏时当作空库，不让应用起不来', () => {
  const dir = tempDir();
  const library = new IpLibrary(dir);
  fs.mkdirSync(library.root, { recursive: true });
  fs.writeFileSync(path.join(library.root, 'library.json'), '{坏了');
  assert.deepEqual(library.list(), []);
  assert.equal(library.create('雪梨').name, '雪梨');
});

test('渲染资料：图片走调用方的 loader，模板只拿到 data URI', () => {
  const library = new IpLibrary(tempDir());
  const ip = library.create('雪梨');
  library.addImage(ip.id, 'avatar', PNG, '.png');
  const full = library.addImage(ip.id, 'pose', PNG, '.png', '打字');
  const kit = buildRenderKit(full, file => `data:${file}`);
  assert.equal(kit.name, '雪梨');
  assert.equal(kit.avatar, `data:${full.avatar}`);
  assert.deepEqual(kit.poses, [{ id: full.poses[0].id, label: '打字', src: `data:${full.poses[0].file}` }]);
  assert.equal(buildRenderKit({ ...full, avatar: '' }, file => file).avatar, '');
});

test('配色工具：合法色保留，非法色回退；混色与调色板推导', () => {
  assert.deepEqual(normalizeColors(null), DEFAULT_IP_COLORS);
  assert.equal(mixColor('#000000', '#FFFFFF', 0.5), '#808080');
  assert.equal(mixColor('#22304D', '#FFFFFF', 0), '#22304D');
  const palette = ipPalette({ primary: '#22304D', accent: '#F4E15B', secondary: '#8DBF5A' });
  assert.equal(palette.ink, '#22304D');
  assert.equal(palette.highlight, '#F4E15B');
  assert.match(palette.softSecondary, /^#[0-9A-F]{6}$/);
});

test('标题工具：【】高亮、| 换行、按最长一行算字号', () => {
  assert.equal(richText('第一个月【赚了多少】|全公开'), '第一个月<mark>赚了多少</mark><br>全公开');
  assert.equal(richText('<b>【a&b】</b>'), '&lt;b&gt;<mark>a&amp;b</mark>&lt;/b&gt;');
  assert.equal(titleFontSize('一二三四五六七八九十', 930, 116), 93);
  assert.equal(titleFontSize('短|【一二三四五六七八九十】', 930, 116), 93);
  assert.equal(titleFontSize('我用 AI', 930, 116), 116);
  assert.ok(titleFontSize('A'.repeat(20), 930, 116) > titleFontSize('一'.repeat(20), 930, 116));
});

test('挑角色：按 id、按名字关键词、按位置兜底；没有动作时为 null', () => {
  const poses = [{ id: 'a', label: '打字' }, { id: 'b', label: '指着标题' }, { id: 'c', label: '全员合影' }];
  assert.equal(pickPose(poses, 'c', ['指'])?.id, 'c');
  assert.equal(pickPose(poses, '', ['指'])?.id, 'b');
  assert.equal(pickPose(poses, '', ['合影', '指'])?.id, 'c', '关键词靠前的优先，不按动作排列顺序');
  assert.equal(pickPose(poses, 'gone', ['团队'], 2)?.id, 'c');
  assert.equal(pickPose(poses, '', ['不存在'], 9)?.id, 'c');
  assert.equal(pickPose([], '', ['打字']), null);
});
