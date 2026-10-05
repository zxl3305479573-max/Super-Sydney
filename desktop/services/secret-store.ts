import fs from 'node:fs';
import path from 'node:path';

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export type LlmKeyStatus = {
  configured: boolean;
  masked: string;
  encryptionAvailable: boolean;
};

const FILE_NAME = 'deepseek-api-key.bin';

export class SecretStore {
  private readonly filePath: string;
  private readonly directory: string;
  private readonly safeStorage: SafeStorageLike;
  constructor(directory: string, safeStorage: SafeStorageLike, fileName = FILE_NAME) {
    this.directory = directory;
    this.safeStorage = safeStorage;
    this.filePath = path.join(directory, fileName);
  }

  getStatus(): LlmKeyStatus {
    const encryptionAvailable = this.safeStorage.isEncryptionAvailable();
    const value = encryptionAvailable ? this.read() : '';
    return { configured: Boolean(value), masked: maskSecret(value), encryptionAvailable };
  }

  save(value: string): void {
    const normalized = value.trim();
    if (!normalized) throw new Error('API key 不能为空');
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存 API key');
    fs.mkdirSync(this.directory, { recursive: true });
    const encrypted = this.safeStorage.encryptString(normalized);
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  read(): string {
    if (!fs.existsSync(this.filePath) || !this.safeStorage.isEncryptionAvailable()) return '';
    try {
      const encrypted = fs.readFileSync(this.filePath);
      const value = this.safeStorage.decryptString(encrypted).trim();
      return value;
    } catch {
      return '';
    }
  }

  remove(): void {
    if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath, { force: false });
  }
}

export function resolveLlmApiKey(stored: string, environment: string): string {
  return stored.trim() || environment.trim();
}

function maskSecret(value: string): string {
  if (!value) return '';
  return `••••${value.slice(-4)}`;
}
