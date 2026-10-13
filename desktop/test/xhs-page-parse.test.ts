import test from 'node:test';
import assert from 'node:assert/strict';
import { bingSearchUrls, isXhsHost, normalizePageRead, normalizeWebResults } from '../services/xhs-page-parse.ts';
import { escapeHtml, renderCardDocument, renderCardsPreview } from '../services/xhs-cards.ts';

/** 样本按 2026-10 网页版小红书实际抽取到的形状构造（内容替换过）。 */
const FEED = {
  url: 'https://www.xiaohongshu.com/explore',
  loginWall: false, captcha: false,
  cards: [
    { href: 'https://www.xiaohongshu.com/explore/6a74106b00000000250107b5?xsec_token=abc', title: '冬天护膝怎么选', author: '膝盖小课堂', authorHref: 'https://www.xiaohongshu.com/user/profile/62e7b854000000001f015710?x=1', likes: '1万', cover: 'https://img/1.jpg', video: false },
    { href: 'https://www.xiaohongshu.com/explore/6a74106b00000000250107b5?xsec_token=dup', title: '重复', likes: '1' },
    { href: 'https://evil.example/explore/6aacaaed00000000290185a9', title: '外站链接' },
    { href: 'https://www.xiaohongshu.com/explore/6aacaaed00000000290185a9', title: '', likes: '1294', video: true }
  ],
  profile: null
};

test('发现页 / 搜索页：按笔记 id 去重，只收小红书链接，点赞按「1万」解析', () => {
  const page = normalizePageRead(FEED);
  assert.equal(page.kind, 'feed');
  assert.equal(page.notes.length, 2);
  assert.equal(page.notes[0].id, '6a74106b00000000250107b5');
  assert.equal(page.notes[0].liked, 10000);
  assert.equal(page.notes[0].author.id, '62e7b854000000001f015710');
  assert.equal(page.notes[1].title, '无标题');
  assert.deepEqual(page.notes[1].topics, ['视频']);
  assert.equal(normalizePageRead({ ...FEED, url: 'https://www.xiaohongshu.com/search_result?keyword=x' }).kind, 'search');
});

test('主页：读出名称、小红书号与「10+ 粉丝」这类下限值', () => {
  const page = normalizePageRead({ ...FEED, url: 'https://www.xiaohongshu.com/user/profile/62e7', loginWall: true,
    profile: { name: '小栗山花', redId: '小红书号：3860652552', bio: '还没有简介', interactions: ['4 关注', '10+ 粉丝', '1万+ 获赞与收藏'] } });
  assert.equal(page.kind, 'profile');
  assert.deepEqual(page.profile, { name: '小栗山花', redId: '3860652552', bio: '还没有简介', fans: 10, follows: 4, likesAndCollects: 10000 });
});

test('未登录的主页卡片没有笔记 id：按标题生成 id，链接指回主页；登录后的主页链接能取到 id', () => {
  const url = 'https://www.xiaohongshu.com/user/profile/62e7b854000000001f015710';
  const page = normalizePageRead({ url, loginWall: true, cards: [
    { href: 'https://www.xiaohongshu.com/explore/', title: '其实当保洁还挺好的', likes: '7' },
    { href: 'https://www.xiaohongshu.com/explore/', title: '其实当保洁还挺好的', likes: '7' },
    { href: 'https://www.xiaohongshu.com/user/profile/62e7b854000000001f015710/6a74106b00000000250107b5?xsec_token=x', title: '登录后', likes: '56' }
  ], profile: { name: '小栗山花', interactions: [] } });
  assert.equal(page.notes.length, 2);
  assert.match(page.notes[0].id, /^page-/);
  assert.equal(page.notes[0].link, url);
  assert.equal(page.notes[1].id, '6a74106b00000000250107b5');
});

test('登录墙且没有内容、验证页、什么都没读到时报错', () => {
  assert.throws(() => normalizePageRead({ url: 'https://www.xiaohongshu.com/search_result', loginWall: true, cards: [] }), /需要登录/);
  assert.throws(() => normalizePageRead({ ...FEED, captcha: true }), /安全验证/);
  assert.throws(() => normalizePageRead({ url: 'https://www.xiaohongshu.com/', cards: [] }), /没有读到/);
});

test('只把 https 的小红书域名当成小红书页面', () => {
  assert.equal(isXhsHost('https://www.xiaohongshu.com/explore'), true);
  assert.equal(isXhsHost('http://www.xiaohongshu.com/explore'), false);
  assert.equal(isXhsHost('https://xiaohongshu.com.evil.io/'), false);
});

test('联网搜索：提出摘要里的日期、按链接去重、标记热度未知', () => {
  const notes = normalizeWebResults([
    { title: '中老年赛道小红书批量出稿', url: 'https://www.sohu.com/a/1', snippet: '2026年2月21日 · 火兔工具箱的一键采集…' },
    { title: '重复', url: 'https://www.sohu.com/a/1', snippet: '' },
    { title: '没有链接', url: 'javascript:alert(1)' },
    { title: '', url: 'https://x.com' }
  ]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].createTime, '2026-02-21');
  assert.equal(notes[0].desc, '火兔工具箱的一键采集…');
  assert.equal(notes[0].author.nickname, 'sohu.com');
  assert.equal(notes[0].unverified, true);
  assert.match(notes[0].id, /^web-/);
  assert.equal(bingSearchUrls('护膝').length, 2);
  assert.match(decodeURIComponent(bingSearchUrls('护膝')[0]), /小红书 护膝 爆款笔记/);
});

test('卡片模板：转义内容、页码与尺寸、预览含全部页', () => {
  const plan = { style: 'mono', pages: [{ heading: '<b>总览</b>', points: ['a & b'], emphasis: '' }, { heading: '要点', points: ['1', '2'], emphasis: '记住' }] };
  const html = renderCardDocument(plan, 0, '标题"x"');
  assert.match(html, /&lt;b&gt;总览&lt;\/b&gt;/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /1\/2/);
  assert.match(html, /width:1080px;height:1440px/);
  assert.match(html, /#E0313B/, '用所选风格的强调色');
  assert.throws(() => renderCardDocument(plan, 5, 't'), /不存在/);
  assert.equal((renderCardsPreview(plan, 't').match(/class="frame"/g) ?? []).length, 2);
  assert.equal(escapeHtml(`'"`), '&#39;&quot;');
});
