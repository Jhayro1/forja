import { ROLE_NAMES, type SettingsBackend, type SettingsInput } from '../api/modules/settings.js';
import { EFFORT_LABELS, EFFORTS, MODEL_CATALOG } from '../providers/catalog.js';
import { updateConfig } from '../registry/config.js';
import type { EngineContext } from './engine-context.js';

/** What the panel's selectors offer: every catalog model, the effort levels and their names. */
export function catalogView(): object {
  return {
    modelos: MODEL_CATALOG.map((m) => ({
      ref: m.ref,
      proveedor: m.provider,
      nombre: m.label,
      descripcion: m.description,
      esfuerzos: m.efforts,
      nivel: m.tier,
      estado: m.status,
      alias: m.alias ?? false,
      contexto: m.context ?? null,
      se_retira: m.retires ?? null,
    })),
    esfuerzos: EFFORTS.map((e) => ({ id: e, nombre: EFFORT_LABELS[e] })),
  };
}

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
    const sugerencias = [...new Set([...MODEL_CATALOG.map((m) => m.ref), ...used])];
    return {
      roles: ROLE_NAMES.map((r) => ({ rol: r, modelos: c.roles[r], esfuerzo: c.esfuerzo[r] ?? null, ayuda: ROLE_HELP[r] })),
      paralelo: c.ejecucion.paralelo,
      sugerencias,
      catalogo: catalogView(),
    };
  }

  save(input: SettingsInput): object {
    updateConfig(this.ctx.checkout.path, (doc) => {
      for (const r of ROLE_NAMES) doc.setIn(['roles', r], input.roles[r]);
      const efforts = ROLE_NAMES.filter((r) => input.esfuerzo[r]);
      if (efforts.length) doc.set('esfuerzo', Object.fromEntries(efforts.map((r) => [r, input.esfuerzo[r]])));
      else doc.delete('esfuerzo');
      doc.setIn(['ejecucion', 'paralelo'], input.paralelo);
    });
    this.reload();
    return { roles: input.roles, esfuerzo: input.esfuerzo, paralelo: input.paralelo };
  }
}
