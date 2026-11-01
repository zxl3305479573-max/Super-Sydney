import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { VideoProject, VideoSkillRunResult } from '../shared.ts';
import { captureProductWebsite } from './video-product-capture.ts';
import { compactProductResearch, normalizeWebsiteUrl } from './video-product-research.ts';

type Report = (message: string) => void;

function skillsRoot(): string {
  return process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'skills') : path.join(os.homedir(), '.codex', 'skills');
}

function requireSource(project: VideoProject): string {
  const source = project.options.sourcePath.trim();
  if (!source) throw new Error('这个工作流需要素材路径或配置文件路径，请先在项目简报里填写');
  if (!fs.existsSync(source)) throw new Error(`找不到工作流输入：${source}`);
  return source;
}

function requireLogo(project: VideoProject): string {
  const logo = project.options.logoPath.trim();
  if (!logo) throw new Error('产品宣传片需要品牌 Logo，请先选择 Logo 文件');
  if (!fs.existsSync(logo) || !fs.statSync(logo).isFile()) throw new Error(`找不到 Logo 文件：${logo}`);
  if (!/\.(png|jpe?g|webp|svg)$/i.test(logo)) throw new Error('Logo 只支持 PNG、JPG、WebP 或 SVG');
  return logo;
}

function run(command: string, args: string[], cwd: string, report: Report): Promise<void> {
  return new Promise((resolve, reject) => {
    report(`${command} ${args.join(' ')}`);
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let stderr = '';
    child.stdout.on('data', chunk => report(String(chunk).trim()));
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} 退出码 ${code ?? 'unknown'}`)));
  });
}

/** 执行已安装的外部视频 skill；脚本成片由应用内本地链路负责。 */
export async function runVideoSkill(
  project: VideoProject,
  dataDir: string,
  report: Report = () => undefined,
  updateProject?: (patch: Partial<VideoProject>) => VideoProject
): Promise<VideoSkillRunResult> {
  const workflow = project.options.workflow ?? 'script-to-video';
  const root = skillsRoot();
  const outputDir = path.join(dataDir, 'video-assets', String(project.id), 'skill-workflow');
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    if (workflow === 'script-to-video') return { workflow, status: 'completed', message: '脚本成片使用应用内 TTS、HTML 帧渲染与 FFmpeg 编排器，请继续执行脚本、配音、画面和成片步骤。' };
    if (workflow === 'footage-edit') {
      const source = requireSource(project);
      const editDir = path.join(outputDir, 'edit');
      await run(process.platform === 'win32' ? 'python' : 'python3', [path.join(root, 'video-use', 'helpers', 'transcribe.py'), source, '--edit-dir', editDir], process.cwd(), report);
      return { workflow, status: 'completed', message: 'video-use 已完成逐字转录，结果已写入项目 skill-workflow/edit。', outputPath: editDir };
    }
    if (workflow === 'browser-demo') {
      const config = requireSource(project);
      const output = path.join(outputDir, 'browser-demo.mp4');
      await run(process.platform === 'win32' ? 'python' : 'python3', [path.join(root, 'browser-video-recording', 'scripts', 'render_browser_demo.py'), '--config', config, '--output', output], process.cwd(), report);
      return { workflow, status: 'completed', message: 'browser-video-recording 已生成浏览器演示视频。', outputPath: output };
    }
    if (workflow === 'localize') {
      const source = requireSource(project);
      const script = path.join(root, 'video-subtitle-translator', 'scripts', 'subtitle-tools.mjs');
      await run('node', [script, 'fusion-to-subtitles', '--input', source, '--out-dir', outputDir, '--formats', 'srt'], process.cwd(), report);
      return { workflow, status: 'completed', message: '字幕翻译 skill 已生成源字幕文件；翻译和配音需完成 OO CLI 登录配置。', outputPath: outputDir };
    }
    if (workflow === 'product-demo') {
      if (!updateProject) throw new Error('产品宣传片抓取结果无法写回项目');
      const websiteUrl = normalizeWebsiteUrl(project.options.websiteUrl || project.options.sourcePath);
      const logoPath = requireLogo(project);
      const siteDir = path.join(outputDir, 'site');
      const capture = await captureProductWebsite(websiteUrl, siteDir, report);
      const productResearch = compactProductResearch(capture);
      const footer = new URL(websiteUrl).hostname.replace(/^www\./i, '');
      const logoStat = fs.statSync(logoPath);
      updateProject({
        title: project.title.trim() || capture.title.trim() || footer,
        topic: project.topic.trim() || capture.description.trim() || capture.title.trim() || footer,
        options: {
          ...project.options,
          websiteUrl,
          logoPath,
          productScreenshots: capture.screenshots,
          productResearch,
          brandColors: capture.colors,
          productAssetSignature: `${capture.capturedAt}:${logoStat.size}:${logoStat.mtimeMs}`,
          bgmMode: project.options.bgmMode === 'custom' && project.options.bgmPath ? 'custom' : 'auto',
          footer
        }
      });
      return {
        workflow,
        status: 'completed',
        message: `已抓取官网公开内容和 ${capture.screenshots.length} 张页面截图，可以继续生成脚本、分镜和成片。`,
        outputPath: siteDir
      };
    }
    throw new Error('未知的视频工作流');
  } catch (error) {
    return { workflow, status: 'blocked', message: error instanceof Error ? error.message : String(error) };
  }
}
