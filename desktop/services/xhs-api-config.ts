import fs from 'node:fs';
import path from 'node:path';
import type { XhsApiSettings } from '../shared.ts';
import { writeFileAtomic } from './atomic-file.ts';

/**
 * 小红书自己的模型连接配置：内容模型（写作、标题、检测…）与图片模型（封面、信息图）。
 *
 * 和公众号完全分开：不读 ~/.wewrite/config.yaml，开关也独立——关掉公众号的内容 API 不影响小红书，反之亦然。
 * 非机密的部分（开关、地址、模型名）存 userData/xhs-api.json；两个 key 走系统安全存储（见 main.ts 的 SecretStore）。
 */

const FILE = 'xhs-api.json';

export const XHS_API_DEFAULTS: XhsApiSettings = {
  llmEnabled: false,
  llmBaseUrl: 'https://api.deepseek.com/v1',
  llmModel: 'deepseek-chat',
  imageBaseUrl: 'https://api.openai.com/v1',
  imageModel: 'gpt-image-2'
};

function cleanUrl(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return fallback;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    return text;
  } catch {
    throw new Error(`接口地址不是有效的 http(s) 地址：${text}`);
  }
}

function cleanModel(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, 100);
}

/** 合并补丁并校验；未知字段忽略。 */
export function normalizeXhsApiSettings(input: Partial<XhsApiSettings>, base: XhsApiSettings = XHS_API_DEFAULTS): XhsApiSettings {
  return {
    llmEnabled: input.llmEnabled === undefined ? base.llmEnabled : input.llmEnabled === true,
    llmBaseUrl: input.llmBaseUrl === undefined ? base.llmBaseUrl : cleanUrl(input.llmBaseUrl, XHS_API_DEFAULTS.llmBaseUrl),
    llmModel: input.llmModel === undefined ? base.llmModel : cleanModel(input.llmModel, XHS_API_DEFAULTS.llmModel),
    imageBaseUrl: input.imageBaseUrl === undefined ? base.imageBaseUrl : cleanUrl(input.imageBaseUrl, XHS_API_DEFAULTS.imageBaseUrl),
    imageModel: input.imageModel === undefined ? base.imageModel : cleanModel(input.imageModel, XHS_API_DEFAULTS.imageModel)
  };
}

/** 文件缺失或损坏时返回默认值（默认关闭内容模型调用）。 */
export function readXhsApiSettings(dataDir: string): XhsApiSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8').replace(/^﻿/, '')) as Partial<XhsApiSettings>;
    return normalizeXhsApiSettings(raw && typeof raw === 'object' ? raw : {});
  } catch {
    return { ...XHS_API_DEFAULTS };
  }
}

export function writeXhsApiSettings(dataDir: string, patch: Partial<XhsApiSettings>): XhsApiSettings {
  const next = normalizeXhsApiSettings(patch ?? {}, readXhsApiSettings(dataDir));
  writeFileAtomic(path.join(dataDir, FILE), JSON.stringify(next, null, 2));
  return next;
}

const WHERE = '「隐私与设置 → 小红书模型」';

export function xhsLlmConfig(settings: XhsApiSettings, apiKey: string): { apiKey: string; baseUrl: string; model: string } {
  if (!settings.llmEnabled) throw new Error(`小红书的内容模型调用还没开启，请先在${WHERE}里打开`);
  if (!apiKey.trim()) throw new Error(`还没有配置小红书的内容模型 API Key，请先在${WHERE}里填写`);
  return { apiKey, baseUrl: settings.llmBaseUrl, model: settings.llmModel };
}

export function xhsImageConfig(settings: XhsApiSettings, apiKey: string): { apiKey: string; baseUrl: string; model: string } {
  if (!apiKey.trim()) throw new Error(`还没有配置小红书的图片模型 API Key，请先在${WHERE}里填写`);
  return { apiKey, baseUrl: settings.imageBaseUrl, model: settings.imageModel };
}
