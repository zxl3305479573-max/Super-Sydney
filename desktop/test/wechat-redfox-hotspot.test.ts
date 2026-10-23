import test from 'node:test';
import assert from 'node:assert/strict';
import type { XhsHotspotQuery } from '../shared.ts';
import {
  normalizeWechatRedfoxData,
  normalizeWechatRedfoxNote,
  searchWechatRedfox,
  WECHAT_REDFOX_ENDPOINTS,
  wechatTopicKeyword,
  type WechatRedfoxOptions
} from '../services/wechat-redfox-hotspot.ts';
import { normalizeHotspotQuery, type FetchLike } from '../services/xhs-hotspot.ts';

const sample = {
  workUuid: 'W-1',
  title: '冬天早餐怎么吃更稳',
  summary: '从蛋白质、主食和蔬菜搭配讲清楚早餐结构。',
  workUrl: 'https://mp.weixin.qq.com/s/example',
  publishTime: '2026-10-20 08:30:00',
  accountId: 'acct-1',
  userName: '健康早餐研究所',
  readCount: 52000,
  watchCount: 800,
  likeCount: 1200,
  commentCount: 90,
  collectCount: 600,
  shareCount: 240,
  accountType: '健康养生'
};

test('红狐公众号结果归一化为公众号阅读、互动和采用所需字段', () => {
  const note = normalizeWechatRedfoxNote(sample);
  assert.equal(note?.title, '冬天早餐怎么吃更稳');
  assert.equal(note?.readCount, 52000);
  assert.equal(note?.interactive, 2930);
  assert.deepEqual(note?.topics, ['健康养生']);
  assert.equal(note?.author.nickname, '健康早餐研究所');

  const query = normalizeHotspotQuery({ keyword: '早餐', startDate: '2026-10-15', endDate: '2026-10-22', pageSize: 10 }, new Date('2026-10-22T10:00:00+08:00'));
  const result = normalizeWechatRedfoxData({ total: 1, list: [sample] }, query, '2026-10-22T02:00:00Z', 'premium');
  assert.equal(result.source, 'redfox');
  assert.equal(result.notes[0].readCount, 52000);
  assert.match(result.tips, /优质库/);
});

test('优质库无权限时自动改用红狐公众号广域库', async () => {
  const calls: string[] = [];
  const fetch: FetchLike = async url => {
    calls.push(url);
    if (url === WECHAT_REDFOX_ENDPOINTS[0].url) return { status: 403, text: async () => '{"code":403}' };
    return { status: 200, text: async () => JSON.stringify({ code: 2000, data: { total: 1, list: [sample] } }) };
  };
  const options: WechatRedfoxOptions = {
    apiKey: 'redfox-key',
    fetch,
    now: () => new Date('2026-10-22T02:00:00Z'),
    maxRetries: 1
  };
  const result = await searchWechatRedfox({
    keyword: '早餐',
    startDate: '2026-10-15',
    endDate: '2026-10-22',
    pageSize: 10
  }, options);
  assert.equal(result.notes.length, 1);
  assert.deepEqual(calls, [WECHAT_REDFOX_ENDPOINTS[0].url, WECHAT_REDFOX_ENDPOINTS[1].url]);
  assert.match(result.notice ?? '', /已改用广域库/);
});

test('公众号红狐搜索缺 key 不发请求，并用选题方向补足关键词', async () => {
  const query: XhsHotspotQuery = { keyword: '' };
  let called = false;
  await assert.rejects(() => searchWechatRedfox(query, {
    apiKey: '',
    fetch: async () => { called = true; return { status: 200, text: async () => '{}' }; }
  }), /红狐 API Key/);
  assert.equal(called, false);
  assert.equal(wechatTopicKeyword({ topic: '', subdirectionName: '饮食营养与蔬果利弊', directionName: '中老年健康科普' }), '饮食营养与蔬果利弊');
});
