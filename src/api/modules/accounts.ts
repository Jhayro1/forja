import { ApiError, stringField } from '../http.js';
import type { ApiModule } from '../server.js';

export type AccountProviderName = 'claude' | 'codex';

/** Several accounts per provider (v3/PLAN.md §4.9): list, add, sign in, enable, remove. */
export interface AccountsBackend {
  accounts(): object;
  addAccount(provider: AccountProviderName, alias: string): object;
  updateAccount(provider: AccountProviderName, alias: string, patch: { activa?: boolean; max_agentes?: number | null }): object;
  removeAccount(provider: AccountProviderName, alias: string): void;
  accountLogin(provider: AccountProviderName, alias: string): object;
  accountCode(provider: AccountProviderName, alias: string, code: string): object;
  accountCancel(provider: AccountProviderName, alias: string): object | null;
}

const ACC = '(claude|codex)/([a-z0-9][a-z0-9-]{0,30})';

export function accountsModule(backend: AccountsBackend): ApiModule {
  const pa = (params: string[]) => [params[0] as AccountProviderName, params[1]!] as const;
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(422, 'cuenta', (error as Error).message);
    }
  };
  return {
    name: 'cuentas',
    routes: [
      { method: 'GET', path: /^\/v1\/cuentas$/, handler: () => ({ cuentas: backend.accounts() }) },
      {
        method: 'POST',
        path: /^\/v1\/cuentas$/,
        handler: async ({ body }) => {
          const b = await body();
          const provider = stringField(b, 'proveedor', { max: 10 });
          if (provider !== 'claude' && provider !== 'codex') throw new ApiError(422, 'campo_invalido', 'el proveedor debe ser claude o codex');
          const alias = stringField(b, 'alias', { max: 31 })!.trim().toLowerCase();
          return { ok: true, cuenta: guard(() => backend.addAccount(provider, alias)), mensaje: `cuenta ${provider}@${alias} creada: ahora inicia su sesión` };
        },
      },
      {
        method: 'POST',
        path: new RegExp(`^/v1/cuentas/${ACC}$`),
        handler: async ({ params, body }) => {
          const b = await body();
          const patch: { activa?: boolean; max_agentes?: number | null } = {};
          if (b.activa !== undefined) {
            if (typeof b.activa !== 'boolean') throw new ApiError(422, 'campo_invalido', '«activa» debe ser verdadero o falso');
            patch.activa = b.activa;
          }
          if (b.max_agentes !== undefined) {
            if (b.max_agentes !== null && (!Number.isInteger(b.max_agentes) || (b.max_agentes as number) < 1 || (b.max_agentes as number) > 16))
              throw new ApiError(422, 'campo_invalido', '«max_agentes» va de 1 a 16, o vacío para no limitar');
            patch.max_agentes = b.max_agentes as number | null;
          }
          return { ok: true, cuenta: guard(() => backend.updateAccount(...pa(params), patch)), mensaje: 'guardado' };
        },
      },
      {
        // POST (not DELETE) so the panel's action helper, CSRF and Idempotency-Key apply as usual.
        method: 'POST',
        path: new RegExp(`^/v1/cuentas/${ACC}/eliminar$`),
        handler: ({ params }) => {
          guard(() => backend.removeAccount(...pa(params)));
          return { ok: true, mensaje: 'cuenta eliminada' };
        },
      },
      { method: 'POST', path: new RegExp(`^/v1/cuentas/${ACC}/sesion$`), handler: ({ params }) => ({ ok: true, sesion: guard(() => backend.accountLogin(...pa(params))) }) },
      {
        method: 'POST',
        path: new RegExp(`^/v1/cuentas/${ACC}/sesion/codigo$`),
        handler: async ({ params, body }) => {
          const code = stringField(await body(), 'codigo', { max: 4096 })!;
          return { ok: true, sesion: guard(() => backend.accountCode(...pa(params), code)), mensaje: 'verificando…' };
        },
      },
      { method: 'POST', path: new RegExp(`^/v1/cuentas/${ACC}/sesion/cancelar$`), handler: ({ params }) => ({ ok: true, sesion: backend.accountCancel(...pa(params)), mensaje: 'cancelado' }) },
    ],
  };
}
