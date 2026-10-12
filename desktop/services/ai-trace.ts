/**
 * Metadata-only trace of one AI turn: which tools ran and which files were
 * touched. Never stores tool arguments, command lines, or tool output.
 */
export type AiTurnTrace = {
  tools: Record<string, number>;
  files: string[];
  /** Markdown / text files the agent read (paths only), used for knowledge-reuse stats. */
  reads?: string[];
  durationMs: number;
  interrupted: boolean;
  model?: string;
};

export class TraceBuilder {
  private tools: Record<string, number> = {};
  private files = new Set<string>();
  private reads = new Set<string>();
  private startedAt = 0;
  private lastAt = 0;
  interrupted = false;
  model = '';

  touch(timestamp?: string | number): void {
    const value = typeof timestamp === 'number' ? timestamp : timestamp ? Date.parse(timestamp) : Date.now();
    const at = Number.isFinite(value) ? value : Date.now();
    if (!this.startedAt) this.startedAt = at;
    if (at > this.lastAt) this.lastAt = at;
  }

  tool(name: string, files: string[] = []): void {
    if (!name) return;
    this.tools[name] = (this.tools[name] || 0) + 1;
    for (const file of files) if (file && this.files.size < 200) this.files.add(file);
  }

  read(files: string[]): void {
    for (const file of files) if (file && this.reads.size < 200) this.reads.add(file);
  }

  snapshot(): AiTurnTrace {
    const trace: AiTurnTrace = {
      tools: { ...this.tools },
      files: [...this.files],
      ...(this.reads.size ? { reads: [...this.reads] } : {}),
      durationMs: this.startedAt && this.lastAt ? Math.max(0, this.lastAt - this.startedAt) : 0,
      interrupted: this.interrupted
    };
    if (this.model) trace.model = this.model;
    return trace;
  }

  reset(): void {
    this.tools = {};
    this.files.clear();
    this.reads.clear();
    this.startedAt = 0;
    this.lastAt = 0;
    this.interrupted = false;
    this.model = '';
  }
}

export function formatTrace(json: string): string {
  if (!json) return '';
  try {
    const trace = JSON.parse(json) as AiTurnTrace;
    const tools = Object.entries(trace.tools || {}).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}×${count}`).join('、');
    const parts = [
      tools ? `工具 ${tools}` : '未调用工具',
      trace.files?.length ? `改动 ${trace.files.length} 个文件` : '',
      trace.durationMs ? `用时 ${Math.max(1, Math.round(trace.durationMs / 1000))} 秒` : '',
      trace.interrupted ? '被中断' : '',
      trace.model || ''
    ];
    return parts.filter(Boolean).join(' · ');
  } catch {
    return '';
  }
}

/** Pick note-like paths (.md) out of a free-form tool argument string. Nothing else is kept. */
export function markdownPathsIn(value: string): string[] {
  const found = new Set<string>();
  for (const match of value.matchAll(/(?:[A-Za-z]:)?[^\s"'`<>|*?]*?\.md\b/g)) {
    const candidate = match[0].replace(/^[([{]+/, '');
    if (candidate.length > 3 && candidate.length < 400) found.add(candidate.replace(/\\\\/g, '\\'));
  }
  return [...found];
}
