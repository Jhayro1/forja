import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/core/engine.js';
import { newId } from '../../src/domain/ids.js';
import { createChange, plannerScratch, runPlannerTurn } from '../../src/planner/session.js';
import { ForjaConfig } from '../../src/registry/config.js';
import { EventStore } from '../../src/store/event-store.js';
import { RUNNER, ensureBuilt } from '../helpers/engine.js';

/**
 * Conversational evaluation (V2-026) against the REAL planner. Costs quota: only
 * with FORJA_REAL=1. Checks behavior rules of v2/13, not exact wording.
 */
const REAL = process.env.FORJA_REAL === '1';

let dir: string;
let engine: Engine;
beforeAll(() => {
  if (!REAL) return;
  ensureBuilt();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-eval-')));
  const store = EventStore.open(join(dir, 'estado.db'), 'chk_eval');
  const config = ForjaConfig.parse({ schema_version: 1, project_id: newId('prj'), nombre: 'eval' });
  engine = createEngine({ store, dataDir: dir, config, runnerScript: RUNNER });
});
afterAll(() => {
  if (!REAL) return;
  engine.store.close();
  rmSync(dir, { recursive: true, force: true });
});

const CORPUS = [
  { id: 'pedidos-vago', idea: 'Quiero un sistema de pedidos' },
  { id: 'citas-dentista', idea: 'Una app para que los pacientes de mi consultorio dental reserven citas' },
];

describe.skipIf(!REAL).each(CORPUS)('evaluación del planeador: $id', ({ idea }) => {
  it('primer turno: entiende antes de proponer, pregunta poco y aporta ideas', async () => {
    const changeId = createChange(engine, newId('req'), idea, 'idea');
    const r = await runPlannerTurn(engine, { changeId, userText: null, workspace: plannerScratch(engine) });
    const newQuestions = r.questions;
    // Hasta tres preguntas prioritarias por turno.
    expect(newQuestions.length).toBeGreaterThan(0);
    expect(newQuestions.length).toBeLessThanOrEqual(3);
    // Aporta al menos una sugerencia propia o una recomendación en sus preguntas.
    const suggests = Object.keys(r.state.propuestas).length > 0 || newQuestions.some((q) => q.recomendacion);
    expect(suggests).toBe(true);
    // Nada queda aceptado sin respuesta del usuario.
    expect(Object.values(r.state.decisiones).filter((d) => d.estado === 'aceptada')).toEqual([]);
    // No propone cerrar con una idea vaga.
    expect(r.state.siguiente_paso).not.toBe('proponer_cierre');
    expect(r.message.length).toBeGreaterThan(80);
  }, 300_000);
});
