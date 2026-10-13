import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ContentTask } from '../shared.ts';
import { assertContentDeliverable, deliverableArticle, isContentPublishable, type ContentDeliveryOptions } from './content-policy.ts';
import { DEFAULT_AIGC_FOOTER } from './article-html.ts';
import { renderEvidenceSection } from './evidence-section.ts';
import { matchImageLine } from './content-images.ts';
// 来源解析单独成纯模块（渲染进程也要用），这里继续导出以兼容既有调用方。
export { parseContentSources } from './content-sources.ts';
export type { ContentSourceRecord } from './content-sources.ts';

/**
 * 每次导出均创建独立文件，绝不覆盖现有知识库笔记或附件。
 *
 * allowUnreviewed 只应在界面二次确认后传入：审稿未通过时用当前初稿导出。
 */
export function exportContentArticle(vault: string, task: ContentTask, options: ContentDeliveryOptions = {}): string {
  assertContentDeliverable(task, options);
  const title = task.title.trim() || '未命名文章';
  const safeTitle = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名文章';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stem = `${stamp}-${task.id}-${randomUUID().slice(0, 8)}-${safeTitle}`;
  const directory = path.join(vault, '06-公众号');
  const target = path.join(directory, `${stem}.md`);
  fs.mkdirSync(directory, { recursive: true });
  let cover = '';
  let coverTarget = '';
  const copiedAssets: string[] = [];
  try {
    if (task.coverPath) {
      if (!fs.existsSync(task.coverPath)) throw new Error('封面文件不存在，请重新选择封面或清空封面后导出');
      const assets = path.join(directory, 'assets');
      fs.mkdirSync(assets, { recursive: true });
      coverTarget = path.join(assets, `${stem}${path.extname(task.coverPath) || '.png'}`);
      fs.copyFileSync(task.coverPath, coverTarget, fs.constants.COPYFILE_EXCL);
      cover = `![封面](<assets/${path.basename(coverTarget)}>)\n\n`;
    }
    // 与预览、推送共用同一份「来源与证据」块；知识库笔记是给自己看的，额外保留待核实主张清单。
    const evidence = renderEvidenceSection(task, { withClaims: true, allSources: true }) || '## 来源与证据\n\n暂无来源记录。';
    const article = deliverableArticle(task, options.allowUnreviewed);
    const reviewed = isContentPublishable(task);
    // 正文配图随笔记一起复制到 assets/，否则知识库里的绝对路径一换机器就失效。
    const assets = path.join(directory, 'assets');
    const renamed = new Map<string, string>();
    for (const image of listLocalInlineImages(article)) {
      if (renamed.has(image.source)) continue;
      if (!fs.existsSync(image.source)) throw new Error(`正文配图不存在，请重新生成或删除：${path.basename(image.source)}`);
      fs.mkdirSync(assets, { recursive: true });
      const name = `${stem}-${randomUUID().slice(0, 8)}${path.extname(image.source) || '.png'}`;
      const copied = path.join(assets, name);
      fs.copyFileSync(image.source, copied, fs.constants.COPYFILE_EXCL);
      copiedAssets.push(copied);
      renamed.set(image.source, name);
    }
    // 把正文里的本地图片路径换成知识库内的相对路径。
    const articleForExport = article.split('\n').map(line => {
      const image = matchImageLine(line);
      const name = image ? renamed.get(image.source) : undefined;
      return name ? `![${image!.caption}](<assets/${name}>)` : line;
    }).join('\n');
    // 导出的元数据带上两级内容方向，方便在知识库里按方向检索。
    const body = `---\ntype: wechat-article\nsource: sydney-desktop\ncontent_task_id: ${task.id}\ndirection: ${JSON.stringify(task.directionName)}\nsubdirection: ${JSON.stringify(task.subdirectionName)}\nstatus: ${JSON.stringify(task.status)}\nreviewed: ${reviewed}\nexported_at: ${JSON.stringify(new Date().toISOString())}\n---\n\n# ${title}\n\n${cover}${articleForExport}\n\n${evidence}\n\n## 合规说明\n\n${DEFAULT_AIGC_FOOTER}\n`;
    fs.writeFileSync(target, body, { encoding: 'utf8', flag: 'wx' });
    return target;
  } catch (error) {
    if (coverTarget && fs.existsSync(coverTarget)) fs.rmSync(coverTarget);
    for (const asset of copiedAssets) if (fs.existsSync(asset)) fs.rmSync(asset);
    throw error;
  }
}

/** 导出需要搬运的是本地图片；已经是 http(s) 地址的保持原样。 */
function listLocalInlineImages(markdown: string): Array<{ caption: string; source: string }> {
  return markdown.replace(/\r\n?/g, '\n').split('\n')
    .map(matchImageLine)
    .filter((image): image is { caption: string; source: string } => Boolean(image) && !/^https?:\/\//i.test(image!.source) && !image!.source.startsWith('data:'));
}
