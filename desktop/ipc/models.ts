import { ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type { ModelConfigDraft, ModelConfigView, ModelPresetInput } from '../shared';
import { writerEndpoint } from '../services/content-api-config';
import { requestChatContent } from '../services/llm-json';
import { normalizeModelConfigDraft } from '../services/model-config';
import { matchActivePreset } from '../services/model-presets';
import { maskSecret, parseImageConfig, yamlScalar } from '../services/wewrite-config';
import { readWeWriteFiles } from '../services/wewrite-files';
import { rewriteModelConfig } from './wewrite';

/* ── 统一模型配置（「设置 → 模型」） ───────────────────────────
 * 全应用只有一个内容模型、一个图片模型：公众号、视频、小红书、AI 整理与经验卡片都用它。
 * 存放位置沿用原来的：地址与模型名在 ~/.wewrite/config.yaml（agent 侧 skill 也读这份），
 * 内容模型 key 在系统安全存储，图片 key 在 config.yaml；开关是应用设置里的 llmEnabled。
 */

function collectModelConfig(ctx: AppContext): ModelConfigView {
  const { configText } = readWeWriteFiles();
  const writer = writerEndpoint(configText);
  const image = parseImageConfig(configText);
  const presets = ctx.modelPresets.list();
  return {
    enabled: ctx.settings.read().llmEnabled,
    writer: { ...writer, key: ctx.secretStore.getStatus() },
    image,
    presets: presets.map(preset => ({ ...preset, apiKeyMasked: maskSecret(ctx.modelPresets.apiKey(preset.id)) })),
    activePresets: {
      writer: matchActivePreset(presets, 'writer', writer),
      image: matchActivePreset(presets, 'image', image)
    }
  };
}

export function registerModelIpc(ctx: AppContext): void {
  ipcMain.handle('models:get', () => collectModelConfig(ctx));

  /**
   * key 留空表示保留现有的。先保存 key，再写 config.yaml；配置文件写失败时
   * 回滚刚写入的 key，避免出现「地址已换但 key 还是旧的」的半套配置。
   */
  ipcMain.handle('models:save', (_event, draft: ModelConfigDraft): ModelConfigView => {
    const normalized = normalizeModelConfigDraft(draft);
    const previousKey = ctx.secretStore.read();
    const nextKey = normalized.writer.apiKey;
    let keyChanged = false;
    if (nextKey && nextKey !== previousKey) {
      ctx.secretStore.save(nextKey);
      keyChanged = true;
    }
    try {
      rewriteModelConfig(ctx, current => {
        current.writer = { ...current.writer!, baseUrl: normalized.writer.baseUrl, model: normalized.writer.model };
        current.image = {
          provider: normalized.image.provider, model: normalized.image.model, baseUrl: normalized.image.baseUrl,
          apiKey: normalized.image.apiKey, estimatedCost: normalized.image.estimatedCost
        };
      });
    } catch (error) {
      if (keyChanged) {
        try {
          if (previousKey) ctx.secretStore.save(previousKey);
          else ctx.secretStore.remove();
        } catch {
          // 原始错误更有用；回滚失败不会把密钥内容写进错误信息。
        }
      }
      throw error;
    }
    return collectModelConfig(ctx);
  });

  /** 用当前在用的内容模型发一条最小请求；不受「允许调用」开关限制，方便先测通再打开。 */
  ipcMain.handle('models:test', async () => {
    const config = { apiKey: ctx.llmApiKey(), ...writerEndpoint(readWeWriteFiles().configText) };
    if (!config.apiKey) throw new Error('还没有内容模型的 API Key');
    await requestChatContent(config, '你是连接测试。', '只输出 JSON：{"ok":true}', { label: '内容模型', timeoutMs: 30_000 });
    return { model: config.model };
  });

  /** 表单 key 留空时沿用当前在用的 key，这样「把现在这套存成预设」不用再贴一遍。 */
  ipcMain.handle('models:preset:save', (_event, input: ModelPresetInput): ModelConfigView => {
    const fallback = input?.kind === 'image' ? yamlScalar(readWeWriteFiles().configText, 'api_key') : ctx.llmApiKey();
    ctx.modelPresets.save(input, fallback);
    return collectModelConfig(ctx);
  });

  ipcMain.handle('models:preset:apply', (_event, id: string): ModelConfigView => {
    const preset = ctx.modelPresets.find(id);
    const apiKey = ctx.modelPresets.apiKey(id);
    if (!apiKey) throw new Error(`预设「${preset.name}」的 API Key 读不出来了，请重新填写 key 后再存一次`);
    if (preset.kind === 'writer') {
      // 先写 key 再改 config.yaml：key 存不进去时不留下「地址换了、key 还是旧的」的半套配置。
      ctx.secretStore.save(apiKey);
      rewriteModelConfig(ctx, draft => { draft.writer = { ...draft.writer!, baseUrl: preset.baseUrl, model: preset.model }; });
    } else {
      rewriteModelConfig(ctx, draft => {
        draft.image = { provider: preset.provider, model: preset.model, baseUrl: preset.baseUrl, apiKey, estimatedCost: preset.estimatedCost || draft.image.estimatedCost };
      });
    }
    return collectModelConfig(ctx);
  });

  ipcMain.handle('models:preset:delete', (_event, id: string): ModelConfigView => {
    ctx.modelPresets.remove(id);
    return collectModelConfig(ctx);
  });
}
