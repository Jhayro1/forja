import { matchesGlob } from 'node:path';
import { z } from 'zod';
import type { StoredEvent } from '../domain/events.js';
import { newId } from '../domain/ids.js';
import type { PlanTask } from '../plan/plan.js';
import type { EventStore } from '../store/event-store.js';
import type { Db } from '../store/sqlite.js';

/**
 * Lessons learned (V2-062 · memoria revisada). A lesson is a PROPOSAL with
 * evidence and scope; it never promotes itself: a human approves or rejects
 * it. Approved lessons are context for workers, below approved decisions, and
 * never change policy, permissions or verification.
 */

export const LEV = { proposed: 'memoria.leccion_propuesta', reviewed: 'memoria.leccion_revisada' } as const;

const Scope = z.object({ tipo: z.string().nullable(), archivos: z.array(z.string()) }).strict();
const Proposed = z.object({ text: z.string().min(1).max(1000), scope: Scope, evidence: z.record(z.string(), z.unknown()) }).strict();
const Reviewed = z.object({ state: z.enum(['aprobada', 'rechazada']), actor: z.string(), note: z.string() }).strict();

export type Lesson = { lesson_id: string; text: string; scope: z.infer<typeof Scope>; evidence: Record<string, unknown>; state: 'propuesta' | 'aprobada' | 'rechazada'; reviewed_by: string | null; note: string | null; created_at: string };

export function applyMemoryEvent(db: Db, e: StoredEvent): void {
  if (e.type === LEV.proposed) {
    const p = Proposed.parse(e.payload);
    db.prepare("INSERT INTO lessons (lesson_id, text, scope, evidence, state, created_at, updated_seq) VALUES (?, ?, ?, ?, 'propuesta', ?, ?)").run(e.aggregate_id, p.text, JSON.stringify(p.scope), JSON.stringify(p.evidence), e.recorded_at, e.seq);
  } else if (e.type === LEV.reviewed) {
    const p = Reviewed.parse(e.payload);
    db.prepare('UPDATE lessons SET state = ?, reviewed_by = ?, note = ?, updated_seq = ? WHERE lesson_id = ?').run(p.state, p.actor, p.note, e.seq, e.aggregate_id);
  }
}

export const MEMORY_TABLES = ['lessons'] as const;

export class LessonError extends Error {}

export class LessonService {
  constructor(private readonly store: EventStore) {}

  list(state?: Lesson['state']): Lesson[] {
    const rows = this.store.db.prepare(`SELECT * FROM lessons ${state ? 'WHERE state = ?' : ''} ORDER BY created_at DESC`).all(...(state ? [state] : [])) as (Omit<Lesson, 'scope' | 'evidence'> & { scope: string; evidence: string })[];
    return rows.map((r) => ({ ...r, scope: JSON.parse(r.scope), evidence: JSON.parse(r.evidence) }));
  }

  get(id: string): Lesson {
    const l = this.list().find((x) => x.lesson_id === id);
    if (!l) throw new LessonError(`no existe la lección ${id}`);
    return l;
  }

  /** Idempotent per evidence key: the same resolved failure never yields two proposals. */
  propose(text: string, scope: Lesson['scope'], evidence: Record<string, unknown>, key: string): string {
    const id = newId('lec');
    const r = this.store.execute({ request_id: `leccion:${key}`, type: LEV.proposed, input: { key } }, () => ({
      result: id,
      events: [{ type: LEV.proposed, aggregate_type: 'leccion', aggregate_id: id, payload: { text: text.slice(0, 1000), scope, evidence } }],
    }));
    return r.result;
  }

  review(id: string, approve: boolean, actor: string, note: string): Lesson {
    const l = this.get(id);
    if (l.state !== 'propuesta') throw new LessonError(`la lección ya está ${l.state}`);
    this.store.execute({ request_id: newId('req'), type: LEV.reviewed, input: { id } }, () => ({
      result: null,
      events: [{ type: LEV.reviewed, aggregate_type: 'leccion', aggregate_id: id, payload: { state: approve ? 'aprobada' : 'rechazada', actor, note } }],
    }));
    return this.get(id);
  }

  /** Approved lessons whose scope touches this task (same type or overlapping files). */
  forTask(task: PlanTask): Lesson[] {
    const mine = [...task.escribe, ...task.lee];
    return this.list('aprobada').filter(
      (l) => l.scope.tipo === task.tipo || l.scope.archivos.some((f) => mine.some((g) => f === g || matchesGlob(f, g) || matchesGlob(g, f))),
    );
  }
}
