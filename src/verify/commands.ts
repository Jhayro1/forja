import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newId } from '../domain/ids.js';
import type { CommandRecipe } from '../registry/config.js';
import { buildAgentEnv } from '../security/env.js';
import { launchDir, readSpool, spawnRunner, waitForLaunch, writeOrder, DEFAULT_RUNNER_SCRIPT } from '../runtime/launcher.js';
import type { LaunchOrder } from '../runtime/order.js';
import { binaryBinds } from '../runtime/sandbox.js';
import { resolveExecutable } from '../providers/adapters.js';

export type CommandRun = { ok: boolean; exitCode: number | null; status: string; output: string; launchId: string; durationMs: number };

export type CommandContext = {
  dataDir: string;
  runnerScript?: string;
  /** Hosts allowed for this command (only install gets the package registry). */
  networkHosts?: string[];
  sandbox: boolean;
  timeoutMs: number;
};

/**
 * Runs a profile command (install, typecheck, test…) inside the sandbox through
 * the same durable runner as agents. Never a shell string: executable + args.
 */
export async function runCommand(ctx: CommandContext, cwd: string, recipe: CommandRecipe | { executable: string; args: string[] }, extraArgs: string[] = []): Promise<CommandRun> {
  const launchId = newId('cmd');
  const dir = launchDir(ctx.dataDir, launchId);
  const cache = join(ctx.dataDir, 'cache');
  mkdirSync(join(cache, 'npm'), { recursive: true, mode: 0o700 });
  const home = homedir();
  const exe = resolveExecutable(recipe.executable) ?? recipe.executable;
  const order: LaunchOrder = {
    protocol_version: 1,
    launch_id: launchId,
    fencing_token: 1,
    run_id: 'verificacion',
    task_id: 'comando',
    attempt: 1,
    provider: 'comando',
    argv: [exe, ...recipe.args, ...extraArgs],
    env: buildAgentEnv(process.env, { home, tmpdir: '/tmp', extra: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', npm_config_cache: join(home, '.npm'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' } }),
    cwd: 'cwd' in recipe && recipe.cwd && recipe.cwd !== '.' ? join(cwd, recipe.cwd) : cwd,
    sandbox: ctx.sandbox
      ? {
          mode: 'bwrap',
          home,
          mounts: [{ src: join(cache, 'npm'), dest: join(home, '.npm'), rw: true }],
          read_only: binaryBinds([exe, process.execPath]),
          network_hosts: ctx.networkHosts ?? [],
          workspace_read_only: false,
        }
      : { mode: 'ninguno' },
    timeout_ms: ctx.timeoutMs,
    kill_grace_ms: 3000,
    redact_files: [],
  };
  const started = Date.now();
  writeOrder(dir, order);
  spawnRunner(dir, ctx.runnerScript ?? DEFAULT_RUNNER_SCRIPT);
  const status = await waitForLaunch(dir, ctx.timeoutMs + 30_000);
  const lines = readSpool(dir).filter((r) => r.stream !== 'forja').map((r) => r.line);
  const output = lines.slice(-120).join('\n');
  if (status.state !== 'terminado') return { ok: false, exitCode: null, status: status.state, output, launchId, durationMs: Date.now() - started };
  const r = status.result;
  return { ok: r.status === 'terminado' && r.exit_code === 0, exitCode: r.exit_code, status: r.status, output, launchId, durationMs: Date.now() - started };
}
