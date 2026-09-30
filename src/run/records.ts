import type { Engine } from '../core/engine.js';
import { newId } from '../domain/ids.js';
import { EV, type RunState } from '../store/planning-projections.js';

/** Read side of runs and per-task execution rows (projections of run/task events). */

export class RunError extends Error {}

export type RunRow = {
  run_id: string;
  change_id: string;
  plan_id: string;
  plan_revision: number;
  plan_hash: string;
  approval_id: string;
  state: RunState;
  base_sha: string;
  branch: string;
  detail: string | null;
  created_at: string;
};

export type ExecRow = {
  run_id: string;
  task_id: string;
  attempt: number;
  quality_failures: number;
  /** Environment failures in a row (install, sandbox, integration races): bounded like launches. */
  env_failures: number;
  level: string | null;
  launch_id: string | null;
  launch_dir: string | null;
  worktree: string | null;
  provider: string | null;
  model: string | null;
  base_sha: string | null;
  candidate_sha: string | null;
  integrated_sha: string | null;
  files: string | null;
  feedback: string | null;
  last_error: string | null;
  question: string | null;
  answer: string | null;
  steps: string | null;
  /** User control on the task: `pausar` (requested) or `pausada:<state it was paused from>`. */
  control: string | null;
  /** Model the user pinned with `forja reasignar` (`proveedor:modelo`), instead of the role's order. */
  pinned_model: string | null;
  /** Provider account the last attempt ran on (v3 §4.9); null = the CLI's default session. */
  account: string | null;
  /** What the agent says it did, in product language (shown on the board). */
  summary: string | null;
  /** The agent's session in the last attempt, to continue it in the next task of a block. */
  session_id: string | null;
  /** How full that session's context was at its last turn (tokens). */
  context_tokens: number | null;
};

const EMPTY_EXEC: Omit<ExecRow, 'run_id' | 'task_id'> = {
  attempt: 0,
  quality_failures: 0,
  env_failures: 0,
  level: null,
  launch_id: null,
  launch_dir: null,
  worktree: null,
  provider: null,
  model: null,
  base_sha: null,
  candidate_sha: null,
  integrated_sha: null,
  files: null,
  feedback: null,
  last_error: null,
  question: null,
  answer: null,
  steps: null,
  control: null,
  pinned_model: null,
  account: null,
  summary: null,
  session_id: null,
  context_tokens: null,
};

export type ExecPatch = Partial<Omit<ExecRow, 'run_id' | 'task_id'>>;

export function getRun(engine: Engine, runId: string): RunRow | undefined {
  return engine.store.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined;
}

export function runsOf(engine: Engine, changeId: string): RunRow[] {
  return engine.store.db.prepare('SELECT * FROM runs WHERE change_id = ? ORDER BY created_at DESC').all(changeId) as RunRow[];
}

export function getExec(engine: Engine, runId: string, taskId: string): ExecRow {
  const row = engine.store.db.prepare('SELECT * FROM task_exec WHERE run_id = ? AND task_id = ?').get(runId, taskId) as ExecRow | undefined;
  return row ?? { run_id: runId, task_id: taskId, ...EMPTY_EXEC };
}

/** Appends a patch of the task's execution row (an event: the row is its projection). */
export function patchExec(engine: Engine, runId: string, taskId: string, patch: ExecPatch, requestType = 'ejecucion_tarea'): void {
  engine.store.execute({ request_id: newId('req'), type: requestType, input: { taskId } }, () => ({
    result: null,
    events: [{ type: EV.taskExec, aggregate_type: 'tarea', aggregate_id: `${runId}/${taskId}`, run_id: runId, task_id: taskId, payload: patch }],
  }));
}

export function setRunState(engine: Engine, runId: string, to: RunState, detail: string | null = null): void {
  const run = getRun(engine, runId);
  if (!run || run.state === to) return;
  engine.store.execute({ request_id: newId('req'), type: 'estado_run', input: { runId, to } }, () => ({
    result: null,
    events: [{ type: EV.runState, aggregate_type: 'run', aggregate_id: runId, payload: { from: run.state, to, detail } }],
  }));
}
