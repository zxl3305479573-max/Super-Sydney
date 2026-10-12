/** 同一条任务同一时间只允许一个长操作，避免两次生成互相覆盖。 */
export class RequestLock {
  private readonly busy = new Set<number>();
  private readonly busyMessage: string;

  constructor(busyMessage: string) {
    this.busyMessage = busyMessage;
  }

  has(id: number): boolean {
    return this.busy.has(id);
  }

  async run<T>(id: number, operation: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new Error(this.busyMessage);
    this.busy.add(id);
    try { return await operation(); } finally { this.busy.delete(id); }
  }
}
