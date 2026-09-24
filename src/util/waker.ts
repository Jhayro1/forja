import { type FSWatcher, watch } from 'node:fs';

/**
 * Wait that ends early when something relevant happens (MEJORAS 2.6). Loops use
 * it instead of sleeping a fixed interval: they react at once to a finished job
 * or a file event and fall back to a slow timer when events are not available
 * (fs.watch is best effort on some file systems).
 */
export class Waker {
  private wake: (() => void) | null = null;
  private pending = false;

  notify(): void {
    if (this.wake) this.wake();
    else this.pending = true;
  }

  wait(ms: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}

/**
 * A set of watched directories that follows what the caller needs (`sync`),
 * calling `onEvent` for file names that pass the filter.
 */
export class DirWatchSet {
  private readonly watchers = new Map<string, FSWatcher>();

  constructor(
    private readonly onEvent: () => void,
    private readonly accept: (file: string) => boolean = () => true,
  ) {}

  sync(dirs: Iterable<string>): void {
    const wanted = new Set(dirs);
    for (const [dir, w] of this.watchers) {
      if (!wanted.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      try {
        const w = watch(dir, { persistent: false }, (_type, file) => {
          if (!file || this.accept(String(file))) this.onEvent();
        });
        w.on('error', () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {
        // Not watchable (missing yet, or unsupported): the fallback timer covers it.
      }
    }
  }

  close(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}
