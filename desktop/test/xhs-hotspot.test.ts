import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyCount, hotspotCacheKey, isXhsLink, normalizeHotNote, normalizeHotspotQuery, normalizeRedfoxData, parseCount, searchRedfox, type FetchLike } from '../services/xhs-hotspot.ts';

const NOW = new Date(2026, 9, 13, 10, 0, 0);

/** 2026-10-13 实测响应的形状（字段名与类型照抄，内容换成假数据）。 */
const SAMPLE = {
  code: 2000, msg: '成功',
  data: {
    keyword: '护膝', total: 7, pageNum: 1, pageSize: 2, tips: '近 7 天数据较少',
    articles: [
      { id: 'n1', title: '', desc: '冬天护膝怎么选\n三个要点', cover: 'https://img/1.jpg', createTime: '2026-10-08 17:50:27', shareInfoLink: 'https://www.xiaohongshu.com/explore/n1', topicsName: null, authorId: 'a1', authorNickname: '膝盖小课堂', authorFans: 72643, interactiveCount: 3486, likedCount: 2000, collectedCount: 1200, commentsCount: 200, sharedCount: 86, totalScore: 9, relevanceScore: 6, popularityScore: 2, recencyScore: 1 },
      { id: 'n1', title: '重复的一条', likedCount: 1 },
      { title: '没有 id 的条目' }
    ],
    latestHotArticles: [{ id: 'n9', title: '近期热门', likedCount: '1.2w', collectedCount: '5000+' }],
    relatedSearches: [{ articleCount: 627, keyword: '护膝关节' }, { articleCount: 1, keyword: '' }],
    hotTopics: [{ articleCount: 1142, topic: '搞笑', totalInteractiveCount: 15335810 }]
  }
};

function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>): { fetch: FetchLike; calls: Array<{ headers: Record<string, string>; body: string }> } {
  const calls: Array<{ headers: Record<string, string>; body: string }> = [];
  return {
    calls,
    fetch: async (_url, init) => {
      calls.push({ headers: init.headers, body: init.body });
      const next = responses.shift();
      if (!next) throw new Error('unexpected call');
      if (next instanceof Error) throw next;
      return { status: next.status, text: async () => typeof next.body === 'string' ? next.body : JSON.stringify(next.body) };
    }
  };
}
const noSleep = async () => {};

test('只放行小红书 https 链接', () => {
  assert.equal(isXhsLink('https://www.xiaohongshu.com/explore/n1'), true);
  assert.equal(isXhsLink('https://xhslink.com/m/abc'), true);
  assert.equal(isXhsLink('http://www.xiaohongshu.com/explore/n1'), false);
  assert.equal(isXhsLink('https://evil-xiaohongshu.com/'), false);
  assert.equal(isXhsLink('https://xiaohongshu.com.evil.io/'), false);
  assert.equal(isXhsLink('not a url'), false);
});

test('查询归一化：默认近 7 天、条数夹在 1~50、日期格式校验', () => {
  assert.deepEqual(normalizeHotspotQuery({ keyword: '  中老年   养生 ' }, NOW), { keyword: '中老年 养生', startDate: '2026-10-06', endDate: '', pageSize: 20 });
  assert.equal(normalizeHotspotQuery({ keyword: '', pageSize: 999 }, NOW).pageSize, 50);
  assert.equal(normalizeHotspotQuery({ keyword: '', pageSize: 0 }, NOW).pageSize, 1);
  assert.throws(() => normalizeHotspotQuery({ keyword: 'x', startDate: '2026/10/01' }, NOW), /yyyy-MM-dd/);
  assert.throws(() => normalizeHotspotQuery({ keyword: 'x', startDate: '2026-10-09', endDate: '2026-10-01' }, NOW), /不能晚于/);
  const key = hotspotCacheKey(normalizeHotspotQuery({ keyword: '护膝' }, NOW));
  assert.equal(key, hotspotCacheKey(normalizeHotspotQuery({ keyword: ' 护膝 ', pageSize: 20 }, NOW)));
  assert.notEqual(key, hotspotCacheKey(normalizeHotspotQuery({ keyword: '护膝', pageSize: 10 }, NOW)));
});

test('互动数解析与模糊化', () => {
  assert.equal(parseCount('1.2w'), 12000);
  assert.equal(parseCount('5000+'), 5000);
  assert.equal(parseCount('3万'), 30000);
  assert.equal(parseCount(null), 0);
  assert.equal(parseCount('abc'), 0);
  assert.equal(fuzzyCount(4999), '4999');
  assert.equal(fuzzyCount(5000), '5000+');
  assert.equal(fuzzyCount(25000), '2w+');
  assert.equal(fuzzyCount(0), '--');
});

test('笔记归一化：空标题取正文前 30 字，无 id 丢弃，缺评分为 null', () => {
  const note = normalizeHotNote(SAMPLE.data.articles[0])!;
  assert.equal(note.title, '冬天护膝怎么选 三个要点');
  assert.deepEqual(note.topics, []);
  assert.deepEqual(note.author, { id: 'a1', nickname: '膝盖小课堂', fans: 72643 });
  assert.deepEqual(note.score, { total: 9, relevance: 6, popularity: 2, recency: 1 });
  assert.equal(normalizeHotNote({ title: 'x' }), null);
  const bare = normalizeHotNote({ id: 'z', likedCount: 3, collectedCount: 2 })!;
  assert.equal(bare.score, null);
  assert.equal(bare.interactive, 5, '缺总互动数时用各项相加');
  assert.equal(bare.link, 'https://www.xiaohongshu.com/explore/z');
});

test('结果归一化：去重、拓词与话题过滤空项', () => {
  const result = normalizeRedfoxData(SAMPLE.data, normalizeHotspotQuery({ keyword: '护膝' }, NOW), NOW.toISOString());
  assert.equal(result.notes.length, 1);
  assert.equal(result.total, 7);
  assert.equal(result.latest[0].liked, 12000);
  assert.deepEqual(result.relatedSearches, [{ keyword: '护膝关节', count: 627 }]);
  assert.deepEqual(result.hotTopics, [{ topic: '搞笑', count: 1142, interactive: 15335810 }]);
  assert.equal(result.tips, '近 7 天数据较少');
  assert.equal(result.cached, false);
});

test('searchRedfox 发 UTF-8 JSON 与 X-API-KEY', async () => {
  const fake = fakeFetch([{ status: 200, body: SAMPLE }]);
  const result = await searchRedfox({ keyword: '护膝' }, { apiKey: 'k-1', fetch: fake.fetch, sleep: noSleep, now: () => NOW });
  assert.equal(result.notes[0].id, 'n1');
  assert.equal(fake.calls[0].headers['X-API-KEY'], 'k-1');
  assert.deepEqual(JSON.parse(fake.calls[0].body), { keyword: '护膝', pageNum: 1, pageSize: 20, startDate: '2026-10-06', endDate: '', source: 'Sydney' });
});

test('缺 key 时不发请求', async () => {
  const fake = fakeFetch([]);
  await assert.rejects(searchRedfox({ keyword: 'x' }, { apiKey: ' ', fetch: fake.fetch }), /还没有配置红狐 API Key/);
  assert.equal(fake.calls.length, 0);
});

test('401 与业务错误不重试，原样给出可读提示', async () => {
  const unauthorized = fakeFetch([{ status: 401, body: 'no' }]);
  await assert.rejects(searchRedfox({ keyword: 'x' }, { apiKey: 'k', fetch: unauthorized.fetch, sleep: noSleep }), /无效或已过期.*redfox\.hk\/settings\/api-keys/);
  assert.equal(unauthorized.calls.length, 1);
  const business = fakeFetch([{ status: 200, body: { code: 500, msg: '请求异常' } }]);
  await assert.rejects(searchRedfox({ keyword: 'x' }, { apiKey: 'k', fetch: business.fetch, sleep: noSleep }), /红狐返回错误：请求异常/);
  assert.equal(business.calls.length, 1);
});

test('网络错误与 5xx 指数退避重试，成功即返回', async () => {
  const waits: number[] = [];
  const fake = fakeFetch([new Error('ECONNRESET'), { status: 502, body: '' }, { status: 200, body: SAMPLE }]);
  const result = await searchRedfox({ keyword: '护膝' }, { apiKey: 'k', fetch: fake.fetch, sleep: async ms => { waits.push(ms); } });
  assert.equal(result.notes.length, 1);
  assert.deepEqual(waits, [1000, 2000]);
});

test('重试用尽后报最后一次错误', async () => {
  const fake = fakeFetch([new Error('down'), new Error('down'), new Error('still down')]);
  await assert.rejects(searchRedfox({ keyword: 'x' }, { apiKey: 'k', fetch: fake.fetch, sleep: noSleep }), /still down（已重试 3 次）/);
});
