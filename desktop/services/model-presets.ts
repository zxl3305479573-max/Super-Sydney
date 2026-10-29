import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelPreset, ModelPresetInput, ModelPresetKind } from '../shared.ts';
import { writeFileAtomic } from './atomic-file.ts';
import { normalizeImageCost } from './wewrite-config.ts';

/**
 * 公众号的模型预设：内容模型与图片模型各自可以存好几套「地址 + 模型 + key」，在界面上用下拉切换。
 *
 * 切换不是让各处改读预设，而是把选中的那套写回「当前在用」的位置（config.yaml + 内容 key 的安全存储）：
 * 生成链路、agent 侧 skill 读的都还是 config.yaml，所以加了预设也不用动任何读配置的地方。
 * 非机密部分存 userData/model-presets.json；各预设的 key 合成一份 JSON 存进系统安全存储（见 main.ts）。
 */

const FILE = 'model-presets.json';
const KINDS: ModelPresetKind[] = ['writer', 'image'];

/** key 存取的最小接口：生产环境是 SecretStore，测试里用内存实现。 */
export type PresetKeyVault = { read(): string; save(value: string): void; remove(): void };

function cleanUrl(value: unknown): string {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) throw new Error('请填写接口地址');
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
  } catch {
    throw new Error(`接口地址不是有效的 http(s) 地址：${text}`);
  }
  return text;
}

/** 校验并整理界面传来的预设；kind 不对、缺地址或模型都直接报错，不悄悄存一份坏预设。 */
export function normalizePresetInput(input: ModelPresetInput): Required<ModelPresetInput> {
  if (!KINDS.includes(input?.kind)) throw new Error('未知的模型类型');
  const model = String(input.model ?? '').trim().slice(0, 100);
  if (!model) throw new Error('请填写模型名');
  const baseUrl = cleanUrl(input.baseUrl);
  const name = (String(input.name ?? '').trim() || model).slice(0, 40);
  return {
    kind: input.kind,
    name,
    baseUrl,
    model,
    provider: input.kind === 'image' ? String(input.provider ?? '').trim() : '',
    estimatedCost: input.kind === 'image' ? normalizeImageCost(String(input.estimatedCost ?? '')) : '',
    apiKey: String(input.apiKey ?? '').trim()
  };
}

/**
 * 当前在用的配置对应哪一个预设：地址与模型（图片再加 provider）一致；调用方能提供
 * key 读取器时还会核对 key，避免相同模型、不同账号的配置彼此混淆。
 */
export function matchActivePreset(
  presets: ModelPreset[],
  kind: ModelPresetKind,
  current: { baseUrl: string; model: string; provider?: string; apiKey?: string },
  apiKeyForPreset?: (preset: ModelPreset) => string
): string {
  const url = current.baseUrl.trim().replace(/\/+$/, '');
  const apiKey = current.apiKey?.trim();
  const found = presets.find(preset => preset.kind === kind
    && preset.baseUrl === url
    && preset.model === current.model.trim()
    && (kind !== 'image' || preset.provider === (current.provider ?? '').trim())
    // 同一厂商、地址、模型可以用不同账号的 key。传入 key 读取器时必须一并比对，
    // 否则切到第二套后下拉框又会错误地显示成第一套。
    && (!apiKey || !apiKeyForPreset || apiKeyForPreset(preset).trim() === apiKey));
  return found?.id ?? '';
}

export class ModelPresetStore {
  private readonly filePath: string;
  private readonly vault: PresetKeyVault;

  constructor(directory: string, vault: PresetKeyVault) {
    this.filePath = path.join(directory, FILE);
    this.vault = vault;
  }

  list(): ModelPreset[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { presets?: ModelPreset[] };
      return Array.isArray(parsed.presets) ? parsed.presets.filter(item => item && KINDS.includes(item.kind) && item.id) : [];
    } catch {
      return [];
    }
  }

  find(id: string): ModelPreset {
    const found = this.list().find(item => item.id === id);
    if (!found) throw new Error('这个模型预设已经不存在了，请刷新后重试');
    return found;
  }

  /** 预设的 key；取不到（被删或系统加密不可用）时返回空串。 */
  apiKey(id: string): string {
    return this.keys()[id] ?? '';
  }

  /**
   * 同类型里同名就覆盖，否则新建。
   * fallbackKey 是「当前在用的 key」：表单 key 留空时沿用它，这样把现有配置存成预设不用再贴一遍 key。
   */
  save(input: ModelPresetInput, fallbackKey: string): ModelPreset {
    const normalized = normalizePresetInput(input);
    const apiKey = normalized.apiKey || fallbackKey.trim();
    if (!apiKey) throw new Error('这套配置还没有 API Key：请先填写 key 再存为预设');
    const presets = this.list();
    const existing = presets.find(item => item.kind === normalized.kind && item.name === normalized.name);
    const preset: ModelPreset = {
      id: existing?.id ?? randomUUID(),
      kind: normalized.kind,
      name: normalized.name,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      provider: normalized.provider,
      estimatedCost: normalized.estimatedCost
    };
    // 先存 key 再写列表：key 存不进去时不留下一个没有 key 的预设。
    this.writeKeys({ ...this.keys(), [preset.id]: apiKey });
    this.writeList(existing ? presets.map(item => item.id === preset.id ? preset : item) : [...presets, preset]);
    return preset;
  }

  remove(id: string): void {
    this.writeList(this.list().filter(item => item.id !== id));
    const keys = this.keys();
    if (!(id in keys)) return;
    delete keys[id];
    this.writeKeys(keys);
  }

  private writeList(presets: ModelPreset[]): void {
    writeFileAtomic(this.filePath, `${JSON.stringify({ presets }, null, 2)}\n`);
  }

  private keys(): Record<string, string> {
    try {
      const parsed = JSON.parse(this.vault.read() || '{}') as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
      return {};
    }
  }

  private writeKeys(keys: Record<string, string>): void {
    if (Object.keys(keys).length) this.vault.save(JSON.stringify(keys));
    else this.vault.remove();
  }
}
