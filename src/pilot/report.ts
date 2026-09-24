import type { RunMetrics } from './metrics.js';

/**
 * Pilot report (V2-042): groups runs by condition (N + routing), reports
 * dispersion and failures — not only favorable averages — and recommends the
 * default N with the rule of v2/09: lower time without degrading quality nor
 * raising conflicts. Without enough data it says so and recommends nothing.
 */

export const MIN_RUNS = 3;
/** Quality may drop at most this much (first-pass rate) to accept a faster N. */
const QUALITY_TOLERANCE = 0.1;
/** Integration conflicts per task above this mean N is too high for this repo. */
const MAX_CONFLICTS_PER_TASK = 0.2;

export type ConditionStats = {
  clave: string;
  paralelo: number | null;
  enrutamiento: string;
  runs: number;
  aceptados: number;
  minutos: { mediana: number | null; min: number | null; max: number | null };
  desvio_estimacion: number | null;
  tasa_primer_intento: number | null;
  conflictos_por_tarea: number | null;
  reintentos: Record<string, number>;
  intervenciones: number;
  costo_por_aceptado_usd: number | null;
  costo_completo: boolean;
};

export type PilotReport = {
  condiciones: ConditionStats[];
  recomendacion: { paralelo: number | null; motivo: string };
  modelos: { modelo: string; tareas: number; tasa_primer_intento: number }[];
  sin_aceptar: { run_id: string; estado: string }[];
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round(((s[m - 1]! + s[m]!) / 2) * 10) / 10;
};
const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 100) / 100 : null);

function stats(key: string, runs: RunMetrics[]): ConditionStats {
  const accepted = runs.filter((r) => r.aceptado);
  const minutes = accepted.map((r) => r.minutos_activos).filter((m): m is number => m !== null);
  const tasks = accepted.reduce((a, r) => a + r.integradas, 0);
  const retries: Record<string, number> = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.reintentos)) retries[k] = (retries[k] ?? 0) + v;
  const deviations = accepted.filter((r) => r.minutos_activos !== null && r.minutos_estimados).map((r) => r.minutos_activos! / r.minutos_estimados!);
  const costs = runs.map((r) => r.costo_usd).filter((c): c is number => c !== null);
  return {
    clave: key,
    paralelo: runs[0]!.paralelo,
    enrutamiento: runs[0]!.enrutamiento,
    runs: runs.length,
    aceptados: accepted.length,
    minutos: { mediana: median(minutes), min: minutes.length ? Math.min(...minutes) : null, max: minutes.length ? Math.max(...minutes) : null },
    desvio_estimacion: median(deviations),
    tasa_primer_intento: ratio(
      accepted.reduce((a, r) => a + r.primer_intento, 0),
      tasks,
    ),
    conflictos_por_tarea: ratio(
      accepted.reduce((a, r) => a + (r.reintentos.conflicto_integracion ?? 0), 0),
      tasks,
    ),
    reintentos: retries,
    intervenciones: runs.reduce((a, r) => a + r.intervenciones, 0),
    // Failed attempts count: total cost of the condition divided by accepted changes.
    costo_por_aceptado_usd: accepted.length && costs.length ? Math.round((costs.reduce((a, c) => a + c, 0) / accepted.length) * 100) / 100 : null,
    costo_completo: runs.every((r) => r.costo_completo),
  };
}

export function pilotReport(metrics: RunMetrics[]): PilotReport {
  const groups = new Map<string, RunMetrics[]>();
  for (const m of metrics) {
    const key = `N=${m.paralelo ?? '?'} · ${m.enrutamiento}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const condiciones = [...groups.entries()].map(([k, runs]) => stats(k, runs)).sort((a, b) => (a.paralelo ?? 0) - (b.paralelo ?? 0));

  // Compare N only within the most measured routing: mixing routings would confound the effect.
  const byRouting = new Map<string, ConditionStats[]>();
  for (const c of condiciones) byRouting.set(c.enrutamiento, [...(byRouting.get(c.enrutamiento) ?? []), c]);
  const routing = [...byRouting.values()].sort((a, b) => b.reduce((x, c) => x + c.aceptados, 0) - a.reduce((x, c) => x + c.aceptados, 0))[0] ?? [];
  const eligible = routing.filter((c) => c.aceptados >= MIN_RUNS && c.paralelo !== null && c.minutos.mediana !== null && c.tasa_primer_intento !== null);
  let recomendacion: PilotReport['recomendacion'];
  if (eligible.length < 2) {
    recomendacion = {
      paralelo: null,
      motivo: `faltan datos: se necesitan al menos ${MIN_RUNS} runs aceptados en dos o más valores de N con el mismo enrutamiento (hay ${eligible.length} condición(es) con datos suficientes)`,
    };
  } else {
    const best = Math.max(...eligible.map((c) => c.tasa_primer_intento!));
    const ok = eligible.filter((c) => c.tasa_primer_intento! >= best - QUALITY_TOLERANCE && (c.conflictos_por_tarea ?? 0) <= MAX_CONFLICTS_PER_TASK);
    if (!ok.length) {
      recomendacion = { paralelo: null, motivo: 'ninguna condición mantiene la calidad con pocos conflictos: conviene revisar la división en tareas antes de subir N' };
    } else {
      const pick = ok.sort((a, b) => a.minutos.mediana! - b.minutos.mediana! || a.paralelo! - b.paralelo!)[0]!;
      recomendacion = {
        paralelo: pick.paralelo,
        motivo: `N=${pick.paralelo} tiene la menor mediana de tiempo (${pick.minutos.mediana} min) sin bajar la calidad más de ${QUALITY_TOLERANCE * 100}% respecto de la mejor (${Math.round(best * 100)}% al primer intento) y con ${pick.conflictos_por_tarea ?? 0} conflictos por tarea`,
      };
    }
  }

  const models = new Map<string, { tareas: number; primer: number }>();
  for (const m of metrics.filter((x) => x.aceptado)) {
    for (const [model, v] of Object.entries(m.por_modelo)) {
      const cur = models.get(model) ?? { tareas: 0, primer: 0 };
      models.set(model, { tareas: cur.tareas + v.tareas, primer: cur.primer + v.primer_intento });
    }
  }
  return {
    condiciones,
    recomendacion,
    modelos: [...models.entries()].map(([modelo, v]) => ({ modelo, tareas: v.tareas, tasa_primer_intento: ratio(v.primer, v.tareas) ?? 0 })).sort((a, b) => b.tasa_primer_intento - a.tasa_primer_intento),
    sin_aceptar: metrics.filter((m) => !m.aceptado).map((m) => ({ run_id: m.run_id, estado: m.estado })),
  };
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const num = (x: number | null) => (x === null ? '—' : String(x));

export function renderPilotMarkdown(r: PilotReport, generatedAt = new Date()): string {
  const lines = [
    `# Piloto de calidad, costo y paralelismo`,
    '',
    `Generado ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. Es un piloto, no una estimación estadística definitiva (v2/09).`,
    '',
    '## Recomendación',
    '',
    r.recomendacion.paralelo === null ? `Sin cambio de N: ${r.recomendacion.motivo}.` : `**N por defecto = ${r.recomendacion.paralelo}**: ${r.recomendacion.motivo}.`,
    '',
    '## Condiciones',
    '',
    '| Condición | Runs | Aceptados | Minutos (mediana, mín–máx) | Real/estimado | Primer intento | Conflictos/tarea | Reintentos | Intervenciones | Costo por aceptado |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...r.condiciones.map(
      (c) =>
        `| ${c.clave} | ${c.runs} | ${c.aceptados} | ${num(c.minutos.mediana)} (${num(c.minutos.min)}–${num(c.minutos.max)}) | ${c.desvio_estimacion === null ? '—' : `×${c.desvio_estimacion.toFixed(2)}`} | ${pct(c.tasa_primer_intento)} | ${num(c.conflictos_por_tarea)} | ${
          Object.entries(c.reintentos)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k} ${v}`)
            .join(', ') || '—'
        } | ${c.intervenciones} | ${c.costo_por_aceptado_usd === null ? 'desconocido' : `US$ ${c.costo_por_aceptado_usd}${c.costo_completo ? '' : ' (mínimo: hay llamadas sin tarifa)'}`} |`,
    ),
    '',
    '## Modelos de trabajo',
    '',
    '| Modelo | Tareas integradas | Aceptadas al primer intento |',
    '|---|---|---|',
    ...r.modelos.map((m) => `| ${m.modelo} | ${m.tareas} | ${pct(m.tasa_primer_intento)} |`),
    '',
  ];
  if (r.sin_aceptar.length) lines.push('## Runs no aceptados (se cuentan en costo y reintentos)', '', ...r.sin_aceptar.map((s) => `- ${s.run_id}: ${s.estado}`), '');
  return `${lines.join('\n')}\n`;
}
