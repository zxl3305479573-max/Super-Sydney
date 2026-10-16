import path from 'node:path';
import { parseClaudeLine } from './claude-session.ts';
import { BoundedIdSet, JsonlByteTail, JsonlTailScanner, type TailFileState } from './jsonl-tail.ts';
import { TraceBuilder, type AiTurnTrace } from './ai-trace.ts';

export type ClaudeCapturedMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  turnId: string;
  sessionId: string;
  cwd: string;
  gitBranch: string;
  sessionFile: string;
  trace?: AiTurnTrace;
};

type Turn = {
  promptUuid: string;
  lastMessageId: string;
  texts: Map<string, string[]>;
  emittedText: string;
  lastLineAt: number;
};

type SessionState = TailFileState & {
  sessionId: string;
  cwd: string;
  gitBranch: string;
  seen: BoundedIdSet;
  trace: TraceBuilder;
  turn: Turn | null;
};

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Default transcript root, honouring CLAUDE_CONFIG_DIR like Claude Code does. */
export function defaultClaudeProjectsRoot(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDir || path.join(home, '.claude'), 'projects');
}

/**
 * Tails Claude Code transcripts. A turn's final answer is the visible text of
 * the last assistant message before the turn ends; the turn is considered
 * finished on `end_turn`, a turn-duration marker, the next prompt, or after
 * `idleMs` without new lines. If more text arrives after an idle flush the
 * answer is re-emitted under the same id so the store can update it.
 */
export class ClaudeSessionAdapter {
  private running = false;
  private timer?: NodeJS.Timeout;
  private readonly scanners: Array<JsonlTailScanner<SessionState>>;
  private readonly onMessage: (message: ClaudeCapturedMessage) => void;
  private readonly onError: (message: string) => void;
  private readonly intervalMs: number;
  private readonly idleMs: number;

  constructor(
    roots: string[],
    onMessage: (message: ClaudeCapturedMessage) => void,
    onError: (message: string) => void = () => {},
    options: { intervalMs?: number; idleMs?: number } = {}
  ) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.idleMs = options.idleMs ?? 30_000;
    this.scanners = [...new Set(roots.filter(Boolean))].map(root => new JsonlTailScanner<SessionState>(
      root,
      (_file, offset) => ({
        tail: new JsonlByteTail(offset), mtimeMs: 0, checkedAt: 0,
        sessionId: '', cwd: '', gitBranch: '', seen: new BoundedIdSet(), trace: new TraceBuilder(), turn: null
      }),
      (file, state, lines) => this.handleLines(file, state, lines),
      { skipDir: name => name === 'subagents' || name === 'tool-results' || UUID_DIR.test(name) }
    ));
  }

  /** 监听是否在运行；刚启动时由调用方补齐错过的最终答复。 */
  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const scanner of this.scanners) {
      try { scanner.baseline(); } catch (error) { this.report(error); }
    }
    this.timer = setInterval(() => this.scanOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.running) this.flushAll();
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const scanner of this.scanners) scanner.states.clear();
  }

  scanOnce(now = Date.now()): void {
    if (!this.running) return;
    for (const scanner of this.scanners) {
      try { scanner.scan(now); } catch (error) { this.report(error); }
    }
    this.flushIdle(now);
  }

  private flushIdle(now: number): void {
    for (const scanner of this.scanners) {
      for (const [file, state] of scanner.states) {
        if (state.turn && now - state.turn.lastLineAt >= this.idleMs) this.flush(file, state);
      }
    }
  }

  private flushAll(): void {
    for (const scanner of this.scanners) for (const [file, state] of scanner.states) this.flush(file, state);
  }

  private handleLines(file: string, state: SessionState, lines: string[]): void {
    const now = Date.now();
    for (const line of lines) {
      const parsed = parseClaudeLine(line);
      if (!parsed) continue;
      if (parsed.sessionId) state.sessionId = parsed.sessionId;
      if (parsed.kind === 'turn_end') { this.flush(file, state); continue; }
      if (parsed.kind === 'interrupt') {
        state.trace.interrupted = true;
        if (state.turn && !state.turn.texts.size) {
          state.turn.texts.set('interrupt', ['（本轮被用户中断，未产生最终答复）']);
          state.turn.lastMessageId = 'interrupt';
        }
        this.flush(file, state);
        continue;
      }
      state.trace.touch(parsed.timestamp);
      if (parsed.cwd) state.cwd = parsed.cwd;

      if (parsed.kind === 'prompt') {
        this.flush(file, state);
        if (state.seen.has(parsed.uuid)) continue;
        state.seen.add(parsed.uuid);
        if (parsed.gitBranch) state.gitBranch = parsed.gitBranch;
        state.trace.reset();
        state.trace.touch(parsed.timestamp);
        state.turn = { promptUuid: parsed.uuid, lastMessageId: '', texts: new Map(), emittedText: '', lastLineAt: now };
        this.onMessage({
          id: parsed.uuid, role: 'user', text: parsed.text, turnId: parsed.uuid,
          sessionId: state.sessionId, cwd: state.cwd, gitBranch: state.gitBranch, sessionFile: file
        });
        continue;
      }

      // Assistant output without a captured prompt (e.g. started before Sydney) is ignored.
      const turn = state.turn;
      if (!turn) continue;
      if (parsed.uuid && state.seen.has(parsed.uuid)) continue;
      if (parsed.uuid) state.seen.add(parsed.uuid);
      turn.lastLineAt = now;
      if (parsed.model) state.trace.model = parsed.model;
      for (const tool of parsed.tools) { state.trace.tool(tool.name, tool.files); state.trace.read(tool.reads); }
      if (parsed.text) {
        const parts = turn.texts.get(parsed.messageId) ?? [];
        parts.push(parsed.text);
        turn.texts.set(parsed.messageId, parts);
        turn.lastMessageId = parsed.messageId;
      }
      if (parsed.stopReason === 'end_turn') this.flush(file, state);
    }
  }

  private flush(file: string, state: SessionState): void {
    const turn = state.turn;
    if (!turn) return;
    const text = (turn.texts.get(turn.lastMessageId) ?? []).join('\n').trim();
    if (text && text !== turn.emittedText) {
      turn.emittedText = text;
      this.onMessage({
        id: `${turn.promptUuid}:final`, role: 'assistant', text, turnId: turn.promptUuid,
        sessionId: state.sessionId, cwd: state.cwd, gitBranch: state.gitBranch, sessionFile: file,
        trace: state.trace.snapshot()
      });
    }
    // Keep the turn open so late text (after an idle flush) can still update it,
    // but push lastLineAt far back so it doesn't re-flush every tick.
    turn.lastLineAt = Number.POSITIVE_INFINITY;
  }

  private report(error: unknown): void {
    this.onError(error instanceof Error ? error.message : String(error));
  }
}
