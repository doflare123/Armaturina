/** FIFO entertainment jobs per chat. Moderation never joins this queue. */
export class CommandQueue {
  private readonly chats = new Map<number, Array<() => Promise<void>>>();
  private readonly running = new Set<Promise<void>>();
  private closed = false;

  enqueue(chatId: number, task: () => Promise<void>): void {
    if (this.closed) return;
    const pending = this.chats.get(chatId);
    if (pending) {
      pending.push(task);
      return;
    }
    const jobs = [task];
    this.chats.set(chatId, jobs);
    const running = this.process(chatId, jobs);
    this.running.add(running);
    void running.then(() => this.running.delete(running));
  }

  private async process(chatId: number, jobs: Array<() => Promise<void>>): Promise<void> {
    while (!this.closed && jobs.length) {
      const task = jobs.shift();
      try {
        await task?.();
      } catch {
        if (!this.closed) console.error('entertainment_command_failed', { chatId });
      }
    }
    this.chats.delete(chatId);
  }

  /** Discard pending jokes on shutdown; let the active handlers settle. */
  close(): void {
    this.closed = true;
    for (const jobs of this.chats.values()) jobs.length = 0;
  }

  async idle(): Promise<void> {
    await Promise.all(this.running);
  }
}
