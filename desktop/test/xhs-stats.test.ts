import test from 'node:test';
import assert from 'node:assert/strict';
import type { XhsNote, XhsNoteStat } from '../shared.ts';
import {
  analyticsDigest, auditMetrics, buildXhsAnalytics, emptyXhsMetrics, funnelValues, matchXhsNote, parseAuditNotes, parseRate, parseSeconds, parseXhsCount, tableToXhsStats
} from '../services/xhs-stats.ts';

test('数值、比率与时长解析', () => {
  assert.equal(parseXhsCount('1.2万'), 12000);
  assert.equal(parseXhsCount('3w'), 30000);
  assert.equal(parseXhsCount('1,234'), 1234);
  assert.equal(parseXhsCount('-'), null);
  assert.equal(parseRate('8.5%'), 0.085);
  assert.equal(parseRate('0.12'), 0.12);
  assert.equal(parseRate('12'), 0.12);
  assert.equal(parseSeconds('1分5秒'), 65);
  assert.equal(parseSeconds('00:01:05'), 65);
  assert.equal(parseSeconds('12秒'), 12);
  assert.equal(parseSeconds('8.5s'), 8.5);
  assert.equal(parseSeconds('--'), null);
});

test('创作者中心导出表 → 记录：跳过说明行，比率列不被计数列抢走，同篇取最大值', () => {
  const table = [
    ['笔记数据明细', '', ''],
    ['笔记标题', '首次发布时间', '体裁', '曝光', '观看量', '封面点击率', '点赞', '评论', '收藏', '涨粉', '分享', '人均观看时长'],
    ['冬天护膝怎么选', '2026-10-08 10:00', '图文', '12000', '1,500', '12.5%', '200', '30', '180', '12', '9', '35秒'],
    ['冬天护膝怎么选', '2026-10-08', '图文', '9000', '1,100', '12.0%', '150', '20', '100', '8', '5', '30秒'],
    ['合计', '', '', '1', '1', '', '', '', '', '', '', '']
  ];
  const rows = tableToXhsStats(table);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publishDate, '2026-10-08');
  assert.deepEqual(rows[0].metrics, { impressions: 12000, views: 1500, ctr: 0.125, avgViewSeconds: 35, completion: null, likes: 200, comments: 30, collects: 180, shares: 9, follows: 12 });
  assert.throws(() => tableToXhsStats([['日期', '曝光']]), /笔记标题/);
  assert.throws(() => tableToXhsStats([['笔记标题', '备注', '体裁'], ['a', 'b', 'c']]), /数据列/);
});

function stat(id: number, title: string, metrics: Partial<ReturnType<typeof emptyXhsMetrics>>, publishDate = `2026-10-${String(id).padStart(2, '0')}`): XhsNoteStat {
  return { id, accountId: 1, title, publishDate, metrics: { ...emptyXhsMetrics(), ...metrics }, noteId: null, importedAt: '' };
}

test('漏斗：每层取值，点击率缺列时用观看 / 曝光', () => {
  const values = funnelValues({ ...emptyXhsMetrics(), impressions: 1000, views: 100, likes: 10, comments: 5, collects: 8, shares: 2, follows: 1 });
  assert.equal(values.exposure, 1000);
  assert.equal(values.click, 0.1);
  assert.equal(values.engagement, 0.15);
  assert.equal(values.save, 0.1);
  assert.equal(values.follow, 0.01);
  assert.equal(values.depth, null);
});

test('归因：第一个明显低于中位数的层是卡点；多数卡在同一层才算账号主要卡点', () => {
  const normal = { impressions: 10000, views: 1000, likes: 100, comments: 10, collects: 80, shares: 10, follows: 10 };
  const lowClick = { ...normal, views: 300, likes: 30, comments: 3, collects: 24, shares: 3, follows: 3 };
  const lowExposure = { ...normal, impressions: 2000, views: 200, likes: 20, comments: 2, collects: 16, shares: 2, follows: 2 };
  const view = buildXhsAnalytics([stat(1, 'a', normal), stat(2, 'b', normal), stat(3, 'c', lowClick), stat(4, 'd', lowClick), stat(5, 'e', lowExposure)]);
  const byTitle = Object.fromEntries(view.rows.map(row => [row.stat.title, row]));
  assert.equal(byTitle.a.weakest, '');
  assert.equal(byTitle.c.weakest, 'click');
  assert.equal(byTitle.e.weakest, 'exposure', '曝光卡住时不再往下看');
  assert.equal(view.layerCounts.click, 2);
  assert.equal(view.dominant, 'click');
  assert.equal(view.rows[0].stat.title, 'e', '按发布日期倒序');
  assert.match(analyticsDigest(view), /主要卡点：点击/);
  // 少于 3 篇不做横向对比。
  assert.equal(buildXhsAnalytics([stat(1, 'a', normal), stat(2, 'b', lowClick)]).rows.every(row => row.weakest === ''), true);
});

test('记录关联笔记：标题归一化后匹配', () => {
  const notes = [{ id: 7, title: '冬天护膝怎么选？', updatedAt: '2026-10-01' }, { id: 8, title: '别的', updatedAt: '2026-10-02' }] as XhsNote[];
  assert.equal(matchXhsNote('冬天 护膝怎么选?', notes)?.id, 7);
  assert.equal(matchXhsNote('', notes), null);
});

test('诊断指标：互动率、爆款率、更新节奏', () => {
  const metrics = auditMetrics({
    target: 'self', name: 'x', bio: '', fans: 1000, follows: 0, likesAndCollects: 0, coverNote: '',
    notes: [
      { title: 'a', liked: 50, collected: 30, comments: 20, date: '2026-10-01', isVideo: false },
      { title: 'b', liked: 40, collected: 40, comments: 20, date: '2026-10-04', isVideo: false },
      { title: 'c', liked: 400, collected: 300, comments: 100, date: '2026-10-15', isVideo: false }
    ]
  });
  assert.equal(metrics.noteCount, 3);
  assert.equal(metrics.medianInteractions, 100);
  assert.equal(metrics.interactionRate, 0.333);
  assert.equal(metrics.hitRate, 0.33);
  assert.equal(metrics.longestGapDays, 11);
  assert.equal(metrics.postsPerWeek, 1.5);
});

test('粘贴的笔记列表解析', () => {
  const notes = parseAuditNotes('膝盖疼别急着贴膏药 | 1200 | 860 | 45 | 2026-10-08\n冬天泡脚\t300\t210\n\n视频：八段锦 | 1.2万 | 3000 | 100 | 2026/10/01');
  assert.equal(notes.length, 3);
  assert.deepEqual(notes[0], { title: '膝盖疼别急着贴膏药', liked: 1200, collected: 860, comments: 45, date: '2026-10-08', isVideo: false });
  assert.equal(notes[1].collected, 210);
  assert.equal(notes[2].liked, 12000);
  assert.equal(notes[2].isVideo, true);
});
