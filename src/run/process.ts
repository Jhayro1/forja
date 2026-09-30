import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LockFile, lockHolder, type ProcessIdentity } from '../registry/lock.js';

/**
 * One process at a time orchestrates a checkout (and restore takes the same
 * lock). Other processes — the board, `forja estado`, `forja detener` — find it
 * through the lock file and never write Git or launch agents themselves.
 */
export const orchestratorLockPath = (dataDir: string): string => join(dataDir, 'orquestador.lock');

export const RUN_PURPOSE = 'ejecutar el plan';

export function acquireOrchestratorLock(dataDir: string, purpose: string): LockFile {
  return LockFile.acquire(orchestratorLockPath(dataDir), purpose);
}

/** The live `forja run` of this checkout, if any. */
export function runningOrchestrator(dataDir: string): (ProcessIdentity & { purpose?: string }) | null {
  const holder = lockHolder(orchestratorLockPath(dataDir));
  return holder?.purpose === RUN_PURPOSE ? holder : null;
}

/**
 * Asks the running orchestrator to stop gracefully (same as Ctrl-C in its
 * terminal): no new launches; agents already working finish and are resumed later.
 */
export function requestStop(dataDir: string): ProcessIdentity | null {
  const holder = runningOrchestrator(dataDir);
  if (!holder) return null;
  // Windows cannot send SIGINT to another process (it would kill it): the stop is
  // also a file the run watches (stopRequested).
  writeFileSync(stopFilePath(dataDir), new Date().toISOString());
  if (process.platform === 'win32') return holder;
  try {
    process.kill(holder.pid, 'SIGINT');
    return holder;
  } catch {
    return null;
  }
}

export const stopFilePath = (dataDir: string): string => join(dataDir, 'detener-run');

/**
 * Files that ask a running `forja run` to stop gracefully: the checkout's, and the
 * panel job's own (`FORJA_TRABAJO_DIR`, set by the job watcher) when it runs as a job.
 */
export function stopFiles(dataDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [stopFilePath(dataDir), ...(env.FORJA_TRABAJO_DIR ? [join(env.FORJA_TRABAJO_DIR, 'detener')] : [])];
}

/** Clears stale stop requests (a new run must not stop at once). */
export function clearStopRequests(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const f of stopFiles(dataDir, env)) rmSync(f, { force: true });
}

export function stopRequested(dataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return stopFiles(dataDir, env).some((f) => existsSync(f));
}
