import { auditTrail } from '../actions/audit.js';
import { ConnectionStore } from '../actions/connections.js';
import type { ConnectionsBackend } from '../api/modules/connections.js';
import type { MemoryBackend } from '../api/modules/memory.js';
import type { RunsBackend } from '../api/modules/runs.js';
import { GraphStore } from '../memory/graph-store.js';
import { LessonService } from '../memory/lessons.js';
import { McpRegistry } from '../mcp/registry.js';
import { actionService } from './commands/actions.js';
import type { EventFeed } from '../api/server.js';
import { approvePlan } from '../plan/approve.js';
import { resumeProvider } from '../core/engine.js';
import { activeChange } from '../planner/session.js';
import { runningOrchestrator } from '../run/process.js';
import { snapshotJson } from '../run/snapshot-json.js';
import type { TaskView } from '../run/snapshot.js';
import { EngineBoardSource } from './board-source.js';
import type { EngineContext } from './engine-context.js';

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
    return { proyecto: this.ctx.config.nombre, ...snapshotJson(snap, runningOrchestrator(this.ctx.dataDir)), registro: snap.run ? this.board.runLog(snap.run.run_id) : [] };
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
    const change = activeChange(this.ctx.engine);
    if (!change) throw new Error('no hay un cambio en curso');
    const approval = approvePlan(this.ctx.engine, change.change_id, 'panel');
    return `plan aprobado (${approval.approval_id}): ${approval.allowed_task_ids.length} tareas; ejecútalo con forja run`;
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
  constructor(private readonly ctx: EngineContext) {}

  private service() {
    return actionService(this.ctx);
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
    return this.withGraph((g) => ({ grafo: g.stats(), construido: g.meta('construido'), modo: this.ctx.config.contexto.modo, lecciones: lessons }));
  }

  search(text: string): object[] {
    return this.withGraph((g) => g.search(text).map((n) => ({ ...n, salen: g.out(n.id).slice(0, 20), entran: g.in(n.id).slice(0, 20) })));
  }

  review(id: string, approve: boolean, note: string): object {
    return new LessonService(this.ctx.store).review(id, approve, 'panel', note);
  }
}
