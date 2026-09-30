import { type Effort, isEffort } from '../../providers/catalog.js';
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
  send(text: string, opts: SendOptions): string;
}

export type SendOptions = {
  nuevo: boolean;
  cerrar: boolean;
  /** Documents dropped into the chat: name and text (planner/attachments.ts validates them). */
  adjuntos?: { name: string; text: string }[];
  /** Model and effort picked in the chat for this message; the planner role's otherwise. */
  modelo?: string;
  esfuerzo?: Effort;
};

const MODEL_REF = /^(claude|codex|simulado):[A-Za-z0-9._[\]-]{1,60}$/;

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
        // Up to 10 attached documents of 512 KB each (JSON-escaped text weighs a bit more).
        maxBody: 8 * 1024 * 1024,
        handler: async ({ body }) => {
          const b = await body();
          const cerrar = b.cerrar === true;
          const raw = Array.isArray(b.adjuntos) ? b.adjuntos : [];
          const adjuntos = raw.map((a) => {
            const x = a as { nombre?: unknown; contenido?: unknown };
            if (typeof x.nombre !== 'string' || typeof x.contenido !== 'string') throw new ApiError(422, 'campo_invalido', 'cada adjunto lleva nombre y contenido de texto');
            return { name: x.nombre, text: x.contenido };
          });
          const text = stringField(b, 'texto', { optional: cerrar || adjuntos.length > 0, max: 20_000 })?.trim() ?? '';
          if (!text && !cerrar && !adjuntos.length) throw new ApiError(422, 'campo_requerido', 'escribe un mensaje');
          const modelo = typeof b.modelo === 'string' && b.modelo ? b.modelo : undefined;
          if (modelo && !MODEL_REF.test(modelo)) throw new ApiError(422, 'campo_invalido', 'ese modelo no tiene la forma proveedor:modelo');
          const esfuerzo = typeof b.esfuerzo === 'string' && b.esfuerzo ? b.esfuerzo : undefined;
          if (esfuerzo && !isEffort(esfuerzo)) throw new ApiError(422, 'campo_invalido', 'esfuerzo desconocido');
          return {
            ok: true,
            mensaje: backend.send(text, {
              nuevo: b.nuevo === true,
              cerrar,
              ...(adjuntos.length ? { adjuntos } : {}),
              ...(modelo ? { modelo } : {}),
              ...(esfuerzo ? { esfuerzo: esfuerzo as Effort } : {}),
            }),
          };
        },
      },
    ],
  };
}
