import fs from 'node:fs';

/**
 * MP4 faststart 二进制文件头检测（仅主进程与 Node 单测使用）：
 * 确认 moov 位于 mdat 之前，支持 32 位常规 Box 与 64 位 largesize Box。
 */

export function parseMp4FaststartFromBuffer(bytes: Uint8Array): boolean | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size32 = view.getUint32(offset, false);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === 'moov') return true;
    if (type === 'mdat') return false;

    let boxSize = size32;
    if (size32 === 1) {
      if (offset + 16 > bytes.byteLength) return null;
      const large = Number(view.getBigUint64(offset + 8, false));
      if (!Number.isSafeInteger(large) || large < 16) return null;
      boxSize = large;
    } else if (size32 === 0 || size32 < 8) {
      return null;
    }
    offset += boxSize;
  }
  return null;
}

/**
 * 按 Box 偏移跳跃式扫描本地 MP4 文件顶层结构，不把整部视频读进内存。
 * 即使文件头有大于 64KB 的 free / meta 块也能准确判断 moov 与 mdat 顺序。
 */
export function inspectMp4Faststart(filePath: string): boolean | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 16) return null;
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    let offset = 0;
    for (let steps = 0; steps < 64 && offset + 8 <= stat.size; steps += 1) {
      const bytesRead = fs.readSync(fd, header, 0, Math.min(16, stat.size - offset), offset);
      if (bytesRead < 8) return null;
      const size32 = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;

      let boxSize = size32;
      if (size32 === 1) {
        if (bytesRead < 16) return null;
        const large = Number(header.readBigUInt64BE(8));
        if (!Number.isSafeInteger(large) || large < 16) return null;
        boxSize = large;
      } else if (size32 === 0 || size32 < 8) {
        return null;
      }
      offset += boxSize;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 忽略关闭异常 */ }
    }
  }
}
