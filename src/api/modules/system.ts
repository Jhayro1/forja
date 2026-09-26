import { ApiError, stringField } from '../http.js';
import type { ApiModule } from '../server.js';

export type Provider = 'claude' | 'codex';

/** Machine setup: diagnosis, installing and signing in to Claude Code / Codex. */
export interface SystemBackend {
  overview(refresh: boolean): Promise<object>;
  install(provider: Provider): object;
  job(id: string): object | null;
  login(provider: Provider): object;
  loginState(provider: Provider): object | null;
  submitCode(provider: Provider, code: string): object;
  cancelLogin(provider: Provider): object | null;
}

const P = '(claude|codex)';

export function systemModule(backend: SystemBackend): ApiModule {
  return {
    name: 'sistema',
    routes: [
      { method: 'GET', path: /^\/v1\/sistema$/, handler: async ({ query }) => ({ sistema: await backend.overview(query.get('refrescar') === '1') }) },
      {
        method: 'POST',
        path: new RegExp(`^/v1/sistema/proveedores/${P}/instalar$`),
        handler: ({ params }) => ({ ok: true, trabajo: backend.install(params[0] as Provider), mensaje: `instalando ${params[0]}…` }),
      },
      {
        method: 'GET',
        path: /^\/v1\/sistema\/trabajos\/(job_[0-9A-HJKMNP-TV-Z]{26})$/,
        handler: ({ params }) => {
          const j = backend.job(params[0]!);
          if (!j) throw new ApiError(404, 'trabajo_no_encontrado', 'ese trabajo no existe');
          return j;
        },
      },
      { method: 'GET', path: new RegExp(`^/v1/sistema/proveedores/${P}/sesion$`), handler: ({ params }) => ({ sesion: backend.loginState(params[0] as Provider) }) },
      { method: 'POST', path: new RegExp(`^/v1/sistema/proveedores/${P}/sesion$`), handler: ({ params }) => ({ ok: true, sesion: backend.login(params[0] as Provider) }) },
      {
        method: 'POST',
        path: new RegExp(`^/v1/sistema/proveedores/${P}/sesion/codigo$`),
        handler: async ({ params, body }) => ({ ok: true, sesion: backend.submitCode(params[0] as Provider, stringField(await body(), 'codigo', { max: 4096 })!), mensaje: 'verificando…' }),
      },
      {
        method: 'POST',
        path: new RegExp(`^/v1/sistema/proveedores/${P}/sesion/cancelar$`),
        handler: ({ params }) => ({ ok: true, sesion: backend.cancelLogin(params[0] as Provider), mensaje: 'cancelado' }),
      },
    ],
  };
}
