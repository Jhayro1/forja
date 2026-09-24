import { EVENT_SCHEMA_VERSION, EventInput, type StoredEvent } from '../domain/events.js';
import { hashJson } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import { migrate } from './migrations.js';
import { PROJECTION_TABLES, applyEvent } from './projections.js';
import { openDatabase, transaction, type Db } from './sqlite.js';

export type Command = {
  /** Idempotency key: the same request_id with the same input returns the first result. */
  request_id: string;
  type: string;
  input: unknown;
};

export type OutboxItem = {
  kind: string;
  payload: Record<string, unknown>;
  /** Index into `events` this order belongs to; defaults to the last event. */
  event_index?: number;
};

export type HandlerOutput<R> = { result: R; events: EventInput[]; outbox?: OutboxItem[] };

export type ExecuteResult<R> = { result: R; duplicated: boolean; events: StoredEvent[] };

export type ClaimedOrder = { id: number; event_seq: number; kind: string; payload: Record<string, unknown>; attempts: number };

export class CommandConflictError extends Error {}

type EventRow = Omit<StoredEvent, 'payload'> & { payload: string };

export class EventStore {
  private constructor(
    readonly db: Db,
    readonly checkoutId: string,
    private readonly now: () => Date,
  ) {}

  static open(path: string, checkoutId: string, now: () => Date = () => new Date()): EventStore {
    const db = openDatabase(path);
    migrate(db);
    return new EventStore(db, checkoutId, now);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Validates, appends events, updates projections, records outbox orders and the
   * command result in ONE transaction. Spawning processes or touching Git never
   * happens here: those are outbox orders executed afterwards (v2/05).
   */
  execute<R>(command: Command, handler: () => HandlerOutput<R>): ExecuteResult<R> {
    const inputHash = hashJson({ type: command.type, input: command.input ?? null });
    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM commands WHERE request_id = ?').get(command.request_id) as
        | { command_type: string; input_hash: string; result: string; first_seq: number | null; last_seq: number | null }
        | undefined;
      if (previous) {
        if (previous.input_hash !== inputHash || previous.command_type !== command.type) {
          throw new CommandConflictError(`la solicitud ${command.request_id} ya se usó con otro contenido`);
        }
        const events = previous.first_seq === null ? [] : this.eventsBetween(previous.first_seq, previous.last_seq!);
        return { result: JSON.parse(previous.result) as R, duplicated: true, events };
      }

      const output = handler();
      const stored: StoredEvent[] = [];
      for (const raw of output.events) {
        const event = this.append(EventInput.parse(raw), command.request_id);
        applyEvent(this.db, event);
        stored.push(event);
      }
      for (const order of output.outbox ?? []) {
        const target = stored[order.event_index ?? stored.length - 1];
        if (!target) throw new Error('una orden del outbox necesita al menos un evento');
        this.db
          .prepare('INSERT INTO outbox (event_seq, kind, payload, available_at) VALUES (?, ?, ?, ?)')
          .run(target.seq, order.kind, JSON.stringify(order.payload), this.now().toISOString());
      }
      this.db
        .prepare('INSERT INTO commands (request_id, command_type, input_hash, result, first_seq, last_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          command.request_id,
          command.type,
          inputHash,
          JSON.stringify(output.result ?? null),
          stored[0]?.seq ?? null,
          stored.at(-1)?.seq ?? null,
          this.now().toISOString(),
        );
      return { result: output.result, duplicated: false, events: stored };
    });
  }

  private append(input: ReturnType<typeof EventInput.parse>, commandId: string): StoredEvent {
    const recordedAt = this.now().toISOString();
    const row = {
      event_id: newId('evt'),
      schema_version: EVENT_SCHEMA_VERSION,
      checkout_id: this.checkoutId,
      occurred_at: input.occurred_at ?? recordedAt,
      recorded_at: recordedAt,
      type: input.type,
      aggregate_type: input.aggregate_type,
      aggregate_id: input.aggregate_id,
      aggregate_revision: input.aggregate_revision,
      correlation_id: input.correlation_id ?? null,
      causation_id: input.causation_id ?? null,
      command_id: commandId,
      run_id: input.run_id ?? null,
      task_id: input.task_id ?? null,
      attempt_id: input.attempt_id ?? null,
      launch_id: input.launch_id ?? null,
    };
    const info = this.db
      .prepare(
        `INSERT INTO events (event_id, schema_version, checkout_id, occurred_at, recorded_at, type, aggregate_type, aggregate_id,
           aggregate_revision, correlation_id, causation_id, command_id, run_id, task_id, attempt_id, launch_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.event_id,
        row.schema_version,
        row.checkout_id,
        row.occurred_at,
        row.recorded_at,
        row.type,
        row.aggregate_type,
        row.aggregate_id,
        row.aggregate_revision,
        row.correlation_id,
        row.causation_id,
        row.command_id,
        row.run_id,
        row.task_id,
        row.attempt_id,
        row.launch_id,
        JSON.stringify(input.payload),
      );
    return { seq: Number(info.lastInsertRowid), ...row, payload: input.payload };
  }

  events(afterSeq = 0, limit = 1000): StoredEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(afterSeq, limit) as EventRow[];
    return rows.map(toEvent);
  }

  private eventsBetween(first: number, last: number): StoredEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq').all(first, last) as EventRow[];
    return rows.map(toEvent);
  }

  /** Drops projections and replays every event in order. */
  rebuildProjections(): void {
    transaction(this.db, () => {
      for (const table of PROJECTION_TABLES) this.db.exec(`DELETE FROM ${table}`);
      let after = 0;
      for (;;) {
        const batch = this.events(after, 500);
        if (batch.length === 0) break;
        for (const event of batch) applyEvent(this.db, event);
        after = batch.at(-1)!.seq;
      }
    });
  }

  /**
   * Takes pending orders for `leaseMs`. An order whose lease expired becomes
   * claimable again: the executor must make each order idempotent (v2/05).
   */
  claimOutbox(leaseMs: number, limit = 10): ClaimedOrder[] {
    return transaction(this.db, () => {
      const now = this.now();
      const nowIso = now.toISOString();
      const rows = this.db
        .prepare(
          `SELECT id, event_seq, kind, payload, attempts FROM outbox
           WHERE (status = 'pendiente' AND available_at <= ?) OR (status = 'tomada' AND claimed_until <= ?)
           ORDER BY id LIMIT ?`,
        )
        .all(nowIso, nowIso, limit) as { id: number; event_seq: number; kind: string; payload: string; attempts: number }[];
      const until = new Date(now.getTime() + leaseMs).toISOString();
      const claim = this.db.prepare("UPDATE outbox SET status = 'tomada', claimed_until = ?, attempts = attempts + 1 WHERE id = ?");
      return rows.map((r) => {
        claim.run(until, r.id);
        return { id: r.id, event_seq: r.event_seq, kind: r.kind, payload: JSON.parse(r.payload) as Record<string, unknown>, attempts: r.attempts + 1 };
      });
    });
  }

  completeOutbox(id: number): void {
    this.db.prepare("UPDATE outbox SET status = 'hecha', claimed_until = NULL WHERE id = ?").run(id);
  }
}

function toEvent(row: EventRow): StoredEvent {
  return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}
