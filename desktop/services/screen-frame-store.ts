import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export class ScreenFrameStore {
  private readonly root: string;
  private readonly keyPath: string;
  private readonly safeStorage: SafeStorageLike;
  private key?: Buffer;

  constructor(root: string, safeStorage: SafeStorageLike) {
    this.root = root;
    this.keyPath = path.join(root, 'screen-key.bin');
    this.safeStorage = safeStorage;
    fs.mkdirSync(root, { recursive: true });
  }

  isAvailable(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  save(png: Buffer, capturedAt = new Date()): string {
    if (!this.isAvailable()) throw new Error('系统加密存储不可用，屏幕采样已跳过');
    const key = this.getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
    const tag = cipher.getAuthTag();
    const name = `${capturedAt.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.sframe`;
    const target = path.join(this.root, name);
    fs.writeFileSync(target, Buffer.concat([Buffer.from('SYDNEY1'), iv, tag, encrypted]));
    return target;
  }

  cleanup(retentionHours: number, now = Date.now()): number {
    const cutoff = now - Math.max(1, retentionHours) * 60 * 60 * 1000;
    let removed = 0;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sframe')) continue;
      const target = path.join(this.root, entry.name);
      if (fs.statSync(target).mtimeMs < cutoff) {
        fs.rmSync(target, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private getKey(): Buffer {
    if (this.key) return this.key;
    if (fs.existsSync(this.keyPath)) {
      const stored = Buffer.from(this.safeStorage.decryptString(fs.readFileSync(this.keyPath)), 'base64');
      if (stored.length !== 32) throw new Error('屏幕数据加密密钥无效');
      this.key = stored;
      return stored;
    }
    this.key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, this.safeStorage.encryptString(this.key.toString('base64')), { mode: 0o600 });
    return this.key;
  }
}
