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
  try {
    process.kill(holder.pid, 'SIGINT');
    return holder;
  } catch {
    return null;
  }
}
