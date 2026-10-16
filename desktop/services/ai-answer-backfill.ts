import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { parseClaudeLine } from './claude-session.ts';
import { persistAiMessage, type AiSource } from './codex-event-store.ts';
import { extractCodexCliEvent, extractCodexMessage } from './codex-session.ts';
import { JsonlTreeLister } from './jsonl-tail.ts';

/**
 * 补齐错过的最终答复。
 *
 * 实时监听只读「开始记录之后」写入日志的行：提问被记下了，但 AI 跑完时记录已经停了
 * （停止 / 暂停记录、关掉应用），这一回合的最终答复就永远缺失，总结和经验卡都用不上它。
 * 每次开始记录时，找出最近一段时间里「有提问、没答复」的回合，回到它的会话日志里按回合号
 * 找最终答复补上。只补已经记下的回合，不会把没记录过的对话收进来。
 */
export const BACKFILL_DAYS = 30;

type PendingTurn = { sessionId: string; turnId: string; cwd: string };

/** 有提问、没有最终答复、带回合号的记录，按会话分组。 */
export function pendingAiTurns(db: DatabaseSync, source: AiSource, sinceIso: string): Map<string, PendingTurn[]> {
  const rows = db.prepare(`SELECT source_session_id, source_turn_id, window_title FROM events
    WHERE source=? AND codex_prompt<>'' AND codex_response='' AND source_session_id<>'' AND source_turn_id<>'' AND created_at>=?`)
    .all(source, sinceIso) as Array<{ source_session_id: string; source_turn_id: string; window_title: string }>;
  const bySession = new Map<string, PendingTurn[]>();
  for (const row of rows) {
    const list = bySession.get(row.source_session_id) ?? [];
    list.push({ sessionId: row.source_session_id, turnId: row.source_turn_id, cwd: row.window_title });
    bySession.set(row.source_session_id, list);
  }
  return bySession;
}

/**
 * Codex 会话日志里每个回合的最终答复（回合号 → 答复）。桌面端看 final_answer 消息，
 * CLI / IDE 看 task_complete；同一回合以 task_complete（回合真正结束时的答复）为准。
 */
export function codexFinalAnswers(lines: string[]): Map<string, string> {
  const fromMessages = new Map<string, string>();
  const fromCompletion = new Map<string, string>();
  for (const line of lines) {
    const message = extractCodexMessage(line, 'Codex Desktop');
    if (message?.role === 'assistant' && message.turnId) fromMessages.set(message.turnId, message.text);
    const event = extractCodexCliEvent(line);
    if (event?.kind === 'final' && event.turnId) fromCompletion.set(event.turnId, event.text);
  }
  return new Map([...fromMessages, ...fromCompletion]);
}

/**
 * Claude Code 会话日志里每个回合的最终答复（提问 uuid → 答复），规则与实时监听一致：
 * 回合内最后一条助手消息的可见文字；被中断且没有文字时记为中断。
 */
export function claudeFinalAnswers(lines: string[]): Map<string, string> {
  const answers = new Map<string, string>();
  let promptUuid = '';
  let lastMessageId = '';
  let texts = new Map<string, string[]>();
  let interrupted = false;
  const close = () => {
    if (!promptUuid) return;
    const text = (texts.get(lastMessageId) ?? []).join('\n').trim();
    if (text) answers.set(promptUuid, text);
    else if (interrupted) answers.set(promptUuid, '（本轮被用户中断，未产生最终答复）');
  };
  for (const line of lines) {
    const parsed = parseClaudeLine(line);
    if (!parsed) continue;
    if (parsed.kind === 'prompt') {
      close();
      promptUuid = parsed.uuid;
      lastMessageId = '';
      texts = new Map();
      interrupted = false;
    } else if (parsed.kind === 'interrupt') {
      interrupted = true;
    } else if (parsed.kind === 'assistant' && promptUuid && parsed.text) {
      const parts = texts.get(parsed.messageId) ?? [];
      parts.push(parsed.text);
      texts.set(parsed.messageId, parts);
      lastMessageId = parsed.messageId;
    }
  }
  close();
  return answers;
}

const SOURCE_RULES: Record<AiSource, {
  /** 会话 id 对应的日志文件：Codex 是 rollout-…-<id>.jsonl，Claude 是 <id>.jsonl。 */
  matches: (file: string, sessionId: string) => boolean;
  answers: (lines: string[]) => Map<string, string>;
  skipDir?: (name: string) => boolean;
}> = {
  codex: { matches: (file, id) => file.endsWith(`${id}.jsonl`), answers: codexFinalAnswers },
  claude: {
    matches: (file, id) => file.endsWith(`${id}.jsonl`),
    answers: claudeFinalAnswers,
    // 子代理和工具结果不是主对话。
    skipDir: name => name === 'subagents' || name === 'tool-results'
  }
};

/** 补齐一个来源的缺失答复，返回补上的条数。读不到的日志直接跳过。 */
export function backfillAiAnswers(db: DatabaseSync, source: AiSource, roots: string[], now = Date.now()): number {
  const since = new Date(now - BACKFILL_DAYS * 86_400_000).toISOString();
  const pending = pendingAiTurns(db, source, since);
  if (!pending.size) return 0;
  const rules = SOURCE_RULES[source];
  const files = [...new Set(roots.filter(Boolean))].flatMap(root => new JsonlTreeLister(root, rules.skipDir).list());
  let filled = 0;
  for (const [sessionId, turns] of pending) {
    const file = files.find(candidate => rules.matches(candidate, sessionId));
    if (!file) continue;
    let answers: Map<string, string>;
    try {
      answers = rules.answers(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean));
    } catch {
      continue;
    }
    for (const turn of turns) {
      const text = answers.get(turn.turnId);
      if (!text) continue;
      const stored = persistAiMessage(db, source, {
        id: `${sessionId}:${turn.turnId}:backfill`, role: 'assistant', text, turnId: turn.turnId, sessionId, cwd: turn.cwd
      }, false);
      if (stored !== null) filled += 1;
    }
  }
  return filled;
}
