import { spawn } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlive, type ProcessIdentity } from '../registry/lock.js';
import { killTree } from '../util/proc.js';
import { FILES, LaunchOrder, LaunchResult, type SpoolRecord } from './order.js';

export const DEFAULT_RUNNER_SCRIPT = fileURLToPath(new URL('./runner-main.js', import.meta.url));

export function launchDir(dataDir: string, launchId: string): string {
  return join(dataDir, 'lanzamientos', launchId);
}

/** Step 1 of the launch protocol: the order is durable before any process exists. */
export function writeOrder(dir: string, order: LaunchOrder): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const valid = LaunchOrder.parse(order);
  const path = join(dir, FILES.order);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (existing !== JSON.stringify(valid)) throw new Error(`el lanzamiento ${valid.launch_id} ya tiene otra orden`);
    return;
  }
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  writeFileSync(fd, JSON.stringify(valid));
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

/** Starts a detached runner. Repeating it is safe: a second runner exits on the launch lock. */
export function spawnRunner(dir: string, runnerScript = DEFAULT_RUNNER_SCRIPT): number | undefined {
  const logFd = openSync(join(dir, 'runner.err'), 'a', 0o600);
  const child = spawn(process.execPath, [runnerScript, dir], { detached: true, stdio: ['ignore', 'ignore', logFd], windowsHide: true });
  closeSync(logFd);
  child.unref();
  return child.pid;
}

export type LaunchStatus =
  | { state: 'sin_iniciar' }
  | { state: 'corriendo'; runner: ProcessIdentity; heartbeatAgeMs: number | null }
  | { state: 'terminado'; result: LaunchResult }
  /** The runner died without a result: its sandbox died with it (--die-with-parent). */
  | { state: 'interrumpido'; runner: ProcessIdentity };

export function launchStatus(dir: string, now = Date.now()): LaunchStatus {
  const resultPath = join(dir, FILES.result);
  if (existsSync(resultPath)) return { state: 'terminado', result: LaunchResult.parse(JSON.parse(readFileSync(resultPath, 'utf8'))) };
  const runnerPath = join(dir, FILES.runner);
  if (!existsSync(runnerPath)) return { state: 'sin_iniciar' };
  const runner = JSON.parse(readFileSync(runnerPath, 'utf8')) as ProcessIdentity;
  if (!isAlive(runner)) {
    // The result could have been written between both checks.
    if (existsSync(resultPath)) return launchStatus(dir, now);
    return { state: 'interrumpido', runner };
  }
  let heartbeatAgeMs: number | null = null;
  try {
    heartbeatAgeMs = now - statSync(join(dir, FILES.heartbeat)).mtimeMs;
  } catch {
    heartbeatAgeMs = null;
  }
  return { state: 'corriendo', runner, heartbeatAgeMs };
}

/** Records after `afterSeq`. A trailing half-written line is ignored until complete. */
export function readSpool(dir: string, afterSeq = 0): SpoolRecord[] {
  const path = join(dir, FILES.spool);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  const out: SpoolRecord[] = [];
  for (const line of complete.split('\n')) {
    if (!line) continue;
    const record = JSON.parse(line) as SpoolRecord;
    if (record.seq > afterSeq) out.push(record);
  }
  return out;
}

/**
 * Asks the runner to stop (it kills its sandbox and writes the result). The request is
 * a file the runner polls, plus SIGTERM where signals exist: on Windows a «signal»
 * would kill the runner outright and leave the agent running without a result.
 */
export function cancelLaunch(dir: string): boolean {
  const status = launchStatus(dir);
  if (status.state !== 'corriendo') return false;
  writeFileSync(join(dir, FILES.cancel), new Date().toISOString(), { mode: 0o600 });
  if (process.platform === 'win32') return true;
  try {
    process.kill(status.runner.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * A runner that died in «directo» mode leaves its agent behind (no --die-with-parent
 * without a sandbox): kill that tree before the task is relaunched on the same worktree.
 */
export function killOrphanAgent(dir: string): boolean {
  const path = join(dir, FILES.agent);
  if (!existsSync(path) || existsSync(join(dir, FILES.result))) return false;
  try {
    const { pid } = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    killTree(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** Waits until the launch has a result (or is interrupted), polling the files. */
export async function waitForLaunch(dir: string, timeoutMs: number, pollMs = 100): Promise<LaunchStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = launchStatus(dir);
    if (status.state === 'terminado' || status.state === 'interrumpido') return status;
    if (Date.now() > deadline) return status;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
