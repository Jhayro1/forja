import { TASK_CREATED, TASK_STATE_CHANGED } from '../domain/events.js';
import { checkTransition, type TaskState, type TransitionReason } from '../domain/task-state.js';
import type { EventStore, ExecuteResult, OutboxItem } from '../store/event-store.js';
import { getTask, listTasks } from '../store/projections.js';

export class DomainError extends Error {}

export function createTask(
  store: EventStore,
  requestId: string,
  input: { run_id: string; task_id: string; title: string; depends_on?: string[]; revision?: number; inherited_from?: string },
): ExecuteResult<{ task_id: string }> {
  return store.execute({ request_id: requestId, type: 'crear_tarea', input }, () => {
    if (getTask(store.db, input.run_id, input.task_id)) throw new DomainError(`la tarea ${input.task_id} ya existe`);
    const deps = input.depends_on ?? [];
    for (const dep of deps) {
      if (!getTask(store.db, input.run_id, dep)) throw new DomainError(`la dependencia ${dep} no existe en el run`);
    }
    return {
      result: { task_id: input.task_id },
      events: [
        {
          type: TASK_CREATED,
          aggregate_type: 'tarea',
          aggregate_id: `${input.run_id}/${input.task_id}`,
          aggregate_revision: input.revision ?? 1,
          run_id: input.run_id,
          task_id: input.task_id,
          payload: {
            title: input.title,
            depends_on: deps,
            initial_state: input.inherited_from ? 'integrada' : deps.length === 0 ? 'lista' : 'pendiente',
            ...(input.inherited_from ? { heredada_de: input.inherited_from } : {}),
          },
        },
      ],
    };
  });
}

export function changeTaskState(
  store: EventStore,
  requestId: string,
  input: { run_id: string; task_id: string; to: TaskState; reason: TransitionReason; detail?: string },
  outbox: OutboxItem[] = [],
): ExecuteResult<{ from: TaskState; to: TaskState }> {
  return store.execute({ request_id: requestId, type: 'cambiar_estado_tarea', input }, () => {
    const task = getTask(store.db, input.run_id, input.task_id);
    if (!task) throw new DomainError(`la tarea ${input.task_id} no existe`);
    const check = checkTransition(task.state, input.to, input.reason);
    if (!check.ok) throw new DomainError(check.error);
    if (input.to === 'lista' && input.reason === 'dependencias_integradas') {
      const pending = task.depends_on.filter((dep) => getTask(store.db, input.run_id, dep)?.state !== 'integrada');
      if (pending.length > 0) throw new DomainError(`dependencias sin integrar: ${pending.join(', ')}`);
    }
    return {
      result: { from: task.state, to: input.to },
      events: [
        {
          type: TASK_STATE_CHANGED,
          aggregate_type: 'tarea',
          aggregate_id: `${input.run_id}/${input.task_id}`,
          run_id: input.run_id,
          task_id: input.task_id,
          payload: { from: task.state, to: input.to, reason: input.reason, ...(input.detail ? { detail: input.detail } : {}) },
        },
      ],
      outbox,
    };
  });
}

/** Pending tasks whose dependencies are all integrated (invariant I04). */
export function tasksReadyToUnblock(store: EventStore, runId: string): string[] {
  const tasks = listTasks(store.db, runId);
  const state = new Map(tasks.map((t) => [t.task_id, t.state]));
  return tasks.filter((t) => t.state === 'pendiente' && t.depends_on.every((d) => state.get(d) === 'integrada')).map((t) => t.task_id);
}
