import type { Db } from './sqlite.js';
import { transaction } from './sqlite.js';

/**
 * Ordered, append-only list. Never edit a released migration: add a new one.
 * Events are never rewritten destructively to change their schema (v2/03).
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    seq                INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id           TEXT NOT NULL UNIQUE,
    schema_version     INTEGER NOT NULL,
    checkout_id        TEXT NOT NULL,
    occurred_at        TEXT NOT NULL,
    recorded_at        TEXT NOT NULL,
    type               TEXT NOT NULL,
    aggregate_type     TEXT NOT NULL,
    aggregate_id       TEXT NOT NULL,
    aggregate_revision INTEGER NOT NULL,
    correlation_id     TEXT,
    causation_id       TEXT,
    command_id         TEXT,
    run_id             TEXT,
    task_id            TEXT,
    attempt_id         TEXT,
    launch_id          TEXT,
    payload            TEXT NOT NULL
  );
  CREATE INDEX events_aggregate ON events(aggregate_type, aggregate_id, seq);
  CREATE INDEX events_run ON events(run_id, seq);

  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'los eventos son inmutables'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'los eventos son inmutables'); END;

  CREATE TABLE commands (
    request_id   TEXT PRIMARY KEY,
    command_type TEXT NOT NULL,
    input_hash   TEXT NOT NULL,
    result       TEXT NOT NULL,
    first_seq    INTEGER,
    last_seq     INTEGER,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE outbox (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_seq     INTEGER NOT NULL REFERENCES events(seq),
    kind          TEXT NOT NULL,
    payload       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'tomada', 'hecha')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    available_at  TEXT NOT NULL,
    claimed_until TEXT
  );
  CREATE INDEX outbox_pending ON outbox(status, available_at);

  CREATE TABLE tasks (
    run_id       TEXT NOT NULL,
    task_id      TEXT NOT NULL,
    title        TEXT NOT NULL,
    state        TEXT NOT NULL,
    depends_on   TEXT NOT NULL,
    last_reason  TEXT,
    revision     INTEGER NOT NULL,
    updated_seq  INTEGER NOT NULL,
    PRIMARY KEY (run_id, task_id)
  );
  CREATE INDEX tasks_state ON tasks(run_id, state);
  `,
];

export const CURRENT_SCHEMA = MIGRATIONS.length;

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  if (current > CURRENT_SCHEMA) {
    throw new Error(
      `la base de datos es de una versión más nueva de Forja (esquema ${current}, esta versión conoce ${CURRENT_SCHEMA}); actualiza Forja`,
    );
  }
  for (let v = current; v < CURRENT_SCHEMA; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        String(v + 1),
      );
    });
  }
}
