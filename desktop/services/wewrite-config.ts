import type { WeWriteCheck, WeWriteConfigDraft, WeWriteSummary } from '../shared.ts';

/**
 * WeWrite 配置的纯解析层。
 *
 * 有意不引入 YAML 依赖：这里只解析 style.yaml / config.yaml 中我们自己书写的
 * 简单结构（标量键、缩进列表、缩进块），遇到任何不符合预期的形状都返回空值，
 * 不会抛错，也不会误读成别的值。
 */

const SCALAR_KEYS = '[A-Za-z_][A-Za-z0-9_]*';

export function maskSecret(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 5)}••••${trimmed.slice(-4)}`;
}

/**
 * 读取一个标量值。
 *
 * 必须能处理 serializer 用 JSON.stringify 写出的双引号字符串：
 *   - `#` 在引号内是内容，不是注释
 *   - `\"` `\\` `\n` `\uXXXX` 等转义要还原
 * 朴素地 split('#') 会把带井号的引号字符串截断，所以先判断引号形式。
 */
export function stripScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return readDoubleQuoted(trimmed);
  if (trimmed.startsWith("'")) return readSingleQuoted(trimmed);
  return trimmed.split('#')[0].trim();
}

function readDoubleQuoted(value: string): string {
  let out = '';
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      const next = value[index + 1] ?? '';
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === 'u') {
        const hex = value.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); index += 4; }
      } else out += next;
      index += 1;
      continue;
    }
    if (char === '"') return out;
    out += char;
  }
  return out;
}

function readSingleQuoted(value: string): string {
  let out = '';
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'") {
      if (value[index + 1] === "'") { out += "'"; index += 1; continue; }
      return out;
    }
    out += char;
  }
  return out;
}

/** 读取 `key: value` 形式的标量。注释行以 # 开头，不会被 ^\s*key 匹配。 */
export function yamlScalar(source: string | null, key: string, from = 1): string {
  if (!source) return '';
  let rest = source;
  if (from > 1) {
    // 同名键（如 topics 同时出现在内容方向与 blacklist 下）需要从第 N 次出现开始找。
    const pattern = new RegExp(`^\\s*${SCALAR_KEYS}\\s*:\\s*(#.*)?$`, 'gm');
    let match: RegExpExecArray | null;
    let seen = 0;
    while ((match = pattern.exec(source)) !== null && seen < from - 1) seen += 1;
    if (match) rest = source.slice(match.index + match[0].length);
  }
  const match = rest.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'm'));
  return match ? stripScalar(match[1]) : '';
}

/** 取出 `key:` 之下缩进更深的内容块（用于 blacklist 这类嵌套结构）。 */
export function yamlBlock(source: string | null, key: string): string {
  if (!source) return '';
  const lines = source.split(/\r?\n/);
  const headerIndex = lines.findIndex(line => new RegExp(`^\\s*${key}\\s*:\\s*(#.*)?$`).test(line));
  if (headerIndex === -1) return '';
  const headerIndent = (lines[headerIndex].match(/^\s*/) ?? [''])[0].length;
  const block: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) { block.push(line); continue; }
    const indent = (line.match(/^\s*/) ?? [''])[0].length;
    if (indent <= headerIndent) break;
    block.push(line.slice(headerIndent + 1));
  }
  return block.join('\n');
}

/** 读取 `key:` 下的 `- item` 列表。 */
export function yamlList(source: string | null, key: string): string[] {
  const block = yamlBlock(source, key);
  if (!block) return [];
  return block
    .split(/\r?\n/)
    .map(line => line.match(/^\s*-\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map(match => stripScalar(match[1]))
    .filter(Boolean);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** 归一化 `wewrite diagnose --json` 的 checks 数组。 */
export function parseChecks(value: unknown): WeWriteCheck[] {
  return list(value)
    .map(entry => {
      const item = record(entry);
      return { group: text(item.group), name: text(item.name), status: text(item.status).toUpperCase(), detail: text(item.detail) };
    })
    .filter(check => check.name);
}

/** 归一化 `wewrite diagnose --json` 的 summary。 */
export function parseSummary(value: unknown): WeWriteSummary {
  const item = record(value);
  return {
    passed: num(item.passed),
    warnings: num(item.warnings),
    failures: num(item.failures),
    skipped: num(item.skipped),
    antiAiLevel: text(item.anti_ai_level),
    antiAiScore: num(item.anti_ai_score),
    antiAiMax: num(item.anti_ai_max),
    styleSetupLevel: text(item.style_setup_level),
    styleSetupScore: num(item.style_setup_score),
    styleSetupMax: num(item.style_setup_max)
  };
}

/** 归一化 diagnose 的 files 段。 */
export function parseDiagnoseFiles(value: unknown): { configYaml: boolean; styleYaml: boolean; playbookMd: boolean; historyYaml: boolean; persona: string; exemplarCount: number } {
  const item = record(value);
  return {
    configYaml: bool(item.config_yaml),
    styleYaml: bool(item.style_yaml),
    playbookMd: bool(item.playbook_md),
    historyYaml: bool(item.history_yaml),
    persona: text(item.persona),
    exemplarCount: list(item.exemplars).length
  };
}

/** 归一化 diagnose 的 flags 段。这些 flag 直接反映"哪些外部能力当前不可用"。 */
export function parseDiagnoseFlags(value: unknown): { skipPublish: boolean; skipImageGen: boolean; useWriterModel: boolean; needsOnboard: boolean } {
  const item = record(value);
  return {
    skipPublish: bool(item.skip_publish),
    skipImageGen: bool(item.skip_image_gen),
    useWriterModel: bool(item.use_writer_model),
    needsOnboard: bool(item.needs_onboard)
  };
}

export function parseRecommendations(value: unknown): string[] {
  return list(value).map(text).filter(Boolean);
}

/** 统计任务状态。 */
export function countRuns(states: unknown[]): { total: number; active: number; completed: number; failed: number } {
  const counts = { total: 0, active: 0, completed: 0, failed: 0 };
  for (const entry of states) {
    const status = text(record(entry).status);
    counts.total += 1;
    if (status === 'completed') counts.completed += 1;
    else if (status === 'failed') counts.failed += 1;
    else counts.active += 1;
  }
  return counts;
}

/** 从 style.yaml / config.yaml 组装风格与图片服务摘要。 */
export function parseStyleSummary(style: string | null): {
  name: string; industry: string; targetAudience: string; tone: string; voice: string;
  wordCount: string; contentStyle: string; persona: string; theme: string; author: string; defaultTopic: string;
  topics: string[]; blacklistWords: string[]; blacklistTopics: string[];
} {
  const blacklist = yamlBlock(style, 'blacklist');
  return {
    name: yamlScalar(style, 'name'),
    industry: yamlScalar(style, 'industry'),
    targetAudience: yamlScalar(style, 'target_audience'),
    tone: yamlScalar(style, 'tone'),
    voice: yamlScalar(style, 'voice'),
    wordCount: yamlScalar(style, 'word_count'),
    contentStyle: yamlScalar(style, 'content_style'),
    persona: yamlScalar(style, 'writing_persona'),
    theme: yamlScalar(style, 'theme'),
    author: yamlScalar(style, 'author'),
    // 不回落成 topics[0]：面板里的“未指定”必须能真正存下来并原样读回来。
    defaultTopic: yamlScalar(style, 'default_topic'),
    topics: yamlList(style, 'topics'),
    blacklistWords: yamlList(blacklist, 'words'),
    blacklistTopics: yamlList(blacklist, 'topics')
  };
}

/** 读取 config.yaml 的 wechat.author（草稿默认署名）；与 style.yaml 的 author 是两个独立字段。 */
export function parseWechatAuthor(config: string | null): string {
  return yamlScalar(yamlBlock(config, 'wechat'), 'author');
}

export function parseImageConfig(config: string | null): { provider: string; model: string; baseUrl: string; apiKeyMasked: string; estimatedCost: string } {
  return {
    provider: yamlScalar(config, 'provider'),
    model: yamlScalar(config, 'model'),
    baseUrl: yamlScalar(config, 'base_url'),
    apiKeyMasked: maskSecret(yamlScalar(config, 'api_key')),
    estimatedCost: yamlScalar(config, 'estimated_cost_per_image')
  };
}

export function normalizeImageCost(value: string): string {
  const text = value.trim();
  if (!text) return '0';
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) throw new Error('图片预估单价必须是非负数');
  return text;
}

/**
 * 「环境与配置」保存时的归一化，独立成纯函数以便单测。
 *
 * 两条规则：
 * 1. 密钥字段（AppSecret / 图片 API Key / 内容 API Key）界面永远拿不到明文，留空即沿用磁盘旧值。
 * 2. 其余字段原样写入，不做补值。此前 default_topic 会回落成 topics[0]，
 *    用户把「默认类别」选成“未指定”后保存又会被改回第一个内容方向。
 */
export function normalizeWeWriteDraft(draft: WeWriteConfigDraft, current: { styleText: string | null; configText: string | null }): WeWriteConfigDraft {
  const wechat = yamlBlock(current.configText, 'wechat');
  const image = yamlBlock(current.configText, 'image');
  return {
    // 内容 API Key 走系统安全存储，不写进 YAML；这里只清除回传的占位明文。
    writer: draft.writer ? { ...draft.writer, apiKey: '' } : undefined,
    style: {
      ...draft.style,
      defaultTopic: draft.style.defaultTopic.trim()
    },
    wechat: {
      ...draft.wechat,
      appid: draft.wechat.appid.trim() || yamlScalar(wechat, 'appid'),
      secret: draft.wechat.secret.trim() || yamlScalar(wechat, 'secret'),
      author: draft.wechat.author.trim()
    },
    image: {
      ...draft.image,
      provider: draft.image.provider.trim(),
      model: draft.image.model.trim(),
      baseUrl: draft.image.baseUrl.trim(),
      apiKey: draft.image.apiKey.trim() || yamlScalar(image, 'api_key'),
      estimatedCost: normalizeImageCost(draft.image.estimatedCost)
    }
  };
}

function yamlQuote(value: string): string {
  return JSON.stringify(value ?? '');
}

function yamlListBlock(key: string, values: string[], indent = ''): string {
  const rows = values.filter(Boolean).map(value => `${indent}  - ${yamlQuote(value)}`);
  return `${indent}${key}:\n${rows.length ? rows.join('\n') : `${indent}  []`}`;
}

/** 生成我们自己维护的 style.yaml，避免把用户输入直接拼成未转义 YAML。 */
export function serializeStyleConfig(style: WeWriteConfigDraft['style']): string {
  const topics = [...new Set([style.defaultTopic, ...style.topics].filter(Boolean))];
  return [
    '# Sydney / WeWrite 中老年健康公众号配置',
    `name: ${yamlQuote(style.name)}`,
    `industry: ${yamlQuote(style.industry)}`,
    `target_audience: ${yamlQuote(style.targetAudience)}`,
    yamlListBlock('topics', topics),
    `tone: ${yamlQuote(style.tone)}`,
    `voice: ${yamlQuote(style.voice)}`,
    `word_count: ${yamlQuote(style.wordCount)}`,
    `content_style: ${yamlQuote(style.contentStyle)}`,
    `writing_persona: ${yamlQuote(style.persona)}`,
    `default_topic: ${yamlQuote(style.defaultTopic)}`,
    'blacklist:',
    yamlListBlock('words', style.blacklistWords, '  '),
    yamlListBlock('topics', style.blacklistTopics, '  '),
    `theme: ${yamlQuote(style.theme)}`,
    `author: ${yamlQuote(style.author)}`,
    ''
  ].join('\n');
}

/** 生成 CLI 配置；调用方应在此之前用旧值填回未修改的敏感字段。 */
export function serializeCliConfig(config: WeWriteConfigDraft): string {
  return [
    '# WeWrite configuration generated by Sydney',
    'wechat:',
    `  appid: ${yamlQuote(config.wechat.appid)}`,
    `  secret: ${yamlQuote(config.wechat.secret)}`,
    `  author: ${yamlQuote(config.wechat.author)}`,
    'image:',
    `  provider: ${yamlQuote(config.image.provider)}`,
    `  api_key: ${yamlQuote(config.image.apiKey)}`,
    `  base_url: ${yamlQuote(config.image.baseUrl)}`,
    `  model: ${yamlQuote(config.image.model)}`,
    `  estimated_cost_per_image: ${normalizeImageCost(config.image.estimatedCost)}`,
    `theme: ${yamlQuote(config.style.theme)}`,
    ...(config.writer ? ['writer:', `  base_url: ${yamlQuote(config.writer.baseUrl)}`, `  model: ${yamlQuote(config.writer.model)}`, `  enabled: ${config.writer.enabled}`] : []),
    ''
  ].join('\n');
}
