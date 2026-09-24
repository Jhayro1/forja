import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { approvePlan } from '../../src/plan/approve.js';
import { dividePlan } from '../../src/plan/divide.js';
import { getChange } from '../../src/planner/session.js';
import { Orchestrator, getExec, getRun, startOrResumeRun } from '../../src/run/orchestrator.js';
import { listTasks } from '../../src/store/projections.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { FILES, TASKS, seedApprovedPlan, sh } from './fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const NON_NEGATIVE = 'export function saldo(f, a) { return Math.max(0, f.reduce((x, y) => x + y, 0) - a.reduce((x, y) => x + y, 0)); }\n';
const APPROVE_REVIEW = { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'correcto' } };

describe('cambio de plan a mitad de run (V2-037)', () => {
  it('la nueva revisión vuelve a aprobarse; el run nuevo hereda lo integrado sin cambios y rehace el resto', async () => {
    let asked = false;
    // Revision 2 changes T-005's definition: it must run again even though it was integrated.
    const revised = TASKS.map((t) => (t.id === 'T-005' ? { ...t, objetivo: 'Consultar saldo sin permitir negativos' } : t));
    let planOutput: object | null = null;
    const simulation: Simulation = ({ role, taskId, prompt }) => {
      if (role === 'revisor') return APPROVE_REVIEW;
      if (role === 'planeador') return { pasos: [], estructurado: planOutput };
      if (taskId === 'T-005' && prompt.includes('sin permitir negativos')) {
        return { pasos: [{ escribir: { ruta: 'src/uc-002.mjs', contenido: NON_NEGATIVE } }], resultado: 'Listo.' };
      }
      if (taskId === 'T-003' && !asked) {
        asked = true;
        return { pasos: [], resultado: 'NECESITA_ACLARACION: ¿Se permiten montos con decimales?' };
      }
      return { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };
    };
    const t = testEngine(simulation);
    cleanup = t.cleanup;
    const { repo, changeId, plan } = await seedApprovedPlan(t.engine, t.dir);
    const { runId: oldRun } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const first = await new Orchestrator(t.engine, repo, oldRun, { sandbox: HAS_BWRAP, pollMs: 100 }).loop();
    expect(first.state).toBe('bloqueado');
    expect(getChange(t.engine, changeId).phase).toBe('ejecutar');

    planOutput = { perfil: plan.perfil, tareas: revised, supuestos: [] };
    const result = await dividePlan(t.engine, { changeId, repoPath: repo, workspace: repo, hasCode: true });
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.plan.revision).toBe(2);
    expect(getChange(t.engine, changeId).phase).toBe('aprobar');
    // The old approval does not cover the new plan: running now must be refused.
    await expect(startOrResumeRun(t.engine, { changeId, repoPath: repo })).rejects.toThrow(/aprobación ya no corresponde/);
    approvePlan(t.engine, changeId);

    const next = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    expect(next.resumed).toBe(false);
    expect(next.inherited.sort()).toEqual(['T-001', 'T-002', 'T-004']);
    expect(getRun(t.engine, oldRun)!.state).toBe('cancelado');
    expect(listTasks(t.engine.store.db, oldRun).find((x) => x.task_id === 'T-003')!.state).toBe('invalidada');

    const second = await new Orchestrator(t.engine, repo, next.runId, { sandbox: HAS_BWRAP, pollMs: 100 }).loop();
    expect(second.state).toBe('completado');
    expect(second.counts).toEqual({ integrada: 5 });
    // Inherited tasks never launched an agent again; the changed and the unfinished ones did.
    for (const id of ['T-001', 'T-002', 'T-004']) expect(getExec(t.engine, next.runId, id).attempt).toBe(0);
    for (const id of ['T-003', 'T-005']) expect(getExec(t.engine, next.runId, id).attempt).toBe(1);
    expect(sh(repo, 'show', `${second.deliveryBranch}:src/uc-001.mjs`)).toContain('saldo + monto');
    expect(sh(repo, 'show', `${second.deliveryBranch}:src/uc-002.mjs`)).toBe(NON_NEGATIVE.trim());
    expect(getChange(t.engine, changeId).phase).toBe('entregado');
  }, 300_000);
});
