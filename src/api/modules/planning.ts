import { stringField } from '../http.js';
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
    ],
  };
}
