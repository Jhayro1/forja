import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTailLines } from '../util/tail.js';

export type RunLogOptions = {
  /** Size at which the current file is rotated (MEJORAS 2.8). */
  maxBytes?: number;
  /** Rotated files kept (registro.1.log … registro.N.log); older ones are deleted. */
  keep?: number;
};

/**
 * Human log of a run (the orchestrator's `onLog` lines), appended by the process
 * that runs the plan so other processes (the board, `forja estado`) can show it.
 * It is a convenience view: the source of truth stays in the event store, so it
 * rotates by size instead of growing without limit.
 */
export class RunLog {
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(
    readonly path: string,
    opts: RunLogOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    this.keep = opts.keep ?? 3;
  }

  static of(dataDir: string, runId: string, opts?: RunLogOptions): RunLog {
    return new RunLog(join(dataDir, 'runs', runId, 'registro.log'), opts);
  }

  /** registro.log → registro.<n>.log */
  generation(n: number): string {
    return n === 0 ? this.path : this.path.replace(/\.log$/, `.${n}.log`);
  }

  append(line: string, now = new Date()): string {
    const entry = `${now.toISOString().slice(11, 19)} ${line.replace(/\n/g, ' ')}`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (existsSync(this.path) && statSync(this.path).size + entry.length + 1 > this.maxBytes) this.rotate();
    appendFileSync(this.path, `${entry}\n`, { mode: 0o600 });
    return entry;
  }

  private rotate(): void {
    rmSync(this.generation(this.keep), { force: true });
    for (let n = this.keep - 1; n >= 0; n--) {
      if (existsSync(this.generation(n))) renameSync(this.generation(n), this.generation(n + 1));
    }
  }

  /** Last lines, continuing into the previous generation right after a rotation. */
  tail(lines: number): string[] {
    const out: string[] = [];
    for (let n = 0; n <= this.keep && out.length < lines; n++) {
      const file = this.generation(n);
      if (!existsSync(file)) continue;
      out.unshift(...readTailLines(file, lines - out.length));
    }
    return out;
  }
}
