import { newId } from '../domain/ids.js';
import { TERMINAL_STATES, type TaskState, type TransitionReason } from '../domain/task-state.js';
import { changeTaskState } from '../core/task-commands.js';
import { allowedModels, type Engine } from '../core/engine.js';
import { cancelLaunch } from '../runtime/launcher.js';
import { getTask, listTasks, type TaskRow } from '../store/projections.js';
import { RunError, getExec, patchExec } from './records.js';

/**
 * User control over single tasks (v2/10): answer, unblock, pause, resume and
 * reassign. Each one is an event; the ones that need to stop a process are a
 * request (`control = pausar`) that whoever runs the run applies when it is safe.
 */

const move = (engine: Engine, runId: string, taskId: string, to: TaskState, reason: TransitionReason, detail?: string) =>
  changeTaskState(engine.store, newId('req'), { run_id: runId, task_id: taskId, to, reason, ...(detail ? { detail } : {}) });

function taskOrFail(engine: Engine, runId: string, taskId: string): TaskRow {
  const t = getTask(engine.store.db, runId, taskId);
  if (!t) throw new RunError(`no existe la tarea ${taskId} en el run ${runId}`);
  return t;
}

/** Answer to a worker's question: the task goes back to the queue with the answer in its context. */
export function answerTaskQuestion(engine: Engine, runId: string, taskId: string, answer: string): void {
  const t = getTask(engine.store.db, runId, taskId);
  if (!t || t.state !== 'esperando_respuesta') throw new RunError(`la tarea ${taskId} no está esperando una respuesta`);
  patchExec(engine, runId, taskId, { answer }, 'responder_tarea');
  move(engine, runId, taskId, 'lista', 'causa_resuelta');
}

/** Retry a blocked task from scratch counting (explicit user decision). */
export function unblockTask(engine: Engine, runId: string, taskId: string, note: string | null): void {
  const t = getTask(engine.store.db, runId, taskId);
  if (!t || t.state !== 'bloqueada') throw new RunError(`la tarea ${taskId} no está bloqueada`);
  patchExec(engine, runId, taskId, { quality_failures: 0, env_failures: 0, ...(note ? { feedback: note } : {}) }, 'desbloquear_tarea');
  move(engine, runId, taskId, 'lista', 'causa_resuelta');
}

const PAUSABLE: ReadonlySet<TaskState> = new Set(['pendiente', 'lista', 'reservada', 'ejecutando', 'verificando', 'verificada', 'integrando']);

export type PauseResult = { immediate: boolean };

/**
 * Pauses a task. One that has not started pauses at once; one with a process or
 * a verification in flight gets a request applied by `applyTaskControls`.
 */
export function requestPause(engine: Engine, runId: string, taskId: string): PauseResult {
  const t = taskOrFail(engine, runId, taskId);
  if (t.state === 'pausada') throw new RunError(`la tarea ${taskId} ya está pausada`);
  if (!PAUSABLE.has(t.state)) throw new RunError(`la tarea ${taskId} está ${t.state}: no hay nada que pausar`);
  patchExec(engine, runId, taskId, { control: 'pausar' }, 'pausar_tarea');
  if (t.state === 'pendiente' || t.state === 'lista') {
    applyTaskControls(engine, runId, new Set());
    return { immediate: true };
  }
  return { immediate: false };
}

/**
 * Applies pending pause requests to tasks nobody is working on right now
 * (`busy`: tasks with a job in flight in this process). Safe to call from the
 * orchestrator on every tick and from the CLI when no run process is active.
 */
export function applyTaskControls(engine: Engine, runId: string, busy: ReadonlySet<string>): string[] {
  const paused: string[] = [];
  for (const t of listTasks(engine.store.db, runId)) {
    const exec = getExec(engine, runId, t.task_id);
    if (exec.control !== 'pausar' || busy.has(t.task_id)) continue;
    if (TERMINAL_STATES.has(t.state) || t.state === 'bloqueada' || t.state === 'esperando_respuesta' || t.state === 'pausada') {
      patchExec(engine, runId, t.task_id, { control: null }, 'pausar_tarea');
      continue;
    }
    if (t.state === 'ejecutando' && exec.launch_dir) cancelLaunch(exec.launch_dir);
    const reason: TransitionReason = t.state === 'pendiente' || t.state === 'lista' ? 'pausa_usuario' : 'pausa_confirmada';
    patchExec(engine, runId, t.task_id, {
      control: `pausada:${t.state}`,
      ...(t.state === 'ejecutando' ? { feedback: 'La tarea se pausó mientras trabajabas. Tu trabajo parcial sigue en el directorio: revísalo y termínala.' } : {}),
    }, 'pausar_tarea');
    move(engine, runId, t.task_id, 'pausada', reason, 'pausada por el usuario');
    paused.push(t.task_id);
  }
  return paused;
}

/** Resumes a paused task where it can continue (a verified candidate is re-verified on the current tip). */
export function resumeTask(engine: Engine, runId: string, taskId: string): TaskState {
  const t = taskOrFail(engine, runId, taskId);
  const exec = getExec(engine, runId, taskId);
  if (t.state !== 'pausada') {
    if (exec.control === 'pausar') {
      patchExec(engine, runId, taskId, { control: null }, 'reanudar_tarea');
      return t.state;
    }
    throw new RunError(`la tarea ${taskId} no está pausada (${t.state})`);
  }
  const from = exec.control?.startsWith('pausada:') ? (exec.control.slice('pausada:'.length) as TaskState) : 'lista';
  const hadCandidate = ['verificando', 'verificada', 'integrando'].includes(from) && exec.candidate_sha !== null;
  const depsDone = t.depends_on.every((d) => getTask(engine.store.db, runId, d)?.state === 'integrada');
  const to: TaskState = hadCandidate ? 'verificando' : depsDone ? 'lista' : 'pendiente';
  patchExec(engine, runId, taskId, { control: null }, 'reanudar_tarea');
  move(engine, runId, taskId, to, 'causa_resuelta', 'reanudada por el usuario');
  return to;
}

/**
 * Pins a task to another model the policy allows (any role of forja.yaml). It
 * applies from the next attempt; `null` returns to the role's configured order.
 */
export function reassignTask(engine: Engine, runId: string, taskId: string, ref: string | null): void {
  const t = taskOrFail(engine, runId, taskId);
  if (TERMINAL_STATES.has(t.state)) throw new RunError(`la tarea ${taskId} ya terminó (${t.state})`);
  if (ref !== null) {
    const allowed = allowedModels(engine);
    if (!allowed.includes(ref)) throw new RunError(`«${ref}» no está permitido por la política (roles de forja.yaml): ${allowed.join(', ')}`);
  }
  patchExec(engine, runId, taskId, { pinned_model: ref }, 'reasignar_tarea');
}
