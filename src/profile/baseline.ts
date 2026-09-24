import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Engine } from '../core/engine.js';
import type { StoredEvent } from '../domain/events.js';
import { hashJson } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import { gitOut } from '../git/git.js';
import { detachedWorktree, removeWorktree } from '../git/workspace.js';
import type { Db } from '../store/sqlite.js';
import { type CommandContext, runCommand } from '../verify/commands.js';
import { type ProfileCommands, profileCommands } from './detect.js';

/**
 * Baseline (V2-030): the approved profile run once on the untouched repository,
 * in the sandbox, before any agent changes anything. A step that already fails
 * there is the repository's problem, not the agent's: verification reports it
 * as pre-existing instead of blaming (and escalating) every task.
 */

export const PEV = { approved: 'perfil.aprobado', baseline: 'perfil.linea_base' } as const;

const Step = z.object({ paso: z.string(), ok: z.boolean(), detalle: z.string() }).strict();
const Approved = z.object({ hash: z.string(), perfil: z.record(z.string(), z.unknown()), actor: z.string() }).strict();
const Baseline = z.object({ sha: z.string(), profile_hash: z.string(), pasos: z.array(Step) }).strict();
export type BaselineStep = z.infer<typeof Step>;
export type BaselineRow = { sha: string; profile_hash: string; pasos: BaselineStep[]; recorded_at: string };

export function applyProfileEvent(db: Db, e: StoredEvent): void {
  if (e.type === PEV.baseline) {
    const p = Baseline.parse(e.payload);
    db.prepare('INSERT INTO baselines (baseline_id, sha, profile_hash, steps, recorded_at, created_seq) VALUES (?, ?, ?, ?, ?, ?)').run(
      e.aggregate_id,
      p.sha,
      p.profile_hash,
      JSON.stringify(p.pasos),
      e.recorded_at,
      e.seq,
    );
  } else if (e.type === PEV.approved) {
    Approved.parse(e.payload);
  }
}

export const PROFILE_TABLES = ['baselines'] as const;

/** Identity of a profile for its baseline: the commands, not stack labels or cwd defaults. */
export const profileHash = (perfil: { comandos: Parameters<typeof profileCommands>[0]['comandos'] }): string => hashJson(profileCommands(perfil));

export function recordProfileApproval(engine: Engine, perfil: object & { comandos: Parameters<typeof profileCommands>[0]['comandos'] }, actor: string): string {
  const hash = profileHash(perfil);
  engine.store.execute({ request_id: newId('req'), type: 'aprobar_perfil', input: { hash } }, () => ({
    result: null,
    events: [{ type: PEV.approved, aggregate_type: 'perfil', aggregate_id: hash, payload: { hash, perfil: perfil as Record<string, unknown>, actor } }],
  }));
  return hash;
}

export function latestBaseline(engine: Engine, profile?: string): BaselineRow | null {
  const row = (
    profile
      ? engine.store.db.prepare('SELECT * FROM baselines WHERE profile_hash = ? ORDER BY created_seq DESC LIMIT 1').get(profile)
      : engine.store.db.prepare('SELECT * FROM baselines ORDER BY created_seq DESC LIMIT 1').get()
  ) as { sha: string; profile_hash: string; steps: string; recorded_at: string } | undefined;
  return row ? { sha: row.sha, profile_hash: row.profile_hash, pasos: JSON.parse(row.steps) as BaselineStep[], recorded_at: row.recorded_at } : null;
}

/** Repository-wide steps that already failed on the baseline of this exact profile. */
export function preexistingFailures(engine: Engine, perfil: { comandos: Parameters<typeof profileCommands>[0]['comandos'] }): Set<string> {
  const b = latestBaseline(engine, profileHash(perfil));
  return new Set((b?.pasos ?? []).filter((s) => !s.ok && s.paso !== 'instalar').map((s) => s.paso));
}

const ORDER = ['instalar', 'typecheck', 'build', 'lint', 'test'] as const;

export async function runBaseline(
  engine: Engine,
  input: { repoPath: string; comandos: ProfileCommands; red_instalar: string[]; cmd: CommandContext; onStep?: (s: BaselineStep) => void },
): Promise<BaselineRow> {
  const sha = await gitOut(input.repoPath, ['rev-parse', 'HEAD']);
  const wt = join(engine.dataDir, 'worktrees', 'linea-base');
  await detachedWorktree(input.repoPath, wt, sha);
  const pasos: BaselineStep[] = [];
  try {
    for (const name of ORDER) {
      const recipe = input.comandos[name];
      if (!recipe) continue;
      if (name === 'instalar' && !existsSync(join(wt, 'package.json')) && recipe.executable.match(/^(npm|pnpm|yarn|bun)$/)) continue;
      const r = await runCommand(name === 'instalar' ? { ...input.cmd, networkHosts: input.red_instalar } : input.cmd, wt, recipe);
      const step = { paso: name, ok: r.ok, detalle: r.ok ? `${Math.round(r.durationMs / 1000)}s` : r.output.split('\n').slice(-12).join('\n').slice(-2000) };
      pasos.push(step);
      input.onStep?.(step);
      // Without dependencies nothing else can be judged.
      if (name === 'instalar' && !r.ok) break;
    }
  } finally {
    await removeWorktree(input.repoPath, wt);
  }
  const profile_hash = hashJson(input.comandos);
  const id = newId('lb');
  engine.store.execute({ request_id: `linea-base:${id}`, type: 'linea_base', input: { sha } }, () => ({
    result: null,
    events: [{ type: PEV.baseline, aggregate_type: 'perfil', aggregate_id: id, payload: { sha, profile_hash, pasos } }],
  }));
  return latestBaseline(engine, profile_hash)!;
}
