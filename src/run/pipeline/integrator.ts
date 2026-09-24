import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detachedWorktree, isAncestor, mergeCandidate, publishRef, refSha, removeWorktree } from '../../git/workspace.js';
import { LessonService } from '../../memory/lessons.js';
import { runCommand } from '../../verify/commands.js';
import { acceptanceFilesFor } from '../../verify/verify.js';
import type { ExecRow } from '../records.js';
import { isNoChangeCandidate } from './outcome-handler.js';
import { TEST_FILE, greenTests } from './regression.js';
import type { RunContext } from './run-context.js';

/**
 * Serial integration queue (v2/05 · Cola de integración): merge onto the tip,
 * full check of the merged result, then a compare-and-swap of the ref. If the
 * ref moved in between, retry on the new tip.
 */
export class Integrator {
  constructor(private readonly ctx: RunContext) {}

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
      if (!(await this.checkMerged(taskId, exec, wtPath, target))) return;
      if (await publishRef(ctx.repoPath, ctx.run.branch, merged.sha, target)) {
        this.confirm(taskId, merged.sha);
        this.proposeLesson(taskId, ctx.execOf(taskId), merged.sha);
        if (exec.worktree) await removeWorktree(ctx.repoPath, exec.worktree);
        ctx.log(`⇪ ${taskId} integrada (${merged.sha.slice(0, 8)})`);
        return;
      }
      // The ref moved between check and publish: retry on the new tip.
    }
    ctx.environmentFailure(taskId, 'la rama de integración cambió varias veces durante la integración');
  }

  private confirm(taskId: string, sha: string): void {
    this.ctx.exec(taskId, { integrated_sha: sha, env_failures: 0 });
    this.ctx.move(taskId, 'integrada', 'integracion_confirmada');
  }

  /** Full check on the merged candidate before publishing. False: the task already moved. */
  private async checkMerged(taskId: string, exec: ExecRow, wtPath: string, target: string): Promise<boolean> {
    const { ctx } = this;
    const def = ctx.task(taskId);
    const c = ctx.plan.perfil.comandos;
    if (c.instalar && existsSync(join(wtPath, 'package.json'))) {
      const r = await runCommand({ ...ctx.cmd, networkHosts: ctx.plan.perfil.red_instalar }, wtPath, c.instalar);
      if (!r.ok) {
        ctx.environmentFailure(taskId, `instalación en integración: ${r.output.split('\n').slice(-2).join(' ')}`);
        return false;
      }
    }
    for (const name of ['typecheck', 'build'] as const) {
      const recipe = c[name];
      if (!recipe) continue;
      const r = await runCommand(ctx.cmd, wtPath, recipe);
      if (!r.ok) {
        ctx.qualityFailure(taskId, `Al integrarlo con lo demás falló «${name}»:\n${r.output}`);
        return false;
      }
    }
    if (c.test && def.tipo !== 'pruebas') {
      const own = [...acceptanceFilesFor(ctx.plan, def), ...(JSON.parse(exec.files ?? '[]') as string[]).filter((f) => TEST_FILE.test(f))];
      const selection = [...new Set([...(await greenTests(ctx, target)), ...own])].filter((f) => existsSync(join(wtPath, f)));
      if (selection.length) {
        const r = await runCommand(ctx.cmd, wtPath, c.test, selection);
        if (!r.ok) {
          ctx.qualityFailure(taskId, `Al integrarlo con lo demás fallaron las pruebas:\n${r.output}`);
          return false;
        }
      }
    }
    return true;
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
