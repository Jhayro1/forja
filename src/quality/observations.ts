import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Engine } from '../core/engine.js';
import type { StoredEvent } from '../domain/events.js';
import { newId } from '../domain/ids.js';
import type { Db } from '../store/sqlite.js';

/**
 * Observations left by review, audit and QA (v3/PLAN.md §5.1.1). They are kept even
 * when the task was approved (a low-severity note would otherwise be lost), listed in
 * the panel, and only become work through an ACTION PLAN the user approves: Forja never
 * runs corrections on its own.
 */
export const OBS_SOURCES = ['revisor', 'auditor', 'qa', 'verificacion'] as const;
export const OBS_SEVERITIES = ['critica', 'alta', 'media', 'baja'] as const;
export const OBS_KINDS = ['defecto', 'sugerencia', 'requisito_nuevo'] as const;
export const OBS_STATES = ['abierta', 'en_plan', 'en_correccion', 'resuelta', 'descartada', 'pospuesta'] as const;
export type ObsState = (typeof OBS_STATES)[number];

export const OBS_EV = { recorded: 'observacion.registrada', state: 'observacion.estado_cambiado' } as const;

export const ObservationInput = z
  .object({
    change_id: z.string().min(1),
    run_id: z.string().nullable().default(null),
    task_id: z.string().nullable().default(null),
    source: z.enum(OBS_SOURCES),
    severity: z.enum(OBS_SEVERITIES),
    kind: z.enum(OBS_KINDS),
    location: z.string().max(300),
    text: z.string().min(1).max(4000),
    evidence: z.string().max(4000).nullable().default(null),
    commit_sha: z.string().nullable().default(null),
  })
  .strict();
export type ObservationInput = z.input<typeof ObservationInput>;

const StateChange = z.object({ to: z.enum(OBS_STATES), reason: z.string().max(1000).nullable(), plan_change: z.string().nullable() }).strict();

export type Observation = z.output<typeof ObservationInput> & { obs_id: string; state: ObsState; reason: string | null; plan_change: string | null; created_at: string };

/** Which moves a user (or the engine) may make; «resuelta» needs the correction delivered. */
const MOVES: Record<ObsState, readonly ObsState[]> = {
  abierta: ['en_plan', 'descartada', 'pospuesta'],
  pospuesta: ['abierta', 'en_plan', 'descartada'],
  descartada: ['abierta'],
  en_plan: ['abierta', 'en_correccion', 'descartada'],
  en_correccion: ['resuelta', 'abierta'],
  resuelta: ['abierta'],
};

/** Same finding (source, task, place and text) = same observation: recording it again changes nothing. */
export function observationId(o: z.output<typeof ObservationInput>): string {
  const key = [o.change_id, o.source, o.task_id ?? '', o.location.trim().toLowerCase(), o.text.trim().toLowerCase()].join('\u0000');
  return `obs_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

export function applyQualityEvent(db: Db, e: StoredEvent): void {
  if (e.type === OBS_EV.recorded) {
    const p = ObservationInput.parse(e.payload);
    db.prepare(
      `INSERT OR IGNORE INTO observations (obs_id, change_id, run_id, task_id, source, severity, kind, location, text, evidence, commit_sha, state, reason, plan_change, created_at, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'abierta', NULL, NULL, ?, ?)`,
    ).run(e.aggregate_id, p.change_id, p.run_id, p.task_id, p.source, p.severity, p.kind, p.location, p.text, p.evidence, p.commit_sha, e.occurred_at, e.seq);
  } else if (e.type === OBS_EV.state) {
    const p = StateChange.parse(e.payload);
    db.prepare('UPDATE observations SET state = ?, reason = ?, plan_change = COALESCE(?, plan_change), updated_seq = ? WHERE obs_id = ?').run(p.to, p.reason, p.plan_change, e.seq, e.aggregate_id);
  }
}

export const QUALITY_TABLES = ['observations'] as const;

type Row = Omit<Observation, never>;

export class ObservationService {
  constructor(private readonly engine: Engine) {}

  private get db(): Db {
    return this.engine.store.db;
  }

  get(id: string): Observation | null {
    return (this.db.prepare('SELECT * FROM observations WHERE obs_id = ?').get(id) as Row | undefined) ?? null;
  }

  /** Records a finding once; returns its id (existing or new). */
  record(input: ObservationInput): string {
    const o = ObservationInput.parse(input);
    const id = observationId(o);
    if (this.get(id)) return id;
    this.engine.store.execute({ request_id: newId('req'), type: 'registrar_observacion', input: { id } }, () => ({
      result: null,
      events: [{ type: OBS_EV.recorded, aggregate_type: 'observacion', aggregate_id: id, ...(o.run_id ? { run_id: o.run_id } : {}), ...(o.task_id ? { task_id: o.task_id } : {}), payload: o }],
    }));
    return id;
  }

  list(filter: { change_id?: string; states?: ObsState[] } = {}): Observation[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.change_id) {
      where.push('change_id = ?');
      args.push(filter.change_id);
    }
    if (filter.states?.length) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      args.push(...filter.states);
    }
    const order = "CASE severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, created_at";
    return this.db.prepare(`SELECT * FROM observations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`).all(...args) as Row[];
  }

  move(id: string, to: ObsState, opts: { reason?: string | null; planChange?: string | null } = {}): Observation {
    const o = this.get(id);
    if (!o) throw new Error(`no existe la observación ${id}`);
    if (o.state === to) return o;
    if (!MOVES[o.state].includes(to)) throw new Error(`la observación está «${o.state}»: no puede pasar a «${to}»`);
    if (to === 'descartada' && !opts.reason?.trim()) throw new Error('para descartar una observación escribe el motivo: queda en el historial');
    this.engine.store.execute({ request_id: newId('req'), type: 'mover_observacion', input: { id, to } }, () => ({
      result: null,
      events: [{ type: OBS_EV.state, aggregate_type: 'observacion', aggregate_id: id, payload: { to, reason: opts.reason?.trim() || null, plan_change: opts.planChange ?? null } }],
    }));
    return this.get(id)!;
  }

  /** When a correction change is delivered, its observations wait to be confirmed as solved. */
  planChanges(): string[] {
    return (this.db.prepare("SELECT DISTINCT plan_change FROM observations WHERE plan_change IS NOT NULL AND state IN ('en_plan', 'en_correccion')").all() as { plan_change: string }[]).map(
      (r) => r.plan_change,
    );
  }
}

/**
 * The idea text of an action plan: the selected observations, with the user's notes,
 * written so the planner proposes one task per fix (it still goes through discovery,
 * spec, plan and the user's approval like any change).
 */
export function actionPlanText(obs: Observation[], note: string): string {
  const lines = [
    'Plan de acción para corregir observaciones de revisión, auditoría y QA. Propón una tarea por corrección, con su criterio de aceptación, y no cambies nada más.',
    '',
    ...obs.map(
      (o, i) =>
        `${i + 1}. [${o.severity} · ${o.kind} · ${o.source}${o.task_id ? ` · ${o.task_id}` : ''}] ${o.location ? `${o.location}: ` : ''}${o.text}${o.evidence ? ` (evidencia: ${o.evidence})` : ''}`,
    ),
  ];
  if (note.trim()) lines.push('', `Indicaciones del usuario: ${note.trim()}`);
  return lines.join('\n');
}
