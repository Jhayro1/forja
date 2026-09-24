import { ApiError, stringField } from '../http.js';
import type { ApiModule } from '../server.js';

/** Knowledge graph and lessons as the panel sees them. */
export interface MemoryBackend {
  overview(): object;
  search(text: string): object[];
  review(id: string, approve: boolean, note: string): object;
}

export function memoryModule(backend: MemoryBackend): ApiModule {
  return {
    name: 'memoria',
    routes: [
      { method: 'GET', path: /^\/v1\/memoria$/, handler: () => ({ memoria: backend.overview() }) },
      {
        method: 'GET',
        path: /^\/v1\/memoria\/buscar$/,
        handler: ({ query }) => {
          const q = (query.get('q') ?? '').trim();
          if (q.length < 2) throw new ApiError(422, 'campo_invalido', 'escribe al menos 2 caracteres');
          return { nodos: backend.search(q.slice(0, 100)) };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/memoria\/lecciones\/(lec_[0-9A-HJKMNP-TV-Z]{26})\/(aprobar|rechazar)$/,
        handler: async ({ params, body }) => ({
          ok: true,
          leccion: backend.review(params[0]!, params[1] === 'aprobar', stringField(await body(), 'nota', { optional: true }) ?? ''),
          mensaje: params[1] === 'aprobar' ? 'lección aprobada' : 'lección rechazada',
        }),
      },
    ],
  };
}
