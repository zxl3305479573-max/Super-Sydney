import type { WeWriteConfigDraft, WeWriteOverview } from '../shared';

/**
 * 「环境与配置」与「创作设置」共用同一份草稿。
 *
 * 两处表单写的是同一份 ~/.wewrite/style.yaml + config.yaml，如果各自维护一份
 * 字段映射，加字段时必然漏掉一处并静默丢值，所以映射只留在这里。
 */
export function emptyWeWriteDraft(): WeWriteConfigDraft {
  return {
    style: {
      name: '', industry: '', targetAudience: '', tone: '', voice: '', wordCount: '', contentStyle: '',
      persona: '', theme: '', author: '', topics: [], defaultTopic: '', blacklistWords: [], blacklistTopics: []
    },
    wechat: { appid: '', secret: '', author: '' },
    writer: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', enabled: false },
    image: { provider: '', model: '', baseUrl: '', apiKey: '', estimatedCost: '' }
  };
}

/**
 * 敏感字段主进程只回传掩码，所以这里始终留空；留空表示保留原值。
 */
export function weWriteDraftFromOverview(overview: WeWriteOverview): WeWriteConfigDraft {
  return {
    style: {
      name: overview.style.name,
      industry: overview.style.industry,
      targetAudience: overview.style.targetAudience,
      tone: overview.style.tone,
      voice: overview.style.voice,
      wordCount: overview.style.wordCount,
      contentStyle: overview.style.contentStyle,
      persona: overview.style.persona || overview.files.persona,
      theme: overview.style.theme,
      author: overview.style.author,
      topics: overview.style.topics,
      defaultTopic: overview.style.defaultTopic,
      blacklistWords: overview.style.blacklistWords,
      blacklistTopics: overview.style.blacklistTopics
    },
    // 草稿默认署名来自 config.yaml 的 wechat.author，不是 style.yaml 的 author：
    // 以前这里回落到 style.author，导致用户在「草稿默认署名」里填的值保存后又被界面改回去，
    // 下一次保存还会把它覆盖掉。
    // 用可选链：主进程与渲染进程版本短暂不一致时（例如只热重载了界面），
    // 也不该让整个面板因为少一个字段而打不开。
    wechat: { appid: '', secret: '', author: overview.wechat?.author ?? '' },
    writer: { ...overview.writer, apiKey: '' },
    image: {
      provider: overview.image.provider,
      model: overview.image.model,
      baseUrl: overview.image.baseUrl,
      apiKey: '',
      estimatedCost: overview.image.estimatedCost
    }
  };
}

/** 多行文本 ↔ 列表：每行一项，忽略空行。 */
export function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}
