import { z } from 'zod';
import type { Engine } from '../core/engine.js';
import { moveChange } from '../planner/phases.js';
import { getChange, PlannerError } from '../planner/session.js';
import { latestSpec, saveSpec } from './generate.js';
import { SpecBody, type SpecIssue, validateSpec } from './spec.js';

/**
 * Changes to the spec made by hand, without the model and without tokens (flujo/PLAN.md
 * §5.4). Each one is a new revision, validated before it is saved: a case that breaks
 * its references is refused with the reasons, and nothing changes.
 */
const UseCase = SpecBody.shape.casos_uso.element;
const Criteria = SpecBody.shape.criterios;
export const UseCaseEdit = z.object({ caso: UseCase, criterios: Criteria }).strict();
export type UseCaseEdit = z.infer<typeof UseCaseEdit>;

type Target = { changeId: string; repoPath: string; projectId: string };

/**
 * Before editing: a sprint past «dividir» goes back to «especificar» (its plan approval
 * stops being valid, decision 4) and, from «ejecutar», only if the run is stopped.
 */
export function openSpecForChanges(engine: Engine, changeId: string, why: string): void {
  const change = getChange(engine, changeId);
  if (change.phase === 'dividir' || change.phase === 'aprobar' || change.phase === 'ejecutar') moveChange(engine, changeId, 'especificar', why);
  else if (change.phase !== 'especificar') throw new PlannerError(`el sprint está en «${change.phase}»: la especificación se cambia desde especificar en adelante`);
}

function current(engine: Engine, changeId: string) {
  const spec = latestSpec(engine, changeId);
  if (!spec) throw new PlannerError('todavía no hay especificación');
  const { schema_version: _v, project_id: _p, change_id: _c, revision: _r, ...body } = spec.spec;
  return body as SpecBody;
}

function refuse(issues: SpecIssue[], id: string): void {
  const mine = issues.filter((x) => x.severity === 'error' && (x.path.includes(id) || x.message.includes(id)));
  if (mine.length) throw new PlannerError(`el caso no se guardó:\n${mine.map((x) => `  - ${x.path}: ${x.message}`).join('\n')}`);
}

/** Replaces one use case and its criteria (or adds it, if the id is new). */
export function editUseCase(engine: Engine, target: Target, edit: UseCaseEdit) {
  const parsed = UseCaseEdit.safeParse(edit);
  if (!parsed.success) throw new PlannerError(`el caso no tiene el formato esperado: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
  const { caso, criterios } = parsed.data;
  const wrong = criterios.filter((c) => c.caso_uso_id !== caso.id);
  if (wrong.length) throw new PlannerError(`los criterios ${wrong.map((c) => c.id).join(', ')} no son de ${caso.id}`);
  const body = current(engine, target.changeId);
  const at = body.casos_uso.findIndex((u) => u.id === caso.id);
  const casos = at >= 0 ? body.casos_uso.map((u, i) => (i === at ? caso : u)) : [...body.casos_uso, caso];
  const next: SpecBody = { ...body, casos_uso: casos, criterios: [...body.criterios.filter((c) => c.caso_uso_id !== caso.id), ...criterios] };
  refuse(validateSpec(next), caso.id);
  openSpecForChanges(engine, target.changeId, `edición manual de ${caso.id}`);
  return saveSpec(engine, { ...target, body: next });
}

/** Removes a use case with its criteria; refused if something else still points to it. */
export function removeUseCase(engine: Engine, target: Target, id: string) {
  const body = current(engine, target.changeId);
  if (!body.casos_uso.some((u) => u.id === id)) throw new PlannerError(`no existe el caso ${id}`);
  const users = [...body.reglas.filter((r) => r.referencias.includes(id)).map((r) => r.id), ...body.preguntas.filter((q) => q.bloquea.includes(id)).map((q) => q.id)];
  if (users.length) throw new PlannerError(`${id} lo usan ${users.join(', ')}: pídelo como cambio para que el planeador ajuste también eso`);
  const next: SpecBody = { ...body, casos_uso: body.casos_uso.filter((u) => u.id !== id), criterios: body.criterios.filter((c) => c.caso_uso_id !== id) };
  openSpecForChanges(engine, target.changeId, `se quitó ${id} a mano`);
  return saveSpec(engine, { ...target, body: next });
}
