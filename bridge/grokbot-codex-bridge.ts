import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

type Json = Record<string, unknown>;
type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type BridgeTaskInput = {
  task: string;
  cwd?: string;
  threadId?: string;
  model?: string;
};

export type BridgeTask = {
  id: string;
  status: TaskStatus;
  task: string;
  cwd: string;
  model: string;
  threadId: string;
  output: string;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
};

const VERSION = '0.1.0';
const MAX_TASK_LENGTH = 20_000;
const MAX_BODY_LENGTH = 128_000;
const MAX_TASKS = 200;

function envBoolean(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value ? ['1', 'true', 'yes', 'on'].includes(value) : fallback;
}

function configuredRoots(): string[] {
  const configured = (process.env.GROK_CODEX_ALLOWED_ROOTS || '')
    .split(';')
    .map(value => value.trim())
    .filter(Boolean);
  const roots = configured.length ? configured : [process.env.GROK_CODEX_WORKSPACE || process.cwd()];
  return roots.map(value => path.resolve(value));
}

function pathIsInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertAllowedCwd(value: unknown): string {
  const cwd = path.resolve(typeof value === 'string' && value.trim() ? value.trim() : configuredRoots()[0]);
  const root = configuredRoots().find(item => pathIsInside(cwd, item));
  if (!root) throw new Error(`工作目录不在允许范围内：${cwd}`);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`工作目录不存在：${cwd}`);
  return cwd;
}

function safeTaskInput(value: unknown): BridgeTaskInput {
  if (!value || typeof value !== 'object') throw new Error('请求体必须是 JSON 对象');
  const input = value as Partial<BridgeTaskInput>;
  const task = String(input.task || '').trim();
  if (!task) throw new Error('缺少 task');
  if (task.length > MAX_TASK_LENGTH) throw new Error(`task 不能超过 ${MAX_TASK_LENGTH} 个字符`);
  const threadId = input.threadId === undefined ? undefined : String(input.threadId).trim();
  const model = input.model === undefined ? undefined : String(input.model).trim();
  return { task, cwd: assertAllowedCwd(input.cwd), ...(threadId ? { threadId } : {}), ...(model ? { model } : {}) };
}

function publicTask(task: BridgeTask): BridgeTask {
  return { ...task, output: task.output.slice(-100_000), error: task.error.slice(-10_000) };
}

function sameSecret(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authToken(request: IncomingMessage): string {
  const authorization = String(request.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : String(request.headers['x-bridge-token'] || '').trim();
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function errorResponse(response: ServerResponse, status: number, message: string): void {
  jsonResponse(response, status, { error: message });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_LENGTH) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求体不是有效 JSON'); }
}

type PendingRequest = { resolve: (value: Json) => void; reject: (error: Error) => void };

class CodexAppServerClient {
  private readonly cwd: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completion: Promise<{ status: string; output: string }>;
  private readonly output: string[] = [];
  private sequence = 0;
  private stderr = '';
  private done = false;

  constructor(cwd: string) {
    this.cwd = cwd;
    const command = process.env.GROK_CODEX_BIN || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
    this.child = spawn(command, ['app-server', '--listen', 'stdio://'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on('line', line => this.onLine(line));
    this.child.stderr.on('data', chunk => { this.stderr += String(chunk); });
    this.child.on('error', error => this.fail(error instanceof Error ? error : new Error(String(error))));
    this.child.on('close', code => { if (!this.done) this.fail(new Error(`Codex app-server 已退出（code=${code}）：${this.stderr.trim()}`)); });
    this.completion = new Promise((resolve, reject) => { this.completionResolve = resolve; this.completionReject = reject; });
  }

  private completionResolve!: (value: { status: string; output: string }) => void;
  private completionReject!: (error: Error) => void;

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: Json;
    try { message = JSON.parse(line) as Json; }
    catch { return; }
    if (typeof message.id === 'string' || typeof message.id === 'number') {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        this.pending.delete(String(message.id));
        if (message.error && typeof message.error === 'object') pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve((message.result as Json) || {});
        return;
      }
    }
    const method = String(message.method || '');
    const params = (message.params && typeof message.params === 'object') ? message.params as Json : {};
    if (method === 'item/agentMessage/delta') this.output.push(String(params.delta || ''));
    if (method === 'turn/completed') {
      const turn = (params.turn && typeof params.turn === 'object') ? params.turn as Json : {};
      this.finish(String(turn.status || 'unknown'));
      return;
    }
    if (typeof message.id === 'string' || typeof message.id === 'number') this.answerApproval(message);
  }

  private answerApproval(message: Json): void {
    const method = String(message.method || '');
    if (!method.includes('requestApproval')) return;
    const autoApprove = envBoolean('GROK_CODEX_AUTO_APPROVE');
    if (method.startsWith('item/permissions/')) {
      const params = (message.params && typeof message.params === 'object') ? message.params as Json : {};
      const requested = params.permissions && typeof params.permissions === 'object' ? params.permissions : {};
      this.write({ jsonrpc: '2.0', id: message.id, result: { permissions: autoApprove ? requested : { fileSystem: null, network: null }, scope: 'turn' } });
      return;
    }
    const modernItemRequest = method.startsWith('item/commandExecution/') || method.startsWith('item/fileChange/');
    const decision = modernItemRequest
      ? (autoApprove ? 'accept' : 'decline')
      : (autoApprove ? 'approved' : { denied: { rejection: 'Grokbot 桥接默认不自动批准执行或修改请求' } });
    this.write({ jsonrpc: '2.0', id: message.id, result: { decision } });
  }

  private write(message: Json): void {
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.completionReject(error);
  }

  private finish(status: string): void {
    if (this.done) return;
    this.done = true;
    this.completionResolve({ status, output: this.output.join('') });
    this.child.kill();
  }

  async run(input: BridgeTaskInput): Promise<{ threadId: string; status: string; output: string }> {
    const clientInfo = { name: 'grokbot-codex-bridge', title: 'Grokbot ↔ Codex Bridge', version: VERSION };
    await this.request('initialize', { clientInfo });
    this.write({ jsonrpc: '2.0', method: 'initialized', params: {} });
    const policy = process.env.GROK_CODEX_APPROVAL_POLICY || 'on-request';
    const sandbox = process.env.GROK_CODEX_SANDBOX || 'workspace-write';
    const shared = { cwd: input.cwd, approvalPolicy: policy, sandbox };
    const thread = input.threadId
      ? await this.request('thread/resume', { threadId: input.threadId, ...shared })
      : await this.request('thread/start', { ...shared, ...(input.model ? { model: input.model } : {}) });
    const threadValue = (thread.thread && typeof thread.thread === 'object') ? thread.thread as Json : {};
    const threadId = String(threadValue.id || input.threadId || '');
    if (!threadId) throw new Error('Codex 没有返回 thread id');
    const completion = this.completion;
    await this.request('turn/start', { threadId, input: [{ type: 'text', text: input.task }], cwd: input.cwd });
    const result = await Promise.race([completion, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Codex 任务超时')), Number(process.env.GROK_CODEX_TIMEOUT_MS || 1_800_000)))]);
    if (result.status !== 'completed') throw new Error(`Codex turn 未成功完成：${result.status}`);
    return { threadId, status: result.status, output: result.output };
  }

  cancel(): void {
    if (!this.done) { this.done = true; this.child.kill(); this.completionReject(new Error('任务已取消')); }
  }
}

class BridgeQueue {
  private readonly tasks = new Map<string, BridgeTask>();
  private readonly clients = new Map<string, CodexAppServerClient>();
  private running = false;

  enqueue(input: BridgeTaskInput): BridgeTask {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const task: BridgeTask = { id, status: 'queued', task: input.task, cwd: input.cwd!, model: input.model || '', threadId: input.threadId || '', output: '', error: '', createdAt: now, startedAt: '', finishedAt: '' };
    this.tasks.set(id, task);
    while (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value as string);
    void this.pump();
    return task;
  }

  get(id: string): BridgeTask | undefined { return this.tasks.get(id); }

  cancel(id: string): BridgeTask | undefined {
    const task = this.tasks.get(id);
    if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    const client = this.clients.get(id);
    task.status = 'cancelled';
    if (client) client.cancel();
    return task;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const task = [...this.tasks.values()].find(item => item.status === 'queued');
    if (!task) return;
    this.running = true;
    task.status = 'running'; task.startedAt = new Date().toISOString();
    const client = new CodexAppServerClient(task.cwd);
    this.clients.set(task.id, client);
    try {
      const result = await client.run({ task: task.task, cwd: task.cwd, ...(task.model ? { model: task.model } : {}), ...(task.threadId ? { threadId: task.threadId } : {}) });
      task.status = 'completed'; task.threadId = result.threadId; task.output = result.output;
    } catch (error) {
      task.status = (task.status as TaskStatus) === 'cancelled' ? 'cancelled' : 'failed';
      task.error = error instanceof Error ? error.message : String(error);
    } finally {
      task.finishedAt = new Date().toISOString();
      this.clients.delete(task.id);
      this.running = false;
      void sendCallback(task);
      void this.pump();
    }
  }
}

async function sendCallback(task: BridgeTask): Promise<void> {
  const target = process.env.GROK_CODEX_CALLBACK_URL?.trim();
  if (!target) return;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.GROK_CODEX_CALLBACK_TOKEN) headers.authorization = `Bearer ${process.env.GROK_CODEX_CALLBACK_TOKEN}`;
    await fetch(target, { method: 'POST', headers, body: JSON.stringify(publicTask(task)) });
  } catch (error) { console.error(`[bridge] 回调 Grokbot 失败：${error instanceof Error ? error.message : String(error)}`); }
}

const token = process.env.GROK_CODEX_BRIDGE_TOKEN?.trim();
if (!token) throw new Error('必须设置 GROK_CODEX_BRIDGE_TOKEN，桥接服务不会默认开放匿名访问');
const host = process.env.GROK_CODEX_BRIDGE_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.GROK_CODEX_BRIDGE_PORT || 8787);
const queue = new BridgeQueue();

const server = http.createServer(async (request, response) => {
  try {
    if (!sameSecret(token, authToken(request))) return errorResponse(response, 401, '未授权');
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') return jsonResponse(response, 200, { ok: true, service: 'grokbot-codex-bridge', version: VERSION });
    if (request.method === 'POST' && url.pathname === '/v1/tasks') {
      const input = safeTaskInput(await readJson(request));
      return jsonResponse(response, 202, publicTask(queue.enqueue(input)));
    }
    const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (match && request.method === 'GET') {
      const task = queue.get(match[1]);
      return task ? jsonResponse(response, 200, publicTask(task)) : errorResponse(response, 404, '任务不存在');
    }
    if (match && request.method === 'POST' && url.searchParams.get('action') === 'cancel') {
      const task = queue.cancel(match[1]);
      return task ? jsonResponse(response, 200, publicTask(task)) : errorResponse(response, 404, '任务不存在');
    }
    return errorResponse(response, 404, '接口不存在');
  } catch (error) {
    return errorResponse(response, 400, error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => console.log(`[bridge] listening on http://${host}:${port}`));

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
