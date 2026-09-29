import type { WorkBackend } from '../api/modules/work.js';
import { activeChange, createChange, getChange } from '../planner/session.js';
import { actionPlanText, OBS_STATES, ObservationService, type ObsState } from '../quality/observations.js';
import { EpicService } from '../work/epics.js';
import { buildHistory, historyMarkdown } from '../work/history.js';
import type { EnginePlanningBackend } from './engine-backend.js';
import type { EngineContext } from './engine-context.js';

const isState = (s: string): s is ObsState => (OBS_STATES as readonly string[]).includes(s);

/** Epics, history and observations of the open project, for the panel. */
export class EngineWorkBackend implements WorkBackend {
  constructor(
    private readonly ctx: EngineContext,
    private readonly planning: EnginePlanningBackend,
  ) {}

  private get engine() {
    return this.ctx.engine;
  }

  history(): object {
    return buildHistory(this.engine);
  }

  historyMarkdown(): string {
    return historyMarkdown(buildHistory(this.engine));
  }

  epics(): object {
    const s = new EpicService(this.engine);
    return { epicas: s.list(), sprints: s.links() };
  }

  createEpic(input: Record<string, unknown>): object {
    return new EpicService(this.engine).create({ title: String(input.titulo ?? ''), goal: String(input.objetivo ?? ''), target_date: (input.fecha_objetivo as string | null) ?? null });
  }

  editEpic(id: string, input: Record<string, unknown>): object {
    const patch: Record<string, unknown> = {};
    if (input.titulo !== undefined) patch.title = input.titulo;
    if (input.objetivo !== undefined) patch.goal = input.objetivo;
    if (input.fecha_objetivo !== undefined) patch.target_date = input.fecha_objetivo;
    if (input.estado !== undefined) patch.state = input.estado;
    return new EpicService(this.engine).edit(id, patch);
  }

  assignSprint(changeId: string, input: Record<string, unknown>): object {
    return new EpicService(this.engine).assign(changeId, {
      epic_id: (input.epica as string | null) ?? null,
      priority: Number(input.prioridad ?? 0),
      target_date: (input.fecha_objetivo as string | null) ?? null,
    });
  }

  /**
   * Keeps observations in step with their action plan: a plan being executed means
   * «en corrección»; a cancelled plan returns them to «abierta». «Resuelta» is never
   * automatic: it needs the user (or a new validation) to confirm it on the new code.
   */
  private sync(service: ObservationService): void {
    for (const changeId of service.planChanges()) {
      let phase: string;
      try {
        phase = getChange(this.engine, changeId).phase;
      } catch {
        continue;
      }
      for (const o of service.list().filter((x) => x.plan_change === changeId)) {
        if (o.state === 'en_plan' && (phase === 'ejecutar' || phase === 'entregado')) service.move(o.obs_id, 'en_correccion');
        if ((o.state === 'en_plan' || o.state === 'en_correccion') && phase === 'cancelado') service.move(o.obs_id, 'abierta', { reason: 'el plan de acción se canceló' });
      }
    }
  }

  observations(states: string[] | null): object {
    const service = new ObservationService(this.engine);
    this.sync(service);
    const all = service.list();
    const wanted = states?.filter(isState) ?? null;
    const counts = Object.fromEntries(OBS_STATES.map((s) => [s, all.filter((o) => o.state === s).length]));
    return { lista: wanted?.length ? all.filter((o) => wanted.includes(o.state)) : all, conteo: counts };
  }

  moveObservation(id: string, to: string, reason: string | null): object {
    if (!isState(to)) throw new Error(`estado desconocido: ${to}`);
    if (to === 'en_plan' || to === 'en_correccion') throw new Error('eso lo decide el plan de acción: elige las observaciones y crea el plan');
    return new ObservationService(this.engine).move(id, to, { reason });
  }

  /**
   * Turns the chosen observations into a NEW sprint whose first message to the planner is
   * the list: it still goes through discovery, spec, plan and your approval. Nothing runs
   * until you approve its plan (v3 §5.1).
   */
  actionPlan(ids: string[], note: string): object {
    const service = new ObservationService(this.engine);
    const chosen = ids.map((id) => service.get(id));
    if (chosen.some((o) => !o)) throw new Error('alguna observación ya no existe; recarga la lista');
    const bad = chosen.filter((o) => !['abierta', 'pospuesta'].includes(o!.state));
    if (bad.length) throw new Error(`${bad.map((o) => o!.obs_id).join(', ')} ya no está abierta`);
    const active = activeChange(this.engine);
    if (active) throw new Error(`termina o cancela primero el sprint «${active.title}» (fase ${active.phase}); las observaciones quedan en la lista`);
    const obs = chosen.map((o) => o!);
    const title = `Correcciones: ${obs.length} observación${obs.length === 1 ? '' : 'es'}`;
    const changeId = createChange(this.engine, `plan-accion:${ids.slice().sort().join(',')}:${Date.now()}`, title, 'mejora');
    for (const o of obs) service.move(o.obs_id, 'en_plan', { planChange: changeId });
    this.planning.send(actionPlanText(obs, note), { nuevo: false, cerrar: false });
    return { cambio: changeId, mensaje: `Sprint «${title}» creado: el planeador está preparando el plan de acción. Revísalo y apruébalo antes de que se ejecute.` };
  }
}
