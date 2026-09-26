import { ApiError } from '../http.js';
import type { ApiModule } from '../server.js';

export type RoleName = 'planeador' | 'trabajador' | 'complejo' | 'revisor';
export const ROLE_NAMES: RoleName[] = ['planeador', 'trabajador', 'complejo', 'revisor'];
export type SettingsInput = { roles: Record<RoleName, string[]>; paralelo: number };

/** The project's models per role and how many agents work at once (forja.yaml). */
export interface SettingsBackend {
  read(): object;
  save(input: SettingsInput): object;
}

function parseInput(b: Record<string, unknown>): SettingsInput {
  const roles = b.roles as Record<string, unknown> | undefined;
  if (!roles || typeof roles !== 'object') throw new ApiError(422, 'campo_requerido', 'faltan los modelos por rol');
  const out = {} as Record<RoleName, string[]>;
  for (const r of ROLE_NAMES) {
    const list = roles[r];
    if (!Array.isArray(list) || list.some((m) => typeof m !== 'string')) throw new ApiError(422, 'campo_invalido', `«${r}» debe ser una lista de modelos`);
    const clean = (list as string[]).map((m) => m.trim()).filter(Boolean);
    if (clean.length === 0) throw new ApiError(422, 'campo_invalido', `elige al menos un modelo para «${r}»`);
    out[r] = [...new Set(clean)].slice(0, 4);
  }
  const paralelo = Number(b.paralelo);
  if (!Number.isInteger(paralelo) || paralelo < 1 || paralelo > 16) throw new ApiError(422, 'campo_invalido', 'agentes en paralelo: entre 1 y 16');
  return { roles: out, paralelo };
}

export function settingsModule(backend: SettingsBackend): ApiModule {
  return {
    name: 'configuracion',
    routes: [
      { method: 'GET', path: /^\/v1\/configuracion$/, handler: () => ({ configuracion: backend.read() }) },
      {
        method: 'POST',
        path: /^\/v1\/configuracion$/,
        handler: async ({ body }) => ({ ok: true, configuracion: backend.save(parseInput(await body())), mensaje: 'configuración guardada en forja.yaml' }),
      },
    ],
  };
}
