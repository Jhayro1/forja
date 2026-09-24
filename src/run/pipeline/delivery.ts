import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../git/git.js';
import { deliveryBranch as deliveryBranchName, refSha, removeWorktree } from '../../git/workspace.js';
import { getChange } from '../../planner/session.js';
import { EV } from '../../store/planning-projections.js';
import type { RunContext } from './run-context.js';

/**
 * Delivery of a completed run: the delivery branch (main is never touched), the
 * change moves to `entregado`, temporary worktrees go away and a report stays
 * in the repository.
 */
export class Delivery {
  constructor(private readonly ctx: RunContext) {}

  async deliver(): Promise<string> {
    const { ctx } = this;
    const branch = deliveryBranchName(ctx.engine.config.git.prefijo, ctx.run.change_id);
    const tip = await refSha(ctx.repoPath, ctx.run.branch);
    await git(ctx.repoPath, ['branch', '-f', branch, tip]);
    const change = getChange(ctx.engine, ctx.run.change_id);
    if (change.phase === 'ejecutar') {
      ctx.engine.store.execute({ request_id: `entregar:${ctx.runId}`, type: 'entregar', input: { runId: ctx.runId } }, () => ({
        result: null,
        events: [{ type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: ctx.run.change_id, payload: { from: 'ejecutar', to: 'entregado' } }],
      }));
    }
    await removeWorktree(ctx.repoPath, ctx.dir('integracion'));
    for (const t of ctx.plan.tareas) await removeWorktree(ctx.repoPath, ctx.dir(`verif-${t.id}`));
    this.writeReport(tip, branch);
    return branch;
  }

  private writeReport(tip: string, branch: string): void {
    const { ctx } = this;
    const usage = ctx.engine.store.db
      .prepare('SELECT role, provider, model, COUNT(*) n, SUM(input) i, SUM(output) o, SUM(cost_micro) c FROM usage WHERE run_id = ? GROUP BY role, provider, model')
      .all(ctx.runId) as { role: string; provider: string; model: string; n: number; i: number | null; o: number | null; c: number | null }[];
    const lines = [
      `# Informe de ejecución · ${ctx.runId}`,
      '',
      `- Rama entregada: \`${branch}\` (${tip.slice(0, 12)}), desde \`${ctx.run.base_sha.slice(0, 12)}\``,
      `- Plan revisión ${ctx.run.plan_revision} · aprobación ${ctx.run.approval_id}`,
      '- La rama principal no se modificó. Para revisar: `git log --oneline ' + `${ctx.run.base_sha.slice(0, 12)}..${branch}` + '`',
      '',
      '## Tareas',
      '| Tarea | Estado | Intentos | Modelo | Verificación |',
      '|---|---|---|---|---|',
      ...ctx.tasks().map((t) => {
        const e = ctx.execOf(t.task_id);
        const steps = (JSON.parse(e.steps ?? '[]') as { paso: string; ok: boolean }[]).map((s) => `${s.ok ? '✔' : '✘'} ${s.paso}`).join(' ');
        return `| ${t.task_id} ${ctx.task(t.task_id)?.titulo ?? ''} | ${t.state} | ${e.attempt} | ${e.provider ?? '—'}:${e.model ?? '—'} | ${steps || '—'} |`;
      }),
      '',
      '## Consumo',
      '| Rol | Modelo | Llamadas | Entrada | Salida | Costo equivalente |',
      '|---|---|---|---|---|---|',
      ...usage.map((u) => `| ${u.role} | ${u.provider}:${u.model} | ${u.n} | ${u.i ?? '?'} | ${u.o ?? '?'} | ${u.c === null ? 'desconocido' : `US$ ${(u.c / 1e6).toFixed(2)}`} |`),
      '',
    ];
    const dir = join(ctx.repoPath, '.forja', 'cambios', ctx.run.change_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'informe.md'), `${lines.join('\n')}\n`);
  }
}
