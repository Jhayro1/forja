import { z } from 'zod';
import type { StoredEvent } from '../domain/events.js';
import type { Db } from './sqlite.js';

export const CHANGE_PHASES = ['descubrir', 'especificar', 'dividir', 'aprobar', 'ejecutar', 'entregado', 'cancelado'] as const;
export type ChangePhase = (typeof CHANGE_PHASES)[number];

export const EV = {
  changeCreated: 'cambio.creado',
  changePhase: 'cambio.fase_cambiada',
  plannerTurn: 'planeador.turno_confirmado',
  discoveryApproved: 'descubrimiento.aprobado',
  specRevised: 'spec.revisada',
  planProposed: 'plan.propuesto',
  approvalGranted: 'aprobacion.otorgada',
  approvalState: 'aprobacion.estado_cambiado',
  usage: 'uso.observado',
} as const;

export const ChangeCreated = z.object({ title: z.string().min(1), mode: z.enum(['idea', 'mejora']) }).strict();
export const ChangePhaseChanged = z.object({ from: z.enum(CHANGE_PHASES), to: z.enum(CHANGE_PHASES) }).strict();
export const PlannerTurn = z
  .object({
    turn_id: z.string(),
    n: z.number().int().positive(),
    base_revision: z.number().int().nonnegative(),
    new_revision: z.number().int().positive(),
    user_text: z.string().nullable(),
    planner_text: z.string(),
    provider: z.string(),
    model: z.string().nullable(),
    prompt_manifest: z.record(z.string(), z.string()),
    state: z.record(z.string(), z.unknown()),
  })
  .strict();
export const DiscoveryApproved = z.object({ revision: z.number().int().positive() }).strict();
export const SpecRevised = z.object({ revision: z.number().int().positive(), hash: z.string(), spec: z.record(z.string(), z.unknown()) }).strict();
export const PlanProposed = z
  .object({ plan_id: z.string(), revision: z.number().int().positive(), hash: z.string(), plan: z.record(z.string(), z.unknown()) })
  .strict();
export const ApprovalGranted = z.object({ approval: z.record(z.string(), z.unknown()) }).strict();
export const ApprovalStateChanged = z.object({ approval_id: z.string(), state: z.enum(['vigente', 'revocada', 'consumida', 'obsoleta']) }).strict();
export const UsageObserved = z
  .object({
    launch_id: z.string(),
    role: z.string(),
    provider: z.string(),
    model: z.string().nullable(),
    input: z.number().nullable(),
    output: z.number().nullable(),
    cache_read: z.number().nullable(),
    cache_write: z.number().nullable(),
    cost_micro: z.number().nullable(),
  })
  .strict();

export class PlanningProjectionError extends Error {}

function changeRow(db: Db, changeId: string) {
  return db.prepare('SELECT * FROM changes WHERE change_id = ?').get(changeId) as
    | { change_id: string; phase: ChangePhase; discovery_revision: number; spec_revision: number; plan_revision: number }
    | undefined;
}

export function applyPlanningEvent(db: Db, e: StoredEvent): void {
  const id = e.aggregate_id;
  switch (e.type) {
    case EV.changeCreated: {
      const p = ChangeCreated.parse(e.payload);
      db.prepare("INSERT INTO changes (change_id, title, mode, phase, created_at, updated_seq) VALUES (?, ?, ?, 'descubrir', ?, ?)").run(id, p.title, p.mode, e.occurred_at, e.seq);
      return;
    }
    case EV.changePhase: {
      const p = ChangePhaseChanged.parse(e.payload);
      const row = changeRow(db, id);
      if (!row) throw new PlanningProjectionError(`el cambio ${id} no existe`);
      if (row.phase !== p.from) throw new PlanningProjectionError(`el cambio está en ${row.phase}, no en ${p.from}`);
      db.prepare('UPDATE changes SET phase = ?, updated_seq = ? WHERE change_id = ?').run(p.to, e.seq, id);
      return;
    }
    case EV.plannerTurn: {
      const p = PlannerTurn.parse(e.payload);
      const row = changeRow(db, id);
      if (!row) throw new PlanningProjectionError(`el cambio ${id} no existe`);
      // Optimistic concurrency: a turn computed on an old revision is rejected (v2/13).
      if (row.discovery_revision !== p.base_revision) {
        throw new PlanningProjectionError(`turno sobre la revisión ${p.base_revision}, pero la vigente es ${row.discovery_revision}`);
      }
      db.prepare(
        'INSERT INTO planner_turns (turn_id, change_id, n, user_text, planner_text, provider, model, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(p.turn_id, id, p.n, p.user_text, p.planner_text, p.provider, p.model, e.seq);
      db.prepare(
        'INSERT INTO discovery (change_id, revision, state) VALUES (?, ?, ?) ON CONFLICT(change_id) DO UPDATE SET revision = excluded.revision, state = excluded.state',
      ).run(id, p.new_revision, JSON.stringify(p.state));
      db.prepare('UPDATE changes SET discovery_revision = ?, updated_seq = ? WHERE change_id = ?').run(p.new_revision, e.seq, id);
      return;
    }
    case EV.discoveryApproved: {
      const p = DiscoveryApproved.parse(e.payload);
      db.prepare('UPDATE discovery SET approved_revision = ? WHERE change_id = ?').run(p.revision, id);
      return;
    }
    case EV.specRevised: {
      const p = SpecRevised.parse(e.payload);
      db.prepare('INSERT INTO specs (change_id, revision, hash, spec) VALUES (?, ?, ?, ?)').run(id, p.revision, p.hash, JSON.stringify(p.spec));
      db.prepare('UPDATE changes SET spec_revision = ?, updated_seq = ? WHERE change_id = ?').run(p.revision, e.seq, id);
      return;
    }
    case EV.planProposed: {
      const p = PlanProposed.parse(e.payload);
      db.prepare('INSERT INTO plans (plan_id, change_id, revision, hash, plan) VALUES (?, ?, ?, ?, ?)').run(p.plan_id, id, p.revision, p.hash, JSON.stringify(p.plan));
      db.prepare('UPDATE changes SET plan_revision = ?, updated_seq = ? WHERE change_id = ?').run(p.revision, e.seq, id);
      return;
    }
    case EV.approvalGranted: {
      const a = ApprovalGranted.parse(e.payload).approval as { approval_id: string; target_type: string; target_hash: string; state: string };
      db.prepare('INSERT INTO approvals (approval_id, change_id, target_type, target_hash, state, approval) VALUES (?, ?, ?, ?, ?, ?)').run(
        a.approval_id,
        id,
        a.target_type,
        a.target_hash,
        a.state,
        JSON.stringify(a),
      );
      return;
    }
    case EV.approvalState: {
      const p = ApprovalStateChanged.parse(e.payload);
      const row = db.prepare('SELECT approval FROM approvals WHERE approval_id = ?').get(p.approval_id) as { approval: string } | undefined;
      if (!row) throw new PlanningProjectionError(`la aprobación ${p.approval_id} no existe`);
      const approval = { ...(JSON.parse(row.approval) as object), state: p.state };
      db.prepare('UPDATE approvals SET state = ?, approval = ? WHERE approval_id = ?').run(p.state, JSON.stringify(approval), p.approval_id);
      return;
    }
    case EV.usage: {
      const p = UsageObserved.parse(e.payload);
      db.prepare(
        `INSERT INTO usage (launch_id, change_id, run_id, task_id, role, provider, model, input, output, cache_read, cache_write, cost_micro, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(launch_id) DO UPDATE SET input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
           cache_write = excluded.cache_write, cost_micro = excluded.cost_micro, model = excluded.model`,
      ).run(p.launch_id, e.aggregate_type === 'cambio' ? id : null, e.run_id, e.task_id, p.role, p.provider, p.model, p.input, p.output, p.cache_read, p.cache_write, p.cost_micro, e.occurred_at);
      return;
    }
    default:
      return;
  }
}

/** Deletion order respects foreign keys. */
export const PLANNING_TABLES = ['planner_turns', 'discovery', 'specs', 'plans', 'approvals', 'usage', 'changes'] as const;
