import type { Engine } from '../core/engine.js';
import type { StoredEvent } from '../domain/events.js';
import { newId } from '../domain/ids.js';
import type { Db } from '../store/sqlite.js';
import type { DbConnectionStore, DbConnectionView } from './connections.js';
import { type DbTarget, type QueryResult, readSchema, runChange, runRead, type TableInfo } from './driver.js';
import { checkSql, type SqlCheck, SqlRejected } from './sql-guard.js';

/**
 * The project's databases (docs/guias/BASES-DE-DATOS.md), with the user's rules:
 *  - the schema of every table: free;
 *  - reads: free or with approval, as the project chose (`lectura`);
 *  - CREATE TABLE and any change: only as a request with WHY and WHAT FOR, approved by
 *    the user — and a change only on a table Forja created (the registry below);
 *  - a table that already existed: never modified nor dropped, approved or not.
 * Everything is an event: who asked, what, why, the decision and the result.
 */
export const DB_EV = {
  linked: 'bd.vinculada',
  request: 'bd.solicitud_creada',
  decided: 'bd.solicitud_decidida',
  done: 'bd.solicitud_ejecutada',
  created: 'bd.tabla_creada',
  dropped: 'bd.tabla_eliminada',
} as const;
export const DB_TABLES = ['db_links', 'db_requests', 'db_objects'] as const;

export type ReadPolicy = 'preguntar' | 'libre';
export type DbLink = { conn: string; bases: string[]; lectura: ReadPolicy; pruebas: boolean; active: boolean };
export type RequestState = 'pendiente' | 'bloqueada' | 'rechazada' | 'ejecutada' | 'fallida';
export type DbRequest = {
  req_id: string;
  conn: string;
  base: string;
  kind: SqlCheck['kind'];
  sql: string;
  motivo: string | null;
  para_que: string | null;
  origin: string;
  run_id: string | null;
  task_id: string | null;
  tables: string[];
  state: RequestState;
  detail: string | null;
  result: QueryResult | null;
  created_at: string;
};
export type DbObject = { conn: string; base: string; name: string; created_by: string; req_id: string | null; created_at: string; dropped_at: string | null };
export type Origin = { who: string; run_id?: string | null; task_id?: string | null };

export class DbServiceError extends Error {}

export function applyDbEvent(db: Db, e: StoredEvent): void {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case DB_EV.linked:
      db.prepare(
        `INSERT INTO db_links (conn, bases, lectura, pruebas, active, updated_seq) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conn) DO UPDATE SET bases = excluded.bases, lectura = excluded.lectura, pruebas = excluded.pruebas, active = excluded.active, updated_seq = excluded.updated_seq`,
      ).run(String(p.conn), JSON.stringify(p.bases), String(p.lectura), p.pruebas ? 1 : 0, p.active ? 1 : 0, e.seq);
      return;
    case DB_EV.request:
      db.prepare(
        'INSERT INTO db_requests (req_id, conn, base, kind, sql, motivo, para_que, origin, run_id, task_id, tables, state, detail, result, created_at, updated_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      ).run(
        String(p.req_id),
        String(p.conn),
        String(p.base),
        String(p.kind),
        String(p.sql),
        (p.motivo as string | null) ?? null,
        (p.para_que as string | null) ?? null,
        String(p.origin),
        (p.run_id as string | null) ?? null,
        (p.task_id as string | null) ?? null,
        JSON.stringify(p.tables ?? []),
        String(p.state),
        (p.detail as string | null) ?? null,
        e.occurred_at,
        e.seq,
      );
      return;
    case DB_EV.decided:
    case DB_EV.done:
      db.prepare('UPDATE db_requests SET state = ?, detail = ?, result = COALESCE(?, result), updated_seq = ? WHERE req_id = ?').run(
        String(p.state),
        (p.detail as string | null) ?? null,
        (p.result as string | null) ?? null,
        e.seq,
        String(p.req_id),
      );
      return;
    case DB_EV.created:
      db.prepare(
        `INSERT INTO db_objects (conn, base, name, created_by, req_id, created_at, dropped_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(conn, base, name) DO UPDATE SET created_by = excluded.created_by, req_id = excluded.req_id, created_at = excluded.created_at, dropped_at = NULL`,
      ).run(String(p.conn), String(p.base), String(p.name), String(p.created_by), (p.req_id as string | null) ?? null, e.occurred_at);
      return;
    case DB_EV.dropped:
      db.prepare('UPDATE db_objects SET dropped_at = ? WHERE conn = ? AND base = ? AND name = ?').run(e.occurred_at, String(p.conn), String(p.base), String(p.name));
      return;
    default:
      return;
  }
}

/** Seams for tests: the real driver talks to MySQL/PostgreSQL. */
export type DbDriver = {
  read(t: DbTarget, sql: string): Promise<QueryResult>;
  change(t: DbTarget, sql: string): Promise<QueryResult>;
  schema(t: DbTarget): Promise<TableInfo[]>;
};
export const realDriver: DbDriver = { read: runRead, change: runChange, schema: readSchema };

const SCHEMA_TTL_MS = 60_000;
const RESULT_MAX_CHARS = 200_000;

export class DbService {
  private readonly schemaCache = new Map<string, { at: number; tables: TableInfo[] }>();

  constructor(
    private readonly engine: Engine,
    readonly store: DbConnectionStore,
    private readonly driver: DbDriver = realDriver,
  ) {}

  private get db(): Db {
    return this.engine.store.db;
  }

  private emit(type: string, aggregateId: string, payload: Record<string, unknown>, extra: { run_id?: string | null; task_id?: string | null } = {}): void {
    this.engine.store.execute({ request_id: newId('req'), type, input: { aggregateId } }, () => ({
      result: null,
      events: [{ type, aggregate_type: 'base_de_datos', aggregate_id: aggregateId, ...(extra.run_id ? { run_id: extra.run_id } : {}), ...(extra.task_id ? { task_id: extra.task_id } : {}), payload }],
    }));
  }

  // ---------- vínculos del proyecto

  links(): DbLink[] {
    const rows = this.db.prepare('SELECT conn, bases, lectura, pruebas, active FROM db_links ORDER BY conn').all() as {
      conn: string;
      bases: string;
      lectura: string;
      pruebas: number;
      active: number;
    }[];
    return rows.map((r) => ({ conn: r.conn, bases: JSON.parse(r.bases) as string[], lectura: r.lectura as ReadPolicy, pruebas: r.pruebas === 1, active: r.active === 1 }));
  }

  activeLinks(): DbLink[] {
    return this.links().filter((l) => l.active);
  }

  link(conn: string, opts: { bases?: string[]; lectura?: ReadPolicy; pruebas?: boolean }): DbLink {
    const c = this.store.get(conn);
    const bases = opts.bases?.length ? opts.bases : c.bases;
    for (const b of bases) if (!c.bases.includes(b)) throw new DbServiceError(`la conexión «${conn}» no tiene la base «${b}»`);
    const prev = this.links().find((l) => l.conn === conn);
    const next: DbLink = { conn, bases, lectura: opts.lectura ?? prev?.lectura ?? 'preguntar', pruebas: opts.pruebas ?? prev?.pruebas ?? false, active: true };
    this.emit(DB_EV.linked, `${conn}`, next);
    return next;
  }

  unlink(conn: string): void {
    const prev = this.links().find((l) => l.conn === conn);
    if (!prev?.active) throw new DbServiceError(`«${conn}» no está vinculada a este proyecto`);
    this.emit(DB_EV.linked, conn, { ...prev, active: false });
  }

  private linkFor(conn: string, base: string): { link: DbLink; view: DbConnectionView } {
    const link = this.activeLinks().find((l) => l.conn === conn);
    if (!link) throw new DbServiceError(`la conexión «${conn}» no está vinculada a este proyecto`);
    if (!link.bases.includes(base)) throw new DbServiceError(`la base «${base}» no está habilitada para este proyecto (${link.bases.join(', ')})`);
    return { link, view: this.store.get(conn) };
  }

  private target(view: DbConnectionView, base: string): DbTarget {
    return { conn: view, base, password: this.store.secrets(view.name).clave };
  }

  // ---------- esquema (libre)

  async schema(conn: string, base: string, fresh = false): Promise<TableInfo[]> {
    const { view } = this.linkFor(conn, base);
    const key = `${conn}/${base}`;
    const hit = this.schemaCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.tables;
    const tables = await this.driver.schema(this.target(view, base));
    this.schemaCache.set(key, { at: Date.now(), tables });
    return tables;
  }

  /** Tables Forja created in this project (the only ones a change may touch), still present. */
  objects(includeDropped = false): DbObject[] {
    return this.db.prepare(`SELECT * FROM db_objects ${includeDropped ? '' : 'WHERE dropped_at IS NULL'} ORDER BY created_at DESC`).all() as DbObject[];
  }

  private ownsTable(conn: string, base: string, name: string): boolean {
    return this.db.prepare('SELECT 1 FROM db_objects WHERE conn = ? AND base = ? AND name = ? AND dropped_at IS NULL').get(conn, base, name) !== undefined;
  }

  /** Why a checked statement cannot run here, or null. Asked when proposed AND right before executing. */
  private async blockedReason(conn: string, base: string, check: SqlCheck): Promise<string | null> {
    if (check.kind === 'lectura') return null;
    if (check.kind === 'crear') {
      const existing = new Set((await this.schema(conn, base, true)).map((t) => t.table));
      const clash = check.targets.find((t) => existing.has(t) && !this.ownsTable(conn, base, t));
      return clash ? `«${clash}» ya existe y no la creó Forja: no se toca` : null;
    }
    const foreign = check.targets.find((t) => !this.ownsTable(conn, base, t));
    return foreign ? `«${foreign}» no la creó Forja en este proyecto: sólo se modifican o borran tablas creadas durante el desarrollo` : null;
  }

  // ---------- solicitudes

  requests(state?: RequestState): DbRequest[] {
    const rows = (
      state ? this.db.prepare('SELECT * FROM db_requests WHERE state = ? ORDER BY created_at DESC').all(state) : this.db.prepare('SELECT * FROM db_requests ORDER BY created_at DESC LIMIT 200').all()
    ) as (Omit<DbRequest, 'tables' | 'result'> & { tables: string; result: string | null })[];
    return rows.map((r) => ({ ...r, tables: JSON.parse(r.tables) as string[], result: r.result ? (JSON.parse(r.result) as QueryResult) : null }));
  }

  get(reqId: string): DbRequest {
    const row = this.db.prepare('SELECT * FROM db_requests WHERE req_id = ?').get(reqId) as (Omit<DbRequest, 'tables' | 'result'> & { tables: string; result: string | null }) | undefined;
    if (!row) throw new DbServiceError(`no existe la solicitud ${reqId}`);
    return { ...row, tables: JSON.parse(row.tables) as string[], result: row.result ? (JSON.parse(row.result) as QueryResult) : null };
  }

  /**
   * A read. With `lectura: libre` it runs now and returns the rows; otherwise it waits
   * for the user's approval (the agent checks it later with the request id).
   */
  async query(origin: Origin, input: { conn: string; base: string; sql: string; motivo?: string | null }): Promise<DbRequest> {
    const { link } = this.linkFor(input.conn, input.base);
    const check = this.check(input.conn, input.base, input.sql);
    if (check.kind !== 'lectura') throw new DbServiceError('eso no es una consulta de lectura: pídelo como cambio, con su motivo');
    const req = this.record(origin, input, check, { motivo: input.motivo ?? null, para_que: null }, 'pendiente', null);
    if (link.lectura === 'libre') return this.execute(req.req_id);
    return req;
  }

  /** CREATE TABLE or a change: always a request with why and what for, approved by the user. */
  async requestChange(origin: Origin, input: { conn: string; base: string; sql: string; motivo: string; para_que: string }): Promise<DbRequest> {
    this.linkFor(input.conn, input.base);
    if (input.motivo.trim().length < 10 || input.para_que.trim().length < 5) throw new DbServiceError('explica por qué hace falta (motivo) y para qué se usará (para_que)');
    const check = this.check(input.conn, input.base, input.sql);
    if (check.kind === 'lectura') throw new DbServiceError('una consulta de lectura va por bd_consultar, no como cambio');
    const blocked = await this.blockedReason(input.conn, input.base, check);
    return this.record(origin, input, check, { motivo: input.motivo.trim(), para_que: input.para_que.trim() }, blocked ? 'bloqueada' : 'pendiente', blocked);
  }

  private check(conn: string, base: string, sql: string): SqlCheck {
    try {
      return checkSql(sql, this.store.get(conn).motor, base);
    } catch (error) {
      if (error instanceof SqlRejected) throw new DbServiceError(`no permitido: ${error.message}`);
      throw error;
    }
  }

  private record(
    origin: Origin,
    input: { conn: string; base: string; sql: string },
    check: SqlCheck,
    why: { motivo: string | null; para_que: string | null },
    state: RequestState,
    detail: string | null,
  ): DbRequest {
    const reqId = newId('bdq');
    this.emit(
      DB_EV.request,
      reqId,
      {
        req_id: reqId,
        conn: input.conn,
        base: input.base,
        kind: check.kind,
        sql: check.statement,
        motivo: why.motivo,
        para_que: why.para_que,
        origin: origin.who,
        run_id: origin.run_id ?? null,
        task_id: origin.task_id ?? null,
        tables: check.targets,
        state,
        detail,
      },
      origin,
    );
    return this.get(reqId);
  }

  reject(reqId: string, reason: string): DbRequest {
    const r = this.get(reqId);
    if (r.state !== 'pendiente') throw new DbServiceError(`la solicitud está ${r.state}`);
    this.emit(DB_EV.decided, reqId, { req_id: reqId, state: 'rechazada', detail: reason.trim().slice(0, 500) || 'rechazada' });
    return this.get(reqId);
  }

  /** The user approved: rules are checked again (the registry or the database may have changed), then it runs. */
  async approve(reqId: string): Promise<DbRequest> {
    const r = this.get(reqId);
    if (r.state !== 'pendiente') throw new DbServiceError(`la solicitud está ${r.state}`);
    return this.execute(reqId);
  }

  private async execute(reqId: string): Promise<DbRequest> {
    const r = this.get(reqId);
    const { view } = this.linkFor(r.conn, r.base);
    const check = this.check(r.conn, r.base, r.sql);
    const blocked = await this.blockedReason(r.conn, r.base, check);
    if (blocked) {
      this.emit(DB_EV.done, reqId, { req_id: reqId, state: 'bloqueada', detail: blocked });
      return this.get(reqId);
    }
    try {
      const t = this.target(view, r.base);
      const result = check.kind === 'lectura' ? await this.driver.read(t, r.sql) : await this.driver.change(t, r.sql);
      let json = JSON.stringify(result);
      if (json.length > RESULT_MAX_CHARS) json = JSON.stringify({ ...result, rows: result.rows.slice(0, 20), truncated: true });
      this.emit(DB_EV.done, reqId, { req_id: reqId, state: 'ejecutada', detail: null, result: json });
      if (check.kind === 'crear') for (const name of check.targets) this.emit(DB_EV.created, `${r.conn}/${r.base}/${name}`, { conn: r.conn, base: r.base, name, created_by: r.origin, req_id: reqId });
      if (check.verb === 'DROP TABLE') for (const name of check.targets) this.emit(DB_EV.dropped, `${r.conn}/${r.base}/${name}`, { conn: r.conn, base: r.base, name });
      if (check.kind !== 'lectura') this.schemaCache.delete(`${r.conn}/${r.base}`);
    } catch (error) {
      this.emit(DB_EV.done, reqId, { req_id: reqId, state: 'fallida', detail: (error as Error).message.slice(0, 500) });
    }
    return this.get(reqId);
  }

  /** Variables for the project's test commands (never for an agent), from links with `pruebas`. */
  testEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const l of this.activeLinks().filter((x) => x.pruebas)) {
      try {
        Object.assign(out, this.store.secrets(l.conn).variables);
      } catch {
        // A connection removed after linking contributes nothing.
      }
    }
    return out;
  }

  /** Short schema of every linked database, for the planner (names and types, no data). */
  async schemaForPrompt(maxChars = 60_000): Promise<object | null> {
    const links = this.activeLinks();
    if (!links.length) return null;
    const out: { conexion: string; base: string; motor: string; tablas?: string[]; error?: string; tablas_creadas_por_forja: string[] }[] = [];
    for (const l of links) {
      for (const base of l.bases) {
        const own = this.objects()
          .filter((o) => o.conn === l.conn && o.base === base)
          .map((o) => o.name);
        try {
          const tables = await this.schema(l.conn, base);
          out.push({
            conexion: l.conn,
            base,
            motor: this.store.get(l.conn).motor,
            tablas: tables.map((t) => `${t.table}(${t.columns.map((c) => `${c.name} ${c.type}${c.key === 'PRI' ? ' PK' : ''}`).join(', ')})`),
            tablas_creadas_por_forja: own,
          });
        } catch (error) {
          out.push({ conexion: l.conn, base, motor: '?', error: (error as Error).message.slice(0, 200), tablas_creadas_por_forja: own });
        }
      }
    }
    let text = JSON.stringify(out);
    while (text.length > maxChars && out.some((o) => (o.tablas?.length ?? 0) > 0)) {
      for (const o of out) if (o.tablas?.length) o.tablas = o.tablas.slice(0, Math.floor(o.tablas.length * 0.7));
      text = JSON.stringify(out);
    }
    return {
      nota: 'Bases de datos del proyecto. Puedes consultar el esquema y leer datos; crear tablas o cambiar datos sólo con una solicitud aprobada por el usuario, y sólo sobre tablas creadas por Forja. Las tablas que ya existían nunca se modifican.',
      bases: out,
    };
  }
}
