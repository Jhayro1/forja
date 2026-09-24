import { activePauses, type Engine, type ProviderPause } from '../core/engine.js';
import { deliveryBranch as deliveryBranchName } from '../git/workspace.js';
import { ACTIVE_STATES, type TaskState } from '../domain/task-state.js';
import { currentApproval } from '../plan/approve.js';
import { latestPlan } from '../plan/divide.js';
import type { Plan, PlanTask } from '../plan/plan.js';
import { activeChange, listChanges, type ChangeRow } from '../planner/session.js';
import { latestSpec, specAnswers } from '../spec/generate.js';
import { listTasks } from '../store/projections.js';
import { agentActivity, type AgentActivity } from './activity.js';
import { getExec, runsOf, type ExecRow, type RunRow } from './records.js';

/**
 * Read model of a change and its latest run, shared by `forja estado`,
 * `forja preguntas`, the terminal board and (in M4) the local API. It only reads
 * committed projections, so it is safe while another process runs the plan.
 */
export type TaskView = {
  id: string;
  title: string;
  state: TaskState;
  kind: PlanTask['tipo'] | null;
  dependsOn: string[];
  exec: ExecRow;
  /** Only for tasks with a live or finished launch. */
  activity: AgentActivity | null;
};

export type PendingKind = 'pregunta_tarea' | 'tarea_bloqueada' | 'tarea_pausada' | 'pregunta_spec' | 'aprobacion';

export type PendingItem = { kind: PendingKind; id: string; text: string; action: string };

export type UsageByRole = { role: string; calls: number; tokens: number | null; costMicro: number | null };

export type RunSnapshot = {
  change: ChangeRow;
  plan: Plan | null;
  approved: boolean;
  run: RunRow | null;
  tasks: TaskView[];
  counts: Partial<Record<TaskState, number>>;
  integrated: number;
  total: number;
  pending: PendingItem[];
  usage: UsageByRole[];
  /** Branch with the delivered result, once the run completed. */
  deliveryBranch: string | null;
  /** Providers skipped for quota or session, persisted so every process sees them (MEJORAS 2.2). */
  providerPauses: ProviderPause[];
  nextStep: string;
};

/** The change the user is working on: the active one, or the last delivered. */
export function currentChange(engine: Engine): ChangeRow | undefined {
  return activeChange(engine) ?? listChanges(engine)[0];
}

export function latestRun(engine: Engine, changeId: string): RunRow | null {
  return runsOf(engine, changeId)[0] ?? null;
}

const WITH_ACTIVITY: ReadonlySet<TaskState> = new Set([...ACTIVE_STATES, 'verificada']);

export function taskViews(engine: Engine, run: RunRow, plan: Plan | null): TaskView[] {
  const defs = new Map((plan?.tareas ?? []).map((t) => [t.id, t]));
  return listTasks(engine.store.db, run.run_id).map((t) => {
    const exec = getExec(engine, run.run_id, t.task_id);
    const def = defs.get(t.task_id);
    return {
      id: t.task_id,
      title: t.title,
      state: t.state,
      kind: def?.tipo ?? null,
      dependsOn: t.depends_on,
      exec,
      activity: WITH_ACTIVITY.has(t.state) && exec.launch_dir ? agentActivity(exec.launch_dir, exec.provider) : null,
    };
  });
}

function runPlan(engine: Engine, run: RunRow): Plan | null {
  const row = engine.store.db.prepare('SELECT plan FROM plans WHERE plan_id = ? AND revision = ?').get(run.plan_id, run.plan_revision) as { plan: string } | undefined;
  return row ? (JSON.parse(row.plan) as Plan) : null;
}

/** Everything that waits on the user, most urgent first. */
export function pendingItems(engine: Engine, change: ChangeRow, tasks: TaskView[]): PendingItem[] {
  const out: PendingItem[] = [];
  for (const t of tasks) {
    if (t.state === 'esperando_respuesta') {
      out.push({ kind: 'pregunta_tarea', id: t.id, text: t.exec.question ?? '(pregunta sin texto)', action: `forja responder ${t.id} "<respuesta>"` });
    } else if (t.state === 'bloqueada') {
      out.push({ kind: 'tarea_bloqueada', id: t.id, text: t.exec.last_error ?? 'bloqueada', action: `forja reintentar ${t.id} ["nota para el agente"]` });
    } else if (t.state === 'pausada') {
      out.push({ kind: 'tarea_pausada', id: t.id, text: 'pausada por el usuario', action: `forja reanudar ${t.id}` });
    }
  }
  if (change.phase === 'especificar') {
    const answered = new Set(specAnswers(engine, change.change_id).map((a) => a.question_id));
    for (const q of latestSpec(engine, change.change_id)?.spec.preguntas ?? []) {
      if (!answered.has(q.id)) out.push({ kind: 'pregunta_spec', id: q.id, text: q.texto, action: `forja responder ${q.id} "<respuesta>"` });
    }
  }
  if (change.phase === 'aprobar' && !currentApproval(engine, change.change_id)) {
    out.push({ kind: 'aprobacion', id: 'plan', text: 'el plan espera tu aprobación', action: 'forja plan · forja aprobar plan' });
  }
  return out;
}

function usageByRole(engine: Engine, runId: string): UsageByRole[] {
  const rows = engine.store.db
    .prepare('SELECT role, COUNT(*) n, SUM(input) i, SUM(output) o, SUM(cost_micro) c, COUNT(input) ni FROM usage WHERE run_id = ? GROUP BY role ORDER BY role')
    .all(runId) as { role: string; n: number; i: number | null; o: number | null; c: number | null; ni: number }[];
  return rows.map((r) => ({ role: r.role, calls: r.n, tokens: r.ni === 0 ? null : (r.i ?? 0) + (r.o ?? 0), costMicro: r.c }));
}

function nextStep(change: ChangeRow, run: RunRow | null, approved: boolean, pending: PendingItem[], deliveryBranch: string | null): string {
  const answer = pending.find((p) => p.kind === 'pregunta_tarea' || p.kind === 'tarea_bloqueada');
  switch (change.phase) {
    case 'descubrir':
      return 'sigue conversando con forja planear y apruébalo con /aprobar';
    case 'especificar':
      return pending.length ? 'responde las preguntas (forja preguntas) y vuelve a ejecutar forja especificar' : 'forja especificar';
    case 'dividir':
      return 'forja dividir';
    case 'aprobar':
      return approved ? 'forja run' : 'revisa el plan (forja plan) y apruébalo con forja aprobar plan';
    case 'ejecutar':
      if (!run) return 'forja run';
      if (run.state === 'ejecutando') return 'mira el avance con forja tablero';
      if (answer) return `atiende lo pendiente (forja preguntas) y retoma con forja run`;
      return 'retoma con forja run';
    case 'entregado':
      return `revisa la rama ${deliveryBranch ?? 'de entrega'} y el informe (forja informe)`;
    default:
      return 'empieza otro cambio con forja planear --nuevo';
  }
}

export function runSnapshot(engine: Engine, change: ChangeRow): RunSnapshot {
  const run = latestRun(engine, change.change_id);
  const plan = run ? runPlan(engine, run) : (latestPlan(engine, change.change_id)?.plan ?? null);
  const tasks = run ? taskViews(engine, run, plan) : [];
  const counts: Partial<Record<TaskState, number>> = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  const approved = currentApproval(engine, change.change_id) !== null;
  const pending = pendingItems(engine, change, tasks);
  const delivered = run?.state === 'completado' ? deliveryBranchName(engine.config.git.prefijo, change.change_id) : null;
  return {
    change,
    plan,
    approved,
    run,
    tasks,
    counts,
    integrated: counts.integrada ?? 0,
    total: tasks.filter((t) => t.state !== 'invalidada' && t.state !== 'cancelada').length || (plan?.tareas.length ?? 0),
    pending,
    usage: run ? usageByRole(engine, run.run_id) : [],
    deliveryBranch: delivered,
    providerPauses: activePauses(engine),
    nextStep: nextStep(change, run, approved, pending, delivered),
  };
}

/** Tasks with an agent process: the «Agentes» panel. */
export const agentTasks = (s: RunSnapshot): TaskView[] => s.tasks.filter((t) => t.state === 'reservada' || t.state === 'ejecutando');

/** Readable age like «2m14s». */
export function elapsed(fromIso: string | null, now = Date.now()): string {
  if (!fromIso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function compactTokens(n: number | null): string {
  if (n === null) return '?';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
