import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { MOVES, moveChange } from '../../src/planner/phases.js';
import { findChange, selectChange, selectedChange } from '../../src/planner/selection.js';
import { approveDiscovery, createChange, getChange, getDiscovery, plannerScratch, runPlannerTurn } from '../../src/planner/session.js';
import { editUseCase, removeUseCase } from '../../src/spec/edit.js';
import { generateSpec, latestSpec, requestSpecChange } from '../../src/spec/generate.js';
import type { SpecBody } from '../../src/spec/spec.js';
import { testEngine } from '../helpers/engine.js';
import { sampleSpec } from './fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

/** The sample spec with four use cases: two parts of cases (3 + 1). */
function fourCases(): SpecBody {
  const { schema_version: _v, project_id: _p, change_id: _c, revision: _r, ...body } = sampleSpec();
  const copies = ['UC-003', 'UC-004'].map((id) => ({ ...body.casos_uso[1]!, id, nombre: `Consultar ${id}` }));
  const criteria = ['UC-003', 'UC-004'].map((id) => ({ ...body.criterios[1]!, id: `CA-${id}-01`, caso_uso_id: id }));
  return { ...body, casos_uso: [...body.casos_uso, ...copies], criterios: [...body.criterios, ...criteria] };
}

const CLOSING_TURN = {
  mensaje_usuario: 'listo',
  observaciones: [],
  propuestas: [],
  preguntas: [],
  preguntas_resueltas: [],
  propuestas_respondidas: [],
  decisiones_propuestas: [],
  cobertura: [],
  contradicciones: [],
  alcance: { incluye: ['registrar fiados'], excluye: [] },
  resumen_actualizado: 'Fiados',
  siguiente_paso: 'proponer_cierre',
};

type Script = { fail: string | null; status: (id: string) => 'igual' | 'cambia' | 'nuevo'; prompts: string[] };

/**
 * Plays the planner: the conversation turn, the frame and the parts of use cases,
 * answering each part with exactly the cases it asks for. `fail` makes the part that
 * contains that case come back broken; `status` is what the index says of each case.
 */
function planner(spec: SpecBody, calls: string[], script: Script): Simulation {
  return ({ prompt }) => {
    script.prompts.push(prompt);
    if (!prompt.includes('PARTE 1') && !prompt.includes('PARTE 2')) return { pasos: [], estructurado: CLOSING_TURN };
    if (prompt.includes('PARTE 1')) {
      calls.push('base');
      const { casos_uso, criterios: _c, ...rest } = spec;
      return {
        pasos: [],
        estructurado: {
          ...rest,
          indice_casos: casos_uso.map((u) => ({ id: u.id, nombre: u.nombre, actor_id: u.actor_id, objetivo: u.objetivo, requisitos: u.requisitos, estado: script.status(u.id) })),
        },
      };
    }
    const asked = /<casos_a_escribir>\n(.*)\n<\/casos_a_escribir>/.exec(prompt)?.[1];
    const ids = (JSON.parse(asked ?? '[]') as { id: string }[]).map((c) => c.id);
    calls.push(ids.join(','));
    if (script.fail && ids.includes(script.fail)) return { pasos: [], estructurado: { casos_uso: 'roto' } };
    return {
      pasos: [],
      estructurado: { casos_uso: spec.casos_uso.filter((u) => ids.includes(u.id)), criterios: spec.criterios.filter((c) => ids.includes(c.caso_uso_id)) },
    };
  };
}

async function sprint(script: Partial<Script> = {}) {
  const spec = fourCases();
  const calls: string[] = [];
  const s: Script = { fail: null, status: () => 'nuevo', prompts: [], ...script };
  const t = testEngine(planner(spec, calls, s));
  cleanup = t.cleanup;
  const changeId = createChange(t.engine, 'r1', 'Fiados', 'idea');
  const ws = plannerScratch(t.engine);
  await runPlannerTurn(t.engine, { changeId, userText: 'fiados', workspace: ws });
  approveDiscovery(t.engine, changeId, 'ap');
  const repo = join(t.dir, 'repo');
  mkdirSync(repo);
  return { t, s, calls, changeId, ws, input: { changeId, workspace: ws, repoPath: repo, projectId: t.engine.config.project_id } };
}

describe('especificar por partes', () => {
  it('escribe la base y luego los casos de a pocos, y al fallar retoma donde quedó', async () => {
    const { t, s, calls, input } = await sprint({ fail: 'UC-004' });
    await expect(generateSpec(t.engine, input)).rejects.toThrow(/casos UC-004.*avance quedó guardado \(3 de 4 casos\)/s);
    expect(calls).toEqual(['base', 'UC-001,UC-002,UC-003', 'UC-004', 'UC-004', 'UC-004']);

    // The next run does not repeat the frame nor the cases already written.
    calls.length = 0;
    s.fail = null;
    const result = await generateSpec(t.engine, input);
    expect(calls).toEqual(['UC-004']);
    expect(result.spec.casos_uso.map((u) => u.id)).toEqual(['UC-001', 'UC-002', 'UC-003', 'UC-004']);
    expect(result.issues.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

describe('volver atrás y cambiar sólo lo necesario (flujo/PLAN.md)', () => {
  it('reabre la conversación sin perder nada y al volver a especificar sólo reescribe el caso que cambia', async () => {
    const { t, s, calls, changeId, ws, input } = await sprint();
    await generateSpec(t.engine, input);
    expect(getChange(t.engine, changeId).phase).toBe('dividir');

    const moved = moveChange(t.engine, changeId, 'descubrir', 'cambiar lo inicial');
    expect(moved.registro).toMatchObject({ spec_revision: 1, plan_revision: null });
    expect(getChange(t.engine, changeId).phase).toBe('descubrir');
    expect(getDiscovery(t.engine, changeId).approvedRevision).toBeNull();
    // The planner knows it was reopened, and the old spec is still there.
    await runPlannerTurn(t.engine, { changeId, userText: 'el saldo también en dólares', workspace: ws });
    expect(s.prompts.at(-1)).toMatch(/reabrió esta conversación/);
    expect(latestSpec(t.engine, changeId)?.revision).toBe(1);
    approveDiscovery(t.engine, changeId, 'ap2');

    // Only UC-002 changes: the other three are copied without calling the model.
    requestSpecChange(t.engine, changeId, 'UC-002: mostrar el saldo también en dólares');
    s.status = (id) => (id === 'UC-002' ? 'cambia' : 'igual');
    calls.length = 0;
    const second = await generateSpec(t.engine, input);
    expect(calls).toEqual(['base', 'UC-002']);
    expect(second.revision).toBe(2);
    expect(second.spec.casos_uso.map((u) => u.id)).toEqual(['UC-001', 'UC-002', 'UC-003', 'UC-004']);
    expect(s.prompts.find((x) => x.includes('PARTE 1') && x.includes('CAMBIO-001'))).toBeDefined();

    // A change already applied is not sent again.
    s.prompts.length = 0;
    await generateSpec(t.engine, input);
    expect(s.prompts.find((x) => x.includes('PARTE 1'))).not.toMatch(/CAMBIO-001/);
  });

  it('cancela y reactiva sin borrar nada, un entregado no se reabre y el registro se reproduce igual', async () => {
    const { t, changeId } = await sprint();
    expect(() => moveChange(t.engine, changeId, 'dividir', '')).toThrow(/no se puede pasar/);
    moveChange(t.engine, changeId, 'cancelado', 'otra prioridad');
    expect(getChange(t.engine, changeId).phase).toBe('cancelado');
    moveChange(t.engine, changeId, 'descubrir', '');
    expect(getChange(t.engine, changeId).phase).toBe('descubrir');
    t.engine.store.rebuildProjections();
    expect(getChange(t.engine, changeId).phase).toBe('descubrir');
    expect(getDiscovery(t.engine, changeId).approvedRevision).toBeNull();
    const moves = t.engine.store.db.prepare("SELECT payload FROM events WHERE type = 'cambio.movido' ORDER BY seq").all() as { payload: string }[];
    expect(moves.map((m) => (JSON.parse(m.payload) as { motivo: string }).motivo)).toEqual(['otra prioridad', 'volver a la conversación']);
    expect(MOVES.entregado).toEqual([]);
  });
});

describe('varios sprints a la vez', () => {
  it('el nuevo queda seleccionado; se elige otro por número o id y un comando puede fijar uno', async () => {
    const { t, changeId } = await sprint();
    expect(selectedChange(t.engine)?.change_id).toBe(changeId);
    const other = createChange(t.engine, 'r2', 'Cotizaciones', 'idea');
    expect(selectedChange(t.engine)?.change_id).toBe(other);
    // Both stay alive: the first one keeps its phase.
    expect(getChange(t.engine, changeId).phase).toBe('especificar');
    selectChange(t.engine, findChange(t.engine, '2').change_id);
    expect(selectedChange(t.engine)?.change_id).toBe(changeId);
    expect(findChange(t.engine, other.slice(-6)).change_id).toBe(other);
    expect(() => findChange(t.engine, 'zzz')).toThrow(/no existe el sprint/);
    process.env.FORJA_CAMBIO = other;
    try {
      expect(selectedChange(t.engine)?.change_id).toBe(other);
    } finally {
      delete process.env.FORJA_CAMBIO;
    }
  });
});

describe('editar un caso a mano', () => {
  it('guarda una revisión validada, rechaza un caso roto y quita un caso con sus criterios', async () => {
    const { t, changeId, input } = await sprint();
    await generateSpec(t.engine, input);
    const target = { changeId, repoPath: input.repoPath, projectId: input.projectId };
    const spec = latestSpec(t.engine, changeId)!.spec;
    const uc = spec.casos_uso.find((u) => u.id === 'UC-003')!;
    const criterios = spec.criterios.filter((c) => c.caso_uso_id === 'UC-003');

    expect(() => editUseCase(t.engine, target, { caso: { ...uc, actor_id: 'A-999' }, criterios })).toThrow(/actor A-999 no existe/);
    expect(latestSpec(t.engine, changeId)?.revision).toBe(1);

    const saved = editUseCase(t.engine, target, { caso: { ...uc, nombre: 'Consultar saldo por WhatsApp' }, criterios });
    expect(saved.revision).toBe(2);
    expect(latestSpec(t.engine, changeId)?.spec.casos_uso.find((u) => u.id === 'UC-003')?.nombre).toBe('Consultar saldo por WhatsApp');
    expect(getChange(t.engine, changeId).phase).toBe('dividir');

    removeUseCase(t.engine, target, 'UC-004');
    const after = latestSpec(t.engine, changeId)!.spec;
    expect(after.casos_uso.map((u) => u.id)).toEqual(['UC-001', 'UC-002', 'UC-003']);
    expect(after.criterios.some((c) => c.caso_uso_id === 'UC-004')).toBe(false);
  });
});
