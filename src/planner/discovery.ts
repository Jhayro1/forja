import { z } from 'zod';

/**
 * Output contract of one planner turn (v2/13 · Estado persistente y salida por turno).
 * Every field is required (nullable when absent) so the same schema works with
 * Claude --json-schema and Codex --output-schema strict mode.
 */
export const PlannerTurnOutput = z
  .object({
    mensaje_usuario: z.string().describe('Lo que verá el usuario: natural, breve, en su idioma'),
    observaciones: z.array(
      z
        .object({
          id: z.string().describe('OBS-n'),
          afirmacion: z.string(),
          clase: z.enum(['aportado', 'observado', 'inferido']),
          fuente: z.string(),
        })
        .strict(),
    ),
    propuestas: z.array(
      z
        .object({
          id: z.string().describe('PRO-n'),
          necesidad: z.string(),
          recomendacion: z.string(),
          alternativas: z.array(z.string()),
          beneficio: z.string(),
          contrapartida: z.string(),
          prioridad: z.enum(['necesaria_para_objetivo', 'recomendada', 'opcional']),
        })
        .strict(),
    ),
    preguntas: z.array(
      z
        .object({
          id: z.string().describe('PRE-n; reutiliza el id si es la misma pregunta'),
          texto: z.string(),
          motivo: z.string(),
          opciones: z.array(z.string()),
          recomendacion: z.string().nullable(),
          bloquea: z.boolean().describe('true si sin respuesta no se puede cerrar el incremento'),
        })
        .strict(),
    ),
    preguntas_resueltas: z.array(z.string()).describe('ids de preguntas que el mensaje del usuario de este turno respondió'),
    propuestas_respondidas: z.array(z.object({ id: z.string(), estado: z.enum(['aceptada', 'rechazada', 'diferida']) }).strict()),
    decisiones_propuestas: z.array(
      z
        .object({
          id: z.string().describe('DEC-n'),
          contenido: z.string(),
          motivo: z.string(),
          origen: z.enum(['respuesta_usuario', 'delegada', 'sugerencia']),
        })
        .strict(),
    ),
    cobertura: z.array(z.object({ tema: z.string(), estado: z.enum(['pendiente', 'parcial', 'resuelto', 'no_aplica']), nota: z.string() }).strict()),
    contradicciones: z.array(z.object({ id: z.string(), descripcion: z.string(), consecuencia: z.string() }).strict()),
    alcance: z.object({ incluye: z.array(z.string()), excluye: z.array(z.string()) }).strict(),
    resumen_actualizado: z.string(),
    siguiente_paso: z.enum(['continuar', 'revisar', 'proponer_cierre']),
  })
  .strict();
export type PlannerTurnOutput = z.infer<typeof PlannerTurnOutput>;

export type Question = PlannerTurnOutput['preguntas'][number] & { estado: 'abierta' | 'resuelta' };
export type Proposal = PlannerTurnOutput['propuestas'][number] & { estado: 'pendiente' | 'aceptada' | 'rechazada' | 'diferida' };
export type Decision = { id: string; contenido: string; motivo: string; origen: string; estado: 'propuesta' | 'aceptada'; turno: number };

export type DiscoveryState = {
  modo: 'idea' | 'mejora';
  idea: string;
  turnos: number;
  observaciones: Record<string, PlannerTurnOutput['observaciones'][number]>;
  propuestas: Record<string, Proposal>;
  preguntas: Record<string, Question>;
  decisiones: Record<string, Decision>;
  cobertura: Record<string, { estado: string; nota: string }>;
  contradicciones: Record<string, { descripcion: string; consecuencia: string }>;
  alcance: { incluye: string[]; excluye: string[] };
  resumen: string;
  siguiente_paso: PlannerTurnOutput['siguiente_paso'];
  /** Last messages kept verbatim; older ones live in the summary. */
  recientes: { rol: 'usuario' | 'planeador'; texto: string }[];
};

export function emptyState(modo: DiscoveryState['modo'], idea: string): DiscoveryState {
  return {
    modo,
    idea,
    turnos: 0,
    observaciones: {},
    propuestas: {},
    preguntas: {},
    decisiones: {},
    cobertura: {},
    contradicciones: {},
    alcance: { incluye: [], excluye: [] },
    resumen: '',
    siguiente_paso: 'continuar',
    recientes: [],
  };
}

// Unicode-aware word limits: \b does not treat accented letters as word characters.
const DELEGATION = /(?<!\p{L})(decide t[uú]|elige t[uú]|lo que (t[uú] )?recomiendes|como (t[uú] )?recomiendes|conf[ií]o en tu criterio|haz lo que (creas|consideres))(?!\p{L})/iu;
const KEEP_RECENT = 8;

/**
 * Applies a turn with Forja's authority rules: the model proposes, the user decides.
 * - Without a user message in this turn, nothing is accepted or resolved.
 * - "delegada" only counts if the user actually delegated in this message.
 */
export function mergeTurn(prev: DiscoveryState, out: PlannerTurnOutput, userText: string | null): { state: DiscoveryState; notes: string[] } {
  const state: DiscoveryState = structuredClone(prev);
  const notes: string[] = [];
  const userSpoke = userText !== null && userText.trim().length > 0;
  const delegated = userSpoke && DELEGATION.test(userText);
  state.turnos += 1;

  for (const o of out.observaciones) state.observaciones[o.id] = o;
  for (const p of out.propuestas) {
    const previous = state.propuestas[p.id];
    state.propuestas[p.id] = { ...p, estado: previous?.estado ?? 'pendiente' };
  }
  for (const q of out.preguntas) {
    const previous = state.preguntas[q.id];
    state.preguntas[q.id] = { ...q, estado: previous?.estado === 'resuelta' ? 'resuelta' : 'abierta' };
  }
  if (userSpoke) {
    for (const id of out.preguntas_resueltas) {
      const q = state.preguntas[id];
      if (q) q.estado = 'resuelta';
    }
    for (const r of out.propuestas_respondidas) {
      const p = state.propuestas[r.id];
      if (p) p.estado = r.estado;
    }
  } else if (out.preguntas_resueltas.length > 0 || out.propuestas_respondidas.length > 0) {
    notes.push('el planeador marcó respuestas sin mensaje del usuario: se ignoraron');
  }
  for (const d of out.decisiones_propuestas) {
    let estado: Decision['estado'] = 'propuesta';
    if (d.origen === 'respuesta_usuario' && userSpoke) estado = 'aceptada';
    if (d.origen === 'delegada') {
      if (delegated) estado = 'aceptada';
      else notes.push(`${d.id} se presentó como delegada pero el usuario no delegó: queda como propuesta`);
    }
    const previous = state.decisiones[d.id];
    state.decisiones[d.id] = { ...d, estado: previous?.estado === 'aceptada' ? 'aceptada' : estado, turno: state.turnos };
  }
  for (const c of out.cobertura) state.cobertura[c.tema] = { estado: c.estado, nota: c.nota };
  state.contradicciones = Object.fromEntries(out.contradicciones.map((c) => [c.id, { descripcion: c.descripcion, consecuencia: c.consecuencia }]));
  state.alcance = out.alcance;
  state.resumen = out.resumen_actualizado;
  state.siguiente_paso = out.siguiente_paso;
  if (userSpoke) state.recientes.push({ rol: 'usuario', texto: userText });
  state.recientes.push({ rol: 'planeador', texto: out.mensaje_usuario });
  state.recientes = state.recientes.slice(-KEEP_RECENT);
  return { state, notes };
}

export function openQuestions(state: DiscoveryState): Question[] {
  return Object.values(state.preguntas).filter((q) => q.estado === 'abierta');
}

/** What blocks approving the discovery (v2/04 · Especificación suficiente). */
export function closureBlockers(state: DiscoveryState): string[] {
  const blockers: string[] = [];
  for (const q of openQuestions(state)) if (q.bloquea) blockers.push(`pregunta sin responder: ${q.texto}`);
  for (const [id, c] of Object.entries(state.contradicciones)) blockers.push(`contradicción ${id}: ${c.descripcion}`);
  if (!state.resumen.trim()) blockers.push('todavía no hay un resumen del incremento');
  if (state.alcance.incluye.length === 0) blockers.push('el alcance no incluye nada todavía');
  return blockers;
}

/** Compact view sent to the model each turn (no full transcript). */
export function stateForPrompt(state: DiscoveryState): object {
  return {
    modo: state.modo,
    idea_inicial: state.idea,
    resumen: state.resumen,
    alcance: state.alcance,
    decisiones: Object.values(state.decisiones).map(({ id, contenido, estado }) => ({ id, contenido, estado })),
    preguntas_abiertas: openQuestions(state).map(({ id, texto, bloquea, recomendacion }) => ({ id, texto, bloquea, recomendacion })),
    propuestas: Object.values(state.propuestas).map(({ id, recomendacion, prioridad, estado }) => ({ id, recomendacion, prioridad, estado })),
    cobertura: state.cobertura,
    contradicciones: state.contradicciones,
    conversacion_reciente: state.recientes,
  };
}
