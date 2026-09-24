import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { Orchestrator, answerTaskQuestion, getExec, getRun, startOrResumeRun } from '../../src/run/orchestrator.js';
import { getChange } from '../../src/planner/session.js';
import { listTasks } from '../../src/store/projections.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { FILES, seedApprovedPlan, sh } from './fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const APPROVE_REVIEW = { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'correcto' } };

function agents(overrides: (taskId: string, attempt: number) => object | null = () => null): Simulation {
  return ({ role, taskId, attempt }) => {
    if (role === 'revisor') return APPROVE_REVIEW;
    const o = overrides(taskId, attempt);
    if (o) return o;
    return { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };
  };
}

describe('orquestador de punta a punta (agentes simulados)', () => {
  it('ejecuta en paralelo, verifica, reintenta un fallo de calidad, integra y entrega sin tocar main', async () => {
    const t = testEngine(
      agents((taskId, attempt) =>
        taskId === 'T-005' && attempt === 1
          ? { pasos: [{ escribir: { ruta: 'src/uc-002.mjs', contenido: 'export function saldo() { return 999; }\n' } }], resultado: 'Listo.' }
          : null,
      ),
    );
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const mainBefore = sh(repo, 'rev-parse', 'main');
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    expect(getChange(t.engine, changeId).phase).toBe('ejecutar');
    const log: string[] = [];
    const summary = await new Orchestrator(t.engine, repo, runId, { parallel: 3, sandbox: HAS_BWRAP, pollMs: 100, onLog: (l) => log.push(l) }).loop();

    expect(summary.state, log.join('\n')).toBe('completado');
    expect(summary.counts).toEqual({ integrada: 5 });
    expect(getExec(t.engine, runId, 'T-005')).toMatchObject({ quality_failures: 1, attempt: 2 });
    expect(log.some((l) => l.startsWith('↻ T-005'))).toBe(true);
    // The two test tasks ran in parallel after the contract was integrated.
    expect(sh(repo, 'rev-parse', 'main')).toBe(mainBefore);
    const delivered = summary.deliveryBranch!;
    expect(sh(repo, 'show', `${delivered}:src/uc-002.mjs`)).toContain('reduce');
    expect(sh(repo, 'log', '--oneline', delivered).split('\n').length).toBeGreaterThan(5);
    expect(getChange(t.engine, changeId).phase).toBe('entregado');
    expect(readFileSync(join(repo, '.forja/cambios', changeId, 'informe.md'), 'utf8')).toContain('| T-005 Consultar saldo | integrada | 2 |');
    const usage = t.engine.store.db.prepare('SELECT COUNT(*) n FROM usage WHERE run_id = ?').get(runId) as { n: number };
    expect(usage.n).toBeGreaterThanOrEqual(8);
  }, 120_000);

  it('rechaza cambios fuera de lo permitido y no deja tocar las pruebas protegidas', async () => {
    const t = testEngine(
      agents((taskId, attempt) =>
        taskId === 'T-003' && attempt === 1
          ? {
              pasos: [
                { escribir: { ruta: 'src/uc-001.mjs', contenido: 'export function registrarFiado() { return 10; }\n' } },
                { escribir: { ruta: 'test/uc-001.test.mjs', contenido: "import { test } from 'node:test';\ntest('trampa', () => {});\n" } },
              ],
            }
          : null,
      ),
    );
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const summary = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 100 }).loop();
    expect(summary.state).toBe('completado');
    const exec = getExec(t.engine, runId, 'T-003');
    expect(exec.quality_failures).toBe(1);
    expect(sh(repo, 'show', `${summary.deliveryBranch}:test/uc-001.test.mjs`)).toContain('CA-UC-001-01');
  }, 120_000);

  it('una pregunta del agente detiene sólo esa tarea; con la respuesta se completa', async () => {
    let asked = false;
    const t = testEngine(
      agents((taskId) => {
        if (taskId === 'T-005' && !asked) {
          asked = true;
          return { pasos: [], resultado: 'NECESITA_ACLARACION: ¿El saldo puede ser negativo? Opciones: sí / no' };
        }
        return null;
      }),
    );
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const first = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 100 }).loop();
    expect(first.state).toBe('bloqueado');
    expect(first.counts).toEqual({ integrada: 4, esperando_respuesta: 1 });
    expect(getExec(t.engine, runId, 'T-005').question).toMatch(/saldo puede ser negativo/);
    answerTaskQuestion(t.engine, runId, 'T-005', 'No, nunca negativo.');
    await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const second = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 100 }).loop();
    expect(second.state).toBe('completado');
    expect(getExec(t.engine, runId, 'T-005').quality_failures).toBe(0);
  }, 120_000);

  it('detenerse a mitad y retomar: nada se pierde ni se repite desde cero', async () => {
    const t = testEngine(
      agents((taskId) => ({ pasos: [{ esperar_ms: 600 }, ...Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } }))], resultado: 'Listo.' })),
    );
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const stop = new AbortController();
    const first = new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 100, onLog: (l) => l.startsWith('⇪ T-001') && stop.abort() , signal: stop.signal }).loop();
    const r1 = await first;
    expect(r1.state).toBe('pausado');
    expect(getRun(t.engine, runId)!.state).toBe('pausado');
    const { resumed } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    expect(resumed).toBe(true);
    const r2 = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 100 }).loop();
    expect(r2.state).toBe('completado');
    const failures = listTasks(t.engine.store.db, runId).map((x) => getExec(t.engine, runId, x.task_id).quality_failures);
    expect(failures.every((f) => f === 0)).toBe(true);
    expect(existsSync(join(repo, '.forja/cambios', changeId, 'informe.md'))).toBe(true);
  }, 120_000);
});
