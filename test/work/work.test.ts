import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { actionPlanText, ObservationService } from '../../src/quality/observations.js';
import { Orchestrator, startOrResumeRun } from '../../src/run/orchestrator.js';
import { EpicService } from '../../src/work/epics.js';
import { buildHistory, historyMarkdown } from '../../src/work/history.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { FILES, seedApprovedPlan } from '../run/fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

/** Every agent writes its files; the reviewer approves but leaves a low-severity note. */
const agents: Simulation = ({ role, taskId }) => {
  if (role === 'revisor')
    return {
      pasos: [],
      estructurado: {
        criterios: [],
        hallazgos: taskId === 'T-003' ? [{ severidad: 'baja', clase: 'sugerencia', ubicacion: 'src/uc-001.mjs:1', motivo: 'Validar que el monto sea positivo' }] : [],
        veredicto: 'aprobado',
        resumen: 'correcto',
      },
    };
  return { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: `Listo.\n\nRESUMEN: ${taskId} ya funciona.` };
};

describe('observaciones', () => {
  it('se registran una sola vez y sólo cambian de estado por caminos permitidos', () => {
    const t = testEngine(agents);
    cleanup = t.cleanup;
    const s = new ObservationService(t.engine);
    const input = { change_id: 'cam_x', source: 'qa' as const, severity: 'alta' as const, kind: 'defecto' as const, location: 'login', text: 'La contraseña incorrecta da un error 500' };
    const id = s.record(input);
    expect(s.record(input)).toBe(id);
    expect(s.list()).toHaveLength(1);
    expect(() => s.move(id, 'descartada')).toThrow(/motivo/);
    expect(() => s.move(id, 'resuelta')).toThrow(/no puede pasar/);
    s.move(id, 'pospuesta');
    expect(s.move(id, 'descartada', { reason: 'no aplica' })).toMatchObject({ state: 'descartada', reason: 'no aplica' });
    expect(s.move(id, 'abierta').state).toBe('abierta');
    expect(actionPlanText(s.list(), 'hazlo simple')).toContain('1. [alta · defecto · qa] login: La contraseña incorrecta da un error 500');
  });
});

describe.skipIf(!HAS_BWRAP)('historial y observaciones de un run real (agentes simulados)', () => {
  it('guarda lo que dejó el revisor, agrupa por épica, sprint e historia y fecha cada tarea', async () => {
    const t = testEngine(agents);
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const epics = new EpicService(t.engine);
    const epic = epics.create({ title: 'Fiados', goal: 'Registrar y cobrar fiados', target_date: '2000-01-01' });
    epics.assign(changeId, { epic_id: epic.epic_id, priority: 5, target_date: '2000-01-02' });
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const summary = await new Orchestrator(t.engine, repo, runId, { parallel: 3, sandbox: HAS_BWRAP, pollMs: 100 }).loop();
    expect(summary.state).toBe('completado');

    const obs = new ObservationService(t.engine).list();
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ source: 'revisor', task_id: 'T-003', kind: 'sugerencia', severity: 'baja', state: 'abierta', change_id: changeId });

    const h = buildHistory(t.engine, '2030-01-01');
    expect(h.epicas).toHaveLength(1);
    const sprint = h.epicas[0]!.sprints[0]!;
    expect(sprint).toMatchObject({ id: changeId, fase: 'entregado', hechas: 5, total: 5, retrasado: false, fecha_objetivo: '2000-01-02' });
    const tasks = sprint.historias.flatMap((s) => s.tareas);
    expect(tasks).toHaveLength(5);
    expect(tasks.every((x) => x.marca === 'unida' && x.inicio && x.fin)).toBe(true);
    expect(tasks.find((x) => x.id === 'T-003')?.resumen).toBe('T-003 ya funciona.');
    expect(h.calendario.filter((e) => e.tipo === 'tarea_unida')).toHaveLength(5);
    expect(h.calendario.some((e) => e.tipo === 'sprint_entregado')).toBe(true);
    expect(historyMarkdown(h)).toContain('- [x] T-003');
  });
});
