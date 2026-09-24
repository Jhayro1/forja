import { isAncestor, refSha } from '../../git/workspace.js';
import { launchStatus, spawnRunner } from '../../runtime/launcher.js';
import type { RunContext } from './run-context.js';

/** Recovery at start (v2/05 · Reconciliación): durable intent is compared with what really happened. */
export class Reconciler {
  constructor(private readonly ctx: RunContext) {}

  async reconcile(): Promise<void> {
    const { ctx } = this;
    for (const t of ctx.tasks()) {
      const exec = ctx.execOf(t.task_id);
      if (t.state === 'reservada') {
        const status = exec.launch_dir ? launchStatus(exec.launch_dir) : null;
        if (!status) ctx.move(t.task_id, 'lista', 'reserva_liberada', 'recuperación: reserva sin lanzamiento');
        else {
          if (status.state === 'sin_iniciar') spawnRunner(exec.launch_dir!, ctx.engine.runnerScript);
          ctx.move(t.task_id, 'ejecutando', 'lanzamiento_iniciado', 'recuperación');
        }
      } else if (t.state === 'integrando' && exec.candidate_sha) {
        const tip = await refSha(ctx.repoPath, ctx.run.branch);
        if (await isAncestor(ctx.repoPath, exec.candidate_sha, tip)) {
          ctx.exec(t.task_id, { integrated_sha: tip });
          ctx.move(t.task_id, 'integrada', 'integracion_confirmada', 'recuperación: ya estaba integrada');
        }
      }
    }
  }
}
