import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VideoProject, VideoShot } from '../shared.ts';
import { buildSrt, buildTimeline, formatDuration, isRenderFresh, parseVideoShots, shotDurations, videoPlatformLabel } from './video-pipeline.ts';
import { shotRoleLabel } from './video-production.ts';
import { DEFAULT_AIGC_FOOTER } from './article-html.ts';

/**
 * 制作包导出：把一条视频任务落成剪辑和发布时真正要用的文件。
 *
 * 每次导出都新建独立目录，不覆盖已有内容。目录里放：
 * `制作包.md`（脚本 + 分镜表 + 说明）、`shotlist.csv`（给剪辑软件）、
 * `captions.srt`（字幕，配过音时按真实时长）、`video.mp4`（成片，渲染过且没过期才拷）、`cover.*`（封面，有才拷）。
 * 模块不代替任何平台发布——成片要人工确认后再发。
 */
export function csvCell(value: string): string {
  return `"${value.replace(/\r\n?/g, '\n').replace(/"/g, '""')}"`;
}

function formatSeconds(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** seconds 是每镜实际时长（配过音时按真实音频），缺省时用分镜估计的秒数。 */
export function buildShotListCsv(shots: VideoShot[], seconds: number[] = shots.map(shot => shot.seconds)): string {
  const header = ['镜号', '作用', '时长(秒)', '画面', '画面大字', '口播', '配图提示词'].map(csvCell).join(',');
  const rows = shots.map((shot, position) => [
    String(shot.index),
    shotRoleLabel(shot.role),
    formatSeconds(seconds[position] ?? shot.seconds),
    shot.visual,
    shot.caption,
    shot.narration,
    shot.imagePrompt ?? ''
  ].map(csvCell).join(','));
  return ['\uFEFF' + header, ...rows].join('\r\n') + '\r\n';
}

/** 制作包正文：先给脚本，再给分镜表，最后是交接说明与合规声明。 */
export function buildProductionMarkdown(project: VideoProject, shots: VideoShot[], withVideo = false): string {
  const title = project.title.trim() || project.topic.trim() || '未命名视频';
  const { seconds, voiced } = shotDurations(project, shots);
  const total = seconds.reduce((sum, value) => sum + value, 0);
  const rows = shots.map((shot, position) =>
    `| ${shot.index} | ${shotRoleLabel(shot.role) || '—'} | ${formatSeconds(seconds[position])} | ${oneLine(shot.visual)} | ${oneLine(shot.caption)} | ${oneLine(shot.narration)} |`
  ).join('\n');
  return `---
type: short-video
source: sydney-desktop
video_project_id: ${project.id}
platform: ${JSON.stringify(project.platform)}
status: ${JSON.stringify(project.status)}
target_seconds: ${project.durationSeconds}
actual_seconds: ${formatSeconds(total)}
timing: ${voiced ? '"voiced"' : '"estimated"'}
exported_at: ${JSON.stringify(new Date().toISOString())}
---

# ${title}

- 平台：${videoPlatformLabel(project.platform)}
- 目标受众：${project.audience || '未填写'}
- 目标时长：${formatDuration(project.durationSeconds)}（${project.durationSeconds} 秒）
- 分镜时长：${formatDuration(total)}（${shots.length} 个镜头，${voiced ? '按真实配音' : '估算'}）
- 成片：${withVideo ? 'video.mp4' : '未包含（没有渲染或已过期）'}
- 封面：${project.coverPath ? path.basename(project.coverPath) : '未设置'}

## 口播脚本

${project.script.trim() || '（还没有口播脚本）'}

## 分镜表

| 镜号 | 作用 | 秒 | 画面 | 画面大字 | 口播 |
| --- | --- | --- | --- | --- | --- |
${rows || '| — | — | — | — | — | — |'}

## 交接说明

- 字幕文件 captions.srt 按句切分（每行不超过 14 字）；配过音时时间轴来自真实音频，否则按分镜秒数估算。改分镜后需要重新导出。
- 分镜表另有 shotlist.csv，可直接导入剪辑软件或交给剪辑同学。
- 本模块只交付制作包与成片，不上传、不发布；成片请人工确认后再发布到平台。

## 合规说明

${DEFAULT_AIGC_FOOTER}
`;
}

function oneLine(value: string): string {
  return value.replace(/\r\n?/g, ' ').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim() || '—';
}

/**
 * 写出制作包并返回目录路径。
 * 目录名带时间戳与随机串，重复导出不会互相覆盖；中途失败时只清理本次新建的目录。
 */
export function exportVideoPackage(vault: string, project: VideoProject): string {
  const shots = parseVideoShots(project.storyboardJson);
  if (!project.script.trim()) throw new Error('请先生成或填写口播脚本，再导出制作包');
  if (!shots.length) throw new Error('请先生成分镜，再导出制作包');
  const title = project.title.trim() || project.topic.trim() || '未命名视频';
  const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || '未命名视频';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(vault, '07-视频', `${stamp}-${project.id}-${randomUUID().slice(0, 8)}-${safeTitle}`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    if (project.coverPath.trim()) {
      if (!fs.existsSync(project.coverPath)) throw new Error('封面文件不存在，请重新选择封面或清空封面后导出');
      fs.copyFileSync(project.coverPath, path.join(directory, `cover${path.extname(project.coverPath) || '.png'}`), fs.constants.COPYFILE_EXCL);
    }
    // 成片只在签名对得上、文件还在时带上：过期的旧成片和当前脚本对不上，宁可不带。
    const video = project.assets.video;
    const withVideo = Boolean(video && isRenderFresh(project) && fs.existsSync(video.path));
    if (withVideo) fs.copyFileSync(video!.path, path.join(directory, 'video.mp4'), fs.constants.COPYFILE_EXCL);
    const { seconds } = shotDurations(project, shots);
    fs.writeFileSync(path.join(directory, '制作包.md'), buildProductionMarkdown(project, shots, withVideo), { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'shotlist.csv'), buildShotListCsv(shots, seconds), { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'captions.srt'), buildSrt(buildTimeline(shots, seconds).lines), { encoding: 'utf8', flag: 'wx' });
    return directory;
  } catch (error) {
    // 只清理本次刚创建的目录：路径在函数内拼出来，且导出前该目录必然不存在。
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
