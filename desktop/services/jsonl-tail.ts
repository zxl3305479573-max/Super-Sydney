import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Incrementally decodes appended bytes into complete JSONL lines (UTF-8 safe). */
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

  reset(offset = 0): void {
    this.offset = offset;
    this.carry = '';
    this.decoder = new StringDecoder('utf8');
  }
}

type DirEntry = { mtimeMs: number; listedAt: number; files: string[]; dirs: string[] };

/** Re-list a directory at least this often even if its mtime looks unchanged (coarse FS timestamps). */
const DIR_RELIST_MS = 30_000;

/**
 * Lists *.jsonl files under a root. Directory listings are cached and only
 * re-read when the directory mtime changes, so polling a large session tree
 * (thousands of historical files) stays cheap.
 */
export class JsonlTreeLister {
  private cache = new Map<string, DirEntry>();
  private readonly root: string;
  private readonly skipDir: (name: string) => boolean;

  constructor(root: string, skipDir: (name: string) => boolean = () => false) {
    this.root = root;
    this.skipDir = skipDir;
  }

  clear(): void {
    this.cache.clear();
  }

  list(): string[] {
    if (!fs.existsSync(this.root)) return [];
    const files: string[] = [];
    const seenDirs = new Set<string>();
    const walk = (directory: string) => {
      seenDirs.add(directory);
      let mtimeMs: number;
      try { mtimeMs = fs.statSync(directory).mtimeMs; } catch { return; }
      const now = Date.now();
      let entry = this.cache.get(directory);
      if (!entry || entry.mtimeMs !== mtimeMs || now - entry.listedAt > DIR_RELIST_MS) {
        const next: DirEntry = { mtimeMs, listedAt: now, files: [], dirs: [] };
        try {
          for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, item.name);
            if (item.isDirectory()) { if (!this.skipDir(item.name)) next.dirs.push(target); }
            else if (item.isFile() && item.name.endsWith('.jsonl')) next.files.push(target);
          }
        } catch { return; }
        entry = next;
        this.cache.set(directory, entry);
      }
      files.push(...entry.files);
      for (const child of entry.dirs) walk(child);
    };
    walk(this.root);
    for (const key of this.cache.keys()) if (!seenDirs.has(key)) this.cache.delete(key);
    return files;
  }
}

export type TailFileState = { tail: JsonlByteTail; mtimeMs: number; checkedAt: number };

export type TailScanOptions = {
  /** Files modified within this window are stat'd on every tick. */
  hotWindowMs?: number;
  /** Cold files are re-checked at most this often. */
  coldRecheckMs?: number;
};

/**
 * Generic poll-based JSONL tailer. Existing files are baselined at EOF on
 * start (no history backfill); files created after start are read from 0.
 * Truncated / rewritten files are re-read from the beginning, and per-file
 * handlers decide what to do with each complete line.
 */
export class JsonlTailScanner<S extends TailFileState> {
  readonly states = new Map<string, S>();
  private readonly lister: JsonlTreeLister;
  private readonly hotWindowMs: number;
  private readonly coldRecheckMs: number;
  private readonly createState: (file: string, offset: number) => S;
  private readonly onLines: (file: string, state: S, lines: string[]) => void;

  constructor(
    root: string,
    createState: (file: string, offset: number) => S,
    onLines: (file: string, state: S, lines: string[]) => void,
    options: TailScanOptions & { skipDir?: (name: string) => boolean } = {}
  ) {
    this.createState = createState;
    this.onLines = onLines;
    this.lister = new JsonlTreeLister(root, options.skipDir);
    this.hotWindowMs = options.hotWindowMs ?? 10 * 60_000;
    this.coldRecheckMs = options.coldRecheckMs ?? 15_000;
  }

  baseline(): void {
    this.states.clear();
    this.lister.clear();
    const now = Date.now();
    for (const file of this.lister.list()) {
      try {
        const stat = fs.statSync(file);
        const state = this.createState(file, stat.size);
        state.mtimeMs = stat.mtimeMs;
        state.checkedAt = now;
        this.states.set(file, state);
      } catch {
        // File vanished between listing and stat.
      }
    }
  }

  scan(now = Date.now()): void {
    const files = this.lister.list();
    const present = new Set(files);
    for (const file of files) {
      let state = this.states.get(file);
      if (!state) {
        state = this.createState(file, 0);
        this.states.set(file, state);
      } else {
        const hot = now - state.mtimeMs < this.hotWindowMs;
        if (!hot && now - state.checkedAt < this.coldRecheckMs) continue;
      }
      this.readAppended(file, state, now);
    }
    for (const file of this.states.keys()) if (!present.has(file)) this.states.delete(file);
  }

  private readAppended(file: string, state: S, now: number): void {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return; }
    state.checkedAt = now;
    state.mtimeMs = stat.mtimeMs;
    if (stat.size < state.tail.offset) state.tail.reset(0);
    if (stat.size === state.tail.offset) return;
    const length = stat.size - state.tail.offset;
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, state.tail.offset);
      const lines = state.tail.append(buffer.subarray(0, bytesRead));
      if (lines.length) this.onLines(file, state, lines);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** A bounded set that forgets the oldest ids, so long sessions don't grow memory forever. */
export class BoundedIdSet {
  private readonly items = new Set<string>();
  private readonly limit: number;
  constructor(limit = 2_000) { this.limit = limit; }
  has(id: string): boolean { return this.items.has(id); }
  add(id: string): void {
    this.items.add(id);
    if (this.items.size > this.limit) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }
}

export function readFirstLine(file: string, maxBytes = 256 * 1024): string {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, 0);
    return chunk.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
  } finally {
    fs.closeSync(fd);
  }
}
