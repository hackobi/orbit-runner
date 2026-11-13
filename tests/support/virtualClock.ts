// A clock that only moves when a test tells it to. Everything in the netcode
// takes its time from a function, so a minute of play runs in milliseconds
// and gives the same result every time.

interface Scheduled {
  atMs: number;
  order: number;
  run: () => void;
}

export class VirtualClock {
  private timeMs = 0;
  private order = 0;
  private readonly queue: Scheduled[] = [];

  readonly now = (): number => this.timeMs;

  at(atMs: number, run: () => void): void {
    const entry: Scheduled = { atMs: Math.max(atMs, this.timeMs), order: this.order++, run };
    let index = this.queue.length;
    while (index > 0) {
      const before = this.queue[index - 1];
      if (!before || before.atMs <= entry.atMs) break;
      index--;
    }
    this.queue.splice(index, 0, entry);
  }

  after(delayMs: number, run: () => void): void {
    this.at(this.timeMs + delayMs, run);
  }

  /** Calls `run` at firstMs, firstMs + intervalMs, ... until `stop` is called. */
  every(intervalMs: number, run: () => void, firstMs = this.timeMs + intervalMs): () => void {
    let stopped = false;
    let count = 0;
    const schedule = (): void => {
      this.at(firstMs + count * intervalMs, () => {
        if (stopped) return;
        run();
        count++;
        schedule();
      });
    };
    schedule();
    return () => {
      stopped = true;
    };
  }

  /** Runs everything scheduled up to and including the given time. */
  runUntil(untilMs: number): void {
    for (;;) {
      const next = this.queue[0];
      if (!next || next.atMs > untilMs) break;
      this.queue.shift();
      this.timeMs = next.atMs;
      next.run();
    }
    this.timeMs = Math.max(this.timeMs, untilMs);
  }
}
