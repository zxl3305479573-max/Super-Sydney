/**
 * 旧版二进制 .xls（Excel 97-2003，BIFF8）的最小读取器。
 *
 * 公众号后台的数据导出就是这种格式，让用户每次另存为 xlsx 太折腾，所以自己读：
 *   1. 外层是 OLE2 复合文档（CFB）：按 FAT 链取出名为 Workbook（或旧名 Book）的流；
 *   2. 流里是 BIFF 记录：全局区的 SST 共享字符串表 + 第一个工作表里的单元格记录。
 * 只读值，不管格式、公式文本、合并单元格；不认识的记录直接跳过。
 */

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

export function isCfb(bytes: Buffer): boolean {
  return bytes.length >= 512 && bytes.subarray(0, 8).equals(CFB_SIGNATURE);
}

/** 从 OLE2 容器里取出指定名字的流（不区分大小写，按顺序尝试）。 */
export function readCfbStream(bytes: Buffer, names: string[]): Buffer | null {
  if (!isCfb(bytes)) throw new Error('不是 OLE2 复合文档');
  const sectorSize = 1 << bytes.readUInt16LE(0x1e);
  const miniSectorSize = 1 << bytes.readUInt16LE(0x20);
  const fatSectorCount = bytes.readUInt32LE(0x2c);
  const firstDirSector = bytes.readUInt32LE(0x30);
  const miniCutoff = bytes.readUInt32LE(0x38);
  const firstMiniFatSector = bytes.readUInt32LE(0x3c);
  let difatSector = bytes.readUInt32LE(0x44);
  const sectorOffset = (sid: number) => (sid + 1) * sectorSize;

  // FAT 扇区号：前 109 个在文件头，其余在 DIFAT 链里（每个 DIFAT 扇区最后 4 字节指向下一个）。
  const fatSectors: number[] = [];
  for (let index = 0; index < 109 && fatSectors.length < fatSectorCount; index += 1) fatSectors.push(bytes.readUInt32LE(0x4c + index * 4));
  for (let guard = 0; difatSector !== END_OF_CHAIN && difatSector !== FREE_SECTOR && fatSectors.length < fatSectorCount && guard < 10_000; guard += 1) {
    const base = sectorOffset(difatSector);
    const perSector = sectorSize / 4 - 1;
    for (let index = 0; index < perSector && fatSectors.length < fatSectorCount; index += 1) fatSectors.push(bytes.readUInt32LE(base + index * 4));
    difatSector = bytes.readUInt32LE(base + perSector * 4);
  }
  const fat: number[] = [];
  for (const sid of fatSectors) {
    const base = sectorOffset(sid);
    for (let index = 0; index < sectorSize / 4 && base + index * 4 + 4 <= bytes.length; index += 1) fat.push(bytes.readUInt32LE(base + index * 4));
  }

  // 链式读取；guard 防止损坏文件里的环把进程卡死。
  const readChain = (start: number, table: number[], read: (sid: number) => Buffer): Buffer => {
    const parts: Buffer[] = [];
    for (let sid = start, guard = 0; sid !== END_OF_CHAIN && sid !== FREE_SECTOR && sid < table.length + 1 && guard < 1_000_000; guard += 1) {
      parts.push(read(sid));
      sid = table[sid] ?? END_OF_CHAIN;
    }
    return Buffer.concat(parts);
  };
  const readSector = (sid: number) => bytes.subarray(sectorOffset(sid), sectorOffset(sid) + sectorSize);

  const directory = readChain(firstDirSector, fat, readSector);
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameLength = directory.readUInt16LE(offset + 0x40);
    entries.push({
      name: directory.subarray(offset, offset + Math.max(0, nameLength - 2)).toString('utf16le'),
      type: directory[offset + 0x42],
      start: directory.readUInt32LE(offset + 0x74),
      size: directory.readUInt32LE(offset + 0x78)
    });
  }
  const root = entries.find(entry => entry.type === 5);
  const wanted = names.map(name => name.toLowerCase());
  const target = wanted.map(name => entries.find(entry => entry.type === 2 && entry.name.toLowerCase() === name)).find(Boolean);
  if (!target) return null;

  if (target.size >= miniCutoff || !root) return readChain(target.start, fat, readSector).subarray(0, target.size);
  // 小于 4096 字节的流存放在 mini stream 里，用 MiniFAT 寻址。
  const miniStream = readChain(root.start, fat, readSector);
  const miniFatBytes = readChain(firstMiniFatSector, fat, readSector);
  const miniFat: number[] = [];
  for (let offset = 0; offset + 4 <= miniFatBytes.length; offset += 4) miniFat.push(miniFatBytes.readUInt32LE(offset));
  return readChain(target.start, miniFat, sid => miniStream.subarray(sid * miniSectorSize, (sid + 1) * miniSectorSize)).subarray(0, target.size);
}

/** BIFF 的 RK 压缩数字：低 2 位是标志（是否 ÷100、是否 30 位整数）。 */
export function decodeRk(rk: number): number {
  const divide = (rk & 0x01) !== 0;
  let value: number;
  if (rk & 0x02) value = rk >> 2;
  else {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = buffer.readDoubleLE(0);
  }
  return divide ? value / 100 : value;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
}

/**
 * SST 字符串可能横跨多条 CONTINUE 记录；跨界处会重新给一个字符宽度标志字节。
 * 所以把各段分开保存，读字符时遇到段尾就切到下一段并重读标志。
 */
class SegmentReader {
  private segment = 0;
  private offset = 0;
  private readonly segments: Buffer[];
  constructor(segments: Buffer[]) { this.segments = segments; }

  private ensure(): void {
    while (this.segment < this.segments.length && this.offset >= this.segments[this.segment].length) { this.segment += 1; this.offset = 0; }
  }
  get done(): boolean { this.ensure(); return this.segment >= this.segments.length; }
  u8(): number { this.ensure(); const value = this.segments[this.segment][this.offset]; this.offset += 1; return value; }
  u16(): number { return this.u8() | (this.u8() << 8); }
  u32(): number { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(count: number): void { for (let index = 0; index < count; index += 1) this.u8(); }

  /** 读 count 个字符；highByte 表示 UTF-16LE，否则是压缩的单字节（Latin-1）。 */
  chars(count: number, highByte: boolean): string {
    let out = '';
    let wide = highByte;
    let remaining = count;
    while (remaining > 0) {
      // 不能调用 ensure()：它会静默跨段，吞掉续段开头的标志字节。
      if (this.segment >= this.segments.length) break;
      const current = this.segments[this.segment];
      const available = Math.floor((current.length - this.offset) / (wide ? 2 : 1));
      if (available === 0) {
        // 字符数据跨入下一条 CONTINUE：新段开头是一个标志字节。
        this.segment += 1; this.offset = 0;
        if (this.segment >= this.segments.length) break;
        wide = (this.u8() & 0x01) !== 0;
        continue;
      }
      const take = Math.min(available, remaining);
      const slice = current.subarray(this.offset, this.offset + take * (wide ? 2 : 1));
      out += wide ? slice.toString('utf16le') : slice.toString('latin1');
      this.offset += slice.length;
      remaining -= take;
    }
    return out;
  }
}

function readSst(segments: Buffer[]): string[] {
  const reader = new SegmentReader(segments);
  reader.skip(4);
  const unique = reader.u32();
  const strings: string[] = [];
  for (let index = 0; index < unique && !reader.done; index += 1) {
    const count = reader.u16();
    const flags = reader.u8();
    const runs = flags & 0x08 ? reader.u16() : 0;
    const extSize = flags & 0x04 ? reader.u32() : 0;
    strings.push(reader.chars(count, (flags & 0x01) !== 0));
    reader.skip(runs * 4 + extSize);
  }
  return strings;
}

function readShortString(data: Buffer, offset: number): string {
  const count = data.readUInt16LE(offset);
  const flags = data[offset + 2];
  const start = offset + 3;
  return flags & 0x01 ? data.subarray(start, start + count * 2).toString('utf16le') : data.subarray(start, start + count).toString('latin1');
}

/** 读取 Workbook 流里第一个工作表，返回二维字符串数组。 */
export function readBiffWorkbook(stream: Buffer): string[][] {
  const cells = new Map<number, string[]>();
  const put = (row: number, col: number, value: string) => {
    const line = cells.get(row) ?? [];
    while (line.length < col) line.push('');
    line[col] = value.trim();
    cells.set(row, line);
  };
  let sst: string[] = [];
  let sstSegments: Buffer[] | null = null;
  let substream = 0;
  let pendingFormula: { row: number; col: number } | null = null;

  for (let offset = 0; offset + 4 <= stream.length;) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const data = stream.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;

    if (sstSegments && type !== 0x003c) { sst = readSst(sstSegments); sstSegments = null; }
    if (type === 0x0809) { substream += 1; continue; }
    if (type === 0x00fc) { sstSegments = [data]; continue; }
    if (type === 0x003c && sstSegments) { sstSegments.push(data); continue; }
    if (type === 0x000a && substream >= 2) break; // 第一个工作表读完
    if (substream !== 2) continue;
    if (type === 0x0207) { // STRING：上一条 FORMULA 的字符串结果
      if (pendingFormula && data.length >= 3) put(pendingFormula.row, pendingFormula.col, readShortString(data, 0));
      pendingFormula = null;
      continue;
    }
    if (data.length < 6) continue;

    const row = data.readUInt16LE(0);
    const col = data.readUInt16LE(2);
    switch (type) {
      case 0x00fd: put(row, col, sst[data.readUInt32LE(6)] ?? ''); break; // LABELSST
      case 0x0203: put(row, col, formatNumber(data.readDoubleLE(6))); break; // NUMBER
      case 0x027e: put(row, col, formatNumber(decodeRk(data.readUInt32LE(6)))); break; // RK
      case 0x0204: put(row, col, readShortString(data, 6)); break; // LABEL
      case 0x00bd: { // MULRK：一条记录里连续多个 RK 单元格
        const last = data.readUInt16LE(data.length - 2);
        for (let index = 0; index <= last - col; index += 1) put(row, col + index, formatNumber(decodeRk(data.readUInt32LE(4 + index * 6 + 2))));
        break;
      }
      case 0x0006: { // FORMULA：只取缓存结果；字符串结果在紧随的 STRING 记录里
        if (data.readUInt16LE(12) !== 0xffff) put(row, col, formatNumber(data.readDoubleLE(6)));
        else if (data[6] === 0) pendingFormula = { row, col };
        break;
      }
      default: break;
    }
  }

  return [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line).filter(line => line.some(Boolean));
}

export function readXls(bytes: Buffer): string[][] {
  const stream = readCfbStream(bytes, ['Workbook', 'Book']);
  if (!stream) throw new Error('xls 文件里没有工作簿数据');
  return readBiffWorkbook(stream);
}
