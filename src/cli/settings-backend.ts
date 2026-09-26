import { ROLE_NAMES, type SettingsBackend, type SettingsInput } from '../api/modules/settings.js';
import { updateConfig } from '../registry/config.js';
import type { EngineContext } from './engine-context.js';

/** Models the panel offers per provider; any other `proveedor:modelo` can still be typed. */
export const SUGGESTED_MODELS: Record<string, string[]> = {
  claude: ['claude:opus', 'claude:sonnet', 'claude:haiku'],
  codex: ['codex:gpt-6-astra', 'codex:gpt-6-sol', 'codex:gpt-6-luna'],
};

export const ROLE_HELP: Record<string, string> = {
  planeador: 'Conversa contigo, especifica y divide en tareas. Conviene el modelo más capaz.',
  trabajador: 'Programa las tareas simples, muchas y en paralelo. Conviene uno barato.',
  complejo: 'Programa las tareas difíciles.',
  revisor: 'Revisa lo que hicieron los demás. Mejor si es de otro proveedor que el trabajador.',
};

/** forja.yaml roles and parallelism, edited in place; the project reopens so the engine uses them. */
export class ProjectSettingsBackend implements SettingsBackend {
  constructor(
    private readonly ctx: EngineContext,
    private readonly reload: () => void,
  ) {}

  read(): object {
    const c = this.ctx.config;
    const used = Object.values(c.roles).flat();
    const sugerencias = [...new Set([...Object.values(SUGGESTED_MODELS).flat(), ...used])];
    return {
      roles: ROLE_NAMES.map((r) => ({ rol: r, modelos: c.roles[r], ayuda: ROLE_HELP[r] })),
      paralelo: c.ejecucion.paralelo,
      sugerencias,
    };
  }

  save(input: SettingsInput): object {
    updateConfig(this.ctx.checkout.path, (doc) => {
      for (const r of ROLE_NAMES) doc.setIn(['roles', r], input.roles[r]);
      doc.setIn(['ejecucion', 'paralelo'], input.paralelo);
    });
    this.reload();
    return { roles: input.roles, paralelo: input.paralelo };
  }
}
