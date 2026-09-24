import type { Role } from '../../core/engine.js';
import { type Plan, type PlanTask, taskResources } from '../../plan/plan.js';
import type { TaskRow } from '../../store/projections.js';

/**
 * Pure launch policy (ADR-002): which ready tasks start now. No I/O, so every
 * rule is unit-testable: free slots, resources held until integration (two tasks
 * never write the same files at once), critical path first, and `only` for
 * `forja run --solo`.
 */

/** States that hold a task's resources: from reservation until integrated. */
export const HOLDING_STATES = ['reservada', 'ejecutando', 'verificando', 'verificada', 'integrando'] as const;

export function levelFor(task: PlanTask, failures: number): Role {
  const base: Role = task.complejidad === 'alta' ? 'complejo' : 'trabajador';
  if (failures < 2) return base;
  return base === 'trabajador' ? 'complejo' : 'planeador';
}

/** Number of tasks transitively waiting on each task (memoized: the plan is a DAG). */
export function dependentCounts(plan: Plan): Map<string, number> {
  const memo = new Map<string, number>();
  const direct = new Map<string, string[]>();
  for (const t of plan.tareas) for (const d of t.depende_de) direct.set(d, [...(direct.get(d) ?? []), t.id]);
  const count = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const all = new Set<string>();
    const walk = (x: string) => {
      for (const c of direct.get(x) ?? []) {
        if (all.has(c)) continue;
        all.add(c);
        walk(c);
      }
    };
    walk(id);
    memo.set(id, all.size);
    return all.size;
  };
  for (const t of plan.tareas) count(t.id);
  return memo;
}

export function selectLaunches(input: { plan: Plan; tasks: TaskRow[]; parallel: number; only?: string | null; dependents?: Map<string, number> }): string[] {
  const { plan, tasks } = input;
  const running = tasks.filter((t) => t.state === 'reservada' || t.state === 'ejecutando').length;
  let slots = input.parallel - running;
  if (slots <= 0) return [];
  const held = new Set(tasks.filter((t) => (HOLDING_STATES as readonly string[]).includes(t.state)).flatMap((t) => taskResources(plan, t.task_id)));
  const dependents = input.dependents ?? dependentCounts(plan);
  const ready = tasks
    .filter((t) => t.state === 'lista' && (!input.only || t.task_id === input.only))
    .sort((a, b) => (dependents.get(b.task_id) ?? 0) - (dependents.get(a.task_id) ?? 0) || a.task_id.localeCompare(b.task_id));
  const out: string[] = [];
  for (const t of ready) {
    if (slots <= 0) break;
    const resources = taskResources(plan, t.task_id);
    if (resources.some((r) => held.has(r))) continue;
    resources.forEach((r) => held.add(r));
    slots--;
    out.push(t.task_id);
  }
  return out;
}

/** Next tasks for the integration queue, in a stable order: at most `max` (1 = serial). */
export function nextToIntegrate(tasks: TaskRow[], max = 1): string[] {
  return tasks
    .filter((t) => t.state === 'verificada' || t.state === 'integrando')
    .map((t) => t.task_id)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, max);
}

/**
 * Batch mode: whether to integrate the verified tasks now or wait a little for
 * the ones still being verified to join the batch (a merge-queue window). Never
 * waits with a full batch, with nothing else in verification, or past `maxWaitMs`.
 */
export function batchReady(tasks: TaskRow[], max: number, waitedMs: number, maxWaitMs: number): boolean {
  const ready = nextToIntegrate(tasks, max);
  if (ready.length === 0) return false;
  if (ready.length >= max || tasks.some((t) => t.state === 'integrando')) return true;
  const joining = tasks.some((t) => t.state === 'verificando');
  return !joining || waitedMs >= maxWaitMs;
}
