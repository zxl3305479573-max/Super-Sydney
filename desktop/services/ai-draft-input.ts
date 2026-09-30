import type { DeepSeekInput } from './deepseek.ts';
import type { WorkEvent } from '../shared.ts';

export function buildDeepSeekInput(event: WorkEvent): DeepSeekInput {
  if (event.source === 'codex') {
    return { prompt: event.codex_prompt || event.note, response: event.codex_response || event.summary };
  }
  return { prompt: event.note, response: event.summary || event.window_title };
}
