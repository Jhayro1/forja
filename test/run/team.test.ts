import { describe, expect, it } from 'vitest';
import type { Plan } from '../../src/plan/plan.js';
import { selectLaunches } from '../../src/run/pipeline/scheduler.js';
import type { ExecRow } from '../../src/run/records.js';
import { buildTeamLedger, declaredNames, extractSummary } from '../../src/run/team.js';
import type { TaskRow } from '../../src/store/projections.js';

const row = (task_id: string, state: TaskRow['state'], updated_seq = 1): TaskRow => ({
  run_id: 'r',
  task_id,
  title: `Tarea ${task_id}`,
  state,
  depends_on: [],
  last_reason: null,
  revision: 1,
  updated_seq,
});
const def = (id: string, extra: Partial<Plan['tareas'][number]> = {}) =>
  ({ id, titulo: `Tarea ${id}`, objetivo: `objetivo ${id}`, escribe: [`src/${id}.ts`], lee: [], depende_de: [], criterios: [], requisitos: [], ...extra }) as unknown as Plan['tareas'][number];

const exec = (task_id: string, extra: Partial<ExecRow> = {}): ExecRow => ({ task_id, run_id: 'r', files: null, summary: null, base_sha: null, candidate_sha: null, ...extra }) as ExecRow;

describe('bitácora del equipo', () => {
  it('lista lo que hacen las otras tareas, lo que terminaron y quién depende de la tarea', async () => {
    const plan = { tareas: [def('A'), def('B'), def('C', { depende_de: ['A'] }), def('D')], recursos_implicitos: {} } as unknown as Plan;
    const tasks = [row('A', 'lista'), row('B', 'ejecutando'), row('C', 'pendiente'), row('D', 'integrada', 5)];
    const ledger = await buildTeamLedger(
      {
        plan,
        tasks,
        exec: (id) => (id === 'D' ? exec('D', { files: JSON.stringify(['src/D.ts']), summary: 'Ya se pueden registrar clientes.' }) : exec(id)),
        exportsOf: async (e) => (e.task_id === 'D' ? ['registrarCliente'] : []),
      },
      'A',
    );
    expect(ledger?.trabajando_ahora).toEqual([{ tarea: 'B', titulo: 'Tarea B', objetivo: 'objetivo B', archivos_reservados: ['src/B.ts'] }]);
    expect(ledger?.terminadas).toEqual([{ tarea: 'D', titulo: 'Tarea D', archivos: ['src/D.ts'], exporta: ['registrarCliente'], resumen: 'Ya se pueden registrar clientes.' }]);
    expect(ledger?.dependen_de_ti).toEqual([{ tarea: 'C', titulo: 'Tarea C' }]);
  });

  it('sin otras tareas no añade nada al contexto', async () => {
    const plan = { tareas: [def('A')], recursos_implicitos: {} } as unknown as Plan;
    expect(await buildTeamLedger({ plan, tasks: [row('A', 'lista')], exec: (id) => exec(id), exportsOf: async () => [] }, 'A')).toBeNull();
  });

  it('saca los nombres públicos que declara un diff', () => {
    const diff = [
      '+++ b/src/a.ts',
      '+export function registrarCliente() {}',
      '+export const LIMITE = 3;',
      '+export default class Repo {}',
      '+  const interno = 1;',
      '+def calcular_total(x):',
      '+func Publica() {}',
      '+pub fn listar() {}',
      '-export function borrada() {}',
    ].join('\n');
    expect(declaredNames(diff)).toEqual(['registrarCliente', 'LIMITE', 'Repo', 'calcular_total', 'Publica', 'listar']);
  });

  it('toma el resumen de la línea RESUMEN o del último párrafo', () => {
    expect(extractSummary('Cambié a.ts.\n\nRESUMEN: Ahora se pueden buscar clientes por RUC.')).toBe('Ahora se pueden buscar clientes por RUC.');
    expect(extractSummary('Hice cosas.\n\nArchivos: a.ts, b.ts')).toBe('Archivos: a.ts, b.ts');
    expect(extractSummary(null)).toBeNull();
  });
});

describe('orden seguro cuando una tarea lee lo que otra está escribiendo', () => {
  const plan = {
    tareas: [def('W'), def('R', { lee: ['src/W.ts'] }), def('X')],
    recursos_implicitos: {},
  } as unknown as Plan;

  it('prefiere otra tarea lista y no deja a la lectora sin lanzar', () => {
    const tasks = [row('W', 'ejecutando'), row('R', 'lista'), row('X', 'lista')];
    expect(selectLaunches({ plan, tasks, parallel: 2 })).toEqual(['X']);
    expect(selectLaunches({ plan, tasks, parallel: 3 })).toEqual(['X', 'R']);
    expect(selectLaunches({ plan, tasks: [row('W', 'ejecutando'), row('R', 'lista')], parallel: 3 })).toEqual(['R']);
  });
});
