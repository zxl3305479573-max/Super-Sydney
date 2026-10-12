import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type { WeWriteConfigDraft, WeWriteEnvironment, WeWriteOverview } from '../shared';
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '../services/content-api-config';
import { resolveDefaultSubdirection, subdirectionNames } from '../services/content-taxonomy';
import {
  maskSecret, normalizeWeWriteDraft, parseChecks, parseDiagnoseFiles, parseDiagnoseFlags, parseImageConfig, parseRecommendations,
  parseStyleSummary, parseSummary, parseWechatAuthor, serializeCliConfig, serializeStyleConfig, weWriteHome, yamlBlock, yamlScalar
} from '../services/wewrite-config';
import { defaultWeWriteTheme, listLocalWeWriteThemes, readWeWriteFiles, writeWeWriteFile } from '../services/wewrite-files';
import { readContentTaxonomy } from './content-support';

/* ── 公众号配置（~/.wewrite） ──────────────────────────────────
 * style.yaml / config.yaml 是原生管道与 agent 侧 skill 共用的配置；
 * 应用只读写这两份文件，不调用 WeWrite CLI。
 */

function collectOverview(ctx: AppContext): WeWriteOverview {
  const home = weWriteHome();
  const { styleText, configText } = readWeWriteFiles(home);
  const apiKey = ctx.llmApiKey();
  const llmEnabled = ctx.settings.read().llmEnabled;
  const checks = [
    { group: 'config', name: '公众号资料', status: styleText ? 'PASS' : 'WARN', detail: styleText ? '已保存到本机' : '请填写公众号资料' },
    { group: 'config', name: 'Wechat Credentials', status: yamlScalar(configText, 'appid') && yamlScalar(configText, 'secret') ? 'PASS' : 'WARN', detail: '配置状态；实际连接由推送时验证' },
    { group: 'config', name: 'Image Api Key', status: yamlScalar(configText, 'api_key') ? 'PASS' : 'WARN', detail: '配置状态；实际连接由生图时验证' },
    { group: 'config', name: '内容生成 API', status: apiKey ? 'PASS' : 'WARN', detail: llmEnabled ? '已允许主动调用' : '请开启“允许发送到 DeepSeek”' }
  ];
  const writer = yamlBlock(configText, 'writer');
  const writerEnabled = yamlScalar(writer, 'enabled');
  return {
    writer: {
      baseUrl: yamlScalar(writer, 'base_url') || process.env.SYDNEY_LLM_BASE_URL || DEFAULT_LLM_BASE_URL,
      model: yamlScalar(writer, 'model') || process.env.SYDNEY_LLM_MODEL || DEFAULT_LLM_MODEL,
      apiKeyMasked: maskSecret(apiKey),
      enabled: writerEnabled ? writerEnabled === 'true' : llmEnabled
    },
    home,
    checks: parseChecks(checks),
    summary: parseSummary({ passed: checks.filter(item => item.status === 'PASS').length, warnings: checks.filter(item => item.status === 'WARN').length, failures: 0, skipped: 0 }),
    recommendations: parseRecommendations([]),
    files: parseDiagnoseFiles({
      config_yaml: configText !== null, style_yaml: styleText !== null,
      playbook_md: fs.existsSync(path.join(home, 'playbook.md')), history_yaml: fs.existsSync(path.join(home, 'history.yaml')),
      persona: yamlScalar(styleText, 'writing_persona'), exemplars: []
    }),
    flags: parseDiagnoseFlags({ skip_publish: !(yamlScalar(configText, 'appid') && yamlScalar(configText, 'secret')), skip_image_gen: !yamlScalar(configText, 'api_key'), needs_onboard: !styleText }),
    image: parseImageConfig(configText),
    wechat: { author: parseWechatAuthor(configText) },
    style: parseStyleSummary(styleText),
    themes: listLocalWeWriteThemes(ctx.homeDir, home)
  };
}

export function registerWeWriteIpc(ctx: AppContext): void {
  ipcMain.handle('wewrite:overview', () => collectOverview(ctx));

  ipcMain.handle('wewrite:config:save', async (_event, draft: WeWriteConfigDraft): Promise<WeWriteOverview> => {
    const home = weWriteHome();
    const normalized = normalizeWeWriteDraft(draft, readWeWriteFiles(home));
    // topics / default_topic 已经由「内容方向」统一维护，这里不拿表单里的旧值覆盖它。
    const taxonomy = readContentTaxonomy(ctx);
    normalized.style = { ...normalized.style, topics: subdirectionNames(taxonomy.directions), defaultTopic: resolveDefaultSubdirection(taxonomy).name };
    // 先落盘配置文件，再写入密钥：密钥保存失败不该让用户填的整套配置一起丢掉。
    writeWeWriteFile(path.join(home, 'style.yaml'), serializeStyleConfig(normalized.style));
    writeWeWriteFile(path.join(home, 'config.yaml'), serializeCliConfig(normalized));
    if (draft.writer?.apiKey.trim()) {
      try {
        ctx.secretStore.save(draft.writer.apiKey);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`配置已保存，但内容 API Key 未能写入系统安全存储：${detail}`);
      }
    }
    ctx.notifyWeWriteChanged();
    return collectOverview(ctx);
  });

  ipcMain.handle('wewrite:environment', async (): Promise<WeWriteEnvironment> => {
    const home = weWriteHome();
    const { styleText, configText } = readWeWriteFiles(home);
    return {
      home,
      theme: defaultWeWriteTheme(styleText),
      themes: listLocalWeWriteThemes(ctx.homeDir, home),
      configFound: configText !== null,
      styleFound: styleText !== null,
      persona: yamlScalar(styleText, 'writing_persona'),
      defaultTopic: parseStyleSummary(styleText).defaultTopic,
      wechatConfigured: Boolean(yamlScalar(configText, 'appid') && yamlScalar(configText, 'secret')),
      imageConfigured: Boolean(yamlScalar(configText, 'api_key'))
    };
  });
}
