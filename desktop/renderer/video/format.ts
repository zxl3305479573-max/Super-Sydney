import type { VideoContentStructure, VideoPlatform, VideoWorkflow } from '../../shared';

export type WorkStep = 'brief' | 'script' | 'storyboard' | 'voice' | 'visuals' | 'render' | 'cover' | 'deliver';

export type WorkflowCard = {
  value: VideoWorkflow;
  label: string;
  description: string;
  engine: string;
  detail: string;
  primary: boolean;
};

export const WORKFLOWS: WorkflowCard[] = [
  {
    value: 'script-to-video',
    label: '脚本 → 成片',
    description: '从选题、口播稿和分镜生成完整短视频。',
    engine: '本地逐帧画面 + TTS + FFmpeg',
    detail: '适合干货科普、清单拆解、口播讲解与多平台短视频。',
    primary: true
  },
  {
    value: 'product-demo',
    label: '产品宣传片',
    description: '给官网与品牌 Logo，自动抓取公开页面生成产品视频。',
    engine: '官网抓取 + TTS + FFmpeg',
    detail: '适合独立开发、AI 工具、SaaS 与产品发布演示。',
    primary: true
  },
  {
    value: 'footage-edit',
    label: '已有素材剪辑',
    description: '把已有长视频适配平台画布并整理字幕章节。',
    engine: '内置 FFmpeg 画布适配 + 可选转录',
    detail: '适合访谈、录屏粗剪、课程切片与 Vlog。',
    primary: false
  },
  {
    value: 'browser-demo',
    label: '网页操作演示',
    description: '按浏览器脚本录制点击、滚动与流程演示。',
    engine: 'Browser Recording Skill + FFmpeg',
    detail: '适合交互教程与功能 Walkthrough（需配置录制脚本）。',
    primary: false
  },
  {
    value: 'localize',
    label: '字幕与多语言',
    description: '语音识别、翻译双语/目标语字幕并压制成片。',
    engine: 'OO Fusion ASR + Subtitle Translator + FFmpeg',
    detail: '适合海外视频汉化与多语言分发（需安装并登录 OO CLI）。',
    primary: false
  }
];

export const ALL_WORK_STEPS: Array<{ value: WorkStep; label: string; hint: string }> = [
  { value: 'brief', label: '选题简报', hint: '平台、受众、热点与候选方向' },
  { value: 'script', label: '口播脚本', hint: 'AI 撰写或粘贴口播稿' },
  { value: 'storyboard', label: '分镜编排', hint: '逐镜画面、运镜与音效' },
  { value: 'voice', label: '声音字幕', hint: 'TTS 配音、试听、BGM 与 SRT' },
  { value: 'visuals', label: '画面素材', hint: '配色模板、AI 配图与关键帧预览' },
  { value: 'render', label: '成片验收', hint: '极速合成、内嵌试看与 11 项质检' },
  { value: 'cover', label: '主封面', hint: '本地大字/IP 模板、AI 或选图' },
  { value: 'deliver', label: '交付导出', hint: '导出 MP4 / 制作包或去多平台分发' }
];

const EXTERNAL_SKILL_STEPS = new Set<WorkStep>(['brief', 'voice', 'render', 'cover', 'deliver']);

export function isExternalSkillWorkflow(workflow: VideoWorkflow): boolean {
  return workflow === 'footage-edit' || workflow === 'browser-demo' || workflow === 'localize';
}

export function stepsForWorkflow(workflow: VideoWorkflow): Array<{ value: WorkStep; label: string; hint: string }> {
  if (!isExternalSkillWorkflow(workflow)) return ALL_WORK_STEPS;
  return ALL_WORK_STEPS.filter(step => EXTERNAL_SKILL_STEPS.has(step.value)).map(step => (
    step.value === 'brief'
      ? { ...step, label: '素材与参数', hint: '选择输入视频/配置与输出规格' }
      : step.value === 'voice'
        ? { ...step, label: '背景音乐', hint: '可选混入自动原创或本地 BGM' }
        : step
  ));
}

export const PLATFORMS: Array<{ value: VideoPlatform; label: string }> = [
  { value: 'douyin', label: '抖音' },
  { value: 'shipinhao', label: '视频号' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'bilibili', label: 'B 站' },
  { value: 'general', label: '通用横屏' }
];

export const CONTENT_STRUCTURES: Array<{ value: VideoContentStructure; label: string; hint: string }> = [
  { value: 'auto', label: '自动匹配', hint: '按题材自动选定一种结构并保持到底' },
  { value: 'problem', label: '问题拆解', hint: '具体痛点 → 原因拆解 → 解决判断 → 行动' },
  { value: 'steps', label: '步骤教程', hint: '明确目标 → 3–5 步实操 → 避坑提醒' },
  { value: 'list', label: '清单盘点', hint: '适用场景 → 3–5 个独立要点 → 首推动作' },
  { value: 'story', label: '场景故事', hint: '日常场景 → 冲突误区 → 关键转折 → 落地' }
];

export type VideoTopicSuggestion = {
  title: string;
  hook: string;
  angle: string;
  why: string;
  evidence: string;
  risk: string;
};

export function readVideoTopics(topicsJson: string): VideoTopicSuggestion[] {
  if (!topicsJson.trim()) return [];
  try {
    const parsed = JSON.parse(topicsJson) as { topics?: unknown };
    if (!Array.isArray(parsed?.topics)) return [];
    return parsed.topics.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const title = String(row.title ?? '').trim();
      if (!title) return [];
      return [{
        title,
        hook: String(row.hook ?? '').trim(),
        angle: String(row.angle ?? '').trim(),
        why: String(row.why ?? '').trim(),
        evidence: String(row.evidence_to_verify ?? row.evidence ?? '').trim(),
        risk: String(row.risk_note ?? row.risk ?? '').trim()
      }];
    });
  } catch {
    return [];
  }
}

/** 中文口播按约 4 字/秒估算朗读时长。 */
export function estimatedSpokenSeconds(script: string): number {
  const chars = script.replace(/\s+/g, '').length;
  return chars ? Math.max(1, Math.round(chars / 4)) : 0;
}
