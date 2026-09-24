import { AEV } from '../store/action-projections.js';
import type { Db } from '../store/sqlite.js';

export type AuditRow = { seq: number; cuando: string; que: string; sobre: string; detalle: string };

const AUDIT_TYPES = Object.values(AEV);

/** Chronological audit of connection/MCP/action events, human-readable (never secret values: none are stored). */
export function auditTrail(db: Db, limit: number): AuditRow[] {
  const rows = db
    .prepare(`SELECT seq, recorded_at, type, aggregate_id, payload FROM events WHERE type IN (${AUDIT_TYPES.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT ?`)
    .all(...AUDIT_TYPES, limit) as { seq: number; recorded_at: string; type: string; aggregate_id: string; payload: string }[];
  return rows.reverse().map((r) => {
    const p = JSON.parse(r.payload) as Record<string, any>;
    const detalle =
      r.type === AEV.linked ? `v${p.version}: ${p.operations.join(', ')}`
      : r.type === AEV.proposed ? `${p.type} ${String(p.preview?.peticion ?? '')} · origen ${p.origin}`
      : r.type === AEV.approved ? `por ${p.actor}`
      : r.type === AEV.discarded ? `por ${p.actor}: ${p.reason}`
      : r.type === AEV.executing ? `intento ${p.attempt}`
      : r.type === AEV.result ? `${p.state}: ${p.detail}`
      : r.type === AEV.reconciled ? `${p.state} por ${p.actor}: ${p.note}`
      : '';
    return { seq: r.seq, cuando: r.recorded_at.slice(0, 19).replace('T', ' '), que: r.type, sobre: r.aggregate_id, detalle };
  });
}
