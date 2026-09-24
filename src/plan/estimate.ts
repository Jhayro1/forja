import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ForjaConfig } from '../registry/config.js';
import { waves, type Plan, type PlanTask } from './plan.js';

/**
 * Pre-run estimate (v2/07 · Presupuestos): works only with persisted inputs, never
 * calls a model or runs repo commands. Until calibrated with real runs it is a
 * wide, labeled guess.
 */

/** Context every CLI launch carries before the task itself (M0 finding 10). */
const BASE_CONTEXT_TOKENS = 13_000;
const OUTPUT_TOKENS = { baja: 3_000, media: 8_000, alta: 16_000 } as const;
const TASK_CONTEXT_TOKENS = { baja: 4_000, media: 8_000, alta: 14_000 } as const;
const MINUTES = { baja: 3, media: 6, alta: 12 } as const;
/** Expected attempts per task including retries (uncalibrated). */
const ATTEMPT_FACTOR = 1.4;
const REVIEW = { input: BASE_CONTEXT_TOKENS + 4_000, output: 1_500 };

export type Prices = Record<string, { entrada: number; salida: number; cache_lectura?: number }>;

/** Optional `~/.forja/precios.yaml`: USD per million tokens per `proveedor:modelo`. Never hardcoded. */
export function loadPrices(home: string): Prices | null {
  const path = join(home, 'precios.yaml');
  if (!existsSync(path)) return null;
  return (parse(readFileSync(path, 'utf8')) as { modelos?: Prices }).modelos ?? null;
}

export type Estimate = {
  calibrado: false;
  tareas: number;
  por_rol: Record<string, { llamadas: number; entrada: number; salida: number; modelo: string }>;
  tokens_total: number;
  costo_equivalente_usd: number | null;
  costo_nota: string;
  minutos_en_serie: number;
  minutos_en_paralelo: number;
  paralelo: number;
  olas: number;
};

function roleFor(task: PlanTask): 'trabajador' | 'complejo' {
  return task.complejidad === 'alta' ? 'complejo' : 'trabajador';
}

/** List scheduling with N slots over the DAG: rough wall-clock time. */
function parallelMinutes(plan: Plan, slots: number): number {
  const remaining = new Map(plan.tareas.map((t) => [t.id, t]));
  const done = new Map<string, number>();
  const running: { id: string; end: number }[] = [];
  let now = 0;
  while (remaining.size > 0 || running.length > 0) {
    const ready = [...remaining.values()].filter((t) => t.depende_de.every((d) => done.has(d) || !plan.tareas.some((x) => x.id === d)));
    while (running.length < slots && ready.length > 0) {
      const t = ready.shift()!;
      remaining.delete(t.id);
      running.push({ id: t.id, end: now + MINUTES[t.complejidad] * ATTEMPT_FACTOR });
    }
    if (running.length === 0) break; // unreachable dependencies
    running.sort((a, b) => a.end - b.end);
    const next = running.shift()!;
    now = next.end;
    done.set(next.id, now);
  }
  return Math.round(now);
}

export function estimatePlan(plan: Plan, config: ForjaConfig, prices: Prices | null): Estimate {
  const perRole: Estimate['por_rol'] = {};
  const add = (role: string, model: string, calls: number, input: number, output: number) => {
    const r = (perRole[role] ??= { llamadas: 0, entrada: 0, salida: 0, modelo: model });
    r.llamadas += calls;
    r.entrada += Math.round(input);
    r.salida += Math.round(output);
  };
  for (const t of plan.tareas) {
    const role = roleFor(t);
    add(role, config.roles[role][0]!, ATTEMPT_FACTOR, (BASE_CONTEXT_TOKENS + TASK_CONTEXT_TOKENS[t.complejidad]) * ATTEMPT_FACTOR, OUTPUT_TOKENS[t.complejidad] * ATTEMPT_FACTOR);
    add('revisor', config.roles.revisor[0]!, 1, REVIEW.input, REVIEW.output);
  }
  for (const r of Object.values(perRole)) r.llamadas = Math.round(r.llamadas);
  const tokens = Object.values(perRole).reduce((a, r) => a + r.entrada + r.salida, 0);

  let cost: number | null = null;
  let note = 'sin precios configurados: crea ~/.forja/precios.yaml para ver el costo equivalente';
  if (prices) {
    cost = 0;
    const missing: string[] = [];
    for (const r of Object.values(perRole)) {
      const p = prices[r.modelo];
      if (!p) {
        missing.push(r.modelo);
        continue;
      }
      cost += (r.entrada * p.entrada + r.salida * p.salida) / 1_000_000;
    }
    if (missing.length) {
      note = `faltan precios de ${missing.join(', ')}: el costo es parcial`;
    } else note = 'costo equivalente estimado, sin calibrar (con suscripción se descuenta de tu cuota, no se cobra por token)';
    cost = Math.round(cost * 100) / 100;
  }
  const serial = Math.round(plan.tareas.reduce((a, t) => a + MINUTES[t.complejidad] * ATTEMPT_FACTOR, 0));
  return {
    calibrado: false,
    tareas: plan.tareas.length,
    por_rol: perRole,
    tokens_total: tokens,
    costo_equivalente_usd: cost,
    costo_nota: note,
    minutos_en_serie: serial,
    minutos_en_paralelo: parallelMinutes(plan, config.ejecucion.paralelo),
    paralelo: config.ejecucion.paralelo,
    olas: waves(plan.tareas).length,
  };
}
