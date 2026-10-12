import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { ContentTask } from '../shared.ts';
import { buildStatsView, matchTask, normalizeDate, normalizeTitle, parseCount, tableToStatInputs } from '../services/article-stats.ts';
import { deleteArticleStat, listArticleStats, migrateArticleStatTables, upsertArticleStats } from '../services/article-stats-store.ts';
import { readDelimited, readHtmlTable, readTableFile } from '../services/table-file.ts';
import { decodeRk } from '../services/xls-biff.ts';

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
  assert.throws(() => readTableFile(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]), 'a.xls'), /读取失败.*另存为/);
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

test('「数据趋势」导出：多表并排时只取标题所在的表，按渠道拆行时优先用"全部"、否则相加', () => {
  const header = ['', '日期', '渠道', '阅读人数', '', '日期', '分享人数', '微信收藏人数', '发表篇数', '', '传播渠道', '发表日期', '内容标题', '阅读人数', '阅读人数占比'];
  const inputs = tableToStatInputs([
    ['', '数据趋势概况(2026.09.12-2026.10.11)'],
    header,
    ['', '2026-10-01', '全部', '999', '', '2026-10-01', '50', '7', '1', '', '朋友圈', '2026-10-01', '冬天吃柿子', '30', '30%'],
    ['', '2026-10-01', '朋友圈', '500', '', '', '', '', '', '', '聊天会话', '2026-10-01', '冬天吃柿子', '70', '70%'],
    ['', '', '', '', '', '', '', '', '', '', '朋友圈', '2026-10-03', '早睡早起', '10', '20%'],
    ['', '', '', '', '', '', '', '', '', '', '全部', '2026-10-03', '早睡早起', '50', '100%'],
    ['', '', '', '', '', '', '', '', '', '', '推荐', '2026-10-03', '早睡早起', '40', '80%']
  ]);
  const byTitle = Object.fromEntries(inputs.map(input => [input.title, input]));
  assert.equal(byTitle['冬天吃柿子'].metrics.readUsers, 100);
  assert.equal(byTitle['冬天吃柿子'].metrics.shareUsers, null, '分享人数在另一张表里，不能错配');
  assert.equal(byTitle['早睡早起'].metrics.readUsers, 50);
});

test('「数据趋势」导出：单篇表为空时提示还没有已发表文章', () => {
  assert.throws(() => tableToStatInputs([
    ['', '日期', '渠道', '阅读人数', '', '传播渠道', '发表日期', '内容标题', '阅读人数'],
    ['', '2026-10-01', '全部', '0']
  ]), /还没有已发表的文章/);
});

test('BIFF RK 数字解码', () => {
  assert.equal(decodeRk((123 << 2) | 0x02), 123);
  assert.equal(decodeRk((12345 << 2) | 0x03), 123.45);
  const buffer = Buffer.alloc(8); buffer.writeDoubleLE(1.5);
  assert.equal(decodeRk(buffer.readUInt32LE(4)), 1.5);
});

function biffRecord(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4); head.writeUInt16LE(type, 0); head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}

function cellHead(row: number, col: number): Buffer {
  const head = Buffer.alloc(6); head.writeUInt16LE(row, 0); head.writeUInt16LE(col, 2);
  return head;
}

/** 手工拼一个单流的 OLE2 文件：1 个 FAT 扇区 + 1 个目录扇区 + Workbook 流（补齐到 ≥4096 字节，走普通 FAT）。 */
function buildCfb(stream: Buffer): Buffer {
  const padded = Buffer.concat([stream, Buffer.alloc(Math.max(0, 4096 - stream.length))]);
  const dataSectors = Math.ceil(padded.length / 512);
  const header = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header);
  header.writeUInt16LE(9, 0x1e); header.writeUInt16LE(6, 0x20); header.writeUInt32LE(1, 0x2c);
  header.writeUInt32LE(1, 0x30); header.writeUInt32LE(4096, 0x38); header.writeUInt32LE(0xfffffffe, 0x3c); header.writeUInt32LE(0xfffffffe, 0x44);
  header.fill(0xff, 0x4c); header.writeUInt32LE(0, 0x4c);
  const fat = Buffer.alloc(512, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0); fat.writeUInt32LE(0xfffffffe, 4);
  for (let index = 0; index < dataSectors; index += 1) fat.writeUInt32LE(index === dataSectors - 1 ? 0xfffffffe : 3 + index, (2 + index) * 4);
  const dir = Buffer.alloc(512);
  const entry = (offset: number, name: string, type: number, start: number, size: number) => {
    dir.write(name, offset, 'utf16le'); dir.writeUInt16LE((name.length + 1) * 2, offset + 0x40); dir[offset + 0x42] = type;
    dir.writeUInt32LE(start, offset + 0x74); dir.writeUInt32LE(size, offset + 0x78);
  };
  entry(0, 'Root Entry', 5, 0xfffffffe, 0);
  entry(128, 'Workbook', 2, 2, padded.length);
  return Buffer.concat([header, fat, dir, padded, Buffer.alloc(dataSectors * 512 - padded.length)]);
}

test('二进制 xls：SST 跨 CONTINUE、LABELSST / NUMBER / RK / MULRK / LABEL', () => {
  const bof = biffRecord(0x0809, Buffer.alloc(16));
  const eof = biffRecord(0x000a, Buffer.alloc(0));
  // SST：2 个字符串；第二个 UTF-16 字符串在中间被切到 CONTINUE，续段开头带新的标志字节（这里切成单字节编码）。
  const sstHead = Buffer.alloc(8); sstHead.writeUInt32LE(2, 0); sstHead.writeUInt32LE(2, 4);
  const first = Buffer.concat([Buffer.from([2, 0, 1]), Buffer.from('标题', 'utf16le')]);
  const second = Buffer.concat([Buffer.from([4, 0, 1]), Buffer.from('冬天', 'utf16le')]);
  const continued = Buffer.concat([Buffer.from([0]), Buffer.from('AB', 'latin1')]);
  const label = Buffer.concat([cellHead(0, 3), Buffer.from([2, 0, 1]), Buffer.from('阅读', 'utf16le')]);
  const mulrk = Buffer.alloc(4 + 6 * 2 + 2);
  mulrk.writeUInt16LE(1, 0); mulrk.writeUInt16LE(2, 2);
  mulrk.writeUInt32LE((7 << 2) | 2, 6); mulrk.writeUInt32LE((8 << 2) | 2, 12); mulrk.writeUInt16LE(3, 16);
  const number = Buffer.concat([cellHead(1, 1), Buffer.alloc(8)]); number.writeDoubleLE(46306, 6);
  const rk = Buffer.concat([cellHead(0, 1), Buffer.alloc(4)]); rk.writeUInt32LE((5 << 2) | 2, 6);
  const sstCell = (row: number, col: number, index: number) => { const data = Buffer.concat([cellHead(row, col), Buffer.alloc(4)]); data.writeUInt32LE(index, 6); return biffRecord(0x00fd, data); };
  const stream = Buffer.concat([
    bof, biffRecord(0x00fc, Buffer.concat([sstHead, first, second])), biffRecord(0x003c, continued), eof,
    bof, sstCell(0, 0, 0), biffRecord(0x027e, rk), biffRecord(0x0204, label), sstCell(1, 0, 1), biffRecord(0x0203, number), biffRecord(0x00bd, mulrk), eof,
    bof, sstCell(0, 0, 1), eof // 第二个工作表不读
  ]);
  assert.deepEqual(readTableFile(buildCfb(stream), 'a.xls'), [['标题', '5', '', '阅读'], ['冬天AB', '46306', '7', '8']]);
});

test('按公众号资料查看：只保留匹配到该资料任务的文章，对不上任务的只计数', () => {
  const metrics = (readUsers: number) => ({ readUsers, reads: null, shareUsers: null, shares: null, likes: null, wows: null, favorites: null, comments: null, delivered: null, follows: null });
  const stored = [
    { id: 1, title: 'A', publishDate: '2026-10-01', metrics: metrics(100), source: 'x', importedAt: '' },
    { id: 2, title: 'B', publishDate: '2026-10-02', metrics: metrics(300), source: 'x', importedAt: '' },
    { id: 3, title: 'C', publishDate: '2026-10-03', metrics: metrics(900), source: 'x', importedAt: '' }
  ];
  const tasks = [task(10, 'A'), { ...task(11, 'B', '', '大模型'), directionId: 2 }];
  const health = buildStatsView(stored, tasks, 1);
  assert.deepEqual(health.records.map(record => record.title), ['A']);
  assert.equal(health.overview.unmatched, 1);
  assert.equal(health.overview.medianReads, 100);
  assert.equal(health.groups[0].name, '饮食营养', '按资料查看时分组只写具体方向名');
  const ai = buildStatsView(stored, tasks, 2);
  assert.deepEqual(ai.records.map(record => record.title), ['B']);
  const all = buildStatsView(stored, tasks);
  assert.equal(all.records.length, 3);
  assert.equal(all.overview.unmatched, 0);
});
