import type { WorkBackend } from '../api/modules/work.js';
import { activePauses } from '../core/engine.js';
import { deliveryState, publishDelivery } from '../git/publish-delivery.js';
import { activeChange, createChange, getChange } from '../planner/session.js';
import { AccountStore, accountPauseKey } from '../providers/accounts.js';
import { actionPlanText, OBS_STATES, ObservationService, type ObsState } from '../quality/observations.js';
import { latestValidation } from '../quality/validate.js';
import { currentChange, runSnapshot } from '../run/snapshot.js';
import { EpicService } from '../work/epics.js';
import { buildHistory, historyMarkdown } from '../work/history.js';
import type { EnginePlanningBackend } from './engine-backend.js';
import type { EngineContext } from './engine-context.js';
import { JobRunner } from './jobs.js';
import { jobsDir } from './jobs-backend.js';

/** The six roles of v3 §4 and the forja.yaml roles behind each one. */
const SIX_ROLES = [
  {
    id: 'orquestador',
    titulo: 'Orquestador',
    roles: ['planeador'],
    descripcion: 'Conversa contigo, especifica, divide en tareas y coordina. El motor que reparte el trabajo es código: no gasta tokens.',
  },
  { id: 'implementador', titulo: 'Implementador', roles: ['trabajador', 'complejo'], descripcion: 'Construye cada tarea en su propia copia del repositorio, con pruebas.' },
  { id: 'integrador', titulo: 'Integrador', roles: ['integrador'], descripcion: 'Conecta APIs, bases de datos y webhooks; exige pruebas de contrato.' },
  { id: 'revisor', titulo: 'Revisor', roles: ['revisor'], descripcion: 'Compara cada cambio con sus criterios y separa defectos, sugerencias y alcance nuevo.' },
  { id: 'auditor', titulo: 'Auditor', roles: ['auditor'], descripcion: 'Revisa seguridad y arquitectura del sprint entregado y declara lo que no cubrió.' },
  { id: 'qa', titulo: 'QA', roles: ['qa'], descripcion: 'Prueba la entrega completa y cada criterio: pasó, falló, bloqueado o no ejecutado.' },
] as const;

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

  /** The six roles now: who works, on what, with which model and account (v3 §6.3 «Agentes»). */
  agents(): object {
    const engine = this.engine;
    const cfg = this.ctx.config;
    const change = currentChange(engine);
    const snap = change ? runSnapshot(engine, change) : null;
    const job = new JobRunner(jobsDir(this.ctx)).list(1)[0] ?? null;
    const jobRunning = job?.estado === 'corriendo' ? job : null;
    const thinking = (this.planning.overview() as { chat?: { pensando?: { texto: string; desde: string } | null } }).chat?.pensando ?? null;
    const tasks = snap?.tasks ?? [];
    const pauses = new Set(activePauses(engine).map((p) => p.key));
    const accounts = new AccountStore(this.ctx.home);
    const usage = snap?.usage ?? [];
    return {
      roles: SIX_ROLES.map((r) => {
        const trabajando = tasks
          .filter((t) => {
            if (r.id === 'revisor') return t.state === 'verificando';
            return (t.state === 'reservada' || t.state === 'ejecutando') && (r.roles as readonly string[]).includes(t.exec.level ?? '');
          })
          .map((t) => ({
            tarea: t.id,
            titulo: t.title,
            modelo: t.exec.provider ? `${t.exec.provider}:${t.exec.model}` : null,
            cuenta: t.exec.account,
            desde: t.activity?.startedAt ?? null,
            actividad: t.activity?.current ?? null,
          }));
        let otra: string | null = null;
        if (r.id === 'orquestador' && thinking) otra = `Respondiendo en el chat: «${thinking.texto.slice(0, 80)}»`;
        if (r.id === 'orquestador' && jobRunning && ['especificar', 'dividir'].includes(jobRunning.tipo)) otra = jobRunning.titulo;
        if ((r.id === 'auditor' || r.id === 'qa') && jobRunning?.tipo === 'validar') otra = 'Validando el sprint entregado';
        const models = r.roles.flatMap((x) => cfg.roles[x as keyof typeof cfg.roles]);
        const consumo = usage.filter((u) => (r.roles as readonly string[]).includes(u.role));
        return {
          id: r.id,
          titulo: r.titulo,
          descripcion: r.descripcion,
          roles_forja: r.roles,
          modelos: [...new Set(models)],
          esfuerzo: cfg.esfuerzo[r.roles[0] as keyof typeof cfg.esfuerzo] ?? null,
          estado: trabajando.length || otra ? 'activo' : 'inactivo',
          trabajando,
          otra_actividad: otra,
          llamadas: consumo.reduce((n, u) => n + u.calls, 0),
          tokens: consumo.every((u) => u.tokens === null) ? null : consumo.reduce((n, u) => n + (u.tokens ?? 0), 0),
        };
      }),
      cuentas: accounts.list().map((a) => ({
        proveedor: a.proveedor,
        alias: a.alias,
        activa: a.activa,
        sesion: accounts.signedIn(a.proveedor, a.alias),
        en_pausa: pauses.has(accountPauseKey(a.proveedor, a.alias)),
        max_agentes: a.max_agentes,
        en_curso: tasks.filter((t) => (t.state === 'reservada' || t.state === 'ejecutando') && t.exec.provider === a.proveedor && (t.exec.account ?? 'principal') === a.alias).length,
      })),
    };
  }

  history(): object {
    return buildHistory(this.engine);
  }

  delivery(): object {
    const change = currentChange(this.engine);
    return change ? deliveryState(this.engine, change, this.ctx.home) : { rama: null, lista: false, github: null, publicada: null };
  }

  async publish(): Promise<object> {
    const change = currentChange(this.engine);
    if (!change) throw new Error('no hay ningún sprint');
    return publishDelivery(this.engine, change, { home: this.ctx.home, repoPath: this.ctx.checkout.path });
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
    const change = currentChange(this.engine);
    return { lista: wanted?.length ? all.filter((o) => wanted.includes(o.state)) : all, conteo: counts, validacion: change ? latestValidation(this.engine, change.change_id) : null };
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
