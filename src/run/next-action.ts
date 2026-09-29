import type { RunSnapshot } from './snapshot.js';

/**
 * The ONE thing the user should do now, computed on the server (v3/PLAN.md §4.1, V3-110)
 * so the panel, the CLI and the board agree. `vista` is the panel screen that does it.
 */
export type NextAction = { accion: string; titulo: string; motivo: string; vista: 'sprint' | 'tablero' | 'calidad' | 'historial'; urgente: boolean };

export function nextAction(s: RunSnapshot, openObservations = 0): NextAction {
  const question = s.pending.find((p) => p.kind === 'pregunta_tarea');
  const blocked = s.pending.find((p) => p.kind === 'tarea_bloqueada');
  const paused = s.pending.find((p) => p.kind === 'tarea_pausada');
  const specQ = s.pending.find((p) => p.kind === 'pregunta_spec');
  switch (s.change.phase) {
    case 'descubrir':
      return { accion: 'conversar', titulo: 'Sigue la conversación con el planeador', motivo: 'Hay que acordar qué se construye antes de especificarlo.', vista: 'sprint', urgente: false };
    case 'especificar':
      return specQ
        ? { accion: 'responder_spec', titulo: `Responde ${specQ.id} de la especificación`, motivo: specQ.text, vista: 'sprint', urgente: true }
        : { accion: 'especificar', titulo: 'Escribe la especificación', motivo: 'La conversación quedó aprobada.', vista: 'sprint', urgente: false };
    case 'dividir':
      return { accion: 'dividir', titulo: 'Divide la especificación en tareas', motivo: 'La especificación no tiene preguntas que bloqueen.', vista: 'sprint', urgente: false };
    case 'aprobar':
      return s.approved
        ? { accion: 'ejecutar', titulo: `Ejecuta el plan (${s.plan?.tareas.length ?? 0} tareas)`, motivo: 'El plan está aprobado.', vista: 'sprint', urgente: false }
        : { accion: 'aprobar_plan', titulo: 'Revisa y aprueba el plan', motivo: 'Nada se programa sin tu aprobación.', vista: 'sprint', urgente: true };
    case 'ejecutar':
      if (question) return { accion: 'responder', titulo: `Responde la pregunta de ${question.id}`, motivo: question.text, vista: 'tablero', urgente: true };
      if (blocked) return { accion: 'desbloquear', titulo: `Revisa ${blocked.id}: está bloqueada`, motivo: blocked.text, vista: 'tablero', urgente: true };
      if (paused) return { accion: 'reanudar', titulo: `Reanuda ${paused.id}`, motivo: 'La pausaste tú.', vista: 'tablero', urgente: false };
      if (s.run?.state === 'ejecutando')
        return { accion: 'observar', titulo: `Los agentes trabajan: ${s.integrated} de ${s.total} tareas unidas`, motivo: 'No hace falta nada de ti por ahora.', vista: 'tablero', urgente: false };
      return { accion: 'retomar', titulo: 'Retoma la ejecución', motivo: s.run?.detail ?? 'El run está detenido.', vista: 'sprint', urgente: false };
    case 'entregado':
      if (openObservations > 0)
        return {
          accion: 'revisar_observaciones',
          titulo: `Revisa ${openObservations} observación${openObservations === 1 ? '' : 'es'} de calidad`,
          motivo: 'Decide cuáles se corrigen con un plan de acción y cuáles se descartan o posponen.',
          vista: 'calidad',
          urgente: false,
        };
      return {
        accion: 'validar_o_seguir',
        titulo: `Revisa la entrega en ${s.deliveryBranch ?? 'la rama de entrega'}`,
        motivo: 'Valídala con QA y auditoría, o empieza el siguiente sprint.',
        vista: 'calidad',
        urgente: false,
      };
    default:
      return { accion: 'nuevo_sprint', titulo: 'Empieza un sprint nuevo', motivo: 'El anterior se canceló.', vista: 'sprint', urgente: false };
  }
}
