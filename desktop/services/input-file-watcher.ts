import fs from 'node:fs';
import path from 'node:path';

export type InputFileChange = { path: string; changeType: 'rename' | 'change' };

export class InputFileWatcher {
  private watchers: fs.FSWatcher[] = [];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly callback: (change: InputFileChange) => void) {}

  start(paths: string[]): void {
    this.stop();
    const files = new Set(paths.map(value => path.resolve(value)).filter(value => fs.existsSync(value) && fs.statSync(value).isFile()));
    const directories = new Set(paths.map(value => path.resolve(value)).filter(value => fs.existsSync(value) && fs.statSync(value).isDirectory()));
    for (const file of files) directories.add(path.dirname(file));
    for (const target of directories) {
      try {
        const watcher = fs.watch(target, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const changed = path.resolve(target, filename.toString());
          if (files.size && !files.has(changed) && ![...files].some(file => changed.startsWith(`${file}${path.sep}`))) return;
          const previous = this.timers.get(changed);
          if (previous) clearTimeout(previous);
          this.timers.set(changed, setTimeout(() => {
            this.timers.delete(changed);
            this.callback({ path: changed, changeType: eventType === 'rename' ? 'rename' : 'change' });
          }, 600));
        });
        this.watchers.push(watcher);
      } catch {
        // A missing or unsupported directory is ignored until settings are refreshed.
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
