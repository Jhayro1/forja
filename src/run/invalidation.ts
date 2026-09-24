import { hashJson } from '../domain/hash.js';
import type { Plan, PlanTask } from '../plan/plan.js';
import type { Spec } from '../spec/spec.js';

/**
 * What a new plan revision can reuse from the run it replaces (V2-037 + MEJORAS
 * 2.4). An integrated task is inherited only if nothing it was built against
 * changed: its own definition, the spec content behind its criteria and
 * requirements (criteria → use case → rules/entities), and — transitively — every
 * task it depends on. Everything else is redone on top of the integrated code.
 */

export type Decision = { inherit: true } | { inherit: false; reason: string };

/** Spec ids whose content changed or disappeared between two revisions. */
export function changedSpecIds(before: Spec, after: Spec): Set<string> {
  const changed = new Set<string>();
  const compare = <T extends { id: string }>(a: T[], b: T[]) => {
    const now = new Map(b.map((x) => [x.id, hashJson(x)]));
    for (const x of a) if (now.get(x.id) !== hashJson(x)) changed.add(x.id);
  };
  compare(before.requisitos, after.requisitos);
  compare(before.entidades, after.entidades);
  compare(before.reglas, after.reglas);
  compare(before.casos_uso, after.casos_uso);
  compare(before.criterios, after.criterios);
  compare(before.contratos, after.contratos);
  // A use case is affected by the rules and entities it applies.
  for (const u of after.casos_uso) if ([...u.reglas, ...u.entidades, ...u.requisitos].some((id) => changed.has(id))) changed.add(u.id);
  // A criterion is affected by its use case and its requirements.
  for (const c of after.criterios) if (changed.has(c.caso_uso_id) || c.requisitos.some((r) => changed.has(r))) changed.add(c.id);
  return changed;
}

function ownReason(task: PlanTask, previous: PlanTask | undefined, changed: Set<string>): string | null {
  if (!previous) return 'tarea nueva';
  if (hashJson(previous) !== hashJson(task)) return 'su definición cambió';
  const hit = [...task.criterios, ...task.requisitos].filter((id) => changed.has(id));
  return hit.length ? `la especificación cambió en ${hit.join(', ')}` : null;
}

export function inheritance(input: { oldPlan: Plan | null; newPlan: Plan; oldSpec: Spec | null; newSpec: Spec | null; integrated: ReadonlySet<string> }): Map<string, Decision> {
  const changed = input.oldSpec && input.newSpec ? changedSpecIds(input.oldSpec, input.newSpec) : new Set<string>();
  const before = new Map((input.oldPlan?.tareas ?? []).map((t) => [t.id, t]));
  const byId = new Map(input.newPlan.tareas.map((t) => [t.id, t]));
  const out = new Map<string, Decision>();
  const decide = (id: string, path: Set<string> = new Set()): Decision => {
    const known = out.get(id);
    if (known) return known;
    const task = byId.get(id)!;
    let d: Decision;
    if (!input.integrated.has(id)) d = { inherit: false, reason: 'no estaba integrada' };
    else {
      const own = ownReason(task, before.get(id), changed);
      if (own) d = { inherit: false, reason: own };
      else {
        const redo = task.depende_de.find((dep) => byId.has(dep) && !path.has(dep) && !decide(dep, new Set([...path, id])).inherit);
        d = redo ? { inherit: false, reason: `a revisar: depende de ${redo}, que se rehace` } : { inherit: true };
      }
    }
    out.set(id, d);
    return d;
  };
  for (const t of input.newPlan.tareas) decide(t.id);
  return out;
}
