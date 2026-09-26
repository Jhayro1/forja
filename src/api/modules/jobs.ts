import { ApiError, stringField } from '../http.js';
import type { ApiModule } from '../server.js';

/** Long commands of the project's flow, started and watched from the panel. */
export interface JobsBackend {
  kinds(): { tipo: string; titulo: string }[];
  list(): object[];
  get(id: string): { trabajo: object; salida: string[] } | null;
  start(kind: string): object;
  cancel(id: string, force: boolean): object;
}

const JOB = /^\/v1\/trabajos\/(job_[0-9A-HJKMNP-TV-Z]{26})$/;

export function jobsModule(backend: JobsBackend): ApiModule {
  return {
    name: 'trabajos',
    routes: [
      { method: 'GET', path: /^\/v1\/trabajos$/, handler: () => ({ trabajos: backend.list(), tipos: backend.kinds() }) },
      {
        method: 'GET',
        path: JOB,
        handler: ({ params }) => {
          const j = backend.get(params[0]!);
          if (!j) throw new ApiError(404, 'trabajo_no_encontrado', 'ese trabajo no existe');
          return j;
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/trabajos$/,
        handler: async ({ body }) => {
          const kind = stringField(await body(), 'tipo', { max: 40 })!;
          if (!backend.kinds().some((k) => k.tipo === kind)) throw new ApiError(422, 'campo_invalido', `tipo de trabajo desconocido: ${kind}`);
          return { ok: true, trabajo: backend.start(kind), mensaje: 'trabajo iniciado' };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/trabajos\/(job_[0-9A-HJKMNP-TV-Z]{26})\/cancelar$/,
        handler: async ({ params, body }) => ({ ok: true, trabajo: backend.cancel(params[0]!, (await body()).forzar === true), mensaje: 'cancelando…' }),
      },
    ],
  };
}
