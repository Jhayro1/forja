import { stringField } from '../http.js';
import type { ApiModule } from '../server.js';

/** Connections, MCP servers, actions and audit, as the panel sees them (no secret values exist here). */
export interface ConnectionsBackend {
  overview(): object;
  actions(): object[];
  audit(limit: number): object[];
  approve(id: string, hash: string): object;
  discard(id: string, reason: string): object;
  /** Only when the panel was opened with the vault (forja ui --boveda); the hash must match what was approved. */
  execute(id: string, hash: string): Promise<object>;
  /** «abierta», «cerrada» (idle timeout) or «no» (panel opened without the vault). */
  vaultState(): 'abierta' | 'cerrada' | 'no';
}

const ID = /^\/v1\/acciones\/(acc_[0-9A-HJKMNP-TV-Z]{26})\/(aprobar|descartar)$/;

export function connectionsModule(backend: ConnectionsBackend): ApiModule {
  return {
    name: 'conexiones',
    routes: [
      { method: 'GET', path: /^\/v1\/conexiones$/, handler: () => ({ conexiones: backend.overview() }) },
      { method: 'GET', path: /^\/v1\/acciones$/, handler: () => ({ acciones: backend.actions() }) },
      { method: 'GET', path: /^\/v1\/boveda$/, handler: () => ({ boveda: backend.vaultState() }) },
      {
        method: 'POST',
        path: /^\/v1\/acciones\/(acc_[0-9A-HJKMNP-TV-Z]{26})\/ejecutar$/,
        handler: async ({ params, body }) => ({ ok: true, accion: await backend.execute(params[0]!, stringField(await body(), 'hash')!), mensaje: 'ejecutada: mira su resultado' }),
      },
      { method: 'GET', path: /^\/v1\/auditoria$/, handler: ({ query }) => ({ auditoria: backend.audit(Math.min(500, Number(query.get('n') ?? 200) || 200)) }) },
      {
        method: 'POST',
        path: ID,
        handler: async ({ params, body }) => {
          const b = await body();
          // Approving from the panel binds the exact hash the user saw; execution stays in the terminal (vault).
          const accion =
            params[1] === 'aprobar' ? backend.approve(params[0]!, stringField(b, 'hash')!) : backend.discard(params[0]!, stringField(b, 'motivo', { optional: true }) ?? 'descartada desde el panel');
          const exec = backend.vaultState() === 'abierta' ? 'ejecútala desde aquí o en la terminal' : 'ejecútala en la terminal con forja accion ejecutar (o abre el panel con forja ui --boveda)';
          return { ok: true, accion, mensaje: params[1] === 'aprobar' ? `aprobada: ${exec}` : 'descartada' };
        },
      },
    ],
  };
}
