import zlib from 'node:zlib';
import { isCfb, readXls } from './xls-biff.ts';

/**
 * 把用户导出的表格文件读成二维字符串数组。
 *
 * 有意不引入表格库：只支持公众号后台导出会出现的几种形状——
 *   - CSV / TSV（可能带 UTF-8 BOM，也可能是 GBK 编码）
 *   - .xlsx（zip 包 + sheet XML）
 *   - 旧版二进制 .xls（公众号后台导出就是这种），见 xls-biff.ts
 *   - 扩展名是 .xls、实际内容是 HTML 表格的"伪 xls"（网页导出常见）
 */

export type Table = string[][];

export function readTableFile(bytes: Buffer, filename = ''): Table {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return readXlsx(bytes);
  if (isCfb(bytes)) {
    try {
      return readXls(bytes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${filename || '该文件'} 读取失败（${detail}）。可以用 Excel/WPS 打开后另存为 .xlsx 或 .csv 再导入`);
    }
  }
  const text = decodeText(bytes);
  if (/<table[\s>]/i.test(text)) return readHtmlTable(text);
  return readDelimited(text);
}

/** UTF-8 优先；出现替换字符说明不是合法 UTF-8，退回 GBK（国内 Excel 另存 CSV 的默认编码）。 */
export function decodeText(bytes: Buffer): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return utf8;
  }
}

/** RFC 4180 风格：支持引号包裹、引号内换行与 "" 转义；分隔符按首行里逗号/制表符哪个多来判断。 */
export function readDelimited(text: string): Table {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const rows: Table = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(cells => cells.map(value => value.trim())).filter(cells => cells.some(Boolean));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function readHtmlTable(html: string): Table {
  const rows: Table = [];
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(cell => decodeEntities(cell[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

/** 最小 zip 读取：只靠中央目录定位条目，支持 store(0) 与 deflate(8)，足够读 xlsx。 */
export function readZipEntries(bytes: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error('xlsx 文件已损坏：找不到 zip 目录');
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('xlsx 文件已损坏：zip 目录项异常');
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, data);
    else if (method === 8) entries.set(name, zlib.inflateRawSync(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function xmlText(fragment: string): string {
  return decodeEntities([...fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => match[1]).join(''));
}

/** 读取第一个工作表。共享字符串、内联字符串、数字都还原成字符串，日期序号原样保留给上层判断。 */
export function readXlsx(bytes: Buffer): Table {
  const entries = readZipEntries(bytes);
  const shared = [...(entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => xmlText(match[1]));
  const sheetName = [...entries.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
  if (!sheetName) throw new Error('xlsx 里没有工作表');
  const sheet = entries.get(sheetName)!.toString('utf8');
  const rows: Table = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? '';
      const ref = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? '';
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
      const value = type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? xmlText(body) : decodeEntities(raw);
      const column = ref ? columnIndex(ref) : row.length;
      while (row.length < column) row.push('');
      row[column] = value.trim();
    }
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}
