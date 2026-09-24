import { git } from '../../git/git.js';
import { acceptanceFilesFor } from '../../verify/verify.js';
import type { RunContext } from './run-context.js';

export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Test files already green at `tip`: the regression suite for later tasks. Only
 * tasks whose integration is contained in `tip` count — another task may be
 * integrated while a verification is being prepared, and its tests must not be
 * demanded from a base that does not have its code yet. Inherited tasks (no
 * integrated SHA in this run) are in the run's base by construction.
 *
 * One `git rev-list` for the whole run instead of one `merge-base` per task (MEJORAS 2.9).
 */
export async function greenTests(ctx: RunContext, tip: string): Promise<string[]> {
  const integrated = ctx.tasks().filter((x) => x.state === 'integrada');
  if (integrated.length === 0) return [];
  const reachable = new Set((await git(ctx.repoPath, ['rev-list', tip, `^${ctx.run.base_sha}`])).stdout.split('\n').filter(Boolean));
  reachable.add(ctx.run.base_sha);
  const out = new Set<string>();
  for (const t of integrated) {
    const def = ctx.task(t.task_id);
    if (!def || def.tipo === 'pruebas') continue;
    const exec = ctx.execOf(t.task_id);
    if (exec.integrated_sha && !reachable.has(exec.integrated_sha)) continue;
    for (const f of acceptanceFilesFor(ctx.plan, def)) out.add(f);
    for (const f of JSON.parse(exec.files ?? '[]') as string[]) if (TEST_FILE.test(f)) out.add(f);
  }
  return [...out];
}
