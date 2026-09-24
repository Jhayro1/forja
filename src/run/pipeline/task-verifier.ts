import { detachedWorktree, mergeCandidate, refSha, removeWorktree } from '../../git/workspace.js';
import { verifyTask } from '../../verify/verify.js';
import { isNoChangeCandidate } from './outcome-handler.js';
import { greenTests } from './regression.js';
import type { RunContext } from './run-context.js';

/** Verifies a candidate as it will really end up: merged onto the current integration tip. */
export class TaskVerifier {
  constructor(
    private readonly ctx: RunContext,
    private readonly review: boolean,
  ) {}

  async verify(taskId: string): Promise<void> {
    const { ctx } = this;
    const exec = ctx.execOf(taskId);
    const task = ctx.task(taskId);
    const tip = await refSha(ctx.repoPath, ctx.run.branch);
    const wt = await detachedWorktree(ctx.repoPath, ctx.dir(`verif-${taskId}`), tip);
    const merged = await mergeCandidate(wt, tip, exec.candidate_sha!, `forja: verificar ${taskId}`);
    if ('conflicts' in merged) {
      if (exec.worktree) await removeWorktree(ctx.repoPath, exec.worktree);
      ctx.exec(taskId, { worktree: null, feedback: `Tu cambio choca con lo ya integrado (${merged.conflicts.join(', ')}). Rehaz la tarea sobre la base nueva.` });
      ctx.move(taskId, 'lista', 'conflicto_integracion', merged.conflicts.join(', '));
      ctx.log(`⚡ ${taskId}: conflicto con lo integrado; se rehace sobre la base nueva`);
      return;
    }
    const v = await verifyTask(ctx.engine, {
      plan: ctx.plan,
      spec: ctx.spec,
      task,
      worktree: wt,
      baseSha: tip,
      candidateSha: merged.sha,
      changedFiles: JSON.parse(exec.files ?? '[]') as string[],
      greenTests: await greenTests(ctx, tip),
      cmd: ctx.cmd,
      runId: ctx.runId,
      review: this.review,
      noChanges: isNoChangeCandidate(exec),
    });
    ctx.exec(taskId, { steps: JSON.stringify(v.steps) });
    if (v.ok) {
      ctx.move(taskId, 'verificada', 'verificacion_aprobada');
      ctx.log(`✔ ${taskId} verificada (${v.steps.map((s) => s.paso).join(', ')})`);
    } else if (v.environmentFailure) {
      const step = v.steps.at(-1);
      ctx.environmentFailure(taskId, `problema del entorno en «${step?.paso ?? 'verificación'}»: ${step?.detalle.slice(-300) ?? ''}`);
    } else {
      ctx.qualityFailure(taskId, v.feedback);
    }
  }
}
