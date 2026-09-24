import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activePauses, pauseProvider, pickCandidate, resumeProvider, type Simulation } from '../../src/core/engine.js';
import type { Plan } from '../../src/plan/plan.js';
import { Orchestrator, getExec, getRun, reassignTask, requestPause, resumeTask, startOrResumeRun } from '../../src/run/orchestrator.js';
import { dependentCounts, levelFor, nextToIntegrate, selectLaunches } from '../../src/run/pipeline/scheduler.js';
import { applyTaskControls } from '../../src/run/task-control.js';
import { getTask, listTasks, type TaskRow } from '../../src/store/projections.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { FILES, TASKS, seedApprovedPlan, seedApprovedPlanIn, sh } from './fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const APPROVE_REVIEW = { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'correcto' } };

function agents(overrides: (taskId: string, attempt: number) => object | null = () => null): Simulation {
  return ({ role, taskId, attempt }) => {
    if (role === 'revisor') return APPROVE_REVIEW;
    return overrides(taskId, attempt) ?? { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };
  };
}

const row = (task_id: string, state: TaskRow['state']): TaskRow => ({ run_id: 'r', task_id, title: task_id, state, depends_on: [], last_reason: null, revision: 1, updated_seq: 1 });
const PLAN = { tareas: TASKS, recursos_implicitos: {} } as unknown as Plan;

describe('política de lanzamiento (función pura)', () => {
  it('respeta los huecos, prioriza el camino crítico y no lanza dos tareas sobre el mismo archivo', () => {
    const tasks = [row('T-001', 'integrada'), row('T-002', 'lista'), row('T-004', 'lista'), row('T-003', 'pendiente'), row('T-005', 'pendiente')];
    expect(selectLaunches({ plan: PLAN, tasks, parallel: 1 })).toEqual(['T-002']);
    expect(selectLaunches({ plan: PLAN, tasks, parallel: 3 })).toEqual(['T-002', 'T-004']);
    expect(selectLaunches({ plan: PLAN, tasks: [...tasks.slice(0, 1), row('T-002', 'ejecutando'), ...tasks.slice(2)], parallel: 1 })).toEqual([]);
    const sameFile = { tareas: [{ ...TASKS[0]!, id: 'A', depende_de: [] }, { ...TASKS[0]!, id: 'B', depende_de: [] }], recursos_implicitos: { 'archivo:x.ts': ['A', 'B'] } } as unknown as Plan;
    expect(selectLaunches({ plan: sameFile, tasks: [row('A', 'lista'), row('B', 'lista')], parallel: 4 })).toEqual(['A']);
    expect(selectLaunches({ plan: sameFile, tasks: [row('A', 'verificada'), row('B', 'lista')], parallel: 4 })).toEqual([]);
  });

  it('--solo sólo lanza esa tarea', () => {
    const tasks = [row('T-001', 'integrada'), row('T-002', 'lista'), row('T-004', 'lista')];
    expect(selectLaunches({ plan: PLAN, tasks, parallel: 3, only: 'T-004' })).toEqual(['T-004']);
  });

  it('cuenta dependientes transitivos una sola vez y escala de nivel tras dos fallos', () => {
    const counts = dependentCounts(PLAN);
    expect(counts.get('T-001')).toBe(4);
    expect(counts.get('T-002')).toBe(1);
    expect(counts.get('T-005')).toBe(0);
    expect(levelFor(TASKS[2]!, 0)).toBe('trabajador');
    expect(levelFor(TASKS[2]!, 2)).toBe('complejo');
    expect(levelFor({ ...TASKS[2]!, complejidad: 'alta' }, 2)).toBe('planeador');
    expect(nextToIntegrate([row('T-003', 'verificada'), row('T-002', 'integrando')])).toBe('T-002');
  });
});

describe('pausas de proveedor persistidas', () => {
  it('se ven desde cualquier proceso, sobreviven a la reconstrucción y se pueden levantar', () => {
    const t = testEngine(agents(), { trabajador: ['simulado:uno', 'simulado:dos'] });
    cleanup = t.cleanup;
    pauseProvider(t.engine, 'simulado:uno', 'cuota agotada', 60_000);
    expect(pickCandidate(t.engine, 'trabajador')?.ref).toBe('simulado:dos');
    t.engine.store.rebuildProjections();
    expect(activePauses(t.engine).map((p) => p.key)).toEqual(['simulado:uno']);
    expect(resumeProvider(t.engine, 'simulado:uno')).toBe(true);
    expect(pickCandidate(t.engine, 'trabajador')?.ref).toBe('simulado:uno');
    expect(resumeProvider(t.engine, 'simulado:uno')).toBe(false);
  });
});

describe('control por tarea y --solo (agentes simulados)', () => {
  it('--solo ejecuta sólo esa tarea y deja el resto como estaba', async () => {
    const t = testEngine(agents());
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const summary = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 50, only: 'T-001' }).loop();
    expect(summary.state).toBe('pausado');
    expect(getRun(t.engine, runId)!.detail).toMatch(/--solo: T-001 integrada/);
    const states = Object.fromEntries(listTasks(t.engine.store.db, runId).map((x) => [x.task_id, x.state]));
    // Unblocked by the integration, but nothing else was launched.
    expect(states).toEqual({ 'T-001': 'integrada', 'T-002': 'lista', 'T-003': 'pendiente', 'T-004': 'lista', 'T-005': 'pendiente' });
    expect(getExec(t.engine, runId, 'T-002').attempt).toBe(0);
    expect(summary.deliveryBranch).toBeNull();
  }, 120_000);

  it('una tarea pausada antes de empezar frena a sus dependientes; al reanudarla el run se completa', async () => {
    const t = testEngine(agents());
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    expect(requestPause(t.engine, runId, 'T-004')).toEqual({ immediate: true });
    expect(getTask(t.engine.store.db, runId, 'T-004')!.state).toBe('pausada');
    const first = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 50 }).loop();
    expect(first.state).toBe('bloqueado');
    expect(getRun(t.engine, runId)!.detail).toMatch(/T-004 \(pausada\)/);
    expect(first.counts).toEqual({ integrada: 3, pausada: 1, pendiente: 1 });
    expect(resumeTask(t.engine, runId, 'T-004')).toBe('lista');
    await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const second = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 50 }).loop();
    expect(second.state).toBe('completado');
  }, 300_000);

  it('pausar una tarea con un agente trabajando lo detiene y conserva el trabajo para el siguiente intento', async () => {
    const t = testEngine(agents((taskId) => (taskId === 'T-001' ? { pasos: [{ esperar_ms: 20_000 }], resultado: 'Listo.' } : null)));
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const orchestrator = new Orchestrator(t.engine, repo, runId, {
      sandbox: HAS_BWRAP,
      pollMs: 50,
      onLog: (l) => {
        if (l.startsWith('▶ T-001')) setTimeout(() => requestPause(t.engine, runId, 'T-001'), 300);
      },
    });
    const started = Date.now();
    const summary = await orchestrator.loop();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(summary.state).toBe('bloqueado');
    expect(getTask(t.engine.store.db, runId, 'T-001')!.state).toBe('pausada');
    const exec = getExec(t.engine, runId, 'T-001');
    expect(exec.control).toBe('pausada:ejecutando');
    expect(exec.feedback).toMatch(/pausó/);
    expect(exec.quality_failures).toBe(0);
    expect(resumeTask(t.engine, runId, 'T-001')).toBe('lista');
    expect(getExec(t.engine, runId, 'T-001').control).toBeNull();
  }, 120_000);

  it('reasignar fija otro modelo permitido desde el siguiente intento y rechaza los que la política no permite', async () => {
    const t = testEngine(agents(), { trabajador: ['simulado:sim'], complejo: ['simulado:grande'] });
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    expect(() => reassignTask(t.engine, runId, 'T-003', 'claude:opus')).toThrow(/no está permitido/);
    reassignTask(t.engine, runId, 'T-003', 'simulado:grande');
    const summary = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 50 }).loop();
    expect(summary.state).toBe('completado');
    expect(getExec(t.engine, runId, 'T-003')).toMatchObject({ model: 'grande', pinned_model: 'simulado:grande' });
    expect(getExec(t.engine, runId, 'T-005').model).toBe('sim');
    expect(() => reassignTask(t.engine, runId, 'T-003', null)).toThrow(/ya terminó/);
  }, 300_000);

  it('una tarea que ya se cumple con el código heredado se integra «sin cambios» con evidencia', async () => {
    const t = testEngine(agents((taskId) => (taskId === 'T-003' ? { pasos: [], resultado: 'El código ya cumple la tarea; no cambié nada.' } : null)));
    cleanup = t.cleanup;
    const repo = join(t.dir, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'src/uc-001.mjs'), FILES['T-003']!['src/uc-001.mjs']!);
    const { changeId } = await seedApprovedPlanIn(t.engine, repo);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const log: string[] = [];
    const summary = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 50, onLog: (l) => log.push(l) }).loop();
    expect(summary.state, log.join('\n')).toBe('completado');
    const exec = getExec(t.engine, runId, 'T-003');
    expect(exec.quality_failures).toBe(0);
    expect(JSON.parse(exec.steps!).map((s: { paso: string }) => s.paso)).toContain('sin_cambios');
    expect(log.some((l) => l.includes('T-003 integrada sin cambios'))).toBe(true);
  }, 300_000);

  it('sin cambios y sin pruebas que lo demuestren sigue siendo un fallo de calidad', async () => {
    const t = testEngine(agents((taskId, attempt) => (taskId === 'T-003' && attempt === 1 ? { pasos: [], resultado: 'Nada que hacer.' } : null)));
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const summary = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 50, review: false }).loop();
    expect(summary.state).toBe('completado');
    // The acceptance test of T-002 fails on the unchanged code, so the empty attempt counts.
    expect(getExec(t.engine, runId, 'T-003')).toMatchObject({ quality_failures: 1, attempt: 2 });
  }, 300_000);

  it('los fallos de entorno se acotan: tras 3 la tarea se bloquea con el motivo', async () => {
    const t = testEngine(agents());
    cleanup = t.cleanup;
    t.engine.adapters.simulado = { id: 'simulado', parser: 'claude', buildOrder: () => { throw new Error('CLI roto'); } } as unknown as typeof t.engine.adapters.simulado;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const summary = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 20 }).loop();
    expect(summary.state).toBe('bloqueado');
    expect(getExec(t.engine, runId, 'T-001')).toMatchObject({ env_failures: 3 });
    expect(getRun(t.engine, runId)!.detail).toMatch(/T-001 \(bloqueada\)/);
    // Nothing to apply for tasks without a pause request.
    expect(applyTaskControls(t.engine, runId, new Set())).toEqual([]);
  }, 60_000);
});
