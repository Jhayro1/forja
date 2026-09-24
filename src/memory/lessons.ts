import { existsSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { z } from 'zod';
import type { StoredEvent } from '../domain/events.js';
import { newId } from '../domain/ids.js';
import type { PlanTask } from '../plan/plan.js';
import type { EventStore } from '../store/event-store.js';
import type { Db } from '../store/sqlite.js';
import { blobHash } from './build.js';

/**
 * Lessons learned (V2-062 · memoria revisada). A lesson is a PROPOSAL with
 * evidence and scope; it never promotes itself: a human approves or rejects
 * it. Approved lessons are context for workers, below approved decisions, and
 * never change policy, permissions or verification.
 */

export const LEV = { proposed: 'memoria.leccion_propuesta', reviewed: 'memoria.leccion_revisada' } as const;

const Scope = z.object({ tipo: z.string().nullable(), archivos: z.array(z.string()) }).strict();
const Proposed = z.object({ text: z.string().min(1).max(1000), scope: Scope, evidence: z.record(z.string(), z.unknown()) }).strict();
/** `hashes`: content of the scope's files when a human approved it (a later change makes the lesson «a revisar»). */
const Reviewed = z.object({ state: z.enum(['aprobada', 'rechazada']), actor: z.string(), note: z.string(), hashes: z.record(z.string(), z.string().nullable()).optional() }).strict();

export type Lesson = {
  lesson_id: string;
  text: string;
  scope: z.infer<typeof Scope>;
  evidence: Record<string, unknown>;
  state: 'propuesta' | 'aprobada' | 'rechazada';
  reviewed_by: string | null;
  note: string | null;
  created_at: string;
  /** File hashes of the scope at approval (null for lessons approved before MEJORAS 5.7). */
  hashes: Record<string, string | null> | null;
};

/** Current content hash of a project file (null: it does not exist). */
export type HashOf = (path: string) => string | null;

export function applyMemoryEvent(db: Db, e: StoredEvent): void {
  if (e.type === LEV.proposed) {
    const p = Proposed.parse(e.payload);
    db.prepare("INSERT INTO lessons (lesson_id, text, scope, evidence, state, created_at, updated_seq) VALUES (?, ?, ?, ?, 'propuesta', ?, ?)").run(
      e.aggregate_id,
      p.text,
      JSON.stringify(p.scope),
      JSON.stringify(p.evidence),
      e.recorded_at,
      e.seq,
    );
  } else if (e.type === LEV.reviewed) {
    const p = Reviewed.parse(e.payload);
    db.prepare('UPDATE lessons SET state = ?, reviewed_by = ?, note = ?, hashes = ?, updated_seq = ? WHERE lesson_id = ?').run(
      p.state,
      p.actor,
      p.note,
      p.hashes ? JSON.stringify(p.hashes) : null,
      e.seq,
      e.aggregate_id,
    );
  }
}

export const MEMORY_TABLES = ['lessons'] as const;

export class LessonError extends Error {}

export class LessonService {
  constructor(private readonly store: EventStore) {}

  list(state?: Lesson['state']): Lesson[] {
    const rows = this.store.db.prepare(`SELECT * FROM lessons ${state ? 'WHERE state = ?' : ''} ORDER BY created_at DESC`).all(...(state ? [state] : [])) as (Omit<
      Lesson,
      'scope' | 'evidence' | 'hashes'
    > & {
      scope: string;
      evidence: string;
      hashes: string | null;
    })[];
    return rows.map((r) => ({ ...r, scope: JSON.parse(r.scope), evidence: JSON.parse(r.evidence), hashes: r.hashes ? JSON.parse(r.hashes) : null }));
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

  /** `hashOf`: to record the scope's files as they are now (the lesson expires when they change). */
  review(id: string, approve: boolean, actor: string, note: string, hashOf?: HashOf): Lesson {
    const l = this.get(id);
    if (l.state !== 'propuesta') throw new LessonError(`la lección ya está ${l.state}`);
    this.emitReview(id, approve ? 'aprobada' : 'rechazada', actor, note, approve ? hashOf : undefined, l);
    return this.get(id);
  }

  /** A human checked a lesson «a revisar» again: it applies with the files as they are now. */
  revalidate(id: string, actor: string, note: string, hashOf: HashOf): Lesson {
    const l = this.get(id);
    if (l.state !== 'aprobada') throw new LessonError(`sólo se revalida una lección aprobada (está ${l.state})`);
    this.emitReview(id, 'aprobada', actor, note, hashOf, l);
    return this.get(id);
  }

  private emitReview(id: string, state: 'aprobada' | 'rechazada', actor: string, note: string, hashOf: HashOf | undefined, l: Lesson): void {
    const hashes = hashOf ? Object.fromEntries(l.scope.archivos.map((f) => [f, hashOf(f)])) : undefined;
    this.store.execute({ request_id: newId('req'), type: LEV.reviewed, input: { id } }, () => ({
      result: null,
      events: [{ type: LEV.reviewed, aggregate_type: 'leccion', aggregate_id: id, payload: { state, actor, note, ...(hashes ? { hashes } : {}) } }],
    }));
  }

  /** Files of the lesson's scope that changed since a human approved it (MEJORAS 5.7). */
  staleFiles(l: Lesson, hashOf: HashOf): string[] {
    if (!l.hashes) return [];
    return Object.entries(l.hashes)
      .filter(([f, h]) => hashOf(f) !== h)
      .map(([f]) => f);
  }

  /**
   * Approved decisions that talk about the same things as the lesson: a POSSIBLE
   * contradiction for a human to read, never an automatic verdict (MEJORAS 5.7).
   */
  conflicts(l: Lesson, decisions: { id: string; texto: string; estado: string }[]): { id: string; texto: string; comunes: string[] }[] {
    const mine = new Set(significantWords(l.text));
    return decisions
      .filter((d) => d.estado === 'aprobada')
      .map((d) => ({ id: d.id, texto: d.texto, comunes: [...new Set(significantWords(d.texto))].filter((w) => mine.has(w)) }))
      .filter((d) => d.comunes.length >= 2);
  }

  /**
   * Approved lessons whose scope touches this task (same type or overlapping
   * files). With `hashOf`, lessons whose files changed since approval are left
   * out until a human revalidates them.
   */
  forTask(task: PlanTask, hashOf?: HashOf): Lesson[] {
    const mine = [...task.escribe, ...task.lee];
    return this.list('aprobada')
      .filter((l) => l.scope.tipo === task.tipo || l.scope.archivos.some((f) => mine.some((g) => f === g || matchesGlob(f, g) || matchesGlob(g, f))))
      .filter((l) => !hashOf || this.staleFiles(l, hashOf).length === 0);
  }
}

const STOP = new Set([
  'para',
  'como',
  'desde',
  'sobre',
  'entre',
  'cuando',
  'donde',
  'porque',
  'pero',
  'este',
  'esta',
  'estos',
  'estas',
  'tiene',
  'tener',
  'debe',
  'deben',
  'puede',
  'pueden',
  'cada',
  'todo',
  'todos',
  'tarea',
  'tareas',
  'intento',
  'primer',
  'cuenta',
  'fallo',
  'resolvio',
  'tenlo',
]);

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

/** Hashes files of a folder (a checkout or a task worktree) for lesson approval and expiry. */
export function hashFilesIn(root: string): HashOf {
  return (path) => {
    const full = join(root, path);
    return existsSync(full) ? blobHash(readFileSync(full)) : null;
  };
}
