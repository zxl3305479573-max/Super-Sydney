import type { VideoStage } from '../../shared';
import type { VideoStep } from '../../services/video-pipeline';

/** 视频流水线界面用的标签与格式化工具（纯函数，无 React）。 */

export const stageLabels: Record<VideoStage, string> = { topics: 'AI 生成候选选题', script: 'AI 写口播脚本', storyboard: 'AI 拆分镜' };
export const statusNames: Record<string, string> = { idea: '选题', script: '已定脚本', storyboard: '已定分镜', exported: '已导出制作包' };
export const stateNames: Record<VideoStep['state'], string> = { done: '已完成', current: '当前步骤', attention: '需处理', ready: '可进行', locked: '未解锁' };

export type TopicSuggestion = { title: string; hook: string; angle: string; risk: string };

export function readTopics(value: string): TopicSuggestion[] {
  try {
    const parsed = JSON.parse(value) as { topics?: Array<Record<string, unknown>> };
    return (parsed.topics ?? []).filter(item => typeof item?.title === 'string').map(item => ({
      title: String(item.title),
      hook: String(item.hook ?? ''),
      angle: String(item.angle ?? ''),
      risk: String(item.risk_note ?? item.risk ?? '')
    }));
  } catch { return []; }
}

/** 口播字数 → 估算秒数（中文口播约每秒 4 字），用来判断脚本是否撑得起目标时长。 */
export function estimatedSeconds(script: string): number {
  return Math.round(script.replace(/\s/g, '').length / 4);
}
