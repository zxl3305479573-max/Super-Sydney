import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { XhsNote } from '../shared.ts';
import { xhsNoteTypeLabel } from './xhs-catalog.ts';
import { assertXhsExportable, countChars, readCheckReport, readImages, readTags } from './xhs-pipeline.ts';

/**
 * 发布包导出：把一篇笔记落成手动发布时真正要用的东西。
 *
 * 目录 `08-小红书/<时间戳>-<id>-<随机串>-<标题>/`：`笔记.md`（标题、正文、标签、检测结果、发布提醒）
 * 与 `01.*`（封面）、`02.*`…（图组，按界面上的顺序）。每次导出新建目录，永不覆盖；中途失败只清理本次目录。
 * 模块不代发布——小红书没有面向个人号的发布接口，发不发、什么时候发都由人决定。
 */

export function buildXhsNoteMarkdown(note: XhsNote, imageNames: string[]): string {
  const tags = readTags(note);
  const report = readCheckReport(note);
  const checks = report
    ? report.items.map(item => `- ${item.ok === true ? '✓' : item.ok === false ? '✗' : '○'} ${item.label}：${item.detail}`).join('\n')
    : '- 导出前没有运行发布前检测';
  return `---
type: xiaohongshu-note
source: sydney-desktop
xhs_note_id: ${note.id}
note_type: ${JSON.stringify(xhsNoteTypeLabel(note.noteType))}
title: ${JSON.stringify(note.title)}
tags: ${JSON.stringify(tags)}
images: ${JSON.stringify(imageNames)}
exported_at: ${JSON.stringify(new Date().toISOString())}
---

# ${note.title}

## 标题（${countChars(note.title)} 字）

${note.title}

## 正文（${countChars(note.body)} 字）

${note.body.trim()}

${tags.map(tag => `#${tag}`).join(' ')}

## 图组（按发布顺序）

${imageNames.map((name, index) => `${index + 1}. ${name}${index === 0 ? '（封面）' : ''}`).join('\n')}

## 发布前检测

${checks}

## 发布提醒

- 本模块不代发布：请在小红书 App 或网页版创作者中心手动发布，图片按上面的顺序上传。
- 正文和配图含 AI 生成内容时，发布时在「添加声明 / 内容类型声明」里勾选 AI 生成相关声明。
- 涉及健康、医疗、理财等内容时，再人工确认一遍有没有诊断、功效承诺或收益承诺。
`;
}

export function exportXhsPackage(vault: string, note: XhsNote): string {
  assertXhsExportable(note);
  if (!vault.trim()) throw new Error('还没有设置知识库目录，请先在「隐私与设置」里选择');
  const images = [note.coverPath, ...readImages(note).map(item => item.path)];
  for (const file of images) if (!fs.existsSync(file)) throw new Error(`图片文件不存在：${path.basename(file)}，请重新生成或从图组里移除`);
  const safeTitle = note.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名笔记';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(vault, '08-小红书', `${stamp}-${note.id}-${randomUUID().slice(0, 8)}-${safeTitle}`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    const names = images.map((file, index) => `${String(index + 1).padStart(2, '0')}${path.extname(file).toLowerCase() || '.png'}`);
    images.forEach((file, index) => fs.copyFileSync(file, path.join(directory, names[index]), fs.constants.COPYFILE_EXCL));
    fs.writeFileSync(path.join(directory, '笔记.md'), buildXhsNoteMarkdown(note, names), { encoding: 'utf8', flag: 'wx' });
    return directory;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
