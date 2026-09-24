/**
 * Single catalog of the user-facing vocabulary (MEJORAS 2.12): the words every
 * surface uses for the same thing — task and action states, phases, what waits
 * on the user, where a number comes from. The CLI and the terminal board import
 * it; the web panel receives it from `GET /v1/textos`, so the three always say
 * the same. Translating Forja starts by providing another catalog with this shape.
 *
 * Context-specific sentences (an error about a given file, a log line) stay next
 * to the code that produces them.
 */
export const TEXTOS = {
  estadoTarea: {
    pendiente: 'espera dependencias',
    lista: 'lista',
    reservada: 'reservada',
    ejecutando: 'agente trabajando',
    verificando: 'verificando',
    verificada: 'verificada',
    integrando: 'integrando',
    integrada: 'integrada',
    esperando_respuesta: 'pregunta para ti',
    pausada: 'pausada',
    bloqueada: 'bloqueada',
    invalidada: 'invalidada',
    cancelada: 'cancelada',
  },
  iconoEstado: {
    pendiente: '·',
    lista: '○',
    reservada: '◔',
    ejecutando: '▶',
    verificando: '◑',
    verificada: '◕',
    integrando: '⇪',
    integrada: '✔',
    esperando_respuesta: '?',
    pausada: '⏸',
    bloqueada: '✘',
    invalidada: '⊘',
    cancelada: '⊘',
  },
  fases: [
    ['descubrir', 'Descubrir'],
    ['especificar', 'Especificar'],
    ['dividir', 'Plan'],
    ['aprobar', 'Aprobar'],
    ['ejecutar', 'Ejecutar'],
    ['entregado', 'Entregado'],
  ],
  pendiente: {
    pregunta_tarea: 'pregunta de un agente',
    tarea_bloqueada: 'tarea bloqueada',
    tarea_pausada: 'tarea pausada',
    pregunta_spec: 'pregunta de la especificación',
    aprobacion: 'aprobación',
  },
  estadoAccion: {
    propuesta: 'espera tu aprobación',
    aprobada: 'aprobada, sin ejecutar',
    caducada: 'caducada',
    descartada: 'descartada',
    ejecutando: 'ejecutándose',
    confirmada: 'confirmada',
    rechazada: 'rechazada (sin efecto)',
    desconocido: 'resultado desconocido: concíliala',
    sin_efecto: 'no se envió (sin efecto)',
  },
  origenDato: {
    medido: 'medido',
    estimado: 'estimado',
    mixto: 'medido y estimado',
    desconocido: 'desconocido',
  },
  modoDemo: 'MODO DEMO: FORJA_SIMULACION está activo; los modelos simulado:* siguen un guion, no son agentes reales.',
} as const;

export type Textos = typeof TEXTOS;

/** Label of a key in a catalog section, falling back to the key itself. */
export function label<S extends keyof Textos>(section: S, key: string): string {
  const table = TEXTOS[section] as unknown as Record<string, string>;
  return table[key] ?? key;
}
