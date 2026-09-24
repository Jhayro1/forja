import { checkApproval } from '../domain/approval.js';
import { hashJson } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import { changeTaskState, createTask } from '../core/task-commands.js';
import type { Engine } from '../core/engine.js';
import { ensureIntegrationBranch, refSha, runBranch } from '../git/workspace.js';
import { approvalTarget, currentApproval, gateProblems } from '../plan/approve.js';
import { latestPlan } from '../plan/divide.js';
import type { Plan, PlanTask } from '../plan/plan.js';
import { getChange } from '../planner/session.js';
import { listTasks } from '../store/projections.js';
import { EV } from '../store/planning-projections.js';
import { RunError, runsOf, setRunState } from './records.js';

const taskDefHash = (t: PlanTask) => hashJson(t);

/**
 * Starts a run for the approved plan, or resumes the open one. The approval must
 * match exactly what is about to run (I02). A new plan revision creates a new run
 * that inherits tasks already integrated with an identical definition (V2-037).
 */
export async function startOrResumeRun(engine: Engine, input: { changeId: string; repoPath: string }): Promise<{ runId: string; resumed: boolean; inherited: string[] }> {
  const change = getChange(engine, input.changeId);
  const problems = gateProblems(engine, input.changeId);
  if (problems.length) throw new RunError(`no se puede ejecutar:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const planRow = latestPlan(engine, input.changeId)!;
  const approval = currentApproval(engine, input.changeId);
  if (!approval) throw new RunError('el plan no está aprobado: forja aprobar plan');
  const check = checkApproval(approval, approvalTarget(engine.config, planRow.plan, planRow.hash));
  if (!check.ok) throw new RunError(`la aprobación ya no corresponde a lo que se ejecutaría:\n${check.reasons.map((r) => `  - ${r}`).join('\n')}`);

  const open = runsOf(engine, input.changeId).find((r) => r.state !== 'completado' && r.state !== 'cancelado');
  if (open && open.plan_hash === planRow.hash) {
    if (open.state !== 'ejecutando') setRunState(engine, open.run_id, 'ejecutando');
    return { runId: open.run_id, resumed: true, inherited: [] };
  }

  const runId = newId('run');
  const branch = runBranch(engine.config.git.prefijo, runId);
  // A replaced run keeps its integrated work: the new one starts from its integration ref.
  let base = planRow.plan.base_sha;
  const inherited = new Map<string, string>();
  if (open) {
    base = await refSha(input.repoPath, open.branch);
    const oldPlan = engine.store.db.prepare('SELECT plan FROM plans WHERE plan_id = ? AND revision = ?').get(open.plan_id, open.plan_revision) as { plan: string } | undefined;
    const oldTasks = new Map(((oldPlan ? (JSON.parse(oldPlan.plan) as Plan) : null)?.tareas ?? []).map((t) => [t.id, taskDefHash(t)]));
    for (const t of listTasks(engine.store.db, open.run_id)) {
      if (t.state === 'integrada') {
        const now = planRow.plan.tareas.find((x) => x.id === t.task_id);
        if (now && oldTasks.get(t.task_id) === taskDefHash(now)) inherited.set(t.task_id, open.run_id);
      } else if (t.state !== 'invalidada' && t.state !== 'cancelada') {
        changeTaskState(engine.store, newId('req'), { run_id: open.run_id, task_id: t.task_id, to: 'invalidada', reason: 'nueva_revision' });
      }
    }
    setRunState(engine, open.run_id, 'cancelado', `reemplazado por ${runId} (plan revisión ${planRow.revision})`);
  }
  await ensureIntegrationBranch(input.repoPath, branch, base);
  engine.store.execute({ request_id: `run:${runId}`, type: 'iniciar_run', input: { runId } }, () => ({
    result: null,
    events: [
      {
        type: EV.runStarted,
        aggregate_type: 'run',
        aggregate_id: runId,
        payload: { change_id: input.changeId, plan_id: planRow.plan.plan_id, plan_revision: planRow.revision, plan_hash: planRow.hash, approval_id: approval.approval_id, base_sha: base, branch },
      },
      ...(change.phase === 'aprobar' ? [{ type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: input.changeId, payload: { from: 'aprobar', to: 'ejecutar' } }] : []),
    ],
  }));
  // Topological creation: dependencies exist before dependents.
  const pending = [...planRow.plan.tareas];
  const created = new Set<string>();
  while (pending.length) {
    const i = pending.findIndex((t) => t.depende_de.every((d) => created.has(d)));
    const t = pending.splice(i < 0 ? 0 : i, 1)[0]!;
    const from = inherited.get(t.id);
    createTask(engine.store, `${runId}:${t.id}`, { run_id: runId, task_id: t.id, title: t.titulo, depends_on: t.depende_de, ...(from ? { inherited_from: from } : {}) });
    created.add(t.id);
  }
  return { runId, resumed: false, inherited: [...inherited.keys()] };
}
