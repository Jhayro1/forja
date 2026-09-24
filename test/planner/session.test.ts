import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import type { PlannerTurnOutput } from '../../src/planner/discovery.js';
import { approveDiscovery, createChange, getChange, getDiscovery, llmSchema, plannerScratch, runPlannerTurn, transcript } from '../../src/planner/session.js';
import { PlannerTurnOutput as Schema } from '../../src/planner/discovery.js';
import { testEngine } from '../helpers/engine.js';

function turn(partial: Partial<PlannerTurnOutput>): PlannerTurnOutput {
  return {
    mensaje_usuario: 'mensaje',
    observaciones: [],
    propuestas: [],
    preguntas: [],
    preguntas_resueltas: [],
    propuestas_respondidas: [],
    decisiones_propuestas: [],
    cobertura: [],
    contradicciones: [],
    alcance: { incluye: [], excluye: [] },
    resumen_actualizado: '',
    siguiente_paso: 'continuar',
    ...partial,
  };
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

/** Scripted planner: returns the next turn of a list on each call. */
function scripted(turns: (PlannerTurnOutput | object)[]): Simulation {
  let i = 0;
  return () => ({ pasos: [], estructurado: turns[Math.min(i++, turns.length - 1)] });
}

describe('esquema del turno', () => {
  it('es compatible con modo estricto: todo requerido y sin claves extra', () => {
    const s = llmSchema(Schema) as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    expect(s.additionalProperties).toBe(false);
    expect(new Set(s.required)).toEqual(new Set(Object.keys(s.properties)));
  });
});

describe('planeador conversacional', () => {
  it('pregunta, registra respuestas del usuario y sólo entonces acepta decisiones', async () => {
    const t = testEngine(
      scripted([
        turn({
          mensaje_usuario: '¿Quién registra los fiados?',
          preguntas: [{ id: 'PRE-1', texto: '¿Quién registra los fiados?', motivo: 'permisos', opciones: ['dueño', 'cualquiera'], recomendacion: 'dueño', bloquea: true }],
          decisiones_propuestas: [{ id: 'DEC-1', contenido: 'Montos en céntimos', motivo: 'evitar redondeo', origen: 'sugerencia' }],
        }),
        turn({
          mensaje_usuario: 'Entendido, sólo el dueño.',
          preguntas: [{ id: 'PRE-1', texto: '¿Quién registra los fiados?', motivo: 'permisos', opciones: [], recomendacion: null, bloquea: true }],
          preguntas_resueltas: ['PRE-1'],
          decisiones_propuestas: [{ id: 'DEC-2', contenido: 'Sólo el dueño registra', motivo: 'respuesta', origen: 'respuesta_usuario' }],
          alcance: { incluye: ['registrar fiados'], excluye: ['facturación'] },
          resumen_actualizado: 'Registro de fiados por el dueño',
          siguiente_paso: 'proponer_cierre',
        }),
      ]),
    );
    cleanup = t.cleanup;
    const changeId = createChange(t.engine, 'c1', 'Fiados por voz', 'idea');
    const ws = plannerScratch(t.engine);

    const first = await runPlannerTurn(t.engine, { changeId, userText: null, workspace: ws });
    expect(first.questions.map((q) => q.id)).toEqual(['PRE-1']);
    expect(first.state.decisiones['DEC-1']?.estado).toBe('propuesta');
    expect(first.blockers.some((b) => b.includes('pregunta sin responder'))).toBe(true);
    expect(() => approveDiscovery(t.engine, changeId, 'ap0')).toThrow(/todavía no se puede aprobar/);

    const second = await runPlannerTurn(t.engine, { changeId, userText: 'Sólo el dueño, nadie más.', workspace: ws });
    expect(second.questions).toEqual([]);
    expect(second.state.decisiones['DEC-2']?.estado).toBe('aceptada');
    expect(second.state.decisiones['DEC-1']?.estado).toBe('propuesta');
    expect(second.blockers).toEqual([]);
    expect(transcript(t.engine, changeId).map((r) => r.user_text)).toEqual([null, 'Sólo el dueño, nadie más.']);

    approveDiscovery(t.engine, changeId, 'ap1');
    expect(getChange(t.engine, changeId).phase).toBe('especificar');
    expect(getDiscovery(t.engine, changeId).approvedRevision).toBe(2);
    await expect(runPlannerTurn(t.engine, { changeId, userText: 'más', workspace: ws })).rejects.toThrow(/ya se aprobó/);
  });

  it('el silencio no resuelve preguntas ni una delegación inventada acepta decisiones', async () => {
    const t = testEngine(
      scripted([
        turn({ preguntas: [{ id: 'PRE-1', texto: '¿Moneda?', motivo: '', opciones: [], recomendacion: 'PEN', bloquea: true }] }),
        turn({
          preguntas_resueltas: ['PRE-1'],
          decisiones_propuestas: [{ id: 'DEC-1', contenido: 'Moneda PEN', motivo: '', origen: 'delegada' }],
        }),
        turn({ decisiones_propuestas: [{ id: 'DEC-1', contenido: 'Moneda PEN', motivo: '', origen: 'delegada' }] }),
      ]),
    );
    cleanup = t.cleanup;
    const changeId = createChange(t.engine, 'c1', 'x', 'idea');
    const ws = plannerScratch(t.engine);
    await runPlannerTurn(t.engine, { changeId, userText: null, workspace: ws });
    const silent = await runPlannerTurn(t.engine, { changeId, userText: null, workspace: ws });
    expect(silent.questions.map((q) => q.id)).toEqual(['PRE-1']);
    expect(silent.state.decisiones['DEC-1']?.estado).toBe('propuesta');
    expect(silent.notes.length).toBe(2);
    const delegated = await runPlannerTurn(t.engine, { changeId, userText: 'decide tú', workspace: ws });
    expect(delegated.state.decisiones['DEC-1']?.estado).toBe('aceptada');
  });

  it('repara una salida que no cumple el esquema', async () => {
    let calls = 0;
    const t = testEngine(() => (++calls === 1 ? { pasos: [], estructurado: { mensaje_usuario: 'incompleto' } } : { pasos: [], estructurado: turn({ mensaje_usuario: 'ok' }) }));
    cleanup = t.cleanup;
    const changeId = createChange(t.engine, 'c1', 'x', 'idea');
    const r = await runPlannerTurn(t.engine, { changeId, userText: null, workspace: plannerScratch(t.engine) });
    expect(r.message).toBe('ok');
    expect(calls).toBe(2);
  });

  it('con cuota agotada pasa al siguiente modelo del mismo rol y lo registra', async () => {
    const t = testEngine(
      ({ attempt }) =>
        attempt === 1 && calls++ === 0
          ? { pasos: [], error: { status: 429, code: 'credits_required', mensaje: 'sin créditos' } }
          : { pasos: [], estructurado: turn({ mensaje_usuario: 'desde el segundo' }) },
      { planeador: ['simulado:caro-a', 'simulado:caro-b'] },
    );
    let calls = 0;
    cleanup = t.cleanup;
    const changeId = createChange(t.engine, 'c1', 'x', 'idea');
    const r = await runPlannerTurn(t.engine, { changeId, userText: null, workspace: plannerScratch(t.engine) });
    expect(r.message).toBe('desde el segundo');
    expect(r.model).toBe('caro-b');
    const usage = t.engine.store.db.prepare('SELECT role, model FROM usage ORDER BY created_at').all();
    expect(usage).toHaveLength(2);
  });

  it('el estado del descubrimiento se reconstruye desde los eventos', async () => {
    const t = testEngine(scripted([turn({ resumen_actualizado: 'r1', alcance: { incluye: ['a'], excluye: [] } })]));
    cleanup = t.cleanup;
    const changeId = createChange(t.engine, 'c1', 'x', 'idea');
    await runPlannerTurn(t.engine, { changeId, userText: null, workspace: plannerScratch(t.engine) });
    const before = getDiscovery(t.engine, changeId);
    t.engine.store.rebuildProjections();
    expect(getDiscovery(t.engine, changeId)).toEqual(before);
  });
});
