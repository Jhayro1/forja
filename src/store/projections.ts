import type { StoredEvent } from '../domain/events.js';
import { TASK_CREATED, TASK_STATE_CHANGED, TaskCreatedPayload, TaskStateChangedPayload } from '../domain/events.js';
import { checkTransition, type TaskState, type TransitionReason } from '../domain/task-state.js';
import { ACTION_TABLES, applyActionEvent } from './action-projections.js';
import { PLANNING_TABLES, applyPlanningEvent } from './planning-projections.js';
import type { Db } from './sqlite.js';

export type TaskRow = {
  run_id: string;
  task_id: string;
  title: string;
  state: TaskState;
  depends_on: string[];
  last_reason: string | null;
  revision: number;
  updated_seq: number;
};

export class ProjectionError extends Error {}

/** Current row as the store sees it, used by command handlers to validate before emitting. */
export function getTask(db: Db, runId: string, taskId: string): TaskRow | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE run_id = ? AND task_id = ?').get(runId, taskId) as
    | (Omit<TaskRow, 'depends_on'> & { depends_on: string })
    | undefined;
  return row ? { ...row, depends_on: JSON.parse(row.depends_on) as string[] } : undefined;
}

export function listTasks(db: Db, runId: string): TaskRow[] {
  const rows = db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id').all(runId) as (Omit<TaskRow, 'depends_on'> & {
    depends_on: string;
  })[];
  return rows.map((r) => ({ ...r, depends_on: JSON.parse(r.depends_on) as string[] }));
}

/**
 * Pure function of (current projection, event). Replay uses only stored data:
 * no clock, no Git, no network (v2/formatos/estado-y-protocolos.md).
 */
export function applyEvent(db: Db, event: StoredEvent): void {
  switch (event.type) {
    case TASK_CREATED: {
      const p = TaskCreatedPayload.parse(event.payload);
      if (!event.run_id || !event.task_id) throw new ProjectionError('tarea.creada sin run_id/task_id');
      if (getTask(db, event.run_id, event.task_id)) throw new ProjectionError(`la tarea ${event.task_id} ya existe`);
      db.prepare(
        'INSERT INTO tasks (run_id, task_id, title, state, depends_on, last_reason, revision, updated_seq) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
      ).run(event.run_id, event.task_id, p.title, p.initial_state, JSON.stringify(p.depends_on), event.aggregate_revision, event.seq);
      return;
    }
    case TASK_STATE_CHANGED: {
      const p = TaskStateChangedPayload.parse(event.payload);
      if (!event.run_id || !event.task_id) throw new ProjectionError('tarea.estado_cambiado sin run_id/task_id');
      const task = getTask(db, event.run_id, event.task_id);
      if (!task) throw new ProjectionError(`la tarea ${event.task_id} no existe`);
      if (task.state !== p.from) throw new ProjectionError(`la tarea ${event.task_id} está en ${task.state}, no en ${p.from}`);
      const check = checkTransition(p.from, p.to, p.reason as TransitionReason);
      if (!check.ok) throw new ProjectionError(check.error);
      db.prepare('UPDATE tasks SET state = ?, last_reason = ?, updated_seq = ? WHERE run_id = ? AND task_id = ?').run(
        p.to,
        p.reason,
        event.seq,
        event.run_id,
        event.task_id,
      );
      return;
    }
    default:
      // Each feature projects its own events and ignores the rest.
      applyPlanningEvent(db, event);
      applyActionEvent(db, event);
      return;
  }
}

export const PROJECTION_TABLES = ['tasks', ...PLANNING_TABLES, ...ACTION_TABLES] as const;
