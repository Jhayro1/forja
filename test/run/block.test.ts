import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { resolveBlock, storyOfTasks } from '../../src/run/block.js';
import { getExec, getRun, Orchestrator, startOrResumeRun } from '../../src/run/orchestrator.js';
import { selectLaunches } from '../../src/run/pipeline/scheduler.js';
import { listTasks, type TaskRow } from '../../src/store/projections.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { sampleSpec } from '../spec/fixture.js';
import { FILES, seedApprovedPlan, sh, TASKS } from './fixture.js';

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

const row = (task_id: string, state: TaskRow['state'], depends_on: string[] = []): TaskRow => ({
  run_id: 'r',
  task_id,
  title: task_id,
  state,
  depends_on,
  last_reason: null,
  revision: 1,
  updated_seq: 1,
});

describe('bloque para un solo agente', () => {
  it('agrega las dependencias que faltan y respeta el orden del plan', () => {
    const plan = { tareas: TASKS } as never;
    const tasks = [row('T-001', 'integrada'), row('T-002', 'lista'), row('T-003', 'pendiente'), row('T-004', 'lista'), row('T-005', 'pendiente')];
    expect(resolveBlock({ plan, spec: null, tasks, ids: ['t-003'] })).toEqual({ tasks: ['T-002', 'T-003'], added: ['T-002'] });
    expect(() => resolveBlock({ plan, spec: null, tasks, ids: ['T-001'] })).toThrow(/ya están terminadas/);
    expect(() => resolveBlock({ plan, spec: null, tasks, ids: ['T-099'] })).toThrow(/no existe/);
  });

  it('un bloque puede ser un caso de uso entero', () => {
    const spec = sampleSpec();
    const stories = storyOfTasks({ tareas: TASKS } as never, spec);
    expect(stories.get('T-001')).toBe('base');
    const uc = stories.get('T-003')!;
    const tasks = TASKS.map((t) => row(t.id, 'lista'));
    const r = resolveBlock({ plan: { tareas: TASKS } as never, spec, tasks, story: uc });
    expect(r.tasks).toContain('T-003');
    expect(r.tasks).toContain('T-001');
  });

  it('en modo secuencial nada nuevo arranca mientras otra tarea sigue en camino, ni si una del bloque espera al usuario', () => {
    const plan = { tareas: TASKS, recursos_implicitos: {} } as never;
    const base = [row('T-001', 'integrada'), row('T-002', 'lista'), row('T-004', 'lista')];
    expect(selectLaunches({ plan, tasks: base, parallel: 3, only: ['T-002', 'T-004'], sequential: true })).toHaveLength(1);
    expect(selectLaunches({ plan, tasks: [...base, row('T-003', 'verificando')], parallel: 3, only: ['T-002', 'T-004'], sequential: true })).toEqual([]);
    expect(selectLaunches({ plan, tasks: [...base.slice(0, 2), row('T-004', 'bloqueada')], parallel: 3, only: ['T-002', 'T-004'], sequential: true })).toEqual([]);
    // Without sequential, the same tasks run in parallel.
    expect(selectLaunches({ plan, tasks: base, parallel: 3, only: ['T-002', 'T-004'] })).toHaveLength(2);
  });

  it('un agente hace el bloque en orden, en la misma carpeta y la misma sesión, y deja el resto del plan', async () => {
    const t = testEngine(agents());
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const mainBefore = sh(repo, 'rev-parse', 'main');
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const block = resolveBlock({ plan: { tareas: TASKS } as never, spec: null, tasks: listTasks(t.engine.store.db, runId), ids: ['T-003'] });
    expect(block.tasks).toEqual(['T-001', 'T-002', 'T-003']);
    const log: string[] = [];
    const summary = await new Orchestrator(t.engine, repo, runId, { block: { tasks: block.tasks }, sandbox: HAS_BWRAP, pollMs: 100, onLog: (l) => log.push(l) }).loop();

    expect(summary.state, log.join('\n')).toBe('pausado');
    expect(getRun(t.engine, runId)!.detail).toContain('bloque terminado');
    const states = Object.fromEntries(listTasks(t.engine.store.db, runId).map((x) => [x.task_id, x.state]));
    expect(states).toMatchObject({ 'T-001': 'integrada', 'T-002': 'integrada', 'T-003': 'integrada' });
    expect(states['T-004']).not.toBe('integrada');
    // One at a time, in plan order.
    const starts = log.filter((l) => l.startsWith('▶ T-')).map((l) => l.slice(2, 7));
    expect(starts).toEqual(['T-001', 'T-002', 'T-003']);
    // Same folder and the same session all along.
    const execs = ['T-001', 'T-002', 'T-003'].map((id) => getExec(t.engine, runId, id));
    expect(new Set(execs.map((e) => e.worktree)).size).toBe(1);
    expect(execs[0]!.worktree).toContain('_agente');
    expect(execs[0]!.session_id).toBeTruthy();
    expect(new Set(execs.map((e) => e.session_id)).size).toBe(1);
    expect(log.filter((l) => l.startsWith('↪ ')).length).toBe(2);
    expect(sh(repo, 'rev-parse', 'main')).toBe(mainBefore);
  }, 300_000);

  it('con la sesión llena, la siguiente tarea empieza una nueva', async () => {
    const t = testEngine(agents());
    cleanup = t.cleanup;
    t.engine.config.ejecucion.sesion_max_tokens = 10_000;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const log: string[] = [];
    const summary = await new Orchestrator(t.engine, repo, runId, { block: { tasks: ['T-001', 'T-004'] }, sandbox: HAS_BWRAP, pollMs: 100, onLog: (l) => log.push(l) }).loop();
    expect(summary.state, log.join('\n')).toBe('pausado');
    const a = getExec(t.engine, runId, 'T-001');
    const b = getExec(t.engine, runId, 'T-004');
    if ((a.context_tokens ?? 0) >= 10_000) {
      expect(b.session_id).not.toBe(a.session_id);
      expect(log.some((l) => l.includes('empieza una nueva'))).toBe(true);
    } else {
      // The simulator reported no usage: the session simply continues.
      expect(b.session_id).toBe(a.session_id);
    }
  }, 300_000);

  it('se detiene en la primera tarea que necesita al usuario y no sigue con las demás', async () => {
    const t = testEngine(agents((taskId) => (taskId === 'T-002' ? { pasos: [], resultado: 'No pude.' } : null)));
    cleanup = t.cleanup;
    t.engine.config.ejecucion.intentos_calidad = 1;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const log: string[] = [];
    const summary = await new Orchestrator(t.engine, repo, runId, { block: { tasks: ['T-001', 'T-002', 'T-003', 'T-004'] }, sandbox: HAS_BWRAP, pollMs: 100, onLog: (l) => log.push(l) }).loop();
    expect(summary.state, log.join('\n')).toBe('bloqueado');
    expect(getRun(t.engine, runId)!.detail).toContain('T-002');
    const states = Object.fromEntries(listTasks(t.engine.store.db, runId).map((x) => [x.task_id, x.state]));
    expect(states['T-002']).toBe('bloqueada');
    // T-004 was ready too, but one agent does not work ahead of an unsolved problem.
    expect(log.some((l) => l.startsWith('▶ T-004'))).toBe(false);
  }, 300_000);
});
