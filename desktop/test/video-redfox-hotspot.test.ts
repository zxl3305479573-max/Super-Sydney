import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIDEO_REDFOX_ENDPOINTS, buildVideoRedfoxBody, normalizeVideoRedfoxData, searchVideoRedfox, type VideoRedfoxOptions
} from '../services/video-redfox-hotspot.ts';
import { normalizeHotspotQuery, type FetchLike } from '../services/xhs-hotspot.ts';

const NOW = new Date(2026, 9, 18, 10, 0, 0);
const normalized = normalizeHotspotQuery({ keyword: '控糖早餐', pageSize: 10 }, NOW);
const noSleep = async () => {};

function fakeFetch(status: number, body: unknown): { fetch: FetchLike; calls: Array<{ url: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
    }
  };
}

test('三个视频平台使用各自的红狐接口和请求字段', () => {
  assert.equal(VIDEO_REDFOX_ENDPOINTS.douyin, 'https://redfox.hk/story/api/dy/data/searchWork');
  assert.equal(VIDEO_REDFOX_ENDPOINTS.shipinhao, 'https://redfox.hk/story/api/sphAllData/searchWork');
  assert.equal(VIDEO_REDFOX_ENDPOINTS.bilibili, 'https://redfox.hk/story/api/bili/data/workSearch');
  assert.deepEqual(buildVideoRedfoxBody('douyin', normalized), {
    keyword: '控糖早餐', exactMatch: false, startDate: '2026-10-11', endDate: '', pageNum: 1, pageSize: 10
  });
  assert.deepEqual(buildVideoRedfoxBody('shipinhao', normalized), {
    keyword: '控糖早餐', sort: '最多点赞', page: 1, size: 10, exactMatch: false
  });
  assert.deepEqual(buildVideoRedfoxBody('bilibili', normalized), {
    keyword: '控糖早餐', exactMatch: false, page: '1', pageSize: 10, order: 'play'
  });
});

test('抖音、视频号、B 站的结果归一化为统一选题条目', () => {
  const douyin = normalizeVideoRedfoxData('douyin', {
    list: [{
      videoId: 'dy1', content: '早餐先吃鸡蛋还是先喝粥？三个控糖细节 #控糖 #早餐', coverUrl: 'https://img/dy.jpg',
      opusUrl: 'https://www.iesdouyin.com/share/video/dy1', publishTime: '2026-10-17 08:00:00',
      authorUid: 'a1', authorName: '早餐研究所', likeCount: 1200, collectCount: 300, commentCount: 80, shareCount: 20,
      tagList: [{ tagId: '1', tagName: '控糖' }]
    }],
    total: 9
  }, normalized, NOW.toISOString());
  assert.equal(douyin.notes[0].id, 'douyin-dy1');
  assert.equal(douyin.notes[0].interactive, 1600);
  assert.deepEqual(douyin.notes[0].topics, ['控糖', '早餐']);
  assert.equal(douyin.total, 9);

  const shipinhao = normalizeVideoRedfoxData('shipinhao', {
    list: [{
      videoId: 'sph1', description: '膝关节保养的三个动作 #膝关节 #中老年健康', coverUrl: 'https://img/sph.jpg',
      videoUrl: 'https://finder.video/sph1', publishTime: '2026-10-16 09:00:00', nickname: '膝盖小课堂',
      likeCount: 20, favCount: 8, commentCount: 3, forwardCount: 2, topic: '["膝关节","中老年健康"]'
    }],
    total: 1
  }, normalized, NOW.toISOString());
  assert.equal(shipinhao.notes[0].id, 'shipinhao-sph1');
  assert.equal(shipinhao.notes[0].interactive, 33);
  assert.deepEqual(shipinhao.notes[0].topics, ['膝关节', '中老年健康']);

  const bilibili = normalizeVideoRedfoxData('bilibili', {
    workList: [{
      bvId: 'BV1demo', title: '控糖早餐怎么搭配', description: '三个搭配原则', picUrl: 'https://img/bili.jpg',
      created: '2026-10-15 10:00:00', author: '营养师小林', authorId: '42', likeCount: 100,
      favoriteCount: 40, commentCount: 10, shareCount: 5, interactionQuantity: 155, tagNames: ['控糖', '早餐']
    }],
    total: 1
  }, normalized, NOW.toISOString());
  assert.equal(bilibili.notes[0].link, 'https://www.bilibili.com/video/BV1demo');
  assert.equal(bilibili.notes[0].interactive, 155);
  assert.deepEqual(bilibili.notes[0].topics, ['控糖', '早餐']);
});

test('红狐视频请求带鉴权头和 JSON 请求体', async () => {
  const fake = fakeFetch(200, {
    code: 2000,
    data: { list: [{ videoId: 'dy1', content: '控糖早餐', likeCount: 3 }], total: 1 }
  });
  const options: VideoRedfoxOptions = { apiKey: 'k-1', fetch: fake.fetch, sleep: noSleep, now: () => NOW };
  const result = await searchVideoRedfox('douyin', { keyword: '控糖早餐', pageSize: 10 }, options);
  assert.equal(result.notes[0].title, '控糖早餐');
  assert.equal(fake.calls[0].url, VIDEO_REDFOX_ENDPOINTS.douyin);
  assert.equal(fake.calls[0].headers['X-API-KEY'], 'k-1');
  assert.equal(fake.calls[0].headers.REDFOX_API_KEY, 'k-1');
  assert.equal(JSON.parse(fake.calls[0].body).keyword, '控糖早餐');
});

test('未开放或无权限的接口给出可读错误', async () => {
  const missing = fakeFetch(404, 'not found');
  await assert.rejects(
    searchVideoRedfox('shipinhao', { keyword: '护膝' }, { apiKey: 'k', fetch: missing.fetch, sleep: noSleep }),
    /即将上线.*联网搜索/
  );
  const forbidden = fakeFetch(403, 'no');
  await assert.rejects(
    searchVideoRedfox('bilibili', { keyword: '护膝' }, { apiKey: 'k', fetch: forbidden.fetch, sleep: noSleep }),
    /没有该平台选题接口权限/
  );
});
