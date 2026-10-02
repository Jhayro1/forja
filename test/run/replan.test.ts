import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { hashJson } from '../../src/domain/hash.js';
import { approvePlan, currentApproval } from '../../src/plan/approve.js';
import { dividePlan } from '../../src/plan/divide.js';
import { moveChange } from '../../src/planner/phases.js';
import { getChange } from '../../src/planner/session.js';
import { changedSpecIds, inheritance } from '../../src/run/invalidation.js';
import { getExec, getRun, Orchestrator, startOrResumeRun } from '../../src/run/orchestrator.js';
import { latestSpec, requestSpecChange, specAnswers } from '../../src/spec/generate.js';
import { EV } from '../../src/store/planning-projections.js';
import { listTasks } from '../../src/store/projections.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { sampleSpec } from '../spec/fixture.js';
import { FILES, seedApprovedPlan, sh, TASKS } from './fixture.js';

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

describe('cambio de especificación a mitad de run (MEJORAS 2.4)', () => {
  it('detecta lo que cambió en la spec, incluso por una regla o un requisito', () => {
    const before = sampleSpec();
    const rule = sampleSpec();
    rule.reglas[0]!.texto = 'Un abono puede superar la deuda y queda a favor';
    expect([...changedSpecIds(before, rule)].sort()).toEqual(['CA-UC-001-01', 'R-001', 'UC-001']);
    const crit = sampleSpec();
    crit.criterios[1]!.entonces = 'es 5 soles';
    expect([...changedSpecIds(before, crit)]).toEqual(['CA-UC-002-01']);
    expect(changedSpecIds(before, sampleSpec()).size).toBe(0);
  });

  it('invalida lo que tocó el cambio y, transitivamente, lo que depende de ello', () => {
    const before = sampleSpec();
    const after = sampleSpec();
    after.criterios[0]!.entonces = 'su saldo es 10 soles';
    const plan = { tareas: TASKS } as never;
    const d = inheritance({ oldPlan: plan, newPlan: plan, oldSpec: before, newSpec: after, integrated: new Set(['T-001', 'T-002', 'T-003', 'T-004', 'T-005']) });
    expect(Object.fromEntries([...d].map(([k, v]) => [k, v.inherit ? 'hereda' : v.reason]))).toEqual({
      'T-001': 'hereda',
      'T-002': 'la especificación cambió en CA-UC-001-01',
      'T-003': 'la especificación cambió en CA-UC-001-01',
      'T-004': 'hereda',
      'T-005': 'hereda',
    });
    const chained = TASKS.map((t) => (t.id === 'T-004' ? { ...t, depende_de: ['T-003'] } : t));
    const d2 = inheritance({ oldPlan: { tareas: chained } as never, newPlan: { tareas: chained } as never, oldSpec: before, newSpec: after, integrated: new Set(TASKS.map((t) => t.id)) });
    expect(d2.get('T-004')).toEqual({ inherit: false, reason: 'a revisar: depende de T-003, que se rehace' });
    expect(d2.get('T-005')).toEqual({ inherit: false, reason: 'a revisar: depende de T-004, que se rehace' });
  });

  it('con el run en marcha: nueva spec → nuevo plan → sólo se rehacen las tareas afectadas', async () => {
    let planOutput: object | null = null;
    let asked = false;
    const simulation: Simulation = ({ role, taskId, prompt }) => {
      if (role === 'revisor') return APPROVE_REVIEW;
      if (role === 'planeador') return { pasos: [], estructurado: planOutput };
      if (taskId === 'T-005' && !asked) {
        asked = true;
        return { pasos: [], resultado: 'NECESITA_ACLARACION: ¿El saldo puede ser negativo?' };
      }
      // The redone test task updates its test to the new criterion (a test task cannot be «unchanged»).
      if (taskId === 'T-002' && prompt.includes('10 soles')) {
        return { pasos: [{ escribir: { ruta: 'test/uc-001.test.mjs', contenido: `// saldo en soles\n${FILES['T-002']!['test/uc-001.test.mjs']}` } }], resultado: 'Listo.' };
      }
      return { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };
    };
    const t = testEngine(simulation);
    cleanup = t.cleanup;
    const { repo, changeId, plan } = await seedApprovedPlan(t.engine, t.dir);
    const { runId: oldRun } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    expect((await new Orchestrator(t.engine, repo, oldRun, { sandbox: HAS_BWRAP, pollMs: 50 }).loop()).state).toBe('bloqueado');

    requestSpecChange(t.engine, changeId, 'el saldo se muestra en soles');
    expect(specAnswers(t.engine, changeId).map((a) => a.question_id)).toEqual(['CAMBIO-001']);
    // What generateSpec records for a valid new revision mid-run.
    const spec2 = { ...latestSpec(t.engine, changeId)!.spec, revision: 2 };
    spec2.criterios = spec2.criterios.map((c) => (c.id === 'CA-UC-001-01' ? { ...c, entonces: 'su saldo es 10 soles' } : c));
    t.engine.store.execute({ request_id: 'spec2', type: 'seed', input: null }, () => ({
      result: null,
      events: [
        { type: EV.specRevised, aggregate_type: 'cambio', aggregate_id: changeId, payload: { revision: 2, hash: hashJson(spec2), spec: spec2 as never } },
        { type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: changeId, payload: { from: 'ejecutar', to: 'dividir' } },
      ],
    }));
    planOutput = { perfil: plan.perfil, tareas: TASKS, supuestos: [] };
    await dividePlan(t.engine, { changeId, repoPath: repo, workspace: repo, hasCode: true });
    approvePlan(t.engine, changeId);
    const next = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    expect(next.inherited.sort()).toEqual(['T-001', 'T-004']);
    expect(next.redone).toEqual([
      { task: 'T-002', reason: 'la especificación cambió en CA-UC-001-01' },
      { task: 'T-003', reason: 'la especificación cambió en CA-UC-001-01' },
    ]);
    const log: string[] = [];
    const done = await new Orchestrator(t.engine, repo, next.runId, { sandbox: HAS_BWRAP, pollMs: 50, onLog: (l) => log.push(l) }).loop();
    expect(done.state, `${JSON.stringify(done.counts)}\n${log.join('\n')}`).toBe('completado');
    for (const id of ['T-002', 'T-003', 'T-005']) expect(getExec(t.engine, next.runId, id).attempt).toBe(1);
  }, 300_000);
});

describe('volver atrás a mitad de run (flujo/PLAN.md §3)', () => {
  it('registra lo avanzado, deja el run en pausa y el plan sin aprobar; nada se borra', async () => {
    const simulation: Simulation = ({ role, taskId }) => {
      if (role === 'revisor') return APPROVE_REVIEW;
      return { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };
    };
    const t = testEngine(simulation);
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    expect(getChange(t.engine, changeId).phase).toBe('ejecutar');

    const moved = moveChange(t.engine, changeId, 'especificar', 'cambiar un caso de uso');
    expect(moved.registro).toMatchObject({ plan_aprobado: true, run: { run_id: runId } });
    expect(getChange(t.engine, changeId).phase).toBe('especificar');
    expect(currentApproval(t.engine, changeId)).toBeNull();
    expect(getRun(t.engine, runId)?.state).toBe('pausado');
    // The plan and the run are still there: the next run inherits what was integrated.
    expect(listTasks(t.engine.store.db, runId).length).toBe(TASKS.length);
  });
});
