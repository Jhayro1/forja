import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { pidExists } from '../util/proc.js';

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

/**
 * Without /proc (Windows, macOS) the start time is not cheap to read: the identity is
 * marked «sin-proc» and liveness falls back to «the pid exists». A recycled pid can be
 * mistaken for the owner there, which only delays the takeover of a stale lock.
 */
const NO_PROC = 'sin-proc';

export function currentIdentity(): ProcessIdentity {
  return { pid: process.pid, start: processStart(process.pid) ?? (process.platform === 'linux' ? 'desconocido' : NO_PROC) };
}

export function isAlive(identity: ProcessIdentity): boolean {
  if (identity.start === NO_PROC) return pidExists(identity.pid);
  const start = processStart(identity.pid);
  return start !== null && start === identity.start;
}

export class LockHeldError extends Error {
  constructor(readonly holder: ProcessIdentity & { purpose?: string }) {
    super(`otro proceso de Forja (pid ${holder.pid}) está usando este proyecto${holder.purpose ? ` para ${holder.purpose}` : ''}`);
  }
}

/** Live owner of a lock file, or null when it is free or its owner died. */
export function lockHolder(path: string): (ProcessIdentity & { purpose?: string }) | null {
  try {
    const holder = JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity & { purpose?: string };
    return isAlive(holder) ? holder : null;
  } catch {
    return null;
  }
}

/** Exclusive lock file; a stale lock (owner dead) is taken over, a live one is refused. */
export class LockFile {
  private constructor(private readonly path: string) {}

  static acquire(path: string, purpose: string): LockFile {
    // Written whole to a private file, then published with link(2), which fails if the
    // lock exists: nobody can ever read a half-written lock and take it for a stale one.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...currentIdentity(), purpose }), { mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          linkSync(tmp, path);
          return new LockFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const holder = lockHolder(path);
          if (holder) throw new LockHeldError(holder);
          unlinkSync(path);
        }
      }
    } finally {
      unlinkSync(tmp);
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
