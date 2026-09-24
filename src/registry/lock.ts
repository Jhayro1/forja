import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

/**
 * Process identity = pid + start time, so a recycled pid is not mistaken for
 * the original owner (v2/05: PID alone is only diagnostic).
 */
export type ProcessIdentity = { pid: number; start: string };

export function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 22 (starttime) comes after the parenthesized command, which may contain spaces.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

export function currentIdentity(): ProcessIdentity {
  return { pid: process.pid, start: processStart(process.pid) ?? 'desconocido' };
}

export function isAlive(identity: ProcessIdentity): boolean {
  const start = processStart(identity.pid);
  return start !== null && start === identity.start;
}

export class LockHeldError extends Error {
  constructor(readonly holder: ProcessIdentity & { purpose?: string }) {
    super(`otro proceso de Forja (pid ${holder.pid}) está usando este proyecto${holder.purpose ? ` para ${holder.purpose}` : ''}`);
  }
}

/** Exclusive lock file; a stale lock (owner dead) is taken over, a live one is refused. */
export class LockFile {
  private constructor(private readonly path: string) {}

  static acquire(path: string, purpose: string): LockFile {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        writeSync(fd, JSON.stringify({ ...currentIdentity(), purpose }));
        closeSync(fd);
        return new LockFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let holder: (ProcessIdentity & { purpose?: string }) | null = null;
        try {
          holder = JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity & { purpose?: string };
        } catch {
          holder = null;
        }
        if (holder && isAlive(holder)) throw new LockHeldError(holder);
        unlinkSync(path);
      }
    }
    throw new Error(`no se pudo tomar el bloqueo ${path}`);
  }

  release(): void {
    try {
      unlinkSync(this.path);
    } catch {
      // Already gone.
    }
  }
}
