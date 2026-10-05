import type { DbConnectionView } from './connections.js';

/**
 * Talks to the database from Forja's own process — never from an agent. Every read runs
 * inside a READ ONLY transaction that is rolled back (the database's own barrier behind
 * the SQL guard), with a statement time limit and a cap on the rows returned.
 */
export type DbTarget = { conn: DbConnectionView; base: string; password: string | null };
export type QueryResult = { columns: string[]; rows: unknown[][]; total: number; truncated: boolean; affected: number | null };
export type TableInfo = { table: string; columns: { name: string; type: string; nullable: boolean; key: string | null /** Foreign key: `tabla.columna` it points to. */; ref?: string }[] };
/** One table or view of a database, without its rows: what `forja bd ver` shows. */
export type TableSummary = { table: string; kind: 'tabla' | 'vista'; rows: number | null; exact: boolean; bytes: number | null; comment: string | null };
export type DbOverview = { version: string; serverBases: string[]; tables: TableSummary[] };

export const MAX_ROWS = 200;
const TIMEOUT_MS = 20_000;

export class DbDriverError extends Error {}

/** Values safe to put in JSON and show: dates as ISO, buffers as a note, big numbers as text. */
function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && v.length > 2000) return `${v.slice(0, 2000)}…`;
  return v;
}

function shape(columns: string[], raw: Record<string, unknown>[] | unknown[][], affected: number | null): QueryResult {
  const rows = (raw as unknown[]).map((r) => (Array.isArray(r) ? r.map(cell) : columns.map((c) => cell((r as Record<string, unknown>)[c]))));
  return { columns, rows: rows.slice(0, MAX_ROWS), total: rows.length, truncated: rows.length > MAX_ROWS, affected };
}

async function withMysql<T>(t: DbTarget, fn: (c: import('mysql2/promise').Connection) => Promise<T>): Promise<T> {
  const mysql = await import('mysql2/promise');
  let conn: import('mysql2/promise').Connection;
  try {
    conn = await mysql.createConnection({
      host: t.conn.host,
      port: t.conn.port,
      user: t.conn.usuario,
      ...(t.password ? { password: t.password } : {}),
      database: t.base,
      connectTimeout: 10_000,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      ...(t.conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  } catch (error) {
    throw new DbDriverError(`no se pudo conectar a ${t.conn.host}:${t.conn.port}/${t.base}: ${(error as Error).message}`);
  }
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function withPg<T>(t: DbTarget, fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
  const pg = await import('pg');
  const client = new pg.default.Client({
    host: t.conn.host,
    port: t.conn.port,
    user: t.conn.usuario,
    ...(t.password ? { password: t.password } : {}),
    database: t.base,
    connectionTimeoutMillis: 10_000,
    statement_timeout: TIMEOUT_MS,
    ...(t.conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  try {
    await client.connect();
  } catch (error) {
    throw new DbDriverError(`no se pudo conectar a ${t.conn.host}:${t.conn.port}/${t.base}: ${(error as Error).message}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** A read, in a READ ONLY transaction that is always rolled back. */
export async function runRead(t: DbTarget, sql: string): Promise<QueryResult> {
  if (t.conn.motor === 'mysql') {
    return withMysql(t, async (c) => {
      await c.query(`SET SESSION max_execution_time = ${TIMEOUT_MS}`).catch(() => undefined);
      await c.query('START TRANSACTION READ ONLY');
      try {
        const [rows, fields] = await c.query({ sql, rowsAsArray: true, timeout: TIMEOUT_MS });
        const columns = Array.isArray(fields) ? fields.map((f) => f.name) : [];
        return shape(columns, Array.isArray(rows) ? (rows as unknown[][]) : [], null);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  }
  return withPg(t, async (c) => {
    await c.query('BEGIN READ ONLY');
    try {
      const r = await c.query({ text: sql, rowMode: 'array' });
      return shape(
        r.fields.map((f) => f.name),
        r.rows as unknown[][],
        null,
      );
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });
}

/** An approved change (DDL or rows), as one statement. */
export async function runChange(t: DbTarget, sql: string): Promise<QueryResult> {
  if (t.conn.motor === 'mysql') {
    return withMysql(t, async (c) => {
      const [res] = await c.query({ sql, timeout: TIMEOUT_MS });
      const affected = (res as { affectedRows?: number }).affectedRows ?? null;
      return { columns: [], rows: [], total: 0, truncated: false, affected };
    });
  }
  return withPg(t, async (c) => {
    const r = await c.query(sql);
    return { columns: [], rows: [], total: 0, truncated: false, affected: r.rowCount ?? null };
  });
}

/**
 * Metadata queries (catalog only, never rows of the user's tables), in a READ ONLY
 * transaction that is rolled back, like any read.
 */
type Meta = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
async function withMeta<T>(t: DbTarget, fn: (q: Meta) => Promise<T>): Promise<T> {
  if (t.conn.motor === 'mysql') {
    return withMysql(t, async (c) => {
      await c.query(`SET SESSION max_execution_time = ${TIMEOUT_MS}`).catch(() => undefined);
      await c.query('START TRANSACTION READ ONLY');
      try {
        return await fn(async (sql, params = []) => (await c.query({ sql, timeout: TIMEOUT_MS }, params))[0] as Record<string, unknown>[]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  }
  return withPg(t, async (c) => {
    await c.query('BEGIN READ ONLY');
    try {
      return await fn(async (sql, params = []) => (await c.query(sql, params)).rows as Record<string, unknown>[]);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });
}

const PG_FOREIGN_KEYS = `SELECT cn.nspname || '.' || cl.relname AS tabla, a.attname AS columna, fn.nspname || '.' || fl.relname AS ref_tabla, fa.attname AS ref_columna
   FROM pg_constraint co
   JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_namespace cn ON cn.oid = cl.relnamespace
   JOIN pg_class fl ON fl.oid = co.confrelid JOIN pg_namespace fn ON fn.oid = fl.relnamespace
   CROSS JOIN LATERAL unnest(co.conkey, co.confkey) AS k(col, fcol)
   JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.col
   JOIN pg_attribute fa ON fa.attrelid = co.confrelid AND fa.attnum = k.fcol
  WHERE co.contype = 'f' AND cn.nspname NOT IN ('pg_catalog', 'information_schema')`;

/** Tables and columns of the database, with their foreign keys (for the agents and the planner: no data). */
export async function readSchema(t: DbTarget): Promise<TableInfo[]> {
  const { rows, fks } = await withMeta(t, async (q) =>
    t.conn.motor === 'mysql'
      ? {
          rows: await q(
            'SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna, COLUMN_TYPE AS tipo, IS_NULLABLE AS nulo, COLUMN_KEY AS clave FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
            [t.base],
          ),
          fks: await q(
            'SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna, REFERENCED_TABLE_NAME AS ref_tabla, REFERENCED_COLUMN_NAME AS ref_columna FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL',
            [t.base],
          ),
        }
      : {
          rows: await q(
            `SELECT c.table_schema || '.' || c.table_name AS tabla, c.column_name AS columna, COALESCE((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
                      WHERE a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass AND a.attname = c.column_name), c.data_type) AS tipo,
                    c.is_nullable AS nulo,
                    (SELECT 'PRI' FROM information_schema.key_column_usage k JOIN information_schema.table_constraints tc ON tc.constraint_schema = k.constraint_schema AND tc.constraint_name = k.constraint_name AND tc.constraint_type = 'PRIMARY KEY'
                      WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name LIMIT 1) AS clave
               FROM information_schema.columns c
              WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
              ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
          ),
          fks: await q(PG_FOREIGN_KEYS),
        },
  );
  const refs = new Map(fks.map((f) => [`${f.tabla}\u0000${f.columna}`, `${f.ref_tabla}.${f.ref_columna}`]));
  const tables = new Map<string, TableInfo>();
  for (const r of rows) {
    const name = String(r.tabla);
    const t2 = tables.get(name) ?? { table: name, columns: [] };
    const ref = refs.get(`${name}\u0000${r.columna}`);
    t2.columns.push({ name: String(r.columna), type: String(r.tipo), nullable: r.nulo === 'YES', key: (r.clave as string | null) || null, ...(ref ? { ref } : {}) });
    tables.set(name, t2);
  }
  return [...tables.values()];
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * What a connection reaches, without reading rows: the server version, the databases
 * this user can see on the server, and every table of `t.base` with its approximate row
 * count and size (catalog statistics). With `count`, an exact COUNT(*) per table — only
 * a number, still in a READ ONLY transaction.
 */
export async function readOverview(t: DbTarget, opts: { count?: boolean } = {}): Promise<DbOverview> {
  const mysql = t.conn.motor === 'mysql';
  return withMeta(t, async (q) => {
    const version = String(Object.values((await q(mysql ? 'SELECT VERSION() AS v' : 'SELECT version() AS v'))[0] ?? {})[0] ?? '?');
    const serverBases = (
      await q(
        mysql
          ? "SELECT SCHEMA_NAME AS nombre FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys') ORDER BY 1"
          : "SELECT datname AS nombre FROM pg_database WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY 1",
      )
    ).map((r) => String(r.nombre));
    const rows = mysql
      ? await q(
          'SELECT TABLE_NAME AS tabla, TABLE_TYPE AS tipo, TABLE_ROWS AS filas, DATA_LENGTH + INDEX_LENGTH AS bytes, TABLE_COMMENT AS comentario FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
          [t.base],
        )
      : await q(
          `SELECT n.nspname || '.' || c.relname AS tabla, CASE WHEN c.relkind IN ('v', 'm') THEN 'VIEW' ELSE 'BASE TABLE' END AS tipo,
                  CASE WHEN c.relkind IN ('r', 'p') AND c.reltuples >= 0 THEN c.reltuples::bigint END AS filas,
                  CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_total_relation_size(c.oid) END AS bytes, obj_description(c.oid, 'pg_class') AS comentario
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND NOT c.relispartition
            ORDER BY 1`,
        );
    const tables: TableSummary[] = rows.map((r) => {
      const view = String(r.tipo).includes('VIEW');
      return { table: String(r.tabla), kind: view ? 'vista' : 'tabla', rows: view ? null : num(r.filas), exact: false, bytes: num(r.bytes), comment: (r.comentario as string | null) || null };
    });
    if (opts.count) {
      for (const tb of tables.filter((x) => x.kind === 'tabla')) {
        const ident = mysql
          ? `\`${tb.table.replaceAll('`', '``')}\``
          : tb.table
              .split('.')
              .map((p) => `"${p.replaceAll('"', '""')}"`)
              .join('.');
        // In PostgreSQL one failed statement aborts the transaction: a savepoint per table.
        if (!mysql) await q('SAVEPOINT forja_contar');
        try {
          tb.rows = num(Object.values((await q(`SELECT COUNT(*) AS n FROM ${ident}`))[0] ?? {})[0]);
          tb.exact = true;
        } catch {
          // Without permission on that table (or too slow): keep the estimate.
          if (!mysql) await q('ROLLBACK TO SAVEPOINT forja_contar');
        }
      }
    }
    return { version, serverBases, tables };
  });
}

/** Lowest-impact check: connect and ask the server version. */
export async function ping(t: DbTarget): Promise<string> {
  const r = await runRead(t, t.conn.motor === 'mysql' ? 'SELECT VERSION()' : 'SELECT version()');
  return String(r.rows[0]?.[0] ?? '?');
}
