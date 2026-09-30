export type CodexRole = 'user' | 'assistant';
export type CodexMessage = { id: string; role: CodexRole; text: string };
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
  if (record?.type !== 'response_item') return null;
  const payload = record.payload;
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
  const text = payload.content
    .filter((block): block is { type: string; text: string } => Boolean(block && typeof block === 'object' && 'type' in block && 'text' in block && block.type === blockType && typeof block.text === 'string'))
    .map(block => block.text)
    .filter(value => value.trim().length > 0)
    .join('\n')
    .trim();
  if (!text) return null;
  return { id: payload.id, role, text };
}
