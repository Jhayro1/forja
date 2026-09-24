import { Approval, checkApproval, type ApprovalTarget } from '../domain/approval.js';
import { hashJson } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import type { Engine } from '../core/engine.js';
import { PlannerError, getChange } from '../planner/session.js';
import type { ForjaConfig } from '../registry/config.js';
import type { RuntimePolicy } from '../security/policy.js';
import { latestSpec } from '../spec/generate.js';
import { blockingQuestions, validateSpec } from '../spec/spec.js';
import { EV } from '../store/planning-projections.js';
import { latestPlan } from './divide.js';
import { validatePlan, type Plan } from './plan.js';

/**
 * Base runtime policy for workers of this plan. Tasks with `red` get the approved
 * install hosts; everything else only reaches the provider API.
 */
export function basePolicy(config: ForjaConfig, plan: Plan): RuntimePolicy {
  return {
    network: plan.perfil.red_instalar.length ? { mode: 'lista', hosts: plan.perfil.red_instalar } : { mode: 'proveedor' },
    tools: ['lectura', 'edicion'],
    write_globs: [...new Set(plan.tareas.flatMap((t) => t.escribe))],
    protected_paths: plan.tareas.filter((t) => t.tipo === 'pruebas').flatMap((t) => t.escribe),
    timeout_ms: config.ejecucion.timeout_min * 60_000,
    max_memory_mb: 2048,
  };
}

export function approvalTarget(config: ForjaConfig, plan: Plan, planHash: string): ApprovalTarget {
  return {
    target_type: 'plan',
    target_id: plan.plan_id,
    target_hash: planHash,
    spec_revision: plan.spec_revision,
    plan_revision: plan.revision,
    profile_hash: hashJson(plan.perfil),
    policy_hash: hashJson(basePolicy(config, plan)),
  };
}

export function currentApproval(engine: Engine, changeId: string): Approval | null {
  const row = engine.store.db.prepare("SELECT approval FROM approvals WHERE change_id = ? AND target_type = 'plan' AND state = 'vigente' ORDER BY rowid DESC LIMIT 1").get(changeId) as
    | { approval: string }
    | undefined;
  return row ? Approval.parse(JSON.parse(row.approval)) : null;
}

/** Everything that must hold for the gate; also re-checked right before running (v2/05 · I02). */
export function gateProblems(engine: Engine, changeId: string): string[] {
  const problems: string[] = [];
  const spec = latestSpec(engine, changeId);
  const plan = latestPlan(engine, changeId);
  if (!spec) return ['no hay especificación'];
  if (!plan) return ['no hay plan'];
  const specErrors = validateSpec(spec.spec).filter((i) => i.severity === 'error');
  if (specErrors.length) problems.push(`la especificación tiene ${specErrors.length} error(es)`);
  for (const q of blockingQuestions(spec.spec)) problems.push(`pregunta pendiente ${q.id}: ${q.texto}`);
  if (plan.plan.spec_hash !== spec.hash) problems.push('el plan se hizo sobre otra revisión de la especificación: vuelve a ejecutar forja dividir');
  const planErrors = validatePlan({ perfil: plan.plan.perfil, tareas: plan.plan.tareas, supuestos: plan.plan.supuestos }, spec.spec).issues.filter((i) => i.severity === 'error');
  for (const e of planErrors) problems.push(`plan: ${e.task ?? ''} ${e.message}`.trim());
  return problems;
}

/** Explicit approval of exactly this spec + plan + profile + policy (R01, R12). */
export function approvePlan(engine: Engine, changeId: string, actor = 'local'): Approval {
  const change = getChange(engine, changeId);
  if (change.phase !== 'aprobar') throw new PlannerError(`el cambio está en la fase «${change.phase}»: se aprueba después de dividir`);
  const problems = gateProblems(engine, changeId);
  if (problems.length) throw new PlannerError(`no se puede aprobar:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const { plan, hash } = latestPlan(engine, changeId)!;
  const target = approvalTarget(engine.config, plan, hash);
  const previous = currentApproval(engine, changeId);
  if (previous && checkApproval(previous, target).ok) return previous;
  const approval = Approval.parse({
    approval_id: newId('apr'),
    actor,
    issued_at: new Date().toISOString(),
    ...target,
    allowed_task_ids: plan.tareas.map((t) => t.id),
    connections: [],
    state: 'vigente',
    request_id: `aprobar-plan:${changeId}:${hash}`,
  });
  engine.store.execute({ request_id: approval.request_id, type: 'aprobar_plan', input: { changeId, hash } }, () => ({
    result: null,
    events: [
      ...(previous ? [{ type: EV.approvalState, aggregate_type: 'cambio', aggregate_id: changeId, payload: { approval_id: previous.approval_id, state: 'obsoleta' } }] : []),
      { type: EV.approvalGranted, aggregate_type: 'cambio', aggregate_id: changeId, payload: { approval: approval as unknown as Record<string, unknown> } },
    ],
  }));
  return approval;
}
