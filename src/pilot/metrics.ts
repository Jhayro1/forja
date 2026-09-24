import type { Engine } from '../core/engine.js';
import { estimatePlan } from '../plan/estimate.js';
import type { Plan } from '../plan/plan.js';
import { getExec, type RunRow } from '../run/orchestrator.js';
import { listTasks } from '../store/projections.js';
import { EV } from '../store/planning-projections.js';

/**
 * Measurements of one run for the quality/cost/parallelism pilot (V2-042,
 * v2/09 · Experimento). Everything is derived from stored events and usage:
 * nothing is sampled live, so a run can be measured long after it ended.
 */
export type RunMetrics = {
  run_id: string;
  change_id: string;
  estado: string;
  /** The unit of comparison is an ACCEPTED change (completed run). */
  aceptado: boolean;
  paralelo: number | null;
  revisor: boolean | null;
  /** Worker models actually used, e.g. "claude:haiku+codex:gpt-6-luna". */
  enrutamiento: string;
  minutos_activos: number | null;
  minutos_estimados: number | null;
  tareas: number;
  integradas: number;
  primer_intento: number;
  reintentos: Record<string, number>;
  intervenciones: number;
  bloqueos: number;
  tokens_por_rol: Record<string, number | null>;
  costo_usd: number | null;
  /** False when some call had no known price: the cost is a lower bound. */
  costo_completo: boolean;
  por_modelo: Record<string, { tareas: number; primer_intento: number }>;
};

const RETRY_CAUSES = ['fallo_calidad', 'fallo_entorno', 'conflicto_integracion', 'proveedor_no_disponible'] as const;

type EvRow = { type: string; recorded_at: string; payload: string; task_id: string | null };

function activeMinutes(events: EvRow[]): number | null {
  let since: number | null = null;
  let total = 0;
  let seen = false;
  for (const e of events) {
    const at = Date.parse(e.recorded_at);
    if (e.type === EV.runStarted) {
      since = at;
      seen = true;
    } else if (e.type === EV.runState) {
      const to = (JSON.parse(e.payload) as { to: string }).to;
      if (to === 'ejecutando') since ??= at;
      else if (since !== null) {
        total += at - since;
        since = null;
      }
    }
  }
  if (!seen) return null;
  // A run still executing counts up to its last recorded event.
  if (since !== null && events.length) total += Date.parse(events.at(-1)!.recorded_at) - since;
  return Math.round((total / 60_000) * 10) / 10;
}

export function runMetrics(engine: Engine, run: RunRow): RunMetrics {
  const db = engine.store.db;
  const events = db.prepare('SELECT type, recorded_at, payload, task_id FROM events WHERE run_id = ? OR aggregate_id = ? ORDER BY seq').all(run.run_id, run.run_id) as EvRow[];
  const params = events.filter((e) => e.type === EV.runParams).map((e) => JSON.parse(e.payload) as { paralelo: number; revisor: boolean });
  const reintentos: Record<string, number> = Object.fromEntries(RETRY_CAUSES.map((c) => [c, 0]));
  let intervenciones = 0;
  let bloqueos = 0;
  for (const e of events.filter((x) => x.type === 'tarea.estado_cambiado')) {
    const p = JSON.parse(e.payload) as { to: string; reason: string };
    if (p.reason in reintentos) reintentos[p.reason]!++;
    if (p.reason === 'causa_resuelta') intervenciones++;
    if (p.to === 'bloqueada') bloqueos++;
  }

  const tasks = listTasks(db, run.run_id).filter((t) => t.state !== 'invalidada' && t.state !== 'cancelada');
  const porModelo: RunMetrics['por_modelo'] = {};
  let primer = 0;
  let integradas = 0;
  for (const t of tasks) {
    const exec = getExec(engine, run.run_id, t.task_id);
    if (t.state !== 'integrada' || exec.attempt === 0) {
      if (t.state === 'integrada') integradas++;
      continue;
    }
    integradas++;
    const first = exec.attempt === 1 && exec.quality_failures === 0;
    if (first) primer++;
    const model = `${exec.provider}:${exec.model}`;
    porModelo[model] ??= { tareas: 0, primer_intento: 0 };
    porModelo[model].tareas++;
    if (first) porModelo[model].primer_intento++;
  }

  const usage = db.prepare('SELECT role, provider, model, input, output, cost_micro FROM usage WHERE run_id = ?').all(run.run_id) as {
    role: string;
    provider: string;
    model: string;
    input: number | null;
    output: number | null;
    cost_micro: number | null;
  }[];
  const tokens: Record<string, number | null> = {};
  let cost = 0;
  let costComplete = usage.length > 0;
  for (const u of usage) {
    const n = u.input === null && u.output === null ? null : (u.input ?? 0) + (u.output ?? 0);
    tokens[u.role] = n === null ? (tokens[u.role] ?? null) : (tokens[u.role] ?? 0) + n;
    if (u.cost_micro === null) costComplete = false;
    else cost += u.cost_micro;
  }
  const workers = [...new Set(usage.filter((u) => u.role === 'trabajador' || u.role === 'complejo').map((u) => `${u.provider}:${u.model}`))].sort();

  const planRow = db.prepare('SELECT plan FROM plans WHERE plan_id = ? AND revision = ?').get(run.plan_id, run.plan_revision) as { plan: string } | undefined;
  const paralelo = params.length ? Math.max(...params.map((p) => p.paralelo)) : null;
  const estimate = planRow && paralelo ? estimatePlan(JSON.parse(planRow.plan) as Plan, { ...engine.config, ejecucion: { ...engine.config.ejecucion, paralelo } }, null) : null;

  return {
    run_id: run.run_id,
    change_id: run.change_id,
    estado: run.state,
    aceptado: run.state === 'completado',
    paralelo,
    revisor: params.length ? params.every((p) => p.revisor) : null,
    enrutamiento: workers.join('+') || 'desconocido',
    minutos_activos: activeMinutes(events),
    minutos_estimados: estimate?.minutos_en_paralelo ?? null,
    tareas: tasks.length,
    integradas,
    primer_intento: primer,
    reintentos,
    intervenciones,
    bloqueos,
    tokens_por_rol: tokens,
    costo_usd: usage.length ? cost / 1e6 : null,
    costo_completo: costComplete,
    por_modelo: porModelo,
  };
}

export function allRunMetrics(engine: Engine): RunMetrics[] {
  const runs = engine.store.db.prepare('SELECT * FROM runs ORDER BY created_at').all() as RunRow[];
  return runs.map((r) => runMetrics(engine, r));
}
