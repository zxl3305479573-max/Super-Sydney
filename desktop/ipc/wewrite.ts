import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import type { AppContext } from '../app-context';
import type { WeWriteConfigDraft, WeWriteEnvironment, WeWriteOverview } from '../shared';
import { writerEndpoint } from '../services/content-api-config';
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
    { group: 'config', name: '内容生成 API', status: apiKey ? 'PASS' : 'WARN', detail: llmEnabled ? '已允许主动调用' : '请在「设置 → 模型」里允许调用内容模型' }
  ];
  const writer = writerEndpoint(configText);
  return {
    writer: {
      ...writer,
      apiKeyMasked: maskSecret(apiKey),
      enabled: llmEnabled
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

/**
 * 用当前文件内容拼出一份完整草稿：只改 writer 或 image 一段时，其余（微信凭证、主题等）原样写回。
 * 密钥字段留空，由 normalizeWeWriteDraft 从 config.yaml 补回。
 */
function currentDraft(ctx: AppContext): WeWriteConfigDraft {
  const overview = collectOverview(ctx);
  return {
    style: overview.style,
    wechat: { appid: '', secret: '', author: overview.wechat.author },
    writer: { baseUrl: overview.writer.baseUrl, model: overview.writer.model, apiKey: '', enabled: overview.writer.enabled },
    image: { provider: overview.image.provider, model: overview.image.model, baseUrl: overview.image.baseUrl, apiKey: '', estimatedCost: overview.image.estimatedCost }
  };
}

/**
 * 改写 config.yaml 里的模型段（「设置 → 模型」用）：mutate 只动 writer / image，其余照当前文件写回。
 * image.apiKey 留空表示保留 config.yaml 里现有的 key。
 */
export function rewriteModelConfig(ctx: AppContext, mutate: (draft: WeWriteConfigDraft) => void): void {
  const home = weWriteHome();
  const draft = currentDraft(ctx);
  mutate(draft);
  writeWeWriteFile(path.join(home, 'config.yaml'), serializeCliConfig(normalizeWeWriteDraft(draft, readWeWriteFiles(home))));
  ctx.notifyWeWriteChanged();
}

export function registerWeWriteIpc(ctx: AppContext): void {
  ipcMain.handle('wewrite:overview', () => collectOverview(ctx));

  ipcMain.handle('wewrite:config:save', async (_event, draft: WeWriteConfigDraft): Promise<WeWriteOverview> => {
    const home = weWriteHome();
    // 模型段统一在「设置 → 模型」维护：这里一律按当前文件写回，不拿表单里可能过期的值覆盖。
    const current = currentDraft(ctx);
    const normalized = normalizeWeWriteDraft({ ...draft, writer: current.writer, image: current.image }, readWeWriteFiles(home));
    // topics / default_topic 已经由「内容方向」统一维护，这里不拿表单里的旧值覆盖它。
    const taxonomy = readContentTaxonomy(ctx);
    normalized.style = { ...normalized.style, topics: subdirectionNames(taxonomy.directions), defaultTopic: resolveDefaultSubdirection(taxonomy).name };
    writeWeWriteFile(path.join(home, 'style.yaml'), serializeStyleConfig(normalized.style));
    writeWeWriteFile(path.join(home, 'config.yaml'), serializeCliConfig(normalized));
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
