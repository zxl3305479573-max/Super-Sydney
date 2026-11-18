import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  FeishuConfigDraft,
  FeishuConfigView,
  FeishuNotifySettings,
  OpsEpisodeReview,
  OpsOverviewView,
  OpsPlatform,
  VideoPublishResultItem
} from '../shared.ts';
import { writeFileAtomic } from './atomic-file.ts';
import { OPS_PLATFORM_LABELS } from './ops-store.ts';
import { resolveLlmApiKey, type SecretStore } from './secret-store.ts';

/**
 * 飞书群机器人通知服务：Webhook 与加签密钥加密保存，发送彩色交互卡片。
 *
 * 覆盖四类卡片：
 * 1. 草稿就绪提醒（国内四平台填好草稿后喊人勾选原创并点发布）
 * 2. 创作者后台登录失效提醒
 * 3. 全平台粉丝与作品数据日报
 * 4. 单期第 1 / 3 / 7 天同龄对比复盘卡片
 */

let feishuFetch: typeof fetch = (...args) => fetch(...args);

/** 在主进程启动时注入 Electron net.fetch，确保系统代理环境下也能稳定发出请求。 */
export function useFeishuFetch(impl: typeof fetch): void {
  feishuFetch = impl;
}

export const DEFAULT_FEISHU_SETTINGS: FeishuNotifySettings = {
  notifyOnDraft: true,
  notifyOnLoginExpired: true,
  notifyDailyReport: false,
  notifyMilestoneReview: true
};

const SETTINGS_FILE = 'feishu-notify.json';

export function readFeishuSettings(dataDir: string): FeishuNotifySettings {
  const file = path.join(dataDir, SETTINGS_FILE);
  if (!fs.existsSync(file)) return { ...DEFAULT_FEISHU_SETTINGS };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FeishuNotifySettings>;
    return {
      notifyOnDraft: typeof parsed.notifyOnDraft === 'boolean' ? parsed.notifyOnDraft : DEFAULT_FEISHU_SETTINGS.notifyOnDraft,
      notifyOnLoginExpired: typeof parsed.notifyOnLoginExpired === 'boolean' ? parsed.notifyOnLoginExpired : DEFAULT_FEISHU_SETTINGS.notifyOnLoginExpired,
      notifyDailyReport: typeof parsed.notifyDailyReport === 'boolean' ? parsed.notifyDailyReport : DEFAULT_FEISHU_SETTINGS.notifyDailyReport,
      notifyMilestoneReview: typeof parsed.notifyMilestoneReview === 'boolean' ? parsed.notifyMilestoneReview : DEFAULT_FEISHU_SETTINGS.notifyMilestoneReview
    };
  } catch {
    return { ...DEFAULT_FEISHU_SETTINGS };
  }
}

export function writeFeishuSettings(dataDir: string, patch: Partial<FeishuNotifySettings>): FeishuNotifySettings {
  const next = { ...readFeishuSettings(dataDir), ...patch };
  writeFileAtomic(path.join(dataDir, SETTINGS_FILE), JSON.stringify(next, null, 2));
  return next;
}

export function validateFeishuWebhookUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('飞书机器人 Webhook 地址不能为空');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('飞书 Webhook 地址格式不正确');
  }
  if (parsed.protocol !== 'https:') throw new Error('飞书 Webhook 地址必须使用 https://');
  if (!/(^|\.)(feishu\.cn|larksuite\.com)$/i.test(parsed.hostname) || !parsed.pathname.includes('/open-apis/bot/v2/hook/')) {
    throw new Error('只接受飞书 / Lark 官方自定义机器人地址（含 /open-apis/bot/v2/hook/）');
  }
  return parsed.toString();
}

export function getFeishuConfigView(
  dataDir: string,
  webhookStore: SecretStore,
  secretStore: SecretStore
): FeishuConfigView {
  return {
    webhook: webhookStore.getStatus(),
    secret: secretStore.getStatus(),
    settings: readFeishuSettings(dataDir)
  };
}

export function saveFeishuConfig(
  dataDir: string,
  webhookStore: SecretStore,
  secretStore: SecretStore,
  draft: FeishuConfigDraft
): FeishuConfigView {
  if (draft.webhookUrl !== undefined) {
    const url = draft.webhookUrl.trim();
    if (url === '') webhookStore.remove();
    else webhookStore.save(validateFeishuWebhookUrl(url));
  }
  if (draft.signingSecret !== undefined) {
    const secret = draft.signingSecret.trim();
    if (secret === '') secretStore.remove();
    else secretStore.save(secret);
  }
  if (draft.settings) {
    writeFeishuSettings(dataDir, draft.settings);
  }
  return getFeishuConfigView(dataDir, webhookStore, secretStore);
}

/** 飞书自定义机器人加签算法：key = `${timestamp}\n${secret}`，对空串算 HMAC-SHA256 Base64。 */
export function computeFeishuSign(timestampSeconds: number | string, secret: string): string {
  const stringToSign = `${timestampSeconds}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

export type FeishuCardTemplateColor = 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey';

export type FeishuCardSpec = {
  title: string;
  color: FeishuCardTemplateColor;
  sections: string[];
  footer?: string;
};

export function buildInteractivePayload(card: FeishuCardSpec, secret = '', nowMs = Date.now()): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  card.sections.forEach((markdown, index) => {
    if (index > 0) elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: markdown });
  });
  if (card.footer) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: card.footer }]
    });
  }

  const payload: Record<string, unknown> = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: card.color,
        title: { tag: 'plain_text', content: card.title }
      },
      elements
    }
  };

  if (secret.trim()) {
    const timestamp = String(Math.floor(nowMs / 1000));
    payload.timestamp = timestamp;
    payload.sign = computeFeishuSign(timestamp, secret.trim());
  }
  return payload;
}

export async function sendFeishuCard(
  webhookUrl: string,
  card: FeishuCardSpec,
  options: { secret?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<void> {
  const url = validateFeishuWebhookUrl(webhookUrl);
  const body = JSON.stringify(buildInteractivePayload(card, options.secret ?? ''));
  const impl = options.fetchImpl ?? feishuFetch;
  const response = await impl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
  });

  if (!response.ok) {
    throw new Error(`飞书卡片推送失败（HTTP ${response.status}）`);
  }
  const result = await response.json().catch(() => ({})) as { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string };
  const code = result.code ?? result.StatusCode ?? 0;
  if (code !== 0) {
    throw new Error(`飞书机器人返回错误（${code}）：${result.msg || result.StatusMessage || '未知错误'}`);
  }
}

export function resolveFeishuCredentials(webhookStore: SecretStore, secretStore: SecretStore): { webhookUrl: string; secret: string } {
  return {
    webhookUrl: resolveLlmApiKey(webhookStore.read(), process.env.SYDNEY_FEISHU_WEBHOOK || ''),
    secret: resolveLlmApiKey(secretStore.read(), process.env.SYDNEY_FEISHU_SECRET || '')
  };
}

/* ── 四类业务卡片构建纯函数 ───────────────────────────────────── */

function formatSigned(value: number | null | undefined): string {
  if (value == null) return '—';
  return value > 0 ? `+${value}` : String(value);
}

function formatPercent(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  const pct = (ratio * 100).toFixed(1);
  return ratio > 0 ? `+${pct}%` : `${pct}%`;
}

export function buildDraftReadyCard(projectTitle: string, items: VideoPublishResultItem[]): FeishuCardSpec {
  const drafts = items.filter(item => item.status === 'draft');
  const failed = items.filter(item => item.status === 'failed');
  const lines = items.map(item => {
    const name = OPS_PLATFORM_LABELS[item.platform] ?? item.platform;
    if (item.locked) return `- 🔒 **${name}**：已在防重保护状态，跳过重传（${item.message}）`;
    if (item.status === 'draft') {
      const coverNote = item.coverUploaded ? '含封面' : '请核对封面';
      return `- ✅ **${name}**：草稿已填好（${coverNote}）— 标题「${item.title}」`;
    }
    return `- ❌ **${name}**：${item.message}`;
  });

  return {
    title: failed.length
      ? `⚠️ 多平台草稿部分完成｜${projectTitle}`
      : `📬 草稿已就绪，请人工点发布｜${projectTitle}`,
    color: failed.length ? 'yellow' : 'wathet',
    sections: [
      `**已完成草稿填充 ${drafts.length}/${items.length} 个平台**`,
      lines.join('\n'),
      '请回到 **Super-Sydney → 视频工作台 → 发布窗口**，检查原创声明与定时设置后手动点击最终「发布」按钮。'
    ],
    footer: 'Super-Sydney 运营中控 · 国内平台遵守人工确认红线，不自动代点最终发布'
  };
}

export function buildLoginExpiredCard(platforms: OpsPlatform[]): FeishuCardSpec {
  const names = platforms.map(p => `**${OPS_PLATFORM_LABELS[p] ?? p}**`).join('、');
  return {
    title: '🔑 创作者后台登录已失效',
    color: 'orange',
    sections: [
      `检测到以下平台的创作者中心需要重新扫码登录：${names}`,
      '请打开 **Super-Sydney** 对应平台的内置发布窗口扫码，恢复后即可继续填草稿或同步数据。'
    ],
    footer: 'Super-Sydney 运营中控 · 不保存任何账号密码'
  };
}

export function buildDailyReportCard(overview: OpsOverviewView): FeishuCardSpec {
  const platformLines = overview.platforms.map(item => {
    const total = item.totalFollowers != null ? item.totalFollowers.toLocaleString('zh-CN') : '未同步';
    return `- **${item.label}**：粉丝 **${total}**（今日 ${formatSigned(item.todayNet)}，近 7 日 ${formatSigned(item.weekNet)}）｜已发 ${item.publishedCount} 期`;
  });

  const sections = [
    `**全平台总粉丝：${overview.totalFollowers.toLocaleString('zh-CN')}**（今日净增 **${formatSigned(overview.todayNetFollowers)}**，近 7 日 **${formatSigned(overview.weekNetFollowers)}**）\n\n${platformLines.join('\n')}`
  ];

  if (overview.latestEpisode) {
    const ep = overview.latestEpisode;
    sections.push(
      `**最新一期《${ep.episode.title}》（第 ${ep.ageDays} 天）**\n播放 **${ep.totalViews.toLocaleString('zh-CN')}** · 互动 **${ep.totalInteractions.toLocaleString('zh-CN')}** · 综合互动率 **${ep.overallEngageRate != null ? `${(ep.overallEngageRate * 100).toFixed(1)}%` : '—'}**`
    );
  }

  const ext = overview.externalSummary;
  if (ext.wechatArticles > 0 || ext.xhsNotes > 0) {
    sections.push(
      `**图文模块汇总**\n- 公众号：累计导入 ${ext.wechatArticles} 篇，总阅读 ${ext.wechatTotalReads.toLocaleString('zh-CN')}\n- 小红书笔记表：累计 ${ext.xhsNotes} 篇，总观看 ${ext.xhsTotalViews.toLocaleString('zh-CN')}，总赞 ${ext.xhsTotalLikes.toLocaleString('zh-CN')}`
    );
  }

  return {
    title: `🌾 Super-Sydney 跨平台运营日报（${new Date().toLocaleDateString('zh-CN')}）`,
    color: 'green',
    sections,
    footer: 'Super-Sydney 运营中控'
  };
}

export function buildEpisodeReviewCard(review: OpsEpisodeReview): FeishuCardSpec {
  const deltaText = review.totalViewsDeltaRatio != null ? `（较上期同龄 ${formatPercent(review.totalViewsDeltaRatio)}）` : '';
  const summary = [
    `**第 ${review.ageDays} 天累计播放：${review.totalViews.toLocaleString('zh-CN')}** ${deltaText}`,
    `总互动：**${review.totalInteractions.toLocaleString('zh-CN')}** ｜ 综合互动率：**${review.overallEngageRate != null ? `${(review.overallEngageRate * 100).toFixed(1)}%` : '—'}** ｜ 期间全平台净涨粉：**${formatSigned(review.periodFollowerGain)}**`,
    `_${review.comparisonNote}_`
  ].join('\n');

  const rows = review.platforms.map(item => {
    const views = item.views != null ? item.views.toLocaleString('zh-CN') : '—';
    const share = item.viewShare != null ? `${(item.viewShare * 100).toFixed(0)}%` : '—';
    const engage = item.engageRate != null ? `${(item.engageRate * 100).toFixed(1)}%` : '—';
    const vsPrev = item.viewsDeltaRatio != null ? `同龄 ${formatPercent(item.viewsDeltaRatio)}` : '无上期样本';
    return `- **${item.label}**：播放 **${views}**（占比 ${share}）｜互动率 ${engage}｜${vsPrev}`;
  });

  return {
    title: `📊 单期同龄复盘（第 ${review.ageDays} 天）｜${review.episode.title}`,
    color: 'purple',
    sections: [summary, rows.join('\n')],
    footer: `采样日期 ${review.reviewDay} · Super-Sydney 运营中控`
  };
}
