/**
 * Task lifecycle from v2/05-ejecucion-y-recuperacion.md. States are user-facing
 * vocabulary, so they stay in Spanish.
 */
export const TASK_STATES = [
  'pendiente',
  'lista',
  'reservada',
  'ejecutando',
  'verificando',
  'verificada',
  'integrando',
  'integrada',
  'esperando_respuesta',
  'pausada',
  'bloqueada',
  'invalidada',
  'cancelada',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['integrada', 'invalidada', 'cancelada']);

/** States in which a process may be writing or a result may still be accepted. */
export const ACTIVE_STATES: ReadonlySet<TaskState> = new Set(['reservada', 'ejecutando', 'verificando', 'integrando']);

const HELD_STATES: ReadonlySet<TaskState> = new Set(['esperando_respuesta', 'pausada', 'bloqueada']);

/** Why a transition happens; recorded on the event so the history explains itself. */
export type TransitionReason =
  | 'dependencias_integradas'
  | 'reservada'
  | 'lanzamiento_iniciado'
  | 'proceso_terminado'
  | 'verificacion_aprobada'
  | 'fallo_calidad'
  | 'integracion_iniciada'
  | 'integracion_confirmada'
  | 'destino_avanzo'
  | 'reserva_liberada'
  | 'pregunta'
  | 'pausa_confirmada'
  | 'causa_resuelta'
  | 'bloqueo'
  | 'nueva_revision'
  | 'cancelacion'
  /** Environment problem (install, sandbox, runner): not the agent's fault, no escalation. */
  | 'fallo_entorno'
  /** The candidate no longer merges on the integrated base: redo on the new base. */
  | 'conflicto_integracion'
  /** Provider quota/session: retry with another model of the same role. */
  | 'proveedor_no_disponible';

type Rule = { from: ReadonlySet<TaskState> | 'no_terminal'; to: TaskState; reasons: readonly TransitionReason[] };

const s = (...states: TaskState[]): ReadonlySet<TaskState> => new Set(states);

const RULES: readonly Rule[] = [
  { from: s('pendiente'), to: 'lista', reasons: ['dependencias_integradas'] },
  { from: s('lista'), to: 'reservada', reasons: ['reservada'] },
  { from: s('reservada'), to: 'lista', reasons: ['reserva_liberada'] },
  { from: s('reservada'), to: 'ejecutando', reasons: ['lanzamiento_iniciado'] },
  { from: s('ejecutando'), to: 'verificando', reasons: ['proceso_terminado'] },
  { from: s('verificando'), to: 'verificada', reasons: ['verificacion_aprobada'] },
  { from: s('verificando'), to: 'lista', reasons: ['fallo_calidad', 'conflicto_integracion'] },
  { from: s('verificada'), to: 'integrando', reasons: ['integracion_iniciada'] },
  { from: s('integrando'), to: 'integrada', reasons: ['integracion_confirmada'] },
  { from: s('integrando'), to: 'verificando', reasons: ['destino_avanzo'] },
  { from: s('reservada', 'ejecutando', 'verificando'), to: 'lista', reasons: ['fallo_entorno', 'proveedor_no_disponible'] },
  { from: s('ejecutando'), to: 'lista', reasons: ['fallo_calidad'] },
  { from: s('integrando'), to: 'lista', reasons: ['fallo_calidad', 'conflicto_integracion', 'fallo_entorno'] },
  { from: s('ejecutando'), to: 'esperando_respuesta', reasons: ['pregunta'] },
  { from: ACTIVE_STATES, to: 'pausada', reasons: ['pausa_confirmada'] },
  { from: HELD_STATES, to: 'lista', reasons: ['causa_resuelta'] },
  { from: 'no_terminal', to: 'bloqueada', reasons: ['bloqueo'] },
  {
    from: s('pendiente', 'lista', 'reservada', 'ejecutando', 'verificando', 'verificada', 'integrando', 'esperando_respuesta', 'pausada', 'bloqueada'),
    to: 'invalidada',
    reasons: ['nueva_revision'],
  },
  {
    from: s('pendiente', 'lista', 'reservada', 'ejecutando', 'verificando', 'verificada', 'esperando_respuesta', 'pausada', 'bloqueada'),
    to: 'cancelada',
    reasons: ['cancelacion'],
  },
];

export type TransitionCheck = { ok: true } | { ok: false; error: string };

export function checkTransition(from: TaskState, to: TaskState, reason: TransitionReason): TransitionCheck {
  if (TERMINAL_STATES.has(from)) return { ok: false, error: `la tarea ya terminó (${from})` };
  for (const rule of RULES) {
    if (rule.to !== to) continue;
    const fromOk = rule.from === 'no_terminal' ? from !== to : rule.from.has(from);
    if (fromOk && rule.reasons.includes(reason)) return { ok: true };
  }
  return { ok: false, error: `transición no permitida: ${from} → ${to} (${reason})` };
}
