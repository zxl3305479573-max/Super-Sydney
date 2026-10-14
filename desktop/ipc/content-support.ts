import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app-context';
import type { ContentTaxonomy } from '../shared';
import type { ContentApiConfig } from '../services/content-workflow';
import { buildContentApiConfig, imageApiConfig } from '../services/content-api-config';
import { readTaxonomy } from '../services/content-store';
import { requestGeneratedImage } from '../services/image-generation';
import { parseStyleSummary } from '../services/wewrite-config';
import { readWeWriteFiles } from '../services/wewrite-files';

/** 公众号与视频两条流水线共用的、需要应用上下文的小工具。 */

/** 默认具体方向的兜底取 style.yaml 的 default_topic。 */
export function readContentTaxonomy(ctx: AppContext): ContentTaxonomy {
  return readTaxonomy(ctx.db, parseStyleSummary(readWeWriteFiles().styleText).defaultTopic);
}

/** 不传 subdirectionId（视频）时不注入内容方向；传 null（未归类文章）同样不注入。 */
export function contentApiConfig(ctx: AppContext, subdirectionId?: number | null): ContentApiConfig {
  return buildContentApiConfig({
    files: readWeWriteFiles(),
    llmEnabled: ctx.settings.read().llmEnabled,
    apiKey: ctx.llmApiKey(),
    taxonomy: readContentTaxonomy(ctx),
    subdirectionId
  });
}

/** 生成的图片按「模块/任务 id」落在 userData 下，返回目录（不存在则创建）。 */
export function assetDirectory(ctx: AppContext, kind: 'content-assets' | 'video-assets', id: number): string {
  const directory = path.join(ctx.dataDir, kind, String(id));
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** 任务删除后清掉它在应用目录里的配图 / 封面（不创建目录，不碰知识库里导出的文件）。 */
export function removeAssetDirectory(ctx: AppContext, kind: 'content-assets' | 'video-assets', id: number): void {
  fs.rmSync(path.join(ctx.dataDir, kind, String(id)), { recursive: true, force: true });
}

/** 生成一张图写到 target；图片接口配置每次现读 config.yaml，改完配置无需重启。 */
export async function generateImageFile(target: string, prompt: string, size: string, signal?: AbortSignal): Promise<string> {
  const bytes = await requestGeneratedImage(imageApiConfig(readWeWriteFiles().configText), prompt, size, signal);
  fs.writeFileSync(target, bytes);
  return target;
}
