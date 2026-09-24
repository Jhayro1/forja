import type { Engine } from '../core/engine.js';
import { tasksReadyToUnblock } from '../core/task-commands.js';
import { newId } from '../domain/ids.js';
import type { GatewayHost } from '../mcp/gateway.js';
import { FILES } from '../runtime/order.js';
import { EV, type RunState } from '../store/planning-projections.js';
import { DirWatchSet, Waker } from '../util/waker.js';
import { Delivery } from './pipeline/delivery.js';
import { Integrator } from './pipeline/integrator.js';
import { JobRunner } from './pipeline/jobs.js';
import { OutcomeHandler } from './pipeline/outcome-handler.js';
import { Reconciler } from './pipeline/reconciler.js';
import { RunContext } from './pipeline/run-context.js';
import { dependentCounts, HOLDING_STATES, nextToIntegrate, selectLaunches } from './pipeline/scheduler.js';
import { gatewayOrigin, TaskLauncher } from './pipeline/task-launcher.js';
import { TaskVerifier } from './pipeline/task-verifier.js';
import { getRun, setRunState } from './records.js';
import { applyTaskControls } from './task-control.js';

// Public surface of the run module (kept here so callers have one entry point).
export { type ExecRow, getExec, getRun, RunError, type RunRow, runsOf } from './records.js';
export { startOrResumeRun } from './start.js';
export { answerTaskQuestion, reassignTask, requestPause, resumeTask, unblockTask } from './task-control.js';

export type OrchestratorOptions = {
  parallel?: number;
  /** false only in Forja's own tests on machines without bubblewrap. */
  sandbox?: boolean;
  review?: boolean;
  /** Fallback interval; the loop normally wakes on job completion and file events. */
  pollMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  /** MCP gateway for workers (M5): only when the project linked connections or MCP servers. */
  gateway?: GatewayHost;
  /** `forja run --solo`: launch only this task (its dependencies must already be integrated). */
  only?: string;
};

export type RunSummary = { runId: string; state: RunState; counts: Record<string, number>; branch: string; deliveryBranch: string | null };

const MIN_GAP_MS = 50;
const DONE = new Set(['integrada', 'invalidada', 'cancelada']);
const NEEDS_USER = new Set(['bloqueada', 'esperando_respuesta', 'pausada']);

/**
 * Deterministic scheduler (ADR-002): coordination spends no tokens. Everything
 * it decides is an event persisted before the effect, so a restart resumes.
 *
 * The orchestrator only coordinates; each stage lives behind its own class
 * (launch, outcome, verification, integration, reconciliation, delivery) and
 * the launch policy is a pure function (`selectLaunches`).
 */
export class Orchestrator {
  private readonly ctx: RunContext;
  private readonly jobs: JobRunner;
  private readonly launcher: TaskLauncher;
  private readonly outcomes: OutcomeHandler;
  private readonly verifier: TaskVerifier;
  private readonly integrator: Integrator;
  private readonly parallel: number;
  private readonly dependents: Map<string, number>;
  private integrating: string | null = null;
  private readonly waker = new Waker();
  private readonly launchWatch: DirWatchSet;
  private readonly storeWatch: DirWatchSet;

  constructor(
    private readonly engine: Engine,
    repoPath: string,
    runId: string,
    private readonly opts: OrchestratorOptions = {},
  ) {
    this.ctx = new RunContext(engine, repoPath, runId, { ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}), ...(opts.onLog ? { onLog: opts.onLog } : {}) });
    this.parallel = opts.parallel ?? engine.config.ejecucion.paralelo;
    this.dependents = dependentCounts(this.ctx.plan);
    this.launcher = new TaskLauncher(this.ctx, opts.gateway);
    this.outcomes = new OutcomeHandler(this.ctx);
    this.verifier = new TaskVerifier(this.ctx, opts.review ?? true);
    this.integrator = new Integrator(this.ctx);
    this.jobs = new JobRunner({
      onError: (key, message) => this.ctx.log(`⚠ ${key}: ${message}`),
      onGiveUp: (key, message) => {
        const taskId = key.slice(key.indexOf(':') + 1);
        const current = this.ctx.tasks().find((t) => t.task_id === taskId);
        if (current && !['integrada', 'invalidada', 'cancelada', 'bloqueada'].includes(current.state)) {
          this.ctx.exec(taskId, { last_error: message.slice(0, 500) });
          this.ctx.move(taskId, 'bloqueada', 'bloqueo', `error interno repetido: ${message}`);
        }
      },
      onSettled: () => this.waker.notify(),
    });
    // A launch finishing (result or runner file) and writes from other processes
    // (an answer, a pause) wake the loop at once instead of waiting for the next poll.
    this.launchWatch = new DirWatchSet(
      () => this.waker.notify(),
      (f) => f === FILES.result || f === FILES.runner,
    );
    this.storeWatch = new DirWatchSet(
      () => this.waker.notify(),
      (f) => f.startsWith('estado.db'),
    );
  }

  private get runId(): string {
    return this.ctx.runId;
  }

  async loop(): Promise<RunSummary> {
    await new Reconciler(this.ctx).reconcile();
    await this.restoreGatewaySockets();
    this.engine.store.execute({ request_id: newId('req'), type: 'parametros_run', input: { runId: this.runId } }, () => ({
      result: null,
      events: [
        {
          type: EV.runParams,
          aggregate_type: 'run',
          aggregate_id: this.runId,
          run_id: this.runId,
          payload: { paralelo: this.parallel, revisor: this.opts.review ?? true, ...(this.opts.only ? { solo: this.opts.only } : {}) },
        },
      ],
    }));
    const pollMs = this.opts.pollMs ?? 2000;
    this.storeWatch.sync([this.engine.dataDir]);
    let stopping = false;
    this.opts.signal?.addEventListener('abort', () => {
      stopping = true;
      this.ctx.log('⏸ deteniendo: no se lanzan tareas nuevas; los agentes en curso siguen y se retoman con forja run');
    });
    for (;;) {
      // Unblock tasks whose dependencies are integrated (I04), then apply user pauses.
      for (const id of tasksReadyToUnblock(this.engine.store, this.runId)) this.ctx.move(id, 'lista', 'dependencias_integradas');
      for (const id of applyTaskControls(this.engine, this.runId, this.jobs.busyTasks())) this.ctx.log(`⏸ ${id} pausada por el usuario`);

      if (!stopping) {
        const finished = this.tick();
        if (finished) return finished;
      } else if (this.jobs.size === 0) {
        return this.finish('pausado', 'detenido por el usuario; los agentes en curso se retoman con forja run');
      }

      const settled = this.settledOutcome(stopping);
      if (settled) return settled;
      this.launchWatch.sync(this.runningLaunchDirs());
      const tickStart = Date.now();
      await this.waker.wait(pollMs);
      // Our own writes also touch the store: never spin faster than MIN_GAP_MS.
      const gap = MIN_GAP_MS - (Date.now() - tickStart);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
  }

  private runningLaunchDirs(): string[] {
    return this.ctx
      .tasks()
      .filter((t) => t.state === 'ejecutando')
      .map((t) => this.ctx.execOf(t.task_id).launch_dir)
      .filter((d): d is string => d !== null);
  }

  /**
   * Agents that kept working while `forja run` was down lost their gateway: the
   * socket is recreated at the same path (their sandbox mounted its folder) and
   * their bridge reconnects (MEJORAS 4.7).
   */
  private async restoreGatewaySockets(): Promise<void> {
    const gateway = this.opts.gateway;
    if (!gateway) return;
    for (const t of this.ctx.tasks().filter((x) => x.state === 'ejecutando')) {
      const exec = this.ctx.execOf(t.task_id);
      if (exec.launch_id) await gateway.socketFor(gatewayOrigin(t.task_id, this.runId), exec.launch_id);
    }
  }

  /** One scheduling round. Returns a summary promise when the run left `ejecutando`. */
  private tick(): Promise<RunSummary> | null {
    const tasks = this.ctx.tasks();
    for (const t of tasks) {
      if (t.state === 'ejecutando') this.jobs.spawn(`proc:${t.task_id}`, () => this.outcomes.poll(t.task_id));
      if (t.state === 'verificando') this.jobs.spawn(`verif:${t.task_id}`, () => this.verifier.verify(t.task_id));
    }
    if (!this.integrating) {
      const next = nextToIntegrate(tasks);
      if (next) {
        this.integrating = next;
        this.jobs.spawn(`integ:${next}`, () => this.integrator.integrate(next).finally(() => (this.integrating = null)));
      }
    }
    const run = getRun(this.engine, this.runId)!;
    if (run.state !== 'ejecutando') return this.finish(run.state, run.detail);
    if (this.budgetExceeded()) {
      setRunState(this.engine, this.runId, 'pausado', 'presupuesto del run agotado: amplíalo en forja.yaml (presupuesto.por_run_usd) y vuelve a ejecutar');
      this.ctx.log('⏸ presupuesto agotado: el run se pausa (no se escala de modelo)');
      return null;
    }
    for (const id of selectLaunches({ plan: this.ctx.plan, tasks, parallel: this.parallel, only: this.opts.only ?? null, dependents: this.dependents })) {
      this.jobs.spawn(`lanzar:${id}`, () => this.launcher.launch(id));
    }
    return null;
  }

  /** Whether the run is over (completed, solo target done, or waiting on the user/models). */
  private settledOutcome(stopping: boolean): Promise<RunSummary> | null {
    const now = this.ctx.tasks();
    if (now.every((t) => DONE.has(t.state))) return this.finish('completado');
    if (stopping || this.jobs.size > 0) return null;
    const active = now.filter((t) => (HOLDING_STATES as readonly string[]).includes(t.state));
    if (active.length > 0) return null;
    const only = this.opts.only ? now.find((t) => t.task_id === this.opts.only) : undefined;
    if (only) {
      if (DONE.has(only.state)) return this.finish('pausado', `modo --solo: ${only.task_id} ${only.state}; el resto del plan sigue pendiente (forja run)`);
      if (NEEDS_USER.has(only.state)) return this.finish('bloqueado', `modo --solo: ${only.task_id} necesita atención (${only.state})`);
    }
    const ready = now.filter((t) => t.state === 'lista' && (!only || t.task_id === only.task_id));
    const starved = this.launcher.starvedForMs;
    if (ready.length > 0 && starved !== null && starved > 60_000) {
      return this.finish('pausado', 'no hay modelos disponibles (cuota agotada o sin sesión); vuelve a ejecutar más tarde');
    }
    if (ready.length === 0 && tasksReadyToUnblock(this.engine.store, this.runId).length === 0) {
      const attention = now.filter((t) => NEEDS_USER.has(t.state)).map((t) => `${t.task_id} (${t.state})`);
      return this.finish('bloqueado', attention.length ? `necesitan atención: ${attention.join(', ')}` : 'hay tareas cuyas dependencias no se pueden integrar');
    }
    return null;
  }

  private budgetExceeded(): boolean {
    const row = this.engine.store.db.prepare('SELECT COALESCE(SUM(cost_micro), 0) AS c FROM usage WHERE run_id = ?').get(this.runId) as { c: number };
    return row.c > this.engine.config.presupuesto.por_run_usd * 1_000_000;
  }

  private async finish(state: RunState, detail: string | null = null): Promise<RunSummary> {
    await this.jobs.settle();
    this.launchWatch.close();
    this.storeWatch.close();
    setRunState(this.engine, this.runId, state, detail);
    const counts: Record<string, number> = {};
    for (const t of this.ctx.tasks()) counts[t.state] = (counts[t.state] ?? 0) + 1;
    const deliveryBranch = state === 'completado' ? await new Delivery(this.ctx).deliver() : null;
    this.ctx.log(state === 'completado' ? `✔ run completado · rama ${deliveryBranch}` : `■ run ${state}${detail ? `: ${detail}` : ''}`);
    return { runId: this.runId, state, counts, branch: this.ctx.run.branch, deliveryBranch };
  }
}
