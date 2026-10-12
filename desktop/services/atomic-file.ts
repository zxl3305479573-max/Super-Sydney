import fs from 'node:fs';
import path from 'node:path';

export type AtomicWriteOptions = { mode?: number; encoding?: BufferEncoding };

/**
 * 先写临时文件再改名，避免其他进程读到写了一半的内容。
 *
 * 但 Windows 上存在「同目录改名必失败」的目录：实测
 * %APPDATA%\sydney-work-os（带 EFS 加密属性）里 rename 直接返回
 * EXDEV，而 ~/.wewrite 和系统临时目录都正常。这种情况必须退回直接
 * 覆盖写，否则首次写入（目标文件还不存在）会整条保存失败。
 */
export function writeFileAtomic(target: string, data: string | Buffer, options: AtomicWriteOptions = {}): void {
  const encoding = options.encoding ?? 'utf8';
  const writeOptions = options.mode === undefined ? { encoding } : { encoding, mode: options.mode };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(temporary, data, writeOptions);
    try {
      fs.renameSync(temporary, target);
      return;
    } catch {
      // 改名不可用时退回直接覆盖写；真正的权限或磁盘错误会在下一行重新抛出。
    }
    fs.writeFileSync(target, data, writeOptions);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}
