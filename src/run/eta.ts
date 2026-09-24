import type { Engine } from '../core/engine.js';
import { TASK_STATE_CHANGED } from '../domain/events.js';
import { scheduleMinutes, taskMinutes } from '../plan/estimate.js';
import type { Plan } from '../plan/plan.js';
import { EV } from '../store/planning-projections.js';
import type { RunRow } from './records.js';

/**
 * Remaining time of a run (MEJORAS 6.5): the plan's estimate for what is left,
 * scheduled on N agents, corrected by what this run measured so far (real
 * minutes per task / estimated). Always labeled as an estimate.
 */
export type Eta = { minutos: number; factor: number | null; medidas: number; paralelo: number };

const DONE = new Set(['integrada', 'invalidada', 'cancelada']);

export function remainingTime(engine: Engine, run: RunRow, plan: Plan, tasks: { id: string; state: string }[], now = Date.now()): Eta | null {
  const left = tasks.filter((t) => !DONE.has(t.state));
  if (!left.length) return null;
  const defs = new Map(plan.tareas.map((t) => [t.id, t]));
  const params = engine.store.db.prepare('SELECT payload FROM events WHERE type = ? AND run_id = ? ORDER BY seq DESC LIMIT 1').get(EV.runParams, run.run_id) as { payload: string } | undefined;
  const paralelo = (params ? (JSON.parse(params.payload) as { paralelo?: number }).paralelo : undefined) ?? engine.config.ejecucion.paralelo;

  // Measured: first reservation → integration, for tasks this run really executed.
  const rows = engine.store.db.prepare('SELECT task_id, payload, recorded_at FROM events WHERE type = ? AND run_id = ? ORDER BY seq').all(TASK_STATE_CHANGED, run.run_id) as {
    task_id: string;
    payload: string;
    recorded_at: string;
  }[];
  const started = new Map<string, number>();
  let real = 0;
  let estimated = 0;
  let measured = 0;
  for (const r of rows) {
    const to = (JSON.parse(r.payload) as { to: string }).to;
    if (to === 'reservada' && !started.has(r.task_id)) started.set(r.task_id, Date.parse(r.recorded_at));
    if (to === 'integrada' && started.has(r.task_id) && defs.has(r.task_id)) {
      real += (Date.parse(r.recorded_at) - started.get(r.task_id)!) / 60_000;
      estimated += taskMinutes(defs.get(r.task_id)!);
      measured++;
    }
  }
  const factor = measured >= 2 && estimated > 0 ? Math.min(4, Math.max(0.25, real / estimated)) : null;
  const minutesOf = (id: string) => {
    const base = (defs.get(id) ? taskMinutes(defs.get(id)!) : 5) * (factor ?? 1);
    const since = started.get(id);
    // A task already in progress has part of its time behind it.
    return since ? Math.max(0.5, base - (now - since) / 60_000) : base;
  };
  const minutos = scheduleMinutes(
    left.map((t) => ({ id: t.id, depende_de: defs.get(t.id)?.depende_de ?? [] })),
    paralelo,
    minutesOf,
  );
  return { minutos, factor: factor === null ? null : Math.round(factor * 100) / 100, medidas: measured, paralelo };
}

export function etaLabel(e: Eta | null): string {
  if (!e) return '';
  return `≈${Math.max(1, Math.round(e.minutos))} min restantes (${e.factor === null ? 'estimación del plan' : `estimación ×${e.factor} según ${e.medidas} tareas medidas`})`;
}
