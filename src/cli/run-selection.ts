import { currentChange, type RunSnapshot, runSnapshot, type TaskView } from '../run/snapshot.js';
import { CliError, EXIT } from './context.js';
import type { EngineContext } from './engine-context.js';

/** The current change's snapshot, or a clear error when there is nothing yet. */
export function snapshotOrFail(ctx: EngineContext): RunSnapshot {
  const change = currentChange(ctx.engine);
  if (!change) throw new CliError('no hay cambios todavía: empieza con forja planear', EXIT.precondition);
  return runSnapshot(ctx.engine, change);
}

export function taskOrFail(s: RunSnapshot, id: string): TaskView {
  if (!s.run) throw new CliError('el cambio todavía no tiene un run: ejecuta forja run', EXIT.precondition);
  const task = s.tasks.find((t) => t.id === id.toUpperCase());
  if (!task) throw new CliError(`no existe la tarea ${id} en el run ${s.run.run_id}`, EXIT.input);
  return task;
}

export const domainError = (error: unknown) => new CliError((error as Error).message, EXIT.precondition);
