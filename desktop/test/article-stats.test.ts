import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { ContentTask } from '../shared.ts';
import { buildStatsView, matchTask, normalizeDate, normalizeTitle, parseCount, tableToStatInputs } from '../services/article-stats.ts';
import { deleteArticleStat, listArticleStats, migrateArticleStatTables, upsertArticleStats } from '../services/article-stats-store.ts';
import { readDelimited, readHtmlTable, readTableFile } from '../services/table-file.ts';

function task(id: number, title: string, publishedAt = '', subdirectionName = '饮食营养'): ContentTask {
  return {
    id, directionId: 1, subdirectionId: 11, directionName: '中老年健康科普', subdirectionName, topic: '', title, status: 'published',
    briefJson: '', claimsJson: '', sourcesJson: '', topicsJson: '', draft: '', finalArticle: '', reviewJson: '', coverPath: '', theme: '',
    publishJson: publishedAt ? JSON.stringify({ mediaId: `m${id}`, publishedAt }) : '', exportPath: '', createdAt: '', updatedAt: ''
  };
}

test('日期与数字归一化', () => {
  assert.equal(normalizeDate('2026/10/1 20:30'), '2026-10-01');
  assert.equal(normalizeDate('2026年10月11日'), '2026-10-11');
  assert.equal(normalizeDate('20261011'), '2026-10-11');
  assert.equal(normalizeDate('46306'), '2026-10-11');
  assert.equal(normalizeDate('1234'), '');
  assert.equal(normalizeDate('2026-13-01'), '');
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('1.2万'), 12000);
  assert.equal(parseCount('-'), null);
  assert.equal(parseCount(''), null);
  assert.equal(parseCount('0'), 0);
});

test('CSV 解析：引号、换行与制表符分隔', () => {
  assert.deepEqual(readDelimited('a,"b,c","d ""e"""\r\n1,"多\n行",3\n'), [['a', 'b,c', 'd "e"'], ['1', '多\n行', '3']]);
  assert.deepEqual(readDelimited('标题\t阅读人数\nx\t5'), [['标题', '阅读人数'], ['x', '5']]);
});

test('表格 → 记录：跳过说明行、识别别名、合并同篇多行、跳过合计', () => {
  const inputs = tableToStatInputs([
    ['内容分析 · 单篇数据'],
    ['文章标题', '发表时间', '送达人数', '阅读人数', '阅读次数', '分享人数', '点赞人数', '在看', '收藏人数'],
    ['冬天吃柿子要注意什么', '2026-10-01', '500', '120', '150', '12', '8', '3', '5'],
    ['冬天吃柿子要注意什么 ', '2026/10/01', '500', '130', '160', '14', '-', '3', '5'],
    ['合计', '2026-10-01', '', '130', '', '', '', '', '']
  ]);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].publishDate, '2026-10-01');
  assert.equal(inputs[0].metrics.readUsers, 130);
  assert.equal(inputs[0].metrics.reads, 160);
  assert.equal(inputs[0].metrics.likes, 8);
  assert.equal(inputs[0].metrics.wows, 3);
  assert.equal(inputs[0].metrics.delivered, 500);
  assert.equal(inputs[0].metrics.comments, null);
});

test('表格 → 记录：缺列时报错并列出实际列名', () => {
  assert.throws(() => tableToStatInputs([['日期', '新增关注'], ['2026-10-01', '3']]), /没有找到"标题"列.*日期、新增关注/);
  assert.throws(() => tableToStatInputs([['标题', '阅读人数'], ['x', '3']]), /缺少发表时间列.*标题、阅读人数/);
  assert.throws(() => tableToStatInputs([['标题', '发表时间', '作者'], ['x', '2026-10-01', 'y']]), /阅读\/分享等数据列/);
});

test('标题匹配：忽略空白与全半角标点，同名时选推草稿日期在前且最近的', () => {
  assert.equal(normalizeTitle('冬天，吃柿子！ '), normalizeTitle('冬天,吃柿子!'));
  const tasks = [task(1, '冬天吃柿子', '2026-09-01T08:00:00Z'), task(2, '冬天吃柿子', '2026-09-28T08:00:00Z'), task(3, '冬天吃柿子', '2026-10-05T08:00:00Z')];
  assert.equal(matchTask({ title: '冬天 吃柿子', publishDate: '2026-10-01' }, tasks)?.id, 2);
  assert.equal(matchTask({ title: '别的文章', publishDate: '2026-10-01' }, tasks), null);
});

test('汇总视图：派生比率、按方向分组、未关联归组', () => {
  const metrics = (readUsers: number, shareUsers: number, likes: number) => ({ readUsers, reads: null, shareUsers, shares: null, likes, wows: null, favorites: null, comments: null, delivered: null, follows: null });
  const view = buildStatsView([
    { id: 1, title: 'A', publishDate: '2026-10-01', metrics: metrics(200, 20, 10), source: 'x', importedAt: '2026-10-12T01:00:00Z' },
    { id: 2, title: 'B', publishDate: '2026-10-02', metrics: metrics(100, 5, 5), source: 'x', importedAt: '2026-10-12T02:00:00Z' },
    { id: 3, title: 'C', publishDate: '2026-10-03', metrics: metrics(50, 0, 1), source: 'x', importedAt: '2026-10-12T01:00:00Z' }
  ], [task(10, 'A'), task(11, 'B', '', '作息')]);
  assert.equal(view.records[0].title, 'C');
  assert.equal(view.records.find(record => record.title === 'A')?.shareRate, 0.1);
  assert.equal(view.overview.matched, 2);
  assert.equal(view.overview.medianReads, 100);
  assert.equal(view.overview.totalReads, 350);
  assert.equal(view.groups[0].name, '中老年健康科普 / 饮食营养');
  assert.ok(view.groups.some(group => group.name === '未关联创作任务'));
  assert.deepEqual(view.availableMetrics, ['readUsers', 'shareUsers', 'likes']);
  assert.equal(view.lastImportedAt, '2026-10-12T02:00:00Z');
});

test('存储：同篇重复导入合并列、null 不覆盖旧值、可删除', () => {
  const db = new DatabaseSync(':memory:');
  migrateArticleStatTables(db);
  const base = { readUsers: 100, reads: null, shareUsers: null, shares: null, likes: null, wows: null, favorites: null, comments: null, delivered: null, follows: null };
  assert.deepEqual(upsertArticleStats(db, [{ title: '冬天吃柿子', publishDate: '2026-10-01', metrics: base }], 'a'), { added: 1, updated: 0 });
  assert.deepEqual(upsertArticleStats(db, [{ title: '冬天 吃柿子', publishDate: '2026-10-01', metrics: { ...base, readUsers: null, shareUsers: 9 } }], 'b'), { added: 0, updated: 1 });
  const [row] = listArticleStats(db);
  assert.equal(row.metrics.readUsers, 100);
  assert.equal(row.metrics.shareUsers, 9);
  assert.equal(row.source, 'b');
  deleteArticleStat(db, row.id);
  assert.equal(listArticleStats(db).length, 0);
});

test('HTML 伪 xls 与 GBK CSV', () => {
  assert.deepEqual(readHtmlTable('<table><tr><th>标题</th><th>阅读</th></tr><tr><td>A&amp;B</td><td>1,2</td></tr></table>'), [['标题', '阅读'], ['A&B', '1,2']]);
  const gbk = Buffer.from([0xb1, 0xea, 0xcc, 0xe2, 0x2c, 0x31, 0x0a]); // "标题,1\n"
  assert.deepEqual(readTableFile(gbk, 'a.csv'), [['标题', '1']]);
  assert.throws(() => readTableFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), 'a.xls'), /另存为/);
});

/** 手工拼一个最小 xlsx（deflate 压缩），验证 zip 与 sheet 解析。 */
function buildXlsx(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = zlib.deflateRawSync(Buffer.from(content));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

test('xlsx：共享字符串、内联字符串、空单元格补位', () => {
  const xlsx = buildXlsx({
    'xl/sharedStrings.xml': '<sst><si><t>标题</t></si><si><r><t>冬天</t></r><r><t>吃柿子</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>阅读人数</t></is></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"/><c r="C2"><v>120</v></c></row></sheetData></worksheet>'
  });
  assert.deepEqual(readTableFile(xlsx, 'a.xlsx'), [['标题', '', '阅读人数'], ['冬天吃柿子', '', '120']]);
});
