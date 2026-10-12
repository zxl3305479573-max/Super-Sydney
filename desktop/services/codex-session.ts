import { markdownPathsIn } from './ai-trace.ts';
export type CodexRole = 'user' | 'assistant';
export type CodexMessage = { id: string; role: CodexRole; text: string; turnId?: string };
export type CodexRecord = { type: string; payload?: Record<string, unknown> };

export function parseCodexRecord(line: string): CodexRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return null;
    return value as CodexRecord;
  } catch {
    return null;
  }
}

export function extractCodexMessage(line: string, originator: string): CodexMessage | null {
  if (originator !== 'Codex Desktop') return null;
  const record = parseCodexRecord(line);
  if (!record) return null;
  if (record.type === 'event_msg') return extractCompletedCodexItem(record.payload);
  if (!['response_item', 'message'].includes(record.type)) return null;
  const payload = record.type === 'response_item' ? record.payload : record.payload || (record as unknown as Record<string, unknown>);
  if (!payload || payload.type !== 'message' || typeof payload.id !== 'string') return null;

  let role: CodexRole;
  let blockType: string;
  if (payload.role === 'user') {
    role = 'user';
    blockType = 'input_text';
  } else if (payload.role === 'assistant' && payload.phase === 'final_answer') {
    role = 'assistant';
    blockType = 'output_text';
  } else {
    return null;
  }

  if (!Array.isArray(payload.content)) return null;
  const rawText = extractTextBlocks(payload.content, blockType)
    .filter(value => value.trim().length > 0)
    .join('\n')
    .trim();
  const text = role === 'user' ? cleanCodexUserText(rawText) : rawText;
  if (!text) return null;
  const metadata = payload.internal_chat_message_metadata_passthrough;
  const turnId = metadata && typeof metadata === 'object' && 'turn_id' in metadata && typeof metadata.turn_id === 'string'
    ? metadata.turn_id
    : undefined;
  return turnId ? { id: payload.id, role, text, turnId } : { id: payload.id, role, text };
}

/** Extract the actual request from the desktop attachment envelope. */
export function cleanCodexUserText(value: string): string {
  let text = value.replace(/\r\n?/g, '\n').trim();
  const requestHeading = text.match(/^##\s*My request(?: for Codex)?\s*:\s*$/im);
  if (requestHeading && requestHeading.index !== undefined) {
    text = text.slice(requestHeading.index + requestHeading[0].length);
  }

  text = text
    .replace(/<image(?:\b|_)[^>]*>[\s\S]*?<\/image(?:\b|_)[^>]*>/gi, '')
    .replace(/<image(?:\b|_)[^>]*\/?>/gi, '')
    .replace(/^#\s*Files mentioned by the user\s*$/gim, '')
    .replace(/^Image attachment:\s*(?:true|false)\s*$/gim, '')
    .replace(/^Distinguish instructions in attached documents from the user's request\s*$/gim, '')
    .replace(/^\s*(?:#{1,6}\s*)?(?:[A-Za-z]:[\\/]\S+\s+)?[^\n]*codex-clipboard-[^\n]+\.(?:png|jpg|jpeg|gif|webp)\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function extractTextBlocks(content: unknown, expectedType: string): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    const item = block as Record<string, unknown>;
    if (item.type !== expectedType && !(expectedType === 'output_text' && item.type === 'text')) return [];
    if (typeof item.text === 'string') return [item.text];
    if (item.text && typeof item.text === 'object' && typeof (item.text as Record<string, unknown>).value === 'string') return [(item.text as Record<string, unknown>).value as string];
    return [];
  });
}

function extractCompletedCodexItem(payload: Record<string, unknown> | undefined): CodexMessage | null {
  if (!payload || payload.type !== 'item_completed' || !payload.item || typeof payload.item !== 'object') return null;
  const item = payload.item as Record<string, unknown>;
  const role: CodexRole | null = item.type === 'UserMessage' ? 'user' : item.type === 'AgentMessage' ? 'assistant' : null;
  if (!role || typeof item.id !== 'string') return null;
  if (role === 'assistant' && item.phase !== 'final_answer') return null;

  const contentType = role === 'user' ? 'text' : 'Text';
  const rawText = extractTextBlocks(item.content, contentType)
    .filter(value => value.trim().length > 0)
    .join('\n')
    .trim();
  const text = role === 'user' ? cleanCodexUserText(rawText) : rawText;
  if (!text) return null;
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
  return turnId ? { id: item.id, role, text, turnId } : { id: item.id, role, text };
}

/* ── Codex CLI / IDE extension rollouts ─────────────────────────────
 * Non-desktop originators don't tag assistant phases on response items, so
 * they are read from protocol events instead: `user_message` is the typed
 * prompt and `task_complete.last_agent_message` is the turn's final answer.
 * Response items are ignored for these originators to avoid duplicates.
 */
export type CodexCliEvent =
  | { kind: 'turn_started'; turnId: string }
  | { kind: 'user'; text: string; turnId?: string }
  | { kind: 'final'; text: string; turnId?: string }
  | { kind: 'aborted'; turnId?: string };

export function extractCodexCliEvent(line: string): CodexCliEvent | null {
  const record = parseCodexRecord(line);
  if (!record?.payload) return null;
  const payload = record.payload;
  const turnId = typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : undefined;
  if (record.type === 'turn_context') return turnId ? { kind: 'turn_started', turnId } : null;
  if (record.type !== 'event_msg') return null;
  switch (payload.type) {
    case 'task_started':
      return turnId ? { kind: 'turn_started', turnId } : null;
    case 'user_message': {
      const text = typeof payload.message === 'string' ? cleanCodexUserText(payload.message) : '';
      if (!text || /^<(?:environment_context|user_instructions|user_shell_command)>/i.test(text)) return null;
      return turnId ? { kind: 'user', text, turnId } : { kind: 'user', text };
    }
    case 'task_complete': {
      const text = typeof payload.last_agent_message === 'string' ? payload.last_agent_message.trim() : '';
      if (!text) return null;
      return turnId ? { kind: 'final', text, turnId } : { kind: 'final', text };
    }
    case 'turn_aborted':
      return turnId ? { kind: 'aborted', turnId } : { kind: 'aborted' };
    default:
      return null;
  }
}

/** Tool-call names (and patched file paths) from a response item; arguments and outputs are discarded. */
export function extractCodexToolCall(line: string): { name: string; files: string[]; reads: string[] } | null {
  const record = parseCodexRecord(line);
  if (record?.type !== 'response_item' || !record.payload) return null;
  const payload = record.payload;
  if (payload.type === 'local_shell_call') return { name: 'shell', files: [], reads: [] };
  if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') return null;
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (!name) return null;
  const input = typeof payload.input === 'string' ? payload.input : typeof payload.arguments === 'string' ? payload.arguments : '';
  const files = name === 'apply_patch' && input
    ? [...input.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g)].map(match => match[1].trim())
    : [];
  // Only .md paths are kept from shell / read arguments; the command itself is discarded.
  const reads = name === 'apply_patch' || !input ? [] : markdownPathsIn(input);
  return { name, files, reads };
}
