import type { Engine } from '../core/engine.js';
import { currentApproval } from '../plan/approve.js';
import { latestPlan } from '../plan/divide.js';
import { runningOrchestrator } from '../run/process.js';
import { runsOf, setRunState } from '../run/records.js';
import { latestSpec } from '../spec/generate.js';
import { type ChangePhase, EV } from '../store/planning-projections.js';
import { listTasks } from '../store/projections.js';
import { getChange, PlannerError } from './session.js';

/**
 * Where the user may take a sprint by hand (flujo/PLAN.md §3). Going forward stays with
 * the commands that produce each phase (approve, specify, divide, run); these moves only
 * go back, cancel or reactivate, and never delete anything.
 */
export const MOVES: Readonly<Record<ChangePhase, readonly ChangePhase[]>> = {
  descubrir: ['cancelado'],
  especificar: ['descubrir', 'cancelado'],
  dividir: ['descubrir', 'especificar', 'cancelado'],
  aprobar: ['descubrir', 'especificar', 'dividir', 'cancelado'],
  ejecutar: ['descubrir', 'especificar', 'dividir', 'cancelado'],
  entregado: [],
  cancelado: ['descubrir'],
};

export const MOVE_LABEL: Record<string, string> = {
  descubrir: 'volver a la conversación',
  especificar: 'volver a la especificación',
  dividir: 'volver a dividir en tareas',
  cancelado: 'cancelar el sprint',
};

export type MoveResult = { from: ChangePhase; to: ChangePhase; registro: Record<string, unknown> };

/** What the sprint had reached: kept in the event so going back never loses track of the work. */
function progress(engine: Engine, changeId: string): Record<string, unknown> {
  const spec = latestSpec(engine, changeId);
  const plan = latestPlan(engine, changeId);
  const run = runsOf(engine, changeId)[0] ?? null;
  const tasks = run ? listTasks(engine.store.db, run.run_id) : [];
  const count: Record<string, number> = {};
  for (const t of tasks) count[t.state] = (count[t.state] ?? 0) + 1;
  return {
    spec_revision: spec?.revision ?? null,
    plan_revision: plan?.revision ?? null,
    plan_aprobado: currentApproval(engine, changeId) !== null,
    run: run ? { run_id: run.run_id, estado: run.state, rama: run.branch, tareas: count, integradas: tasks.filter((t) => t.state === 'integrada').map((t) => t.task_id) } : null,
  };
}

/**
 * Moves a sprint back to an earlier phase, cancels it or reactivates it.
 * - The conversation, specs, plans and runs stay as they are: they are the base for
 *   the next pass, which redoes only what changed.
 * - A plan approval stops being valid (decision 4 of the plan): it must be approved again.
 * - From «ejecutar» the orchestrator must be stopped first; the run is left paused, so
 *   the next run inherits the tasks already integrated (V2-037).
 */
export function moveChange(engine: Engine, changeId: string, to: ChangePhase, motivo: string): MoveResult {
  const change = getChange(engine, changeId);
  const from = change.phase;
  if (from === to) throw new PlannerError(`el sprint ya está en «${to}»`);
  if (!MOVES[from].includes(to)) {
    throw new PlannerError(from === 'entregado' ? 'un sprint entregado no se reabre: crea uno nuevo a partir de él' : `no se puede pasar de «${from}» a «${to}»`);
  }
  const run = runsOf(engine, changeId).find((r) => r.state === 'ejecutando' || r.state === 'pausado' || r.state === 'bloqueado') ?? null;
  // One orchestrator per project: if it is up and this sprint's run is the one executing, it must stop first.
  if (run?.state === 'ejecutando' && runningOrchestrator(engine.dataDir)) throw new PlannerError('el run de este proyecto se está ejecutando: detenlo primero (Detener en el panel o forja detener)');
  const registro = progress(engine, changeId);
  const approval = currentApproval(engine, changeId);
  engine.store.execute({ request_id: `mover:${changeId}:${from}:${to}:${Date.now()}`, type: 'mover_cambio', input: { changeId, from, to } }, () => ({
    result: null,
    events: [
      ...(approval ? [{ type: EV.approvalState, aggregate_type: 'cambio', aggregate_id: changeId, payload: { approval_id: approval.approval_id, state: 'obsoleta' } }] : []),
      { type: EV.changeMoved, aggregate_type: 'cambio', aggregate_id: changeId, payload: { from, to, motivo: motivo.trim() || MOVE_LABEL[to] || to, registro } },
    ],
  }));
  // A run cut off mid-way stays open (paused): its integrated work is inherited later.
  if (run?.state === 'ejecutando') setRunState(engine, run.run_id, 'pausado', `el sprint volvió a «${to}»`);
  return { from, to, registro };
}
