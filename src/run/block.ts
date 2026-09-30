import { allowedModels, type Engine } from '../core/engine.js';
import type { Plan } from '../plan/plan.js';
import { MODEL_CATALOG } from '../providers/catalog.js';
import type { Spec } from '../spec/spec.js';
import type { TaskRow } from '../store/projections.js';

/**
 * A block for one agent (ligera/PLAN.md F4): the tasks the user picked — or a whole
 * story (use case) — plus every dependency not integrated yet, in plan order. The agent
 * cannot skip a dependency, so Forja adds it and says so instead of refusing.
 */
export class BlockError extends Error {}

const DONE = new Set(['integrada', 'cancelada', 'invalidada']);

/** Story (use case id, or «base») of each task, the same grouping the history shows. */
export function storyOfTasks(plan: Plan, spec: Spec | null): Map<string, string> {
  const ucOf = new Map((spec?.criterios ?? []).map((c) => [c.id, c.caso_uso_id]));
  return new Map(plan.tareas.map((t) => [t.id, t.criterios.map((c) => ucOf.get(c)).find(Boolean) ?? 'base']));
}

export type ResolvedBlock = { tasks: string[]; added: string[] };

export function resolveBlock(input: { plan: Plan; spec: Spec | null; tasks: TaskRow[]; ids?: string[]; story?: string }): ResolvedBlock {
  const { plan, tasks } = input;
  const state = new Map(tasks.map((t) => [t.task_id, t.state]));
  let picked: string[];
  if (input.story) {
    const story = input.story.trim();
    const stories = storyOfTasks(plan, input.spec);
    picked = plan.tareas.filter((t) => stories.get(t.id)?.toLowerCase() === story.toLowerCase()).map((t) => t.id);
    if (picked.length === 0) throw new BlockError(`no hay tareas en el bloque «${story}» (usa el id del caso de uso, p. ej. CU-01, o «base»)`);
  } else {
    picked = [...new Set((input.ids ?? []).map((id) => id.trim().toUpperCase()).filter(Boolean))];
    if (picked.length === 0) throw new BlockError('elige al menos una tarea');
    for (const id of picked) if (!state.has(id)) throw new BlockError(`no existe la tarea ${id} en este run`);
  }
  const wanted = picked.filter((id) => !DONE.has(state.get(id) ?? ''));
  if (wanted.length === 0) throw new BlockError('esas tareas ya están terminadas: no hay nada que ejecutar');
  const deps = new Map(plan.tareas.map((t) => [t.id, t.depende_de]));
  const block = new Set<string>();
  const visit = (id: string) => {
    if (block.has(id) || DONE.has(state.get(id) ?? '')) return;
    block.add(id);
    for (const d of deps.get(id) ?? []) visit(d);
  };
  for (const id of wanted) visit(id);
  const order = plan.tareas.map((t) => t.id).filter((id) => block.has(id));
  return { tasks: order, added: order.filter((id) => !wanted.includes(id)) };
}

/**
 * Models a block may be given: the ones the policy allows plus every current model of the
 * catalog — choosing who does the work is the point of a block.
 */
export function blockModels(engine: Engine): string[] {
  const catalog = MODEL_CATALOG.filter((m) => m.status !== 'retirandose').map((m) => m.ref);
  return [...new Set([...allowedModels(engine), ...catalog])];
}

export function checkBlockModel(engine: Engine, ref: string): string {
  const r = ref.trim();
  if (!/^(claude|codex|simulado):[A-Za-z0-9._[\]-]{1,60}$/.test(r)) throw new BlockError(`«${ref}» no es un modelo (usa proveedor:modelo, p. ej. claude:sonnet o codex:gpt-6-sol)`);
  if (r.startsWith('simulado:') && !allowedModels(engine).includes(r)) throw new BlockError(`«${r}» no está en la configuración`);
  return r;
}
