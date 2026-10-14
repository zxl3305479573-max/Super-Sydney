import type { BrowserWindow } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import type { SettingsFile } from './services/app-settings';
import type { LlmConfig } from './services/llm-json';
import type { SecretStore } from './services/secret-store';

/**
 * 主进程各模块共享的依赖。启动时在 db、密钥存储都就绪后一次性构造，
 * 再传给各个 register*Ipc 与采集运行时——模块之间不再通过 main.ts 的全局变量互相读写。
 */
export interface AppContext {
  db: DatabaseSync;
  /** Electron userData 目录：数据库、生成的图片素材都在这里。 */
  dataDir: string;
  homeDir: string;
  settings: SettingsFile;
  secretStore: SecretStore;
  /** 红狐（小红书热点数据）API Key，与内容 API 的密钥分文件存。 */
  redfoxKeyStore: SecretStore;
  /** 小红书自己的内容模型与图片模型 key，与公众号分开存。 */
  xhsLlmKeyStore: SecretStore;
  xhsImageKeyStore: SecretStore;
  /** 密钥优先取系统安全存储，其次环境变量。 */
  llmApiKey(): string;
  llmConfig(): LlmConfig;
  /** 红狐 key：优先系统安全存储，其次环境变量 REDFOX_API_KEY。 */
  redfoxApiKey(): string;
  /** 通知渲染进程重新拉取 state:get。 */
  broadcast(): void;
  /** 通知渲染进程 ~/.wewrite 配置变了。 */
  notifyWeWriteChanged(): void;
  /** 通知渲染进程变现模块里那个站点的状态变了（导航、标题、载入失败）。 */
  notifySiteChanged(): void;
  /** 对话框需要父窗口；窗口未创建时为 null。 */
  window(): BrowserWindow | null;
}
