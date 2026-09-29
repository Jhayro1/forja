import { z } from 'zod';
import type { Engine } from '../core/engine.js';
import type { StoredEvent } from '../domain/events.js';
import { newId } from '../domain/ids.js';
import type { Db } from '../store/sqlite.js';

/**
 * Epics group sprints (v3/PLAN.md §3): Épica → Sprint (a change) → Historia (a use case)
 * → Tarea. An epic is an objective with a closing criterion; a sprint belongs to at most
 * one epic and carries a priority and an optional TARGET date (never a promise).
 */
export const EPIC_EV = { created: 'epica.creada', edited: 'epica.editada', assigned: 'sprint.asignado' } as const;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha AAAA-MM-DD');

export const EpicInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().max(2000).default(''),
    target_date: Day.nullable().default(null),
  })
  .strict();
const EpicEdit = EpicInput.partial()
  .extend({ state: z.enum(['abierta', 'cerrada']).optional() })
  .strict();
const Assign = z.object({ epic_id: z.string().nullable(), priority: z.number().int().min(0).max(1000).default(0), target_date: Day.nullable().default(null) }).strict();

export type Epic = { epic_id: string; title: string; goal: string; state: 'abierta' | 'cerrada'; target_date: string | null; created_at: string };
export type SprintLink = { change_id: string; epic_id: string | null; priority: number; target_date: string | null };

export function applyWorkEvent(db: Db, e: StoredEvent): void {
  if (e.type === EPIC_EV.created) {
    const p = EpicInput.parse(e.payload);
    db.prepare("INSERT OR IGNORE INTO epics (epic_id, title, goal, state, target_date, created_at, updated_seq) VALUES (?, ?, ?, 'abierta', ?, ?, ?)").run(
      e.aggregate_id,
      p.title,
      p.goal,
      p.target_date,
      e.occurred_at,
      e.seq,
    );
  } else if (e.type === EPIC_EV.edited) {
    const p = EpicEdit.parse(e.payload);
    const keys = (['title', 'goal', 'target_date', 'state'] as const).filter((k) => p[k] !== undefined);
    if (keys.length) db.prepare(`UPDATE epics SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_seq = ? WHERE epic_id = ?`).run(...keys.map((k) => p[k] as string | null), e.seq, e.aggregate_id);
  } else if (e.type === EPIC_EV.assigned) {
    const p = Assign.parse(e.payload);
    db.prepare(
      `INSERT INTO change_epics (change_id, epic_id, priority, target_date, updated_seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(change_id) DO UPDATE SET epic_id = excluded.epic_id, priority = excluded.priority, target_date = excluded.target_date, updated_seq = excluded.updated_seq`,
    ).run(e.aggregate_id, p.epic_id, p.priority, p.target_date, e.seq);
  }
}

export const WORK_TABLES = ['change_epics', 'epics'] as const;

export class EpicService {
  constructor(private readonly engine: Engine) {}

  private get db(): Db {
    return this.engine.store.db;
  }

  list(): Epic[] {
    return this.db.prepare("SELECT epic_id, title, goal, state, target_date, created_at FROM epics ORDER BY state = 'cerrada', created_at").all() as Epic[];
  }

  get(id: string): Epic | null {
    return (this.db.prepare('SELECT epic_id, title, goal, state, target_date, created_at FROM epics WHERE epic_id = ?').get(id) as Epic | undefined) ?? null;
  }

  links(): SprintLink[] {
    return this.db.prepare('SELECT change_id, epic_id, priority, target_date FROM change_epics').all() as SprintLink[];
  }

  create(input: z.input<typeof EpicInput>): Epic {
    const p = EpicInput.parse(input);
    const id = newId('epi');
    this.engine.store.execute({ request_id: newId('req'), type: 'crear_epica', input: { id } }, () => ({
      result: null,
      events: [{ type: EPIC_EV.created, aggregate_type: 'epica', aggregate_id: id, payload: p }],
    }));
    return this.get(id)!;
  }

  edit(id: string, patch: z.input<typeof EpicEdit>): Epic {
    if (!this.get(id)) throw new Error(`no existe la épica ${id}`);
    const p = EpicEdit.parse(patch);
    this.engine.store.execute({ request_id: newId('req'), type: 'editar_epica', input: { id } }, () => ({
      result: null,
      events: [{ type: EPIC_EV.edited, aggregate_type: 'epica', aggregate_id: id, payload: p }],
    }));
    return this.get(id)!;
  }

  /** Puts a sprint (change) in an epic, or takes it out with `epic_id: null`. */
  assign(changeId: string, input: z.input<typeof Assign>): SprintLink {
    const p = Assign.parse(input);
    if (!this.db.prepare('SELECT 1 FROM changes WHERE change_id = ?').get(changeId)) throw new Error(`no existe el sprint ${changeId}`);
    if (p.epic_id && !this.get(p.epic_id)) throw new Error(`no existe la épica ${p.epic_id}`);
    this.engine.store.execute({ request_id: newId('req'), type: 'asignar_sprint', input: { changeId } }, () => ({
      result: null,
      events: [{ type: EPIC_EV.assigned, aggregate_type: 'cambio', aggregate_id: changeId, payload: p }],
    }));
    return { change_id: changeId, ...p };
  }
}
