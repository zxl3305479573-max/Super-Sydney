import type { ModelConfigDraft } from '../shared.ts';
import { normalizeImageCost } from './wewrite-config.ts';

/**
 * 统一模型设置的边界归一化。
 *
 * Renderer 传来的对象来自 IPC，不能假定字段一定存在或一定是字符串。
 * 在写入 ~/.wewrite/config.yaml 和系统安全存储前先整理一次，避免保存一半
 * 后才因为 undefined、非法地址或费用格式抛错。
 */
export function normalizeModelConfigDraft(input: ModelConfigDraft): ModelConfigDraft {
  const writer = input?.writer;
  const image = input?.image;
  if (!writer || !image) throw new Error('模型配置不完整，请刷新设置页后重试');

  const writerBaseUrl = cleanUrl(writer.baseUrl, '内容模型接口地址', true);
  const writerModel = cleanText(writer.model, '内容模型名');
  const imageBaseUrl = cleanUrl(image.baseUrl, '图片模型接口地址', false);
  return {
    writer: {
      baseUrl: writerBaseUrl,
      model: writerModel,
      apiKey: cleanSecret(writer.apiKey)
    },
    image: {
      provider: cleanText(image.provider),
      model: cleanText(image.model),
      baseUrl: imageBaseUrl,
      apiKey: cleanSecret(image.apiKey),
      estimatedCost: normalizeImageCost(cleanText(image.estimatedCost))
    }
  };
}

function cleanText(value: unknown, label = ''): string {
  const text = String(value ?? '').trim();
  if (label && !text) throw new Error(`请填写${label}`);
  return text;
}

function cleanSecret(value: unknown): string {
  return String(value ?? '').trim();
}

function cleanUrl(value: unknown, label: string, required: boolean): string {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text && !required) return '';
  if (!text) throw new Error(`请填写${label}`);
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    throw new Error(`${label}不是有效的 http(s) 地址`);
  }
  return text;
}
