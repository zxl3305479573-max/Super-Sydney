import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * WeWrite CLI 调用封装。
 *
 * 两个必须遵守的约束（实测得出，见项目记忆）：
 * 1. Windows 控制台默认 GBK，Python 打印框线字符会以 UnicodeEncodeError 崩溃，
 *    因此每条调用都必须带 PYTHONUTF8/ PYTHONIOENCODING。
 * 2. 一律用 spawn(exe, argsArray) 不用 shell 字符串，避免参数注入。
 */

export type CliResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string; detail: string };

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export function weWriteHome(): string {
  return process.env.WEWRITE_HOME?.trim() || path.join(os.homedir(), '.wewrite');
}

/** 优先用已知的安装位置，找不到再回退 PATH 上的裸命令名。 */
export function resolveWeWriteBinary(): string {
  const platformName = process.platform === 'win32' ? 'wewrite.exe' : 'wewrite';
  const installed = path.join(os.homedir(), '.local', 'bin', platformName);
  return fs.existsSync(installed) ? installed : 'wewrite';
}

export function runWeWrite(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CliResult> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(resolveWeWriteBinary(), args, {
        windowsHide: true,
        // PYTHONUTF8 是硬要求：没有它 Windows 上会因 GBK 编码直接崩溃。
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      });
    } catch (error) {
      resolve({ ok: false, error: '无法启动 wewrite CLI', detail: messageOf(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `wewrite 命令超时（${Math.round(timeoutMs / 1000)} 秒）`, detail: args.join(' ') });
    }, timeoutMs);

    child.stdout?.on('data', chunk => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', chunk => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8');
    });
    child.on('error', error => {
      const hint = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? '未找到 wewrite 命令，请确认已安装（uv tool install wewrite）'
        : 'wewrite 启动失败';
      finish({ ok: false, error: hint, detail: messageOf(error) });
    });
    child.on('close', code => {
      if (code === 0) {
        finish({ ok: true, stdout, stderr });
        return;
      }
      finish({ ok: false, error: firstLine(stderr) || `wewrite 退出码 ${code}`, detail: stderr || stdout });
    });
  });
}

/** 调用并解析 JSON 输出。CLI 的错误走 stderr + 退出码 2，已被 runWeWrite 归一化。 */
export async function runWeWriteJson<T>(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ ok: true; data: T } | { ok: false; error: string; detail: string }> {
  const result = await runWeWrite(args, timeoutMs);
  if (!result.ok) return result;
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T };
  } catch {
    return { ok: false, error: 'wewrite 返回的内容不是有效 JSON', detail: result.stdout.slice(0, 400) };
  }
}

export function readRunFile(relativePath: string): string | null {
  try {
    const target = path.join(weWriteHome(), 'runs', relativePath);
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
}
