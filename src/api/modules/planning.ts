import { ApiError, stringField } from '../http.js';
import type { ApiModule } from '../server.js';

/**
 * Planning as the panel sees it (MEJORAS 3.4): the planner conversation,
 * decisions and open questions of discovery, the spec's questions, and the plan
 * by waves with its estimate — everything needed to decide before approving.
 * The conversation itself (which spends tokens) stays in `forja planear`.
 */
export interface PlanningBackend {
  overview(): object;
  answerSpecQuestion(questionId: string, text: string): string;
  approveDiscovery(): string;
  /**
   * One message to the planner, answered in the background (it can take minutes):
   * the panel sees the reply through the event feed. `nuevo` starts a new change;
   * `cerrar` asks it to close discovery and prepare the summary to approve.
   */
  send(text: string, opts: { nuevo: boolean; cerrar: boolean }): string;
}

export function planningModule(backend: PlanningBackend): ApiModule {
  return {
    name: 'planeacion',
    routes: [
      { method: 'GET', path: /^\/v1\/planeacion$/, handler: () => ({ planeacion: backend.overview() }) },
      {
        method: 'POST',
        path: /^\/v1\/planeacion\/preguntas\/(Q-\d{1,4})\/respuesta$/i,
        handler: async ({ params, body }) => ({ ok: true, mensaje: backend.answerSpecQuestion(params[0]!.toUpperCase(), stringField(await body(), 'respuesta')!.trim()) }),
      },
      { method: 'POST', path: /^\/v1\/planeacion\/descubrimiento\/aprobar$/, handler: () => ({ ok: true, mensaje: backend.approveDiscovery() }) },
      {
        method: 'POST',
        path: /^\/v1\/planeacion\/mensaje$/,
        handler: async ({ body }) => {
          const b = await body();
          const cerrar = b.cerrar === true;
          const text = stringField(b, 'texto', { optional: cerrar, max: 20_000 })?.trim() ?? '';
          if (!text && !cerrar) throw new ApiError(422, 'campo_requerido', 'escribe un mensaje');
          return { ok: true, mensaje: backend.send(text, { nuevo: b.nuevo === true, cerrar }) };
        },
      },
    ],
  };
}
