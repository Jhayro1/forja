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
  specAnswer: 'spec.pregunta_respondida',
  runStarted: 'run.iniciado',
  runState: 'run.estado_cambiado',
  /** How a run segment was executed (N, reviewer): evidence for the pilot; no projection. */
  runParams: 'run.parametros',
  taskExec: 'tarea.ejecucion_actualizada',
  /** A provider (or a simulated model) answered «quota» or «no session»: skipped until `until`. */
  providerPaused: 'proveedor.pausado',
} as const;

export const RUN_STATES = ['ejecutando', 'pausado', 'bloqueado', 'completado', 'cancelado'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RunStarted = z
  .object({
    change_id: z.string(),
    plan_id: z.string(),
    plan_revision: z.number().int(),
    plan_hash: z.string(),
    approval_id: z.string(),
    base_sha: z.string(),
    branch: z.string(),
  })
  .strict();
export const RunStateChanged = z.object({ from: z.enum(RUN_STATES), to: z.enum(RUN_STATES), detail: z.string().nullable() }).strict();

/** Patch of the execution row; only these columns can be set. */
export const TASK_EXEC_FIELDS = [
  'attempt',
  'quality_failures',
  'level',
  'launch_id',
  'launch_dir',
  'worktree',
  'provider',
  'model',
  'base_sha',
  'candidate_sha',
  'integrated_sha',
  'files',
  'feedback',
  'last_error',
  'question',
  'answer',
  'steps',
  'env_failures',
  'control',
  'pinned_model',
] as const;
export const TaskExecPatch = z.object(Object.fromEntries(TASK_EXEC_FIELDS.map((f) => [f, z.union([z.string(), z.number(), z.null()]).optional()]))).strict();

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

export const SpecAnswer = z.object({ question_id: z.string(), question: z.string(), answer: z.string().min(1) }).strict();

export const ProviderPaused = z.object({ key: z.string().min(1), until: z.string(), reason: z.string() }).strict();

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
    case EV.runStarted: {
      const p = RunStarted.parse(e.payload);
      db.prepare(
        "INSERT INTO runs (run_id, change_id, plan_id, plan_revision, plan_hash, approval_id, state, base_sha, branch, created_at, updated_seq) VALUES (?, ?, ?, ?, ?, ?, 'ejecutando', ?, ?, ?, ?)",
      ).run(id, p.change_id, p.plan_id, p.plan_revision, p.plan_hash, p.approval_id, p.base_sha, p.branch, e.occurred_at, e.seq);
      return;
    }
    case EV.runState: {
      const p = RunStateChanged.parse(e.payload);
      const row = db.prepare('SELECT state FROM runs WHERE run_id = ?').get(id) as { state: string } | undefined;
      if (!row) throw new PlanningProjectionError(`el run ${id} no existe`);
      if (row.state !== p.from) throw new PlanningProjectionError(`el run está ${row.state}, no ${p.from}`);
      db.prepare('UPDATE runs SET state = ?, detail = ?, updated_seq = ? WHERE run_id = ?').run(p.to, p.detail, e.seq, id);
      return;
    }
    case EV.taskExec: {
      const patch = TaskExecPatch.parse(e.payload);
      if (!e.run_id || !e.task_id) throw new PlanningProjectionError('tarea.ejecucion_actualizada sin run_id/task_id');
      db.prepare('INSERT OR IGNORE INTO task_exec (run_id, task_id, updated_seq) VALUES (?, ?, ?)').run(e.run_id, e.task_id, e.seq);
      const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
      if (keys.length) {
        db.prepare(`UPDATE task_exec SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_seq = ? WHERE run_id = ? AND task_id = ?`).run(
          ...keys.map((k) => (patch as Record<string, string | number | null>)[k]!),
          e.seq,
          e.run_id,
          e.task_id,
        );
      }
      return;
    }
    case EV.specAnswer: {
      const p = SpecAnswer.parse(e.payload);
      db.prepare(
        `INSERT INTO spec_answers (change_id, question_id, question, answer, answered_seq) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(change_id, question_id) DO UPDATE SET answer = excluded.answer, answered_seq = excluded.answered_seq`,
      ).run(id, p.question_id, p.question, p.answer, e.seq);
      return;
    }
    case EV.providerPaused: {
      const p = ProviderPaused.parse(e.payload);
      db.prepare(
        `INSERT INTO provider_pauses (pause_key, until, reason, updated_seq) VALUES (?, ?, ?, ?)
         ON CONFLICT(pause_key) DO UPDATE SET until = excluded.until, reason = excluded.reason, updated_seq = excluded.updated_seq`,
      ).run(p.key, p.until, p.reason, e.seq);
      return;
    }
    default:
      return;
  }
}

/** Deletion order respects foreign keys. */
export const PLANNING_TABLES = ['provider_pauses', 'task_exec', 'runs', 'planner_turns', 'discovery', 'spec_answers', 'specs', 'plans', 'approvals', 'usage', 'changes'] as const;
