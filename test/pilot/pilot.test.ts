import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { type RunMetrics, runMetrics } from '../../src/pilot/metrics.js';
import { MIN_RUNS, type PilotReport, pilotReport, renderPilotMarkdown, routingRecommendation } from '../../src/pilot/report.js';
import { answerTaskQuestion, getRun, Orchestrator, startOrResumeRun } from '../../src/run/orchestrator.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { FILES, seedApprovedPlan } from '../run/fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const APPROVE_REVIEW = { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'correcto' } };

describe('métricas de un run (V2-042)', () => {
  it('mide N, primer intento, reintentos por causa, intervenciones y consumo desde los eventos', async () => {
    let asked = false;
    const simulation: Simulation = ({ role, taskId, attempt }) => {
      if (role === 'revisor') return APPROVE_REVIEW;
      if (taskId === 'T-005' && attempt === 1) return { pasos: [{ escribir: { ruta: 'src/uc-002.mjs', contenido: 'export function saldo() { return 999; }\n' } }] };
      if (taskId === 'T-003' && !asked) {
        asked = true;
        return { pasos: [], resultado: 'NECESITA_ACLARACION: ¿decimales?' };
      }
      return { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };
    };
    const t = testEngine(simulation);
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    await new Orchestrator(t.engine, repo, runId, { parallel: 2, sandbox: HAS_BWRAP, pollMs: 100 }).loop();
    const blocked = runMetrics(t.engine, getRun(t.engine, runId)!);
    expect(blocked).toMatchObject({ aceptado: false, estado: 'bloqueado', paralelo: 2, revisor: true });
    answerTaskQuestion(t.engine, runId, 'T-003', 'sí');
    await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    await new Orchestrator(t.engine, repo, runId, { parallel: 3, sandbox: HAS_BWRAP, pollMs: 100 }).loop();

    const m = runMetrics(t.engine, getRun(t.engine, runId)!);
    expect(m).toMatchObject({ aceptado: true, paralelo: 3, tareas: 5, integradas: 5, primer_intento: 4, intervenciones: 1, bloqueos: 0, enrutamiento: 'simulado:sim' });
    expect(m.reintentos.fallo_calidad).toBe(1);
    expect(m.minutos_activos).toBeGreaterThanOrEqual(0);
    expect(m.minutos_estimados).toBeGreaterThan(0);
    expect(m.tokens_por_rol.trabajador).toBeGreaterThan(0);
    expect(m.por_modelo['simulado:sim']).toEqual({ tareas: 5, primer_intento: 4 });
  }, 300_000);
});

describe('informe del piloto', () => {
  const run = (n: number, minutes: number, first: number, extra: Partial<RunMetrics> = {}): RunMetrics => ({
    run_id: `run_${n}_${minutes}_${Math.random()}`,
    change_id: 'c',
    estado: 'completado',
    aceptado: true,
    paralelo: n,
    revisor: true,
    enrutamiento: 'claude:haiku+codex:gpt-6-luna',
    minutos_activos: minutes,
    minutos_estimados: minutes,
    tareas: 10,
    integradas: 10,
    primer_intento: first,
    reintentos: { fallo_calidad: 10 - first, fallo_entorno: 0, conflicto_integracion: 0, proveedor_no_disponible: 0 },
    intervenciones: 0,
    bloqueos: 0,
    tokens_por_rol: { trabajador: 1000 },
    costo_usd: 1,
    costo_completo: true,
    por_modelo: { 'claude:haiku': { tareas: 10, primer_intento: first } },
    ...extra,
  });

  it('sin suficientes runs por condición no recomienda nada y lo dice', () => {
    const r = pilotReport([run(2, 50, 8), run(3, 30, 8)]);
    expect(r.recomendacion.paralelo).toBeNull();
    expect(r.recomendacion.motivo).toMatch(new RegExp(`al menos ${MIN_RUNS} runs`));
  });

  it('elige el N más rápido que no degrada la calidad ni dispara conflictos', () => {
    const metrics = [
      ...[60, 62, 58].map((m) => run(2, m, 9)),
      ...[40, 45, 42].map((m) => run(3, m, 9)),
      // N=4 is fastest but quality drops by 30 points.
      ...[30, 31, 29].map((m) => run(4, m, 6)),
      // A failed run counts in cost and appears in the report.
      run(3, 20, 0, { aceptado: false, estado: 'bloqueado', costo_usd: 3 }),
    ];
    const r = pilotReport(metrics);
    expect(r.recomendacion.paralelo).toBe(3);
    const n3 = r.condiciones.find((c) => c.paralelo === 3)!;
    expect(n3).toMatchObject({ runs: 4, aceptados: 3, minutos: { mediana: 42, min: 40, max: 45 }, tasa_primer_intento: 0.9 });
    expect(n3.costo_por_aceptado_usd).toBe(2); // (1+1+1+3) / 3 accepted
    expect(r.sin_aceptar).toHaveLength(1);
    const md = renderPilotMarkdown(r, new Date('2026-09-24T12:00:00Z'));
    expect(md).toContain('**N por defecto = 3**');
    expect(md).toContain('| N=3 · claude:haiku+codex:gpt-6-luna | 4 | 3 | 42 (40–45) |');
    expect(md).toContain('Runs no aceptados');
  });

  it('muchos conflictos de integración descartan ese N aunque sea rápido', () => {
    const metrics = [...[60, 61, 59].map((m) => run(2, m, 9)), ...[30, 31, 29].map((m) => run(4, m, 9, { reintentos: { conflicto_integracion: 5 } }))];
    expect(pilotReport(metrics).recomendacion.paralelo).toBe(2);
  });

  it('un costo con llamadas sin tarifa se marca como mínimo', () => {
    const r = pilotReport([run(3, 10, 9, { costo_completo: false })]);
    expect(renderPilotMarkdown(r)).toContain('mínimo: hay llamadas sin tarifa');
  });

  it('sugiere poner primero al modelo que acepta claramente más al primer intento, sólo con datos suficientes (MEJORAS 3.12)', () => {
    const report = (modelos: PilotReport['modelos']): PilotReport => ({ condiciones: [], recomendacion: { paralelo: null, motivo: '' }, modelos, sin_aceptar: [] });
    const roles = { trabajador: ['claude:haiku', 'codex:luna'], complejo: ['claude:sonnet', 'codex:sol'] };
    const clear = routingRecommendation(
      report([
        { modelo: 'codex:luna', tareas: 12, tasa_primer_intento: 0.9 },
        { modelo: 'claude:haiku', tareas: 10, tasa_primer_intento: 0.6 },
        { modelo: 'codex:sol', tareas: 2, tasa_primer_intento: 1 },
      ]),
      roles,
    );
    expect(clear).toEqual([{ rol: 'trabajador', actual: roles.trabajador, propuesto: ['codex:luna', 'claude:haiku'], motivo: 'codex:luna acepta 90% al primer intento frente a 60% de claude:haiku' }]);
    // A small difference, or too few tasks, changes nothing.
    expect(
      routingRecommendation(
        report([
          { modelo: 'codex:luna', tareas: 12, tasa_primer_intento: 0.7 },
          { modelo: 'claude:haiku', tareas: 10, tasa_primer_intento: 0.65 },
        ]),
        roles,
      ),
    ).toEqual([]);
    expect(routingRecommendation(report([{ modelo: 'codex:luna', tareas: 3, tasa_primer_intento: 1 }]), roles)).toEqual([]);
  });
});
