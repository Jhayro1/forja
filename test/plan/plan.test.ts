import { describe, expect, it } from 'vitest';
import { approvalTarget } from '../../src/plan/approve.js';
import { draftTasks } from '../../src/plan/draft.js';
import { estimatePlan } from '../../src/plan/estimate.js';
import { findCycle, globsMayOverlap, type Plan, type PlanOutput, type PlanTask, taskResources, validatePlan, waves } from '../../src/plan/plan.js';
import { ForjaConfig } from '../../src/registry/config.js';
import { sampleSpec } from '../spec/fixture.js';

const config = ForjaConfig.parse({ schema_version: 1, project_id: 'prj_01M3A9EACH225PY14R95F392B4', nombre: 'x' });
const perfil = { stack: ['typescript'], gestor: 'npm', comandos: { instalar: null, build: null, typecheck: null, lint: null, test: { executable: 'npx', args: ['vitest', 'run'] } }, red_instalar: [] };

function task(id: string, partial: Partial<PlanTask> = {}): PlanTask {
  return {
    id,
    titulo: id,
    objetivo: 'x',
    tipo: 'implementacion',
    criterios: [],
    requisitos: [],
    depende_de: [],
    escribe: [`src/${id}/**`],
    lee: [],
    recursos_exclusivos: [],
    complejidad: 'media',
    red: false,
    notas: '',
    ...partial,
  };
}

describe('solapamiento de rutas (conservador)', () => {
  it.each([
    ['src/a/**', 'src/b/**', false],
    ['src/**', 'src/a.ts', true],
    ['src/a.ts', 'src/a.ts', true],
    ['src/a.ts', 'src/b.ts', false],
    ['src/**/*.ts', 'src/x/y.ts', true],
    ['test/aceptacion/uc-001.test.ts', 'src/**', false],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(globsMayOverlap(a, b)).toBe(expected);
  });
});

describe('validación del plan', () => {
  const spec = sampleSpec();

  it('un borrador por reglas ya cubre todos los criterios automáticos', () => {
    const tareas = draftTasks(spec, config, false);
    const { issues } = validatePlan({ perfil, tareas, supuestos: [] }, spec);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(tareas[0]).toMatchObject({ tipo: 'infraestructura', red: true });
    expect(tareas.filter((t) => t.tipo === 'pruebas').every((t) => t.depende_de.length === 1)).toBe(true);
  });

  it('detecta ciclos, dependencias inexistentes, criterios sin cubrir y rutas prohibidas', () => {
    const out: PlanOutput = {
      perfil,
      supuestos: [],
      tareas: [task('T-001', { depende_de: ['T-002'], criterios: ['CA-UC-001-01'] }), task('T-002', { depende_de: ['T-001', 'T-009'], escribe: ['../fuera/**'] })],
    };
    const messages = validatePlan(out, spec).issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'depende de T-009, que no existe',
        expect.stringMatching(/^ciclo de dependencias: T-00\d → T-00\d → T-00\d$/),
        'el criterio CA-UC-002-01 no lo cubre ninguna tarea',
        'ruta de escritura no permitida: ../fuera/**',
      ]),
    );
    expect(findCycle(out.tareas)).not.toBeNull();
  });

  it('la implementación no puede escribir las pruebas protegidas', () => {
    const out: PlanOutput = {
      perfil,
      supuestos: [],
      tareas: [
        task('T-001', { tipo: 'pruebas', escribe: ['test/aceptacion/uc-001.test.ts'], criterios: ['CA-UC-001-01', 'CA-UC-002-01'] }),
        task('T-002', { depende_de: ['T-001'], escribe: ['src/**', 'test/**'] }),
      ],
    };
    expect(validatePlan(out, spec).issues.some((i) => i.severity === 'error' && i.message.includes('las pruebas son protegidas'))).toBe(true);
  });

  it('tareas independientes que podrían tocar lo mismo reciben un recurso exclusivo común', () => {
    const out: PlanOutput = {
      perfil,
      supuestos: [],
      tareas: [task('T-001', { criterios: ['CA-UC-001-01', 'CA-UC-002-01'], escribe: ['src/app.ts'] }), task('T-002', { escribe: ['src/**'] }), task('T-003', { escribe: ['docs/**'] })],
    };
    const { implicitResources } = validatePlan(out, spec);
    expect(Object.values(implicitResources)).toEqual([['T-001', 'T-002']]);
    const plan = { recursos_implicitos: implicitResources, tareas: out.tareas } as unknown as Plan;
    expect(taskResources(plan, 'T-002')).toHaveLength(1);
    expect(taskResources(plan, 'T-003')).toEqual([]);
  });

  it('olas por profundidad de dependencias', () => {
    expect(waves([task('T-001'), task('T-002', { depende_de: ['T-001'] }), task('T-003', { depende_de: ['T-001'] }), task('T-004', { depende_de: ['T-002', 'T-003'] })])).toEqual([
      ['T-001'],
      ['T-002', 'T-003'],
      ['T-004'],
    ]);
  });
});

describe('estimación y aprobación', () => {
  const tareas = [task('T-001'), task('T-002', { depende_de: ['T-001'] }), task('T-003', { depende_de: ['T-001'] }), task('T-004', { depende_de: ['T-001'] })];
  const plan: Plan = {
    schema_version: 1,
    plan_id: 'plan_1',
    change_id: 'cam_1',
    revision: 1,
    spec_revision: 1,
    spec_hash: 'sha256:x',
    base_sha: 'abc',
    perfil,
    tareas,
    supuestos: [],
    recursos_implicitos: {},
  };

  it('en paralelo tarda menos que en serie y dice que no está calibrada', () => {
    const e = estimatePlan(plan, config, null);
    expect(e.calibrado).toBe(false);
    expect(e.minutos_en_paralelo).toBeLessThan(e.minutos_en_serie);
    expect(e.costo_equivalente_usd).toBeNull();
    expect(e.por_rol.revisor?.llamadas).toBe(4);
  });

  it('con precios configurados calcula el costo; si falta un modelo lo dice', () => {
    const e = estimatePlan(plan, config, { 'claude:haiku': { entrada: 1, salida: 5 } });
    expect(e.costo_equivalente_usd).toBeGreaterThan(0);
    expect(e.costo_nota).toMatch(/faltan precios de codex:gpt-6-sol/);
  });

  it('cambiar el perfil o el plan cambia lo que se aprobó', () => {
    const a = approvalTarget(config, plan, 'sha256:h1');
    const b = approvalTarget(config, { ...plan, perfil: { ...perfil, gestor: 'pnpm' } }, 'sha256:h1');
    expect(a.profile_hash).not.toBe(b.profile_hash);
  });
});
