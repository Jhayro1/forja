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
  `
  -- M2: changes (increments), discovery, spec, plan, approvals, usage.
  CREATE TABLE changes (
    change_id          TEXT PRIMARY KEY,
    title              TEXT NOT NULL,
    mode               TEXT NOT NULL CHECK (mode IN ('idea', 'mejora')),
    phase              TEXT NOT NULL,
    discovery_revision INTEGER NOT NULL DEFAULT 0,
    spec_revision      INTEGER NOT NULL DEFAULT 0,
    plan_revision      INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_seq        INTEGER NOT NULL
  );

  CREATE TABLE discovery (
    change_id  TEXT PRIMARY KEY REFERENCES changes(change_id),
    revision   INTEGER NOT NULL,
    state      TEXT NOT NULL,
    approved_revision INTEGER
  );

  CREATE TABLE planner_turns (
    turn_id      TEXT PRIMARY KEY,
    change_id    TEXT NOT NULL REFERENCES changes(change_id),
    n            INTEGER NOT NULL,
    user_text    TEXT,
    planner_text TEXT NOT NULL,
    provider     TEXT NOT NULL,
    model        TEXT,
    created_seq  INTEGER NOT NULL
  );
  CREATE INDEX planner_turns_change ON planner_turns(change_id, n);

  CREATE TABLE specs (
    change_id TEXT NOT NULL REFERENCES changes(change_id),
    revision  INTEGER NOT NULL,
    hash      TEXT NOT NULL,
    spec      TEXT NOT NULL,
    PRIMARY KEY (change_id, revision)
  );

  CREATE TABLE plans (
    plan_id   TEXT NOT NULL,
    change_id TEXT NOT NULL REFERENCES changes(change_id),
    revision  INTEGER NOT NULL,
    hash      TEXT NOT NULL,
    plan      TEXT NOT NULL,
    PRIMARY KEY (plan_id, revision)
  );

  CREATE TABLE approvals (
    approval_id TEXT PRIMARY KEY,
    change_id   TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_hash TEXT NOT NULL,
    state       TEXT NOT NULL,
    approval    TEXT NOT NULL
  );

  CREATE TABLE usage (
    launch_id    TEXT PRIMARY KEY,
    change_id    TEXT,
    run_id       TEXT,
    task_id      TEXT,
    role         TEXT NOT NULL,
    provider     TEXT NOT NULL,
    model        TEXT,
    input        INTEGER,
    output       INTEGER,
    cache_read   INTEGER,
    cache_write  INTEGER,
    cost_micro   INTEGER,
    created_at   TEXT NOT NULL
  );
  `,
  `
  -- User answers to open questions of a spec (incorporated in the next revision).
  CREATE TABLE spec_answers (
    change_id   TEXT NOT NULL REFERENCES changes(change_id),
    question_id TEXT NOT NULL,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    answered_seq INTEGER NOT NULL,
    PRIMARY KEY (change_id, question_id)
  );
  `,
  `
  -- M3: runs and per-task execution state.
  CREATE TABLE runs (
    run_id        TEXT PRIMARY KEY,
    change_id     TEXT NOT NULL,
    plan_id       TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    plan_hash     TEXT NOT NULL,
    approval_id   TEXT NOT NULL,
    state         TEXT NOT NULL,
    base_sha      TEXT NOT NULL,
    branch        TEXT NOT NULL,
    detail        TEXT,
    created_at    TEXT NOT NULL,
    updated_seq   INTEGER NOT NULL
  );

  CREATE TABLE task_exec (
    run_id           TEXT NOT NULL,
    task_id          TEXT NOT NULL,
    attempt          INTEGER NOT NULL DEFAULT 0,
    quality_failures INTEGER NOT NULL DEFAULT 0,
    level            TEXT,
    launch_id        TEXT,
    launch_dir       TEXT,
    worktree         TEXT,
    provider         TEXT,
    model            TEXT,
    base_sha         TEXT,
    candidate_sha    TEXT,
    integrated_sha   TEXT,
    files            TEXT,
    feedback         TEXT,
    last_error       TEXT,
    question         TEXT,
    answer           TEXT,
    steps            TEXT,
    updated_seq      INTEGER NOT NULL,
    PRIMARY KEY (run_id, task_id)
  );
  `,
  `
  -- M5: connections linked to this checkout and external actions (v2/06).
  CREATE TABLE connection_links (
    connection  TEXT PRIMARY KEY,
    version     INTEGER NOT NULL,
    operations  TEXT NOT NULL,
    active      INTEGER NOT NULL,
    updated_seq INTEGER NOT NULL
  );

  CREATE TABLE actions (
    action_id          TEXT PRIMARY KEY,
    type               TEXT NOT NULL,
    connection         TEXT NOT NULL,
    connection_version INTEGER NOT NULL,
    params             TEXT NOT NULL,
    preview            TEXT NOT NULL,
    hash               TEXT NOT NULL,
    idempotency_key    TEXT NOT NULL,
    origin             TEXT NOT NULL,
    expires_at         TEXT NOT NULL,
    state              TEXT NOT NULL,
    approved_by        TEXT,
    attempts           INTEGER NOT NULL DEFAULT 0,
    result             TEXT,
    created_seq        INTEGER NOT NULL,
    updated_seq        INTEGER NOT NULL
  );
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
