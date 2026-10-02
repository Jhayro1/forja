import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { approveDiscovery, createChange, plannerScratch, runPlannerTurn } from '../../src/planner/session.js';
import { generateSpec } from '../../src/spec/generate.js';
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

/**
 * Plays the planner: the conversation turn, the frame and the parts of use cases,
 * answering each part with exactly the cases it asks for. `failCases` makes the
 * part that contains that case come back empty.
 */
function planner(spec: SpecBody, calls: string[], failCases: { id: string | null }): Simulation {
  return ({ prompt }) => {
    if (!prompt.includes('PARTE 1') && !prompt.includes('PARTE 2')) return { pasos: [], estructurado: CLOSING_TURN };
    if (prompt.includes('PARTE 1')) {
      calls.push('base');
      const { casos_uso, criterios: _c, ...rest } = spec;
      return {
        pasos: [],
        estructurado: { ...rest, indice_casos: casos_uso.map((u) => ({ id: u.id, nombre: u.nombre, actor_id: u.actor_id, objetivo: u.objetivo, requisitos: u.requisitos })) },
      };
    }
    const asked = /<casos_a_escribir>\n(.*)\n<\/casos_a_escribir>/.exec(prompt)?.[1];
    const ids = (JSON.parse(asked ?? '[]') as { id: string }[]).map((c) => c.id);
    calls.push(ids.join(','));
    if (failCases.id && ids.includes(failCases.id)) return { pasos: [], estructurado: { casos_uso: 'roto' } };
    return {
      pasos: [],
      estructurado: { casos_uso: spec.casos_uso.filter((u) => ids.includes(u.id)), criterios: spec.criterios.filter((c) => ids.includes(c.caso_uso_id)) },
    };
  };
}

describe('especificar por partes', () => {
  it('escribe la base y luego los casos de a pocos, y al fallar retoma donde quedó', async () => {
    const spec = fourCases();
    const calls: string[] = [];
    const fail = { id: 'UC-004' as string | null };
    const t = testEngine(planner(spec, calls, fail));
    cleanup = t.cleanup;
    const changeId = createChange(t.engine, 'r1', 'Fiados', 'idea');
    const ws = plannerScratch(t.engine);
    await runPlannerTurn(t.engine, { changeId, userText: 'fiados', workspace: ws });
    approveDiscovery(t.engine, changeId, 'ap');
    const repo = join(t.dir, 'repo');
    mkdirSync(repo);
    const input = { changeId, workspace: ws, repoPath: repo, projectId: t.engine.config.project_id };

    await expect(generateSpec(t.engine, input)).rejects.toThrow(/casos UC-004.*avance quedó guardado \(3 de 4 casos\)/s);
    expect(calls).toEqual(['base', 'UC-001,UC-002,UC-003', 'UC-004', 'UC-004', 'UC-004']);

    // The next run does not repeat the frame nor the cases already written.
    calls.length = 0;
    fail.id = null;
    const result = await generateSpec(t.engine, input);
    expect(calls).toEqual(['UC-004']);
    expect(result.spec.casos_uso.map((u) => u.id)).toEqual(['UC-001', 'UC-002', 'UC-003', 'UC-004']);
    expect(result.issues.filter((x) => x.severity === 'error')).toEqual([]);
  });
});
