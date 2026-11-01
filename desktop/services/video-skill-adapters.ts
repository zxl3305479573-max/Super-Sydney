import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveVideoBgmStyle, type VideoProject, type VideoShot, type VideoSkillRunResult } from '../shared.ts';
import { buildExternalBgmArgs } from './video-compose.ts';
import { captureProductWebsite } from './video-product-capture.ts';
import { compactProductResearch, normalizeWebsiteUrl } from './video-product-research.ts';
import { parseVideoShots, serializeVideoShots } from './video-pipeline.ts';
import { videoFrameSpec } from './video-frame-spec.ts';
import { ensureAutoBgm } from './video-bgm.ts';
import { probeVideo, resolveFfmpeg, runFfmpeg } from './video-render.ts';
import { skillInputFingerprint } from './video-skill-inputs.ts';

type Report = (message: string) => void;
type CommandResult = { stdout: string; stderr: string };
type WorkflowArtifact = {
  video: string;
  rawVideo: string;
  transcript: string;
  subtitle: string;
  script: string;
  visual: string;
  diagnostics: string[];
};

function skillsRoot(): string {
  return process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'skills') : path.join(os.homedir(), '.codex', 'skills');
}

function pythonCommand(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function requireSource(project: VideoProject): string {
  const source = project.options.sourcePath.trim();
  if (!source) throw new Error('这个工作流需要素材路径或配置文件路径，请先在项目简报里填写');
  if (!fs.existsSync(source)) throw new Error(`找不到工作流输入：${source}`);
  if (!fs.statSync(source).isFile()) throw new Error(`工作流输入不是文件：${source}`);
  return source;
}

function requireLogo(project: VideoProject): string {
  const logo = project.options.logoPath.trim();
  if (!logo) throw new Error('产品宣传片需要品牌 Logo，请先选择 Logo 文件');
  if (!fs.existsSync(logo) || !fs.statSync(logo).isFile()) throw new Error(`找不到 Logo 文件：${logo}`);
  if (!/\.(png|jpe?g|webp|svg)$/i.test(logo)) throw new Error('Logo 只支持 PNG、JPG、WebP 或 SVG');
  return logo;
}

function run(command: string, args: string[], cwd: string, report: Report, quiet = false): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!quiet) report(`${path.basename(command)} ${args.join(' ')}`);
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let stderr = '';
    child.stdout.on('data', chunk => {
      if (!quiet) report(String(chunk).trim());
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      if (!quiet) {
        const message = String(chunk).trim();
        if (message) report(message.slice(-1000));
      }
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${path.basename(command)} 退出码 ${code ?? 'unknown'}`)));
  });
}

function runCapture(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(stderr.trim().slice(-1500) || `${path.basename(command)} 退出码 ${code ?? 'unknown'}`)));
  });
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch { /* 让调用方给出可读错误 */ }
    }
    return null;
  }
}

function findValue(value: unknown, names: Set<string>): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValue(item, names);
      if (found) return found;
    }
    return '';
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (names.has(key) && typeof child === 'string' && child.trim()) return child.trim();
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findValue(child, names);
    if (found) return found;
  }
  return '';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fitForPlatform(
  project: VideoProject,
  source: string,
  output: string,
  report: Report,
  trimToTarget: boolean
): Promise<void> {
  const ffmpegSkill = path.join(skillsRoot(), 'ffmpeg-skill', 'scripts', 'fit.py');
  const frame = videoFrameSpec(project.platform);
  const tools = await resolveFfmpeg();
  const probe = await probeVideo(tools, source);
  const args = [
    ffmpegSkill, source, '-o', output,
    '--aspect', frame.aspect, '--fit', 'blur', '--width', String(frame.width), '--height', String(frame.height),
    '--fps', '30', '--overwrite', '--json-brief'
  ];
  if (trimToTarget && probe.seconds > project.durationSeconds * 1.04) {
    args.push('--duration', String(project.durationSeconds), '--method', 'trim');
  }
  await run(pythonCommand(), args, process.cwd(), report);
  if (!fs.existsSync(output) || fs.statSync(output).size < 1024) throw new Error('平台规格适配没有生成有效 MP4');
}

async function addBgm(project: VideoProject, source: string, output: string, dataDir: string, report: Report): Promise<void> {
  if (project.options.bgmMode === 'none') {
    fs.copyFileSync(source, output);
    return;
  }
  const context = `${project.title} ${project.topic} ${project.audience} ${project.script} ${project.options.productResearch}`;
  const style = resolveVideoBgmStyle(project.options, context);
  const music = project.options.bgmMode === 'auto'
    ? ensureAutoBgm(dataDir, style)
    : project.options.bgmPath.trim();
  if (!music || !fs.existsSync(music)) throw new Error('背景音乐文件不存在，请重新选择或关闭 BGM');
  const tools = await resolveFfmpeg();
  const probe = await probeVideo(tools, source);
  report(project.options.bgmMode === 'auto' ? `正在混入自动原创 BGM（${style}）…` : '正在混入本地 BGM…');
  await runFfmpeg(tools, buildExternalBgmArgs({
    video: source,
    music,
    volumePercent: project.options.bgmVolume,
    ducking: project.options.bgmDucking,
    fadeIn: project.options.bgmFadeIn,
    fadeOut: project.options.bgmFadeOut,
    total: probe.seconds,
    output,
    hasSourceAudio: probe.hasAudio
  }));
  if (!fs.existsSync(output) || fs.statSync(output).size < 1024) throw new Error('BGM 混音没有生成有效 MP4');
}

function browserConfigInfo(source: string): { duration: number; scenes: string[] } {
  try {
    const raw = JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>;
    const duration = Math.max(1, Number(raw.duration) || 20);
    const scenes = raw.scene_starts && Array.isArray(raw.scene_starts)
      ? raw.scene_starts.flatMap(item => Array.isArray(item) && typeof item[1] === 'string' ? [item[1]] : [])
      : raw.shots && typeof raw.shots === 'object' ? Object.keys(raw.shots as Record<string, unknown>) : [];
    return { duration, scenes };
  } catch {
    return { duration: 20, scenes: [] };
  }
}

function importedText(project: VideoProject, fallback: string): string {
  return project.topic.trim() || project.script.trim() || fallback;
}

function oneShotStoryboard(project: VideoProject, narration: string, visual: string, seconds: number): string {
  const shots = parseVideoShots(project.storyboardJson);
  if (shots.length) return project.storyboardJson;
  const shot: VideoShot = {
    index: 1,
    seconds: Math.max(1, Math.round(seconds)),
    visual,
    narration,
    caption: project.title.trim() || project.topic.trim() || '成片',
    role: 'takeaway'
  };
  return serializeVideoShots([shot]);
}

function transcriptWords(raw: unknown): Array<{ text: string; start: number; end: number }> {
  const words = raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).words)
    ? (raw as { words: unknown[] }).words
    : [];
  return words.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (record.type && record.type !== 'word') return [];
    const text = String(record.text ?? '').trim();
    const start = Number(record.start);
    const end = Number(record.end);
    return text && Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ text, start, end }] : [];
  });
}

function srtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor(totalMs % 3_600_000 / 60_000);
  const secs = Math.floor(totalMs % 60_000 / 1000);
  const millis = totalMs % 1000;
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

/** 把 video-use 的逐字转录压成短字幕；断点只落在词边界和自然停顿。 */
export function buildSrtFromTranscript(raw: unknown): string {
  const words = transcriptWords(raw);
  const groups: Array<{ text: string; start: number; end: number }> = [];
  let current: Array<{ text: string; start: number; end: number }> = [];
  const flush = () => {
    if (!current.length) return;
    groups.push({
      text: current.map(word => word.text).join(' ').replace(/\s+([，。！？、；：,.!?;:])/g, '$1'),
      start: current[0].start,
      end: current[current.length - 1].end
    });
    current = [];
  };
  for (const word of words) {
    const previous = current[current.length - 1];
    const gap = previous ? word.start - previous.end : 0;
    const width = current.reduce((sum, item) => sum + item.text.length, 0);
    if (current.length && (gap >= 0.42 || width >= 14)) flush();
    current.push(word);
    if (/[，。！？、；：,.!?;:]$/.test(word.text)) flush();
  }
  flush();
  return groups.map((group, index) => `${index + 1}\n${srtTime(group.start)} --> ${srtTime(group.end)}\n${group.text}\n`).join('\n');
}

function transcriptScript(raw: unknown): string {
  const words = transcriptWords(raw);
  return words.map(word => word.text).join(' ').replace(/\s+([，。！？、；：,.!?;:])/g, '$1').trim();
}

function hasElevenLabsKey(root: string): boolean {
  if (process.env.ELEVENLABS_API_KEY?.trim()) return true;
  const env = path.join(root, 'video-use', '.env');
  if (!fs.existsSync(env)) return false;
  return fs.readFileSync(env, 'utf8').split(/\r?\n/).some(line => /^\s*ELEVENLABS_API_KEY\s*=\s*\S+/.test(line));
}

async function transcribeWithVideoUse(source: string, editDir: string, report: Report): Promise<{ transcript: string; srt: string; text: string }> {
  const root = skillsRoot();
  await run(pythonCommand(), [path.join(root, 'video-use', 'helpers', 'transcribe.py'), source, '--edit-dir', editDir], process.cwd(), report);
  const transcript = path.join(editDir, 'transcripts', `${path.basename(source, path.extname(source))}.json`);
  if (!fs.existsSync(transcript)) throw new Error('video-use 转录完成但没有找到 transcript JSON');
  const raw = JSON.parse(fs.readFileSync(transcript, 'utf8')) as unknown;
  const srt = path.join(editDir, 'master.srt');
  fs.writeFileSync(srt, buildSrtFromTranscript(raw), 'utf8');
  return { transcript, srt, text: transcriptScript(raw) };
}

async function ensureOoReady(): Promise<string> {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'oo', process.platform === 'win32' ? 'oo.exe' : 'oo');
  const candidates = [process.env.OO_CLI?.trim() || '', fs.existsSync(local) ? local : '', 'oo'].filter(Boolean);
  let command = '';
  let availabilityError = '';
  for (const candidate of candidates) {
    try {
      await runCapture(candidate, ['--version'], process.cwd());
      command = candidate;
      break;
    } catch (error) {
      availabilityError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!command) {
    if (/not recognized|ENOENT|not found|找不到/i.test(availabilityError)) {
      throw new Error('字幕本地化需要 OO CLI。请先运行：irm https://cli.oomol.com/install.ps1 | iex，然后重新打开应用');
    }
    throw new Error(`无法启动 OO CLI：${availabilityError}`);
  }
  try {
    await runCapture(command, ['llm', 'config', '--json'], process.cwd());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OO CLI 尚未登录或 LLM 配置不可用：${detail}`);
  }
  return command;
}

async function transcribeWithOo(project: VideoProject, source: string, outputDir: string, report: Report, oo: string): Promise<{ transcript: string; srt: string; text: string }> {
  const tools = await resolveFfmpeg();
  const audio = path.join(outputDir, 'audio.wav');
  await runFfmpeg(tools, ['-y', '-hide_banner', '-loglevel', 'error', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio]);
  report('正在上传字幕音轨到 OO Fusion ASR…');
  const uploaded = parseJson((await runCapture(oo, ['file', 'upload', audio, '--json'], process.cwd())).stdout);
  const fileURL = findValue(uploaded, new Set(['downloadUrl', 'fileURL', 'url']));
  if (!fileURL) throw new Error('OO 文件上传成功，但没有返回可用的下载地址');
  const submitPath = path.join(outputDir, 'submit-asr.json');
  const payload: Record<string, unknown> = { fileURL, enableITN: false, enableWords: true };
  if (project.options.sourceLanguage && project.options.sourceLanguage !== 'auto') payload.language = project.options.sourceLanguage;
  fs.writeFileSync(submitPath, JSON.stringify(payload, null, 2), 'utf8');
  const submitted = parseJson((await runCapture(oo, [
    'connector', 'run', 'fusion-api', '--action', 'qwen_asr_filetrans_submit', '--data', `@${submitPath}`, '--json'
  ], process.cwd())).stdout);
  const sessionId = findValue(submitted, new Set(['sessionId', 'sessionID', 'session_id']));
  if (!sessionId) throw new Error('Fusion ASR 提交成功，但没有返回 sessionId');
  fs.writeFileSync(path.join(outputDir, 'job.created.json'), JSON.stringify(submitted, null, 2), 'utf8');
  let done: unknown = null;
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    report(`等待 Fusion ASR 转录 ${attempt}/90…`);
    const state = parseJson((await runCapture(oo, [
      'connector', 'run', 'fusion-api', '--action', 'qwen_asr_filetrans_state', '--data', JSON.stringify({ sessionID: sessionId }), '--json'
    ], process.cwd())).stdout);
    const status = findValue(state, new Set(['status', 'state'])).toLowerCase();
    if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) {
      done = parseJson((await runCapture(oo, [
        'connector', 'run', 'fusion-api', '--action', 'qwen_asr_filetrans_result', '--data', JSON.stringify({ sessionID: sessionId }), '--json'
      ], process.cwd())).stdout);
      break;
    }
    if (['failed', 'error', 'not_found', 'cancelled'].includes(status)) throw new Error(`Fusion ASR 任务状态：${status || '未知'}`);
    await delay(2_000);
  }
  if (!done) throw new Error(`Fusion ASR 转录超时，sessionId：${sessionId}`);
  const transcript = path.join(outputDir, 'transcript.json');
  fs.writeFileSync(transcript, JSON.stringify(done, null, 2), 'utf8');
  const script = path.join(skillsRoot(), 'video-subtitle-translator', 'scripts', 'subtitle-tools.mjs');
  await run('node', [script, 'fusion-to-subtitles', '--input', transcript, '--out-dir', outputDir, '--formats', 'srt'], process.cwd(), report);
  const srt = path.join(outputDir, 'transcript.srt');
  if (!fs.existsSync(srt)) throw new Error('Fusion ASR 结果已保存，但没有生成源字幕');
  return { transcript, srt, text: fs.readFileSync(path.join(outputDir, 'transcript.txt'), 'utf8').trim() };
}

async function translateAndBurn(
  project: VideoProject,
  sourceVideo: string,
  sourceSrt: string,
  outputDir: string,
  report: Report
): Promise<{ displaySrt: string; output: string }> {
  const script = path.join(skillsRoot(), 'video-subtitle-translator', 'scripts', 'subtitle-tools.mjs');
  const code = project.options.targetCode.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'zh';
  await run('node', [
    script, 'translate-srt', '--input', sourceSrt, '--out-dir', outputDir,
    '--source-language', project.options.sourceLanguage || 'auto',
    '--target-language', project.options.targetLanguage || '简体中文',
    '--target-code', code, '--profile', 'youtube_explainer', '--formats', 'srt'
  ], process.cwd(), report);
  const translated = path.join(outputDir, `translation.${code}.srt`);
  if (!fs.existsSync(translated)) throw new Error('翻译完成但没有生成目标语言 SRT');
  const displaySrt = path.join(outputDir, `translation.${code}.display.srt`);
  await run('node', [
    script, 'prepare-display-srt', '--input', translated, '--output', displaySrt,
    '--cjk-line-length', '18', '--max-lines', '2'
  ], process.cwd(), report);
  const output = path.join(outputDir, `localized-${code}.mp4`);
  await run(pythonCommand(), [
    path.join(skillsRoot(), 'ffmpeg-skill', 'scripts', 'caption.py'),
    sourceVideo, '--srt', displaySrt, '--mode', 'burn', '--language', code,
    '--max-lines', '2', '--overwrite', '--json-brief', '-o', output
  ], process.cwd(), report);
  return { displaySrt, output };
}

async function finalizeWorkflow(
  project: VideoProject,
  sourcePath: string,
  outputDir: string,
  artifact: Omit<WorkflowArtifact, 'video'>,
  dataDir: string,
  report: Report,
  updateProject: (patch: Partial<VideoProject>) => VideoProject
): Promise<VideoSkillRunResult> {
  const sourceSignature = skillInputFingerprint(sourcePath);
  const withBgm = path.join(outputDir, 'final.mp4');
  await addBgm(project, artifact.rawVideo, withBgm, dataDir, report);
  const tools = await resolveFfmpeg();
  const probe = await probeVideo(tools, withBgm);
  if (probe.width <= 0 || probe.height <= 0 || (!probe.hasAudio && project.options.bgmMode !== 'none')) {
    throw new Error('外部 Skill 成片校验失败：输出缺少有效画面或音频');
  }
  const script = artifact.script.trim() || importedText(project, `外部 Skill 成片：${path.basename(sourcePath)}`);
  const storyboard = oneShotStoryboard(project, script, artifact.visual, probe.seconds);
  updateProject({
    title: project.title.trim() || project.topic.trim() || path.basename(sourcePath, path.extname(sourcePath)),
    script,
    storyboardJson: storyboard,
    durationSeconds: Math.max(1, Math.round(probe.seconds)),
    status: 'storyboard',
    exportPath: '',
    options: {
      ...project.options,
      workflow: project.options.workflow,
      sourcePath,
      skillInputSignature: sourceSignature
    }
  });
  return {
    workflow: project.options.workflow,
    status: 'completed',
    message: `外部 Skill 已生成并通过校验：${probe.width}×${probe.height}，${probe.seconds.toFixed(1)} 秒。`,
    outputPath: withBgm,
    videoPath: withBgm,
    rawOutputPath: artifact.rawVideo,
    transcriptPath: artifact.transcript,
    subtitlePath: artifact.subtitle,
    seconds: probe.seconds,
    diagnostics: artifact.diagnostics
  };
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
    if (workflow === 'script-to-video') {
      return { workflow, status: 'completed', message: '脚本成片使用应用内 TTS、HTML 帧渲染与 FFmpeg 编排器，请继续执行脚本、配音、画面和成片步骤。' };
    }
    if (!updateProject) throw new Error('外部 Skill 产物无法写回项目');

    if (workflow === 'footage-edit') {
      const source = requireSource(project);
      const editDir = path.join(outputDir, 'edit');
      const normalized = path.join(outputDir, 'footage-platform.mp4');
      await fitForPlatform(project, source, normalized, report, true);
      const diagnostics: string[] = [];
      let transcript = '';
      let subtitle = '';
      let text = '';
      if (hasElevenLabsKey(root)) {
        const transcribed = await transcribeWithVideoUse(source, editDir, report);
        transcript = transcribed.transcript;
        subtitle = transcribed.srt;
        text = transcribed.text;
      } else {
        diagnostics.push('未配置 ELEVENLABS_API_KEY：本次按 FFmpeg 粗剪兜底，没有语音内容重排和逐字字幕。');
        report(diagnostics[0]);
      }
      return finalizeWorkflow(project, source, outputDir, {
        rawVideo: normalized,
        transcript,
        subtitle,
        script: text || importedText(project, `已有素材自动剪辑：${path.basename(source)}`),
        visual: `已有素材：${path.basename(source)}`,
        diagnostics
      }, dataDir, report, updateProject);
    }

    if (workflow === 'browser-demo') {
      const config = requireSource(project);
      const raw = path.join(outputDir, 'browser-demo-raw.mp4');
      await run(pythonCommand(), [path.join(root, 'browser-video-recording', 'scripts', 'render_browser_demo.py'), '--config', config, '--output', raw], process.cwd(), report);
      if (!fs.existsSync(raw) || fs.statSync(raw).size < 1024) throw new Error('browser-video-recording 没有生成有效 MP4');
      const normalized = path.join(outputDir, 'browser-platform.mp4');
      await fitForPlatform(project, raw, normalized, report, false);
      const info = browserConfigInfo(config);
      const scenes = info.scenes.length ? `依次展示：${info.scenes.join('、')}。` : '展示真实页面状态、点击和滚动流程。';
      return finalizeWorkflow(project, config, outputDir, {
        rawVideo: normalized,
        transcript: '',
        subtitle: '',
        script: importedText(project, `网页操作演示。${scenes}`),
        visual: '浏览器页面操作演示',
        diagnostics: [`浏览器原始渲染：${raw}`, `配置时长：${info.duration.toFixed(1)} 秒`]
      }, dataDir, report, updateProject);
    }

    if (workflow === 'localize') {
      const source = requireSource(project);
      if (!/\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(source)) throw new Error('字幕与多语言工作流需要视频文件；SRT 或音频只能作为中间产物');
      const oo = await ensureOoReady();
      const localizedDir = path.join(outputDir, 'localize');
      fs.mkdirSync(localizedDir, { recursive: true });
      const transcribed = await transcribeWithOo(project, source, localizedDir, report, oo);
      const normalized = path.join(localizedDir, 'platform.mp4');
      await fitForPlatform(project, source, normalized, report, false);
      const translated = await translateAndBurn(project, normalized, transcribed.srt, localizedDir, report);
      return finalizeWorkflow(project, source, outputDir, {
        rawVideo: translated.output,
        transcript: transcribed.transcript,
        subtitle: translated.displaySrt,
        script: transcribed.text || importedText(project, `多语言字幕视频：${path.basename(source)}`),
        visual: `多语言字幕：${project.options.targetLanguage}`,
        diagnostics: [`目标语言：${project.options.targetLanguage}（${project.options.targetCode}）`]
      }, dataDir, report, updateProject);
    }

    if (workflow === 'product-demo') {
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
