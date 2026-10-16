import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { FRAME_HEIGHT, FRAME_WIDTH } from './video-compose';

/**
 * 依赖 Electron 与子进程的成片工具：画面帧截图、ffprobe 取时长、ffmpeg 合成。
 * 纯 Node 单测加载不了这个文件；能单测的规则都在 video-compose.ts / video-pipeline.ts。
 */

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 一段画面：一个 HTML 页面，加上依次要截的静帧（这一刻写到 <html> 上的 CSS 变量、输出文件）。 */
export type FrameJob = { html: string; stills: Array<{ style: string; target: string }> };

/**
 * 把一组本地 HTML 画面截成 1080×1920 的图片：目标是 .png 就存 PNG，否则存 JPEG（质量 95）。
 *
 * 做法与小红书卡片导出一致（见 AGENTS.md 的 Electron 隐藏窗口截图坑）：离屏窗口 + 先载入 about:blank 再挂调试器 +
 * 设备模拟固定视口——普通隐藏窗口会被夹到屏幕尺寸、在主窗口显示时不出帧导致截图挂起。
 * 帧页面用 loadFile 而不是 data: URL：配图以 file:// 引用，data: 页面既读不了本地文件，也有 2MB 的地址长度上限。
 * 页面是本地模板生成的静态 HTML：关掉脚本、独立的内存分区，不联网。
 *
 * 镜头内动效：每段页面只载入一次，之后逐张把这一刻的 CSS 变量写到 <html style> 上再截图。
 * 写属性走调试协议的 DOM 命令，页面本身仍然不跑脚本；截图会等新的一帧画完，写完直接截，实测截到的总是新状态。
 * 离屏窗口的帧率调到 240：截图不用等 60Hz 的下一拍，实测每张从约 90ms 降到约 45ms。
 * 成片的中间帧用 JPEG：几百张 PNG 动辄上 GB，而最终的 H.264 本来就比 JPEG 95 损失大。
 */
export async function renderFrameFiles(jobs: FrameJob[], onProgress?: (done: number) => void): Promise<void> {
  const total = jobs.reduce((sum, job) => sum + job.stills.length, 0);
  const win = new BrowserWindow({
    show: false, width: 540, height: 960, paintWhenInitiallyHidden: true, frame: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'sydney-video-frames' }
  });
  win.webContents.setFrameRate(240);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await win.loadURL('about:blank');
        const cdp = win.webContents.debugger;
        cdp.attach('1.3');
        try {
          await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: FRAME_WIDTH, height: FRAME_HEIGHT, deviceScaleFactor: 1, mobile: false });
          let done = 0;
          for (const job of jobs) {
            // loadFile 在 load 事件后才返回，此时配图已经解码；再留一点时间给字体排版。
            await win.loadFile(job.html);
            await wait(80);
            const document = await cdp.sendCommand('DOM.getDocument', { depth: 1 }) as { root: { children?: Array<{ nodeId: number; nodeName: string }> } };
            const root = document.root.children?.find(node => node.nodeName === 'HTML');
            if (!root) throw new Error('画面帧页面结构异常');
            for (const still of job.stills) {
              await cdp.sendCommand('DOM.setAttributeValue', { nodeId: root.nodeId, name: 'style', value: still.style });
              const png = still.target.toLowerCase().endsWith('.png');
              const shot = await cdp.sendCommand('Page.captureScreenshot', {
                format: png ? 'png' : 'jpeg', ...(png ? {} : { quality: 95 }), optimizeForSpeed: true,
                clip: { x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT, scale: 1 }, captureBeyondViewport: false
              }) as { data: string };
              fs.writeFileSync(still.target, Buffer.from(shot.data, 'base64'));
              done += 1;
              onProgress?.(done);
            }
          }
        } finally {
          try { cdp.detach(); } catch { /* 窗口已关闭 */ }
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('画面帧渲染超时')), 60_000 + jobs.length * 3_000 + total * 1_000); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).replace(/\s+/g, ' ').trim().slice(-300);
        reject(Object.assign(new Error(detail || error.message), { code: (error as NodeJS.ErrnoException).code }));
      } else resolve(String(stdout));
    });
  });
}

export type FfmpegTools = { ffmpeg: string; ffprobe: string };

let cachedTools: FfmpegTools | null = null;

/**
 * 找 ffmpeg / ffprobe：环境变量 SYDNEY_FFMPEG（ffmpeg 可执行文件或它所在的目录）优先，其次 PATH。
 * 找到后缓存；找不到时给出能照着做的提示，而不是子进程的 ENOENT。
 */
export async function resolveFfmpeg(): Promise<FfmpegTools> {
  if (cachedTools) return cachedTools;
  const configured = (process.env.SYDNEY_FFMPEG || '').trim();
  const exe = process.platform === 'win32' ? '.exe' : '';
  let candidates: FfmpegTools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
  if (configured) {
    const directory = fs.existsSync(configured) && fs.statSync(configured).isDirectory() ? configured : path.dirname(configured);
    candidates = { ffmpeg: path.join(directory, `ffmpeg${exe}`), ffprobe: path.join(directory, `ffprobe${exe}`) };
  }
  try {
    await run(candidates.ffmpeg, ['-version'], 15_000);
    await run(candidates.ffprobe, ['-version'], 15_000);
  } catch {
    throw new Error('没有找到 ffmpeg / ffprobe：请先安装 ffmpeg（例如 winget install Gyan.FFmpeg）并重启应用，或用环境变量 SYDNEY_FFMPEG 指向 ffmpeg 所在目录');
  }
  cachedTools = candidates;
  return candidates;
}

/** 音频 / 视频时长（秒）。 */
export async function probeDuration(tools: FfmpegTools, file: string): Promise<number> {
  const output = await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], 30_000);
  const seconds = Number(output.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`读不出音频时长：${path.basename(file)}`);
  return seconds;
}

/**
 * 配音里真正出声的区间（秒）：用 silencedetect 找开头和结尾的静音。系统语音句首、句尾各带一段静音，
 * 字幕逐字高亮按出声区间分配才跟得上声音。检测不出来（整段静音、ffmpeg 出错）时返回 null，交给上层按时长估计。
 */
export async function speechSpan(tools: FfmpegTools, file: string, seconds: number): Promise<{ start: number; end: number } | null> {
  let output: string;
  try {
    output = await new Promise<string>((resolve, reject) => {
      execFile(tools.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-35dB:d=0.1', '-f', 'null', '-'],
        { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => (error ? reject(error) : resolve(String(stderr))));
    });
  } catch {
    return null;
  }
  const starts = [...output.matchAll(/silence_start: (-?[\d.]+)/g)].map(match => Number(match[1]));
  const ends = [...output.matchAll(/silence_end: ([\d.]+)/g)].map(match => Number(match[1]));
  let start = 0;
  let end = seconds;
  // 开头的静音：从 0 开始的那一段；结尾的静音：最后一段没有 silence_end，或结束在文件末尾。
  if (starts.length && starts[0] <= 0.02 && ends.length) start = ends[0];
  const lastStart = starts[starts.length - 1];
  if (starts.length && (ends.length < starts.length || ends[ends.length - 1] >= seconds - 0.05) && lastStart > start) end = lastStart;
  return end - start > 0.2 ? { start, end } : null;
}

export async function runFfmpeg(tools: FfmpegTools, args: string[], timeoutMs = 10 * 60_000): Promise<void> {
  try {
    await run(tools.ffmpeg, args, timeoutMs);
  } catch (error) {
    throw new Error(`ffmpeg 合成失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
