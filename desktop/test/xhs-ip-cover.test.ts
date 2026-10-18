import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { IpRenderKit } from '../shared.ts';
import {
  XHS_IP_COVER_TEMPLATES, defaultIpCoverTemplate, emptyIpCoverInput, ipCoverPose, normalizeIpCoverInput, renderIpCoverDocument
} from '../services/xhs-ip-cover.ts';
import { listXhsAccounts, migrateXhsTables, updateXhsAccount } from '../services/xhs-store.ts';

const KIT: IpRenderKit = {
  id: 'k1', name: '某某的一人公司', tagline: '一个人也是团队',
  colors: { primary: '#112233', accent: '#FFEE00', secondary: '#00AA55' },
  avatar: 'data:image/png;base64,AV',
  poses: [
    { id: 'p1', label: '打字', src: 'data:image/png;base64,TY' },
    { id: 'p2', label: '指向', src: 'data:image/png;base64,PO' },
    { id: 'p3', label: '团队', src: 'data:image/png;base64,TE' }
  ]
};

test('三种模板都能出完整文档：尺寸、配色、角色图都取自 IP，不放头像和品牌名', () => {
  for (const { key } of XHS_IP_COVER_TEMPLATES) {
    const html = renderIpCoverDocument({ ...emptyIpCoverInput(key, '我开了一家|只有我一个人的公司'), steps: ['选题', '写作'], bubble: '老板好！' }, KIT);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /width:1080px;height:1440px/);
    assert.match(html, /只有我一个人的公司/);
    assert.ok(!html.includes('class="brand"') && !html.includes(KIT.avatar) && !html.includes('某某的一人公司'), '不放头像和品牌名');
    assert.ok(html.includes('#112233') && html.includes('#FFEE00'), '配色来自 IP');
    assert.ok(!html.includes('雪梨'), '模板里不能写死具体 IP');
  }
  const tutorial = renderIpCoverDocument({ ...emptyIpCoverInput('tutorial', '标题'), steps: ['选题', '写作', '配图'] }, KIT);
  assert.ok(tutorial.includes('base64,TY') && tutorial.includes('<span>② 写作</span>'));
  const list = renderIpCoverDocument({ ...emptyIpCoverInput('list', '标题'), number: '10', unit: '个' }, KIT);
  assert.ok(list.includes('base64,PO') && list.includes('10<small>个</small>') && list.includes('建议<br>收藏'));
  const recap = renderIpCoverDocument({ ...emptyIpCoverInput('recap', '标题'), bubble: '老板好！' }, KIT);
  assert.ok(recap.includes('base64,TE') && recap.includes('<div class="bubble">老板好！</div>'));
});

test('角色图：用户指定的优先，否则按动作名挑，名字对不上按位置兜底', () => {
  assert.equal(ipCoverPose({ ...emptyIpCoverInput('recap'), pose: 'p1' }, KIT)?.id, 'p1');
  assert.equal(ipCoverPose(emptyIpCoverInput('list'), KIT)?.id, 'p2');
  const unnamed: IpRenderKit = { ...KIT, poses: KIT.poses.map((pose, index) => ({ ...pose, label: `动作${index}` })) };
  assert.equal(ipCoverPose(emptyIpCoverInput('recap'), unnamed)?.id, 'p3');
  const single: IpRenderKit = { ...KIT, poses: [KIT.poses[0]] };
  assert.equal(ipCoverPose(emptyIpCoverInput('recap'), single)?.id, 'p1');
  // 没有角色图也能出图，只是少了对应元素
  const bare = renderIpCoverDocument({ ...emptyIpCoverInput('recap', '标题'), tag: '' }, { ...KIT, name: ' ', avatar: '', poses: [] });
  assert.ok(!bare.includes('class="brand"') && !bare.includes('class="hero"') && !bare.includes('class="bubble"') && !bare.includes('class="tag"'));
});

test('用户输入与 IP 名称都转义，不能注入标签', () => {
  const html = renderIpCoverDocument({ ...emptyIpCoverInput('recap', '<script>x</script>'), sub: '"><img>', bubble: '<i>' }, { ...KIT, name: '<b>牌</b>' });
  assert.ok(!html.includes('<script>') && !html.includes('<img>') && !html.includes('<i>') && !html.includes('<b>牌'));
});

test('IPC 输入规整：未知模板拒绝，字段截断，步骤最多 5 条', () => {
  assert.throws(() => normalizeIpCoverInput({ template: 'poster', title: 'x' }), /没有这个封面模板/);
  assert.throws(() => normalizeIpCoverInput(null), /没有这个封面模板/);
  const clean = normalizeIpCoverInput({ template: 'tutorial', title: ` ${'长'.repeat(100)} `, steps: ['a', '', 'b', 'c', 'd', 'e', 'f', 3], number: 12345678, pose: 'p2', extra: 1 });
  assert.equal(clean.title.length, 60);
  assert.deepEqual(clean.steps, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(clean.number, '1234');
  assert.equal(clean.pose, 'p2');
  assert.ok(!('extra' in clean));
});

test('默认模板按笔记类型选', () => {
  assert.equal(defaultIpCoverTemplate('list'), 'list');
  assert.equal(defaultIpCoverTemplate('recap'), 'recap');
  assert.equal(defaultIpCoverTemplate('story'), 'recap');
  assert.equal(defaultIpCoverTemplate('tutorial'), 'tutorial');
  assert.equal(defaultIpCoverTemplate('share'), 'tutorial');
});

test('账号上记着选用的 IP：默认不使用，可读写', () => {
  const db = new DatabaseSync(':memory:');
  migrateXhsTables(db);
  migrateXhsTables(db);
  const [account] = listXhsAccounts(db);
  assert.equal(account.ipId, '');
  assert.equal(updateXhsAccount(db, account.id, { ipId: ' sydney ' }).ipId, 'sydney');
  assert.equal(updateXhsAccount(db, account.id, { name: '改名' }).ipId, 'sydney');
  assert.equal(updateXhsAccount(db, account.id, { ipId: '' }).ipId, '');
});

test('图文卡片：选了 IP 时每页右下角放角色、各页轮流换动作；没选 IP 时和以前一样', async () => {
  const { cardDensity, cardMascotIndex, renderCardDocument, renderCardsPreview } = await import('../services/xhs-cards.ts');
  const plan = { style: '', pages: [0, 1, 2, 3].map(index => ({ heading: `第 ${index + 1} 页`, points: ['要点一', '要点二'], emphasis: '' })) };
  const plain = renderCardDocument(plan, 1, '标题');
  assert.equal(renderCardDocument(plan, 1, '标题', null), plain);
  assert.ok(!plain.includes('ip-mascot') && !plain.includes('with-ip'));
  const withIp = renderCardDocument(plan, 1, '标题', KIT);
  assert.ok(withIp.includes('<div class="ip-mascot ip-m1"></div>') && withIp.includes('with-ip'));
  assert.ok(withIp.includes('base64,PO') && !withIp.includes('base64,TY'), '单页文档只带这一页用到的角色图');
  assert.ok(!withIp.includes('某某的一人公司') && !withIp.includes(KIT.avatar), '不放头像和品牌名');
  assert.deepEqual([0, 1, 2, 3].map(index => cardMascotIndex(KIT, index)), [0, 1, 2, 0]);
  assert.equal(cardMascotIndex({ ...KIT, poses: [] }, 0), -1);
  const preview = renderCardsPreview(plan, '标题', 0.24, KIT);
  assert.equal(preview.split('base64,TY').length - 1, 1, '预览里同一个角色图只写一次');
  // 让出底部后版面变小，内容多的页更早换小一号字
  const busy = { heading: '标题', points: Array.from({ length: 3 }, () => '一'.repeat(16)), emphasis: '' };
  assert.equal(cardDensity(busy, false), '');
  assert.equal(cardDensity(busy, false, true), 'dense');
});
