import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../domain/ids.js';
import type { TaskState, TransitionReason } from '../../domain/task-state.js';
import { changeTaskState } from '../../core/task-commands.js';
import type { Engine } from '../../core/engine.js';
import type { Plan, PlanTask } from '../../plan/plan.js';
import { ClaudeAdapter, CodexAdapter } from '../../providers/adapters.js';
import { secretsFromFile } from '../../runtime/runner.js';
import { Redactor } from '../../security/redact.js';
import { latestSpec } from '../../spec/generate.js';
import type { Spec } from '../../spec/spec.js';
import { listTasks, type TaskRow } from '../../store/projections.js';
import type { CommandContext } from '../../verify/commands.js';
import { RunError, getExec, getRun, patchExec, type ExecPatch, type ExecRow, type RunRow } from '../records.js';

/** How many environment failures in a row a task tolerates before it is blocked (MEJORAS 4.6). */
export const MAX_ENV_FAILURES = 3;

/**
 * Everything the pipeline stages share about one run: the frozen plan and spec
 * it executes, and the only primitives that write (`exec`, `move`). Stages get
 * this object instead of the orchestrator, so each can be tested alone.
 */
export class RunContext {
  readonly run: RunRow;
  readonly plan: Plan;
  readonly spec: Spec;
  readonly cmd: CommandContext;
  readonly redactor = new Redactor();

  constructor(
    readonly engine: Engine,
    readonly repoPath: string,
    runId: string,
    opts: { sandbox?: boolean; onLog?: (line: string) => void } = {},
  ) {
    const run = getRun(engine, runId);
    if (!run) throw new RunError(`no existe el run ${runId}`);
    this.run = run;
    const planRow = engine.store.db.prepare('SELECT plan FROM plans WHERE plan_id = ? AND revision = ?').get(run.plan_id, run.plan_revision) as { plan: string };
    this.plan = JSON.parse(planRow.plan) as Plan;
    this.spec = latestSpec(engine, run.change_id)!.spec;
    this.cmd = { dataDir: engine.dataDir, sandbox: opts.sandbox ?? true, timeoutMs: engine.config.ejecucion.timeout_min * 60_000, ...(engine.runnerScript ? { runnerScript: engine.runnerScript } : {}) };
    this.onLog = opts.onLog;
    for (const f of [ClaudeAdapter.credentialFile(), CodexAdapter.credentialFile()]) {
      if (existsSync(f)) for (const v of secretsFromFile(f)) this.redactor.add({ name: 'credencial_proveedor', value: v });
    }
  }

  private readonly onLog: ((line: string) => void) | undefined;

  get runId(): string {
    return this.run.run_id;
  }

  log(line: string): void {
    this.onLog?.(line);
  }

  task(id: string): PlanTask {
    return this.plan.tareas.find((t) => t.id === id)!;
  }

  tasks(): TaskRow[] {
    return listTasks(this.engine.store.db, this.run.run_id);
  }

  execOf(taskId: string): ExecRow {
    return getExec(this.engine, this.run.run_id, taskId);
  }

  exec(taskId: string, patch: ExecPatch): void {
    patchExec(this.engine, this.run.run_id, taskId, patch);
  }

  move(taskId: string, to: TaskState, reason: TransitionReason, detail?: string): void {
    changeTaskState(this.engine.store, newId('req'), { run_id: this.run.run_id, task_id: taskId, to, reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
  }

  dir(...parts: string[]): string {
    return join(this.engine.dataDir, 'worktrees', this.run.run_id, ...parts);
  }

  /** The agent's work did not meet the bar: retry with feedback, escalating; block after the configured attempts. */
  qualityFailure(taskId: string, feedback: string): void {
    const exec = this.execOf(taskId);
    const failures = exec.quality_failures + 1;
    const first = feedback.split('\n')[0]!;
    this.exec(taskId, { quality_failures: failures, feedback: feedback.slice(0, 8000), last_error: first.slice(0, 300) });
    const max = this.engine.config.ejecucion.intentos_calidad;
    if (failures >= max) {
      this.move(taskId, 'bloqueada', 'bloqueo', `falló ${failures} veces: ${first}`);
      this.log(`✘ ${taskId} bloqueada tras ${failures} intentos`);
    } else {
      this.move(taskId, 'lista', 'fallo_calidad', first);
      this.log(`↻ ${taskId} reintenta (${failures}/${max}): ${first.slice(0, 120)}`);
    }
  }

  /**
   * The environment failed (install, sandbox, a moving integration ref): retry
   * without escalating the model, but only a few times in a row — an
   * environment that does not fix itself must reach the user, not loop.
   */
  environmentFailure(taskId: string, what: string, extra: ExecPatch = {}): void {
    const failures = this.execOf(taskId).env_failures + 1;
    this.exec(taskId, { ...extra, env_failures: failures, last_error: what.slice(0, 500) });
    if (failures >= MAX_ENV_FAILURES) {
      this.move(taskId, 'bloqueada', 'bloqueo', `el entorno falló ${failures} veces seguidas: ${what}`);
      this.log(`✘ ${taskId} bloqueada: el entorno falló ${failures} veces seguidas (${what.slice(0, 160)})`);
    } else {
      this.move(taskId, 'lista', 'fallo_entorno', what);
      this.log(`⚠ ${taskId}: ${what.slice(0, 200)} (entorno ${failures}/${MAX_ENV_FAILURES}; se reintenta sin escalar)`);
    }
  }
}
