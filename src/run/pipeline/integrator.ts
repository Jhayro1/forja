import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detachedWorktree, isAncestor, mergeCandidate, publishRef, refSha, removeWorktree } from '../../git/workspace.js';
import { LessonService } from '../../memory/lessons.js';
import { runCommand } from '../../verify/commands.js';
import { acceptanceFilesFor } from '../../verify/verify.js';
import type { ExecRow } from '../records.js';
import { type BatchOutcome, integrateBisecting } from './batching.js';
import { isNoChangeCandidate } from './outcome-handler.js';
import { greenTests, TEST_FILE } from './regression.js';
import type { RunContext } from './run-context.js';

/** Why a merged result cannot be published: the environment or the code. */
type CheckFailure = { kind: 'entorno' | 'calidad'; message: string };

/**
 * Integration queue (v2/05 · Cola de integración): merge onto the tip, full
 * check of the merged result, then a compare-and-swap of the ref. If the ref
 * moved in between, retry on the new tip. Serial by default; with
 * `ejecucion.integracion: lotes`, verified tasks are tried together and
 * bisected only on failure (`integrateBatch`).
 */
export class Integrator {
  /** `onIntegrated`: called with the integration worktree at the new tip (e.g. to re-index it). */
  constructor(
    private readonly ctx: RunContext,
    private readonly onIntegrated: (worktree: string, sha: string) => Promise<void> | void = () => {},
  ) {}

  async integrate(taskId: string): Promise<void> {
    const { ctx } = this;
    if (ctx.tasks().find((t) => t.task_id === taskId)?.state === 'verificada') ctx.move(taskId, 'integrando', 'integracion_iniciada');
    const exec = ctx.execOf(taskId);
    const def = ctx.task(taskId);
    const wtPath = ctx.dir('integracion');
    for (let tries = 0; tries < 3; tries++) {
      const target = await refSha(ctx.repoPath, ctx.run.branch);
      if (await isAncestor(ctx.repoPath, exec.candidate_sha!, target)) {
        this.confirm(taskId, target);
        if (isNoChangeCandidate(exec)) ctx.log(`⇪ ${taskId} integrada sin cambios (el código ya la cumplía)`);
        return;
      }
      await detachedWorktree(ctx.repoPath, wtPath, target);
      const merged = await mergeCandidate(wtPath, target, exec.candidate_sha!, `forja: integrar ${taskId} · ${def.titulo}`);
      if ('conflicts' in merged) {
        if (exec.worktree) await removeWorktree(ctx.repoPath, exec.worktree);
        ctx.exec(taskId, { worktree: null, feedback: `Tu cambio anterior chocó con lo que se integró mientras trabajabas (${merged.conflicts.join(', ')}). Rehaz la tarea sobre la base nueva.` });
        ctx.move(taskId, 'lista', 'conflicto_integracion', merged.conflicts.join(', '));
        ctx.log(`⚡ ${taskId}: conflicto al integrar (${merged.conflicts.join(', ')}); se rehace sobre la base nueva`);
        return;
      }
      const failure = await this.check([taskId], wtPath, target);
      if (failure) {
        if (failure.kind === 'entorno') ctx.environmentFailure(taskId, failure.message);
        else ctx.qualityFailure(taskId, failure.message);
        return;
      }
      if (await publishRef(ctx.repoPath, ctx.run.branch, merged.sha, target)) {
        this.confirm(taskId, merged.sha);
        this.proposeLesson(taskId, ctx.execOf(taskId), merged.sha);
        await this.onIntegrated(wtPath, merged.sha);
        if (exec.worktree) await removeWorktree(ctx.repoPath, exec.worktree);
        ctx.log(`⇪ ${taskId} integrada (${merged.sha.slice(0, 8)})`);
        return;
      }
      // The ref moved between check and publish: retry on the new tip.
    }
    ctx.environmentFailure(taskId, 'la rama de integración cambió varias veces durante la integración');
  }

  /** Several verified tasks: one merge and one check for all, bisecting on failure. */
  async integrateBatch(ids: readonly string[]): Promise<void> {
    await integrateBisecting(
      ids,
      (batch) => this.tryBatch(batch),
      (id) => this.integrate(id),
    );
  }

  private async tryBatch(ids: string[]): Promise<BatchOutcome> {
    const { ctx } = this;
    const target = await refSha(ctx.repoPath, ctx.run.branch);
    const execs = ids.map((id) => ctx.execOf(id));
    for (const e of execs) if (await isAncestor(ctx.repoPath, e.candidate_sha!, target)) return 'serie';
    for (const id of ids) if (ctx.tasks().find((t) => t.task_id === id)?.state === 'verificada') ctx.move(id, 'integrando', 'integracion_iniciada');
    const wtPath = ctx.dir('integracion');
    await detachedWorktree(ctx.repoPath, wtPath, target);
    // Each task gets its own merge commit: the history stays per task.
    const shas: string[] = [];
    let tip = target;
    for (const [i, id] of ids.entries()) {
      const merged = await mergeCandidate(wtPath, tip, execs[i]!.candidate_sha!, `forja: integrar ${id} · ${ctx.task(id).titulo}`);
      if ('conflicts' in merged) return 'serie';
      tip = merged.sha;
      shas.push(tip);
    }
    const failure = await this.check(ids, wtPath, target);
    if (failure) {
      ctx.log(`⇪ lote ${ids.join(', ')}: falló junto (${failure.kind}); se divide para encontrar la causa`);
      return 'fallo';
    }
    if (!(await publishRef(ctx.repoPath, ctx.run.branch, tip, target))) return 'serie';
    for (const [i, id] of ids.entries()) {
      this.confirm(id, shas[i]!);
      this.proposeLesson(id, ctx.execOf(id), shas[i]!);
    }
    await this.onIntegrated(wtPath, tip);
    for (const e of execs) if (e.worktree) await removeWorktree(ctx.repoPath, e.worktree);
    ctx.log(`⇪ lote ${ids.join(', ')} integrado con una sola verificación (${tip.slice(0, 8)})`);
    return 'integrado';
  }

  private confirm(taskId: string, sha: string): void {
    this.ctx.exec(taskId, { integrated_sha: sha, env_failures: 0 });
    this.ctx.move(taskId, 'integrada', 'integracion_confirmada');
  }

  /** Full check of a merged result before publishing it; null when it can be published. */
  private async check(ids: string[], wtPath: string, target: string): Promise<CheckFailure | null> {
    const { ctx } = this;
    const c = ctx.plan.perfil.comandos;
    if (c.instalar && existsSync(join(wtPath, 'package.json'))) {
      const r = await runCommand({ ...ctx.cmd, networkHosts: ctx.plan.perfil.red_instalar }, wtPath, c.instalar);
      if (!r.ok) return { kind: 'entorno', message: `instalación en integración: ${r.output.split('\n').slice(-2).join(' ')}` };
    }
    for (const name of ['typecheck', 'build'] as const) {
      const recipe = c[name];
      if (!recipe || ctx.preexisting.has(name)) continue;
      const r = await runCommand(ctx.cmd, wtPath, recipe);
      if (!r.ok) return { kind: 'calidad', message: `Al integrarlo con lo demás falló «${name}»:\n${r.output}` };
    }
    const tested = ids.filter((id) => ctx.task(id).tipo !== 'pruebas');
    if (c.test && tested.length) {
      const own = tested.flatMap((id) => [...acceptanceFilesFor(ctx.plan, ctx.task(id)), ...(JSON.parse(ctx.execOf(id).files ?? '[]') as string[]).filter((f) => TEST_FILE.test(f))]);
      const selection = [...new Set([...(await greenTests(ctx, target)), ...own])].filter((f) => existsSync(join(wtPath, f)));
      if (selection.length) {
        const r = await runCommand(ctx.cmd, wtPath, c.test, selection);
        if (!r.ok) return { kind: 'calidad', message: `Al integrarlo con lo demás fallaron las pruebas:\n${r.output}` };
      }
    }
    return null;
  }

  /** A task that passed after failing leaves a lesson PROPOSAL (a human decides if it is worth keeping). */
  private proposeLesson(taskId: string, exec: ExecRow, sha: string): void {
    if (exec.quality_failures === 0 || !exec.feedback) return;
    const def = this.ctx.task(taskId);
    const cause = exec.feedback.split('\n').find((l) => l.trim()) ?? '';
    new LessonService(this.ctx.engine.store).propose(
      `En tareas de tipo ${def.tipo} sobre ${def.escribe.join(', ') || 'este módulo'}: un intento falló por «${cause.slice(0, 300)}» y se resolvió en el intento ${exec.attempt}. Tenlo en cuenta desde el primer intento.`,
      { tipo: def.tipo, archivos: JSON.parse(exec.files ?? '[]') as string[] },
      { run: this.ctx.runId, tarea: taskId, commit: sha, intentos: exec.attempt, fallos: exec.quality_failures },
      `${this.ctx.runId}:${taskId}`,
    );
  }
}
