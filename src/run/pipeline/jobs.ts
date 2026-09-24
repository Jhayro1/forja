/**
 * At most one job per key (`<kind>:<task>`), each tracked until it settles. An
 * unexpected exception is an internal problem: after `maxErrors` in a row for the
 * same key, `onGiveUp` decides what happens to the task instead of looping forever.
 */
export class JobRunner {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, number>();

  constructor(
    private readonly hooks: { onError: (key: string, message: string) => void; onGiveUp: (key: string, message: string) => void },
    private readonly maxErrors = 3,
  ) {}

  spawn(key: string, fn: () => Promise<void>): void {
    if (this.jobs.has(key)) return;
    const p = fn()
      .then(() => {
        this.errors.delete(key);
      })
      .catch((error: unknown) => {
        const message = (error as Error).message;
        const n = (this.errors.get(key) ?? 0) + 1;
        this.errors.set(key, n);
        this.hooks.onError(key, message);
        if (n >= this.maxErrors) {
          this.errors.delete(key);
          this.hooks.onGiveUp(key, message);
        }
      })
      .finally(() => this.jobs.delete(key));
    this.jobs.set(key, p);
  }

  has(key: string): boolean {
    return this.jobs.has(key);
  }

  get size(): number {
    return this.jobs.size;
  }

  /** Tasks with a job in flight (the part of the key after the kind). */
  busyTasks(): Set<string> {
    return new Set([...this.jobs.keys()].map((k) => k.slice(k.indexOf(':') + 1)));
  }

  settle(): Promise<unknown> {
    return Promise.allSettled([...this.jobs.values()]);
  }
}
