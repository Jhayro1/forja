import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTailLines } from '../util/tail.js';

/**
 * Human log of a run (the orchestrator's `onLog` lines), appended by the process
 * that runs the plan so other processes (the board, `forja estado`) can show it.
 * It is a convenience view: the source of truth stays in the event store.
 */
export class RunLog {
  constructor(readonly path: string) {}

  static of(dataDir: string, runId: string): RunLog {
    return new RunLog(join(dataDir, 'runs', runId, 'registro.log'));
  }

  append(line: string, now = new Date()): string {
    const entry = `${now.toISOString().slice(11, 19)} ${line.replace(/\n/g, ' ')}`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${entry}\n`, { mode: 0o600 });
    return entry;
  }

  tail(lines: number): string[] {
    return existsSync(this.path) ? readTailLines(this.path, lines) : [];
  }
}
