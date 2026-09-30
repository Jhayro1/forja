import { auditTrail } from '../actions/audit.js';
import { ConnectionStore } from '../actions/connections.js';
import type { ActionService } from '../actions/protocol.js';
import type { ConnectionsBackend } from '../api/modules/connections.js';
import type { MemoryBackend } from '../api/modules/memory.js';
import type { PlanningBackend, SendOptions } from '../api/modules/planning.js';
import type { RunsBackend } from '../api/modules/runs.js';
import type { EventFeed } from '../api/server.js';
import { resumeProvider } from '../core/engine.js';
import { databasesForPrompt } from '../db/project.js';
import { McpRegistry } from '../mcp/registry.js';
import { GraphStore } from '../memory/graph-store.js';
import { hashFilesIn, LessonService } from '../memory/lessons.js';
import { MailService, panelLink } from '../notify/mail.js';
import { currentApproval, gateProblems } from '../plan/approve.js';
import { latestPlan } from '../plan/divide.js';
import { estimatePlan } from '../plan/estimate.js';
import { waves } from '../plan/plan.js';
import { saveAttachments, validate as validateAttachments } from '../planner/attachments.js';
import { closureBlockers, openQuestions } from '../planner/discovery.js';
import { activeChange, approveDiscovery, createChange, getDiscovery, listChanges, plannerScratch, runPlannerTurn, transcript } from '../planner/session.js';
import { ObservationService } from '../quality/observations.js';
import { runningOrchestrator } from '../run/process.js';
import type { TaskView } from '../run/snapshot.js';
import { currentChange } from '../run/snapshot.js';
import { snapshotJson } from '../run/snapshot-json.js';
import { answerSpecQuestion, latestSpec, specAnswers } from '../spec/generate.js';
import { validateSpec } from '../spec/spec.js';
import type { Vault } from '../vault/vault.js';
import { EngineBoardSource } from './board-source.js';
import { actionService } from './commands/actions.js';
import { type EngineContext, hasProductCode, repoEvidence } from './engine-context.js';

/**
 * Engine-backed implementation of the API ports. It delegates to the same read
 * model and domain commands as the CLI and the terminal board, so every surface
 * shows and does exactly the same things.
 */
export class EngineRunsBackend implements RunsBackend {
  private readonly board: EngineBoardSource;

  constructor(private readonly ctx: EngineContext) {
    this.board = new EngineBoardSource(ctx);
  }

  state(): object {
    const snap = this.board.snapshot();
    if (!snap) return { cambio: null };
    const open = new ObservationService(this.ctx.engine).list({ change_id: snap.change.change_id, states: ['abierta'] }).length;
    return { proyecto: this.ctx.config.nombre, ...snapshotJson(snap, runningOrchestrator(this.ctx.dataDir), open), registro: snap.run ? this.board.runLog(snap.run.run_id) : [] };
  }

  private find(id: string): TaskView | null {
    return this.board.snapshot()?.tasks.find((t) => t.id === id) ?? null;
  }

  task(id: string) {
    const t = this.find(id);
    if (!t) return null;
    return { detalle: this.board.taskDetail(t), registro: this.board.taskLog(t), instrucciones: this.board.taskContext(t) };
  }

  async diff(id: string): Promise<string[]> {
    const t = this.find(id);
    return t ? this.board.taskDiff(t) : [];
  }

  answer(taskId: string, text: string): void {
    const t = this.find(taskId);
    if (!t) throw new Error(`no existe la tarea ${taskId}`);
    this.board.answer(t, text);
  }

  retry(taskId: string, note: string | null): void {
    const t = this.find(taskId);
    if (!t) throw new Error(`no existe la tarea ${taskId}`);
    this.board.retry(t, note);
  }

  private must(taskId: string): TaskView {
    const t = this.find(taskId);
    if (!t) throw new Error(`no existe la tarea ${taskId}`);
    return t;
  }

  pause(taskId: string): string {
    const t = this.must(taskId);
    if (t.state === 'pausada') throw new Error(`${taskId} ya está pausada`);
    return this.board.togglePause(t);
  }

  resume(taskId: string): string {
    const t = this.must(taskId);
    if (t.state !== 'pausada' && t.exec.control !== 'pausar') throw new Error(`${taskId} no está pausada`);
    return this.board.togglePause(t);
  }

  reassign(taskId: string, model: string | null): string {
    return this.board.reassign(this.must(taskId), model);
  }

  resumeProvider(key: string): string {
    if (!resumeProvider(this.ctx.engine, key)) throw new Error(`${key} no está en pausa`);
    return `${key} disponible de nuevo`;
  }

  stop(): string {
    return this.board.stop();
  }

  approvePlan(): string {
    return this.board.approvePlan('panel');
  }
}

export class EngineEventFeed implements EventFeed {
  readonly checkoutId: string;

  constructor(private readonly ctx: EngineContext) {
    this.checkoutId = ctx.checkout.checkout_id;
  }

  lastSeq(): number {
    return (this.ctx.store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get() as { s: number }).s;
  }

  after(seq: number, limit: number) {
    // Only ids and types go to the browser: it refetches the state it needs.
    return this.ctx.store.events(seq, limit).map((e) => ({ seq: e.seq, type: e.type, aggregate_id: e.aggregate_id, run_id: e.run_id, task_id: e.task_id, recorded_at: e.recorded_at }));
  }
}

export class EngineConnectionsBackend implements ConnectionsBackend {
  /** `vault`: opened by `forja ui --boveda` (closes itself after inactivity), or null. */
  constructor(
    private readonly ctx: EngineContext,
    private readonly vault: Vault | null = null,
    private readonly makeService: () => ActionService = () => actionService(ctx),
  ) {}

  vaultState(): 'abierta' | 'cerrada' | 'no' {
    if (!this.vault) return 'no';
    return this.vault.isOpen ? 'abierta' : 'cerrada';
  }

  async execute(id: string, hash: string): Promise<object> {
    const svc = this.service();
    const a = svc.get(id);
    // The panel executes exactly what the user saw and approved (v2/06).
    if (a.hash !== hash) throw new Error('la acción cambió desde que la viste: recarga el panel');
    if (!this.vault) throw new Error('el panel se abrió sin la bóveda: usa forja ui --boveda o ejecuta en la terminal (forja accion ejecutar)');
    if (!this.vault.isOpen) throw new Error('la bóveda se cerró por inactividad: vuelve a abrir el panel con forja ui --boveda');
    const vault = this.vault;
    return svc.execute(id, (name) => (vault.has(name) ? vault.get(name) : null));
  }

  private service(): ActionService {
    return this.makeService();
  }

  overview(): object {
    return { conexiones: ConnectionStore.in(this.ctx.home).all(), mcp: McpRegistry.in(this.ctx.home).all(), vinculos: this.service().links() };
  }

  actions(): object[] {
    const svc = this.service();
    svc.recoverInterrupted();
    return svc.list();
  }

  audit(limit: number): object[] {
    return auditTrail(this.ctx.store.db, limit);
  }

  approve(id: string, hash: string): object {
    return this.service().approve(id, hash, 'panel');
  }

  discard(id: string, reason: string): object {
    return this.service().discard(id, 'panel', reason);
  }
}

export class EngineMemoryBackend implements MemoryBackend {
  constructor(private readonly ctx: EngineContext) {}

  private withGraph<T>(fn: (g: GraphStore) => T): T {
    const graph = GraphStore.open(this.ctx.dataDir);
    try {
      return fn(graph);
    } finally {
      graph.close();
    }
  }

  overview(): object {
    const lessons = new LessonService(this.ctx.store).list();
    return this.withGraph((g) => ({ grafo: g.stats(), construido: g.meta('construido'), fuente: g.meta('fuente'), modo: this.ctx.config.contexto.modo, lecciones: lessons }));
  }

  search(text: string): object[] {
    return this.withGraph((g) => g.search(text).map((n) => ({ ...n, salen: g.out(n.id).slice(0, 20), entran: g.in(n.id).slice(0, 20) })));
  }

  review(id: string, approve: boolean, note: string): object {
    return new LessonService(this.ctx.store).review(id, approve, 'panel', note, hashFilesIn(this.ctx.checkout.path));
  }
}

/** Lets a backend hold the project open (no switching) while in-process work uses its store. */
export type BusyFlag = { set(reason: string | null): void };

/** Planning read model for the panel: the same data `forja planear`, `forja plan` and `forja preguntas` show. */
export class EnginePlanningBackend implements PlanningBackend {
  private thinking: { texto: string; desde: string; adjuntos?: string[]; modelo?: string | null } | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly ctx: EngineContext,
    private readonly busy: BusyFlag = { set: () => {} },
  ) {}

  /** Email notice about the planner (v3 §5.6). Never throws: a notice cannot break the chat. */
  private mailChat(message: { asunto: string; texto: string }): void {
    try {
      if (!this.ctx.home) return;
      void new MailService(this.ctx.home).notice('chat', message).catch(() => undefined);
    } catch {
      // Without mail settings there is nothing to send.
    }
  }

  private chat(): object {
    return {
      pensando: this.thinking,
      error: this.lastError,
      planeador: this.ctx.config.roles.planeador[0],
      esfuerzo: this.ctx.config.esfuerzo.planeador ?? null,
    };
  }

  /** Same as `forja planear`: creates the change if needed and runs one planner turn, here in the background. */
  send(text: string, opts: SendOptions): string {
    if (this.thinking) throw new Error('el planeador todavía está respondiendo');
    // Checked before anything starts: a bad document must not leave a half-created change.
    const files = opts.adjuntos?.length ? validateAttachments(opts.adjuntos) : [];
    const engine = this.ctx.engine;
    let change = opts.nuevo ? undefined : activeChange(engine);
    if (change && change.phase !== 'descubrir') throw new Error(`el cambio «${change.title}» ya pasó la conversación (fase ${change.phase}); empieza uno nuevo cuando termine`);
    let userText: string | null = opts.cerrar ? 'Quiero cerrar el descubrimiento: revisa huecos y prepara el resumen para aprobar.' : text;
    let created = false;
    if (!change) {
      if (!text && !files.length) throw new Error('escribe qué quieres construir o mejorar');
      created = true;
      // The title keeps the first 120 characters (as the CLI); a longer idea, or one with documents,
      // also goes as the first message.
      userText = text.length > 120 || files.length ? text || '(ver documentos adjuntos)' : null;
    } else if (!text && files.length) userText = '(ver documentos adjuntos)';
    this.thinking = {
      texto: opts.cerrar ? 'Cerrar el descubrimiento' : text,
      desde: new Date().toISOString(),
      adjuntos: files.map((f) => f.name),
      modelo: opts.modelo ?? this.ctx.config.roles.planeador[0] ?? null,
    };
    this.lastError = null;
    this.busy.set('el planeador está respondiendo');
    void (async () => {
      try {
        if (!change) {
          const mode = (await hasProductCode(this.ctx.checkout.path)) ? 'mejora' : 'idea';
          const title = (text || files.map((f) => f.name).join(', ')).slice(0, 120);
          const id = createChange(engine, `cambio:${Date.now()}`, title, mode);
          change = listChanges(engine).find((c) => c.change_id === id)!;
        }
        const inputs = change.mode === 'mejora' ? { workspace: this.ctx.checkout.path, evidence: await repoEvidence(this.ctx.checkout.path) } : { workspace: plannerScratch(engine) };
        const started = Date.now();
        const attachments = files.length ? saveAttachments(engine.dataDir, change.change_id, files) : [];
        const databases = await databasesForPrompt(engine, this.ctx.home);
        await runPlannerTurn(engine, {
          changeId: change.change_id,
          databases,
          userText,
          ...inputs,
          closing: opts.cerrar,
          ...(attachments.length ? { attachments } : {}),
          ...(opts.modelo ? { model: opts.modelo } : {}),
          ...(opts.esfuerzo ? { effort: opts.esfuerzo } : {}),
        });
        // A long answer deserves an email (v3 §5.6): the user may have left the tab.
        if (Date.now() - started > 60_000) {
          const reply = transcript(engine, change.change_id).at(-1)?.planner_text ?? '';
          this.mailChat({
            asunto: `Forja · ${this.ctx.config.nombre}: el planeador respondió`,
            texto: `Cambio: ${change.title}\n\n${reply.slice(0, 3000)}${panelLink()}`,
          });
        }
      } catch (error) {
        this.lastError = (error as Error).message;
        this.mailChat({
          asunto: `Forja · ${this.ctx.config.nombre}: el planeador no pudo responder`,
          texto: `${this.lastError.slice(0, 2000)}${panelLink()}`,
        });
      } finally {
        this.thinking = null;
        this.busy.set(null);
      }
    })();
    return created ? 'cambio creado: el planeador está pensando…' : 'el planeador está pensando…';
  }

  overview(): object {
    const change = currentChange(this.ctx.engine);
    if (!change) return { cambio: null, chat: this.chat() };
    const id = change.change_id;
    const { state, approvedRevision, revision } = getDiscovery(this.ctx.engine, id);
    const spec = latestSpec(this.ctx.engine, id);
    const answers = new Map(specAnswers(this.ctx.engine, id).map((a) => [a.question_id, a.answer]));
    const plan = latestPlan(this.ctx.engine, id);
    return {
      chat: this.chat(),
      cambio: { id, titulo: change.title, fase: change.phase, modo: change.mode },
      conversacion: transcript(this.ctx.engine, id)
        .slice(-30)
        .map((t) => ({ n: t.n, usuario: t.user_text, planeador: t.planner_text, modelo: `${t.provider}:${t.model ?? '?'}`, adjuntos: t.attachments.map((a) => a.name) })),
      descubrimiento: {
        revision,
        aprobado: approvedRevision !== null,
        resumen: state.resumen,
        alcance: state.alcance,
        decisiones: Object.values(state.decisiones),
        propuestas: Object.values(state.propuestas),
        preguntas_abiertas: openQuestions(state),
        cobertura: state.cobertura,
        bloqueos: closureBlockers(state),
      },
      especificacion: spec
        ? {
            revision: spec.revision,
            sistema: spec.spec.sistema,
            casos_uso: spec.spec.casos_uso.map((u) => ({ id: u.id, nombre: u.nombre, objetivo: u.objetivo })),
            criterios: spec.spec.criterios.length,
            decisiones: spec.spec.decisiones,
            preguntas: spec.spec.preguntas.map((q) => ({ ...q, respuesta: answers.get(q.id) ?? null })),
            problemas: validateSpec(spec.spec).filter((i) => i.severity === 'error'),
          }
        : null,
      plan: plan
        ? {
            revision: plan.revision,
            olas: waves(plan.plan.tareas),
            tareas: plan.plan.tareas.map((t) => ({ id: t.id, titulo: t.titulo, tipo: t.tipo, complejidad: t.complejidad, depende_de: t.depende_de, escribe: t.escribe, criterios: t.criterios })),
            supuestos: plan.plan.supuestos,
            perfil: plan.plan.perfil,
            estimacion: estimatePlan(plan.plan, this.ctx.config, this.ctx.engine.prices ?? null),
            aprobado: currentApproval(this.ctx.engine, id) !== null,
            problemas_para_aprobar: change.phase === 'aprobar' ? gateProblems(this.ctx.engine, id) : [],
          }
        : null,
    };
  }

  answerSpecQuestion(questionId: string, text: string): string {
    const change = activeChange(this.ctx.engine);
    if (!change) throw new Error('no hay un cambio en curso');
    answerSpecQuestion(this.ctx.engine, change.change_id, questionId, text);
    return `respuesta a ${questionId} registrada; incorpórala con forja especificar`;
  }

  approveDiscovery(): string {
    const change = activeChange(this.ctx.engine);
    if (!change) throw new Error('no hay un cambio en curso');
    const { revision } = getDiscovery(this.ctx.engine, change.change_id);
    approveDiscovery(this.ctx.engine, change.change_id, `aprobar:${change.change_id}:${revision}`);
    return `descubrimiento aprobado (revisión ${revision}); sigue con forja especificar`;
  }
}
