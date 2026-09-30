import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { extractCodexMessage, parseCodexRecord, type CodexMessage } from './codex-session.ts';

export type CodexCapturedMessage = CodexMessage & {
  sessionId: string;
  cwd: string;
  sessionFile: string;
};

type SessionMetadata = { originator: string; sessionId: string; cwd: string };
type SessionState = SessionMetadata & { tail: JsonlByteTail; seenIds: Set<string> };

export function shouldRunCodexCapture(enabled: boolean, recording: boolean, paused: boolean): boolean {
  return enabled && recording && !paused;
}

export class JsonlByteTail {
  offset: number;
  private carry = '';
  private decoder = new StringDecoder('utf8');

  constructor(offset = 0) {
    this.offset = offset;
  }

  append(buffer: Buffer): string[] {
    this.offset += buffer.length;
    const combined = this.carry + this.decoder.write(buffer);
    const lines = combined.split(/\r?\n/);
    this.carry = lines.pop() ?? '';
    return lines.filter(line => line.length > 0);
  }
}

export class CodexSessionAdapter {
  private running = false;
  private timer?: NodeJS.Timeout;
  private sessions = new Map<string, SessionState>();
  private readonly sessionsRoot: string;
  private readonly onMessage: (message: CodexCapturedMessage) => void;
  private readonly onError: (message: string) => void;
  private readonly intervalMs: number;

  constructor(
    sessionsRoot: string,
    onMessage: (message: CodexCapturedMessage) => void,
    onError: (message: string) => void = () => {},
    intervalMs = 1_000
  ) {
    this.sessionsRoot = sessionsRoot;
    this.onMessage = onMessage;
    this.onError = onError;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.sessions.clear();
    try {
      const baseline = this.listSessionFiles().map(file => ({ file, size: fs.statSync(file).size }));
      for (const { file, size } of baseline) {
        const metadata = this.readMetadata(file);
        if (metadata?.originator !== 'Codex Desktop') continue;
        this.sessions.set(file, { ...metadata, tail: new JsonlByteTail(size), seenIds: new Set() });
      }
    } catch (error) {
      this.report(error);
    }
    this.timer = setInterval(() => this.scanOnce(), this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sessions.clear();
  }

  scanOnce(): void {
    if (!this.running) return;
    try {
      for (const file of this.listSessionFiles()) {
        let state = this.sessions.get(file);
        if (!state) {
          state = { originator: '', sessionId: '', cwd: '', tail: new JsonlByteTail(), seenIds: new Set() };
          this.sessions.set(file, state);
        }
        this.readAppended(file, state);
      }
    } catch (error) {
      this.report(error);
    }
  }

  private readAppended(file: string, state: SessionState): void {
    const size = fs.statSync(file).size;
    if (size <= state.tail.offset) return;
    const length = size - state.tail.offset;
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, state.tail.offset);
      for (const line of state.tail.append(buffer.subarray(0, bytesRead))) {
        if (!state.originator) {
          const metadata = metadataFromLine(line);
          if (!metadata) continue;
          Object.assign(state, metadata);
          if (state.originator !== 'Codex Desktop') return;
          continue;
        }
        if (state.originator !== 'Codex Desktop') return;
        const message = extractCodexMessage(line, state.originator);
        if (!message || state.seenIds.has(message.id)) continue;
        state.seenIds.add(message.id);
        this.onMessage({ ...message, sessionId: state.sessionId, cwd: state.cwd, sessionFile: file });
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private readMetadata(file: string): SessionMetadata | null {
    const fd = fs.openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(64 * 1024);
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, 0);
      const firstLine = chunk.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
      return metadataFromLine(firstLine);
    } finally {
      fs.closeSync(fd);
    }
  }

  private listSessionFiles(): string[] {
    if (!fs.existsSync(this.sessionsRoot)) return [];
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(target);
      }
    };
    walk(this.sessionsRoot);
    return files;
  }

  private report(error: unknown): void {
    this.onError(error instanceof Error ? error.message : String(error));
  }
}

function metadataFromLine(line: string): SessionMetadata | null {
  const record = parseCodexRecord(line);
  if (record?.type !== 'session_meta' || !record.payload) return null;
  const originator = typeof record.payload.originator === 'string' ? record.payload.originator : '';
  const sessionId = typeof record.payload.session_id === 'string'
    ? record.payload.session_id
    : typeof record.payload.id === 'string' ? record.payload.id : '';
  const cwd = typeof record.payload.cwd === 'string' ? record.payload.cwd : '';
  return { originator, sessionId, cwd };
}
