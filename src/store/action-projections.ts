import { z } from 'zod';
import type { StoredEvent } from '../domain/events.js';
import type { Db } from './sqlite.js';

/** Events of connections and external actions (M5). Unknown types are ignored. */
export const AEV = {
  linked: 'conexion.vinculada',
  unlinked: 'conexion.desvinculada',
  proposed: 'accion.propuesta',
  approved: 'accion.aprobada',
  discarded: 'accion.descartada',
  executing: 'accion.ejecutando',
  result: 'accion.resultado',
  reconciled: 'accion.conciliada',
} as const;

export const ACTION_STATES = ['propuesta', 'aprobada', 'descartada', 'ejecutando', 'confirmada', 'rechazada', 'desconocido', 'sin_efecto'] as const;
export type ActionState = (typeof ACTION_STATES)[number];

const Linked = z.object({ connection: z.string(), version: z.number().int(), operations: z.array(z.string()) }).strict();
const Proposed = z
  .object({
    type: z.string(),
    connection: z.string(),
    connection_version: z.number().int(),
    params: z.record(z.string(), z.unknown()),
    preview: z.record(z.string(), z.unknown()),
    hash: z.string(),
    idempotency_key: z.string(),
    origin: z.string(),
    expires_at: z.string(),
  })
  .strict();
const Approved = z.object({ hash: z.string(), actor: z.string() }).strict();
const Discarded = z.object({ actor: z.string(), reason: z.string() }).strict();
const Executing = z.object({ attempt: z.number().int().positive() }).strict();
const Result = z.object({ state: z.enum(['confirmada', 'rechazada', 'desconocido', 'sin_efecto']), detail: z.string(), evidence: z.record(z.string(), z.unknown()) }).strict();
const Reconciled = z.object({ state: z.enum(['confirmada', 'sin_efecto']), actor: z.string(), note: z.string() }).strict();

export function applyActionEvent(db: Db, e: StoredEvent): void {
  const id = e.aggregate_id;
  switch (e.type) {
    case AEV.linked: {
      const p = Linked.parse(e.payload);
      db.prepare(
        `INSERT INTO connection_links (connection, version, operations, active, updated_seq) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(connection) DO UPDATE SET version = excluded.version, operations = excluded.operations, active = 1, updated_seq = excluded.updated_seq`,
      ).run(p.connection, p.version, JSON.stringify(p.operations), e.seq);
      return;
    }
    case AEV.unlinked:
      db.prepare('UPDATE connection_links SET active = 0, updated_seq = ? WHERE connection = ?').run(e.seq, id);
      return;
    case AEV.proposed: {
      const p = Proposed.parse(e.payload);
      db.prepare(
        `INSERT INTO actions (action_id, type, connection, connection_version, params, preview, hash, idempotency_key, origin, expires_at, state, created_seq, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'propuesta', ?, ?)`,
      ).run(id, p.type, p.connection, p.connection_version, JSON.stringify(p.params), JSON.stringify(p.preview), p.hash, p.idempotency_key, p.origin, p.expires_at, e.seq, e.seq);
      return;
    }
    case AEV.approved: {
      const p = Approved.parse(e.payload);
      db.prepare("UPDATE actions SET state = 'aprobada', approved_by = ?, updated_seq = ? WHERE action_id = ?").run(p.actor, e.seq, id);
      return;
    }
    case AEV.discarded:
      Discarded.parse(e.payload);
      db.prepare("UPDATE actions SET state = 'descartada', result = ?, updated_seq = ? WHERE action_id = ?").run(JSON.stringify(e.payload), e.seq, id);
      return;
    case AEV.executing: {
      const p = Executing.parse(e.payload);
      db.prepare("UPDATE actions SET state = 'ejecutando', attempts = ?, updated_seq = ? WHERE action_id = ?").run(p.attempt, e.seq, id);
      return;
    }
    case AEV.result: {
      const p = Result.parse(e.payload);
      db.prepare('UPDATE actions SET state = ?, result = ?, updated_seq = ? WHERE action_id = ?').run(p.state, JSON.stringify(p), e.seq, id);
      return;
    }
    case AEV.reconciled: {
      const p = Reconciled.parse(e.payload);
      db.prepare('UPDATE actions SET state = ?, result = ?, updated_seq = ? WHERE action_id = ?').run(p.state, JSON.stringify({ ...p, conciliada: true }), e.seq, id);
      return;
    }
    default:
      return;
  }
}

export const ACTION_TABLES = ['actions', 'connection_links'] as const;
