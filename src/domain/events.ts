import { z } from 'zod';
import { TASK_STATES } from './task-state.js';

export const EVENT_SCHEMA_VERSION = 1;

/** Envelope from v2/formatos/estado-y-protocolos.md (seq and recorded_at are set by the store). */
export const EventInput = z
  .object({
    type: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
    aggregate_type: z.string().min(1),
    aggregate_id: z.string().min(1),
    aggregate_revision: z.number().int().nonnegative().default(0),
    occurred_at: z.iso.datetime().optional(),
    correlation_id: z.string().optional(),
    causation_id: z.string().optional(),
    run_id: z.string().optional(),
    task_id: z.string().optional(),
    attempt_id: z.string().optional(),
    launch_id: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EventInput = z.input<typeof EventInput>;

export type StoredEvent = {
  seq: number;
  event_id: string;
  schema_version: number;
  checkout_id: string;
  occurred_at: string;
  recorded_at: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_revision: number;
  correlation_id: string | null;
  causation_id: string | null;
  command_id: string | null;
  run_id: string | null;
  task_id: string | null;
  attempt_id: string | null;
  launch_id: string | null;
  payload: Record<string, unknown>;
};

// Payloads of the events the core projections understand. Unknown types are
// stored and replayed but ignored by projections.
export const TaskCreatedPayload = z
  .object({
    title: z.string().min(1),
    depends_on: z.array(z.string()).default([]),
    initial_state: z.enum(['pendiente', 'lista']).default('pendiente'),
  })
  .strict();

export const TaskStateChangedPayload = z
  .object({
    from: z.enum(TASK_STATES),
    to: z.enum(TASK_STATES),
    reason: z.string(),
    detail: z.string().optional(),
  })
  .strict();

export const TASK_CREATED = 'tarea.creada';
export const TASK_STATE_CHANGED = 'tarea.estado_cambiado';
