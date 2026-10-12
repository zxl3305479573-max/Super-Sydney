import { extractCodexCliEvent, extractCodexMessage, extractCodexToolCall, parseCodexRecord, type CodexMessage } from './codex-session.ts';
import { BoundedIdSet, JsonlByteTail, JsonlTailScanner, readFirstLine, type TailFileState } from './jsonl-tail.ts';
import { TraceBuilder, type AiTurnTrace } from './ai-trace.ts';

export { JsonlByteTail } from './jsonl-tail.ts';

export type CodexCapturedMessage = CodexMessage & {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  originator?: string;
  trace?: AiTurnTrace;
};

/** Desktop is captured by default; CLI / IDE originators are opt-in. */
export const DEFAULT_CODEX_ORIGINATORS = ['Codex Desktop'];
export const KNOWN_CODEX_ORIGINATORS = ['Codex Desktop', 'codex_cli_rs', 'codex_vscode', 'codex_exec'];

type SessionMetadata = { originator: string; sessionId: string; cwd: string };
type SessionState = TailFileState & SessionMetadata & {
  seenIds: BoundedIdSet;
  trace: TraceBuilder;
  currentTurnId: string;
  lineIndex: number;
};

export function shouldRunCodexCapture(enabled: boolean, recording: boolean, paused: boolean): boolean {
  return enabled && recording && !paused;
}

export class CodexSessionAdapter {
  private running = false;
  private timer?: NodeJS.Timeout;
  private readonly scanner: JsonlTailScanner<SessionState>;
  private readonly onMessage: (message: CodexCapturedMessage) => void;
  private readonly onError: (message: string) => void;
  private readonly intervalMs: number;
  private originators: Set<string>;

  constructor(
    sessionsRoot: string,
    onMessage: (message: CodexCapturedMessage) => void,
    onError: (message: string) => void = () => {},
    intervalMs = 1_000,
    originators: string[] = DEFAULT_CODEX_ORIGINATORS
  ) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.intervalMs = intervalMs;
    this.originators = new Set(originators);
    this.scanner = new JsonlTailScanner<SessionState>(
      sessionsRoot,
      (file, offset) => {
        const state: SessionState = {
          tail: new JsonlByteTail(offset), mtimeMs: 0, checkedAt: 0,
          originator: '', sessionId: '', cwd: '',
          seenIds: new BoundedIdSet(), trace: new TraceBuilder(), currentTurnId: '', lineIndex: 0
        };
        // Baselined files are read from EOF, so their header must be read separately.
        if (offset > 0) {
          try { Object.assign(state, metadataFromLine(readFirstLine(file)) ?? {}); } catch { /* unreadable header */ }
        }
        return state;
      },
      (file, state, lines) => this.handleLines(file, state, lines)
    );
  }

  setOriginators(originators: string[]): void {
    this.originators = new Set(originators.length ? originators : DEFAULT_CODEX_ORIGINATORS);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    try { this.scanner.baseline(); } catch (error) { this.report(error); }
    this.timer = setInterval(() => this.scanOnce(), this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.scanner.states.clear();
  }

  scanOnce(): void {
    if (!this.running) return;
    try { this.scanner.scan(); } catch (error) { this.report(error); }
  }

  private handleLines(file: string, state: SessionState, lines: string[]): void {
    for (const line of lines) {
      state.lineIndex += 1;
      if (!state.originator) {
        const metadata = metadataFromLine(line);
        if (metadata) Object.assign(state, metadata);
        continue;
      }
      if (!this.originators.has(state.originator)) return;
      if (state.originator === 'Codex Desktop') this.handleDesktopLine(file, state, line);
      else this.handleCliLine(file, state, line);
    }
  }

  private handleDesktopLine(file: string, state: SessionState, line: string): void {
    if (this.collectTrace(state, line)) return;
    const message = extractCodexMessage(line, state.originator);
    if (!message || state.seenIds.has(message.id)) return;
    state.seenIds.add(message.id);
    if (message.role === 'user') {
      state.trace.reset();
      state.trace.touch(timestampOf(line));
      this.emit(file, state, message);
      return;
    }
    this.emit(file, state, { ...message, trace: state.trace.snapshot() });
  }

  private handleCliLine(file: string, state: SessionState, line: string): void {
    if (this.collectTrace(state, line)) return;
    const event = extractCodexCliEvent(line);
    if (!event) return;
    if (event.kind === 'turn_started') {
      if (event.turnId !== state.currentTurnId) {
        state.currentTurnId = event.turnId;
        state.trace.reset();
        state.trace.touch(timestampOf(line));
      }
      return;
    }
    if (event.kind === 'aborted') { state.trace.interrupted = true; return; }
    const turnId = event.turnId || state.currentTurnId || undefined;
    // Rollout lines are append-only, so file + line number is a stable fallback id.
    const id = `${state.sessionId || file}:${event.kind}:${turnId || state.lineIndex}`;
    if (state.seenIds.has(id)) return;
    state.seenIds.add(id);
    if (event.kind === 'user') {
      this.emit(file, state, turnId ? { id, role: 'user', text: event.text, turnId } : { id, role: 'user', text: event.text });
    } else {
      const base: CodexMessage = turnId ? { id, role: 'assistant', text: event.text, turnId } : { id, role: 'assistant', text: event.text };
      this.emit(file, state, { ...base, trace: state.trace.snapshot() });
    }
  }

  /** Returns true when the line was a tool call / turn marker consumed for the trace. */
  private collectTrace(state: SessionState, line: string): boolean {
    const record = parseCodexRecord(line);
    if (!record) return true;
    state.trace.touch(timestampOf(line, record));
    if (record.type === 'turn_context' && typeof record.payload?.model === 'string') state.trace.model = record.payload.model;
    const tool = extractCodexToolCall(line);
    if (tool) { state.trace.tool(tool.name, tool.files); state.trace.read(tool.reads); return true; }
    if (record.type === 'event_msg' && record.payload?.type === 'turn_aborted') state.trace.interrupted = true;
    return false;
  }

  private emit(file: string, state: SessionState, message: CodexMessage & { trace?: AiTurnTrace }): void {
    this.onMessage({ ...message, sessionId: state.sessionId, cwd: state.cwd, sessionFile: file, originator: state.originator });
  }

  private report(error: unknown): void {
    this.onError(error instanceof Error ? error.message : String(error));
  }
}

function timestampOf(line: string, record = parseCodexRecord(line)): string | undefined {
  const value = (record as unknown as Record<string, unknown> | null)?.timestamp;
  return typeof value === 'string' ? value : undefined;
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
