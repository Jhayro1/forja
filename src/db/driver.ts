import type { DbConnectionView } from './connections.js';

/**
 * Talks to the database from Forja's own process — never from an agent. Every read runs
 * inside a READ ONLY transaction that is rolled back (the database's own barrier behind
 * the SQL guard), with a statement time limit and a cap on the rows returned.
 */
export type DbTarget = { conn: DbConnectionView; base: string; password: string | null };
export type QueryResult = { columns: string[]; rows: unknown[][]; total: number; truncated: boolean; affected: number | null };
export type TableInfo = { table: string; columns: { name: string; type: string; nullable: boolean; key: string | null }[] };

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

/** Tables and columns of the database (for the agents and the planner: no data). */
export async function readSchema(t: DbTarget): Promise<TableInfo[]> {
  const rows: { tabla: string; columna: string; tipo: string; nulo: string; clave: string | null }[] =
    t.conn.motor === 'mysql'
      ? await withMysql(t, async (c) => {
          const [r] = await c.query(
            'SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna, COLUMN_TYPE AS tipo, IS_NULLABLE AS nulo, COLUMN_KEY AS clave FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
            [t.base],
          );
          return r as { tabla: string; columna: string; tipo: string; nulo: string; clave: string | null }[];
        })
      : await withPg(t, async (c) => {
          const r = await c.query(
            `SELECT c.table_schema || '.' || c.table_name AS tabla, c.column_name AS columna, c.data_type AS tipo, c.is_nullable AS nulo,
                    (SELECT 'PRI' FROM information_schema.key_column_usage k JOIN information_schema.table_constraints tc ON tc.constraint_name = k.constraint_name AND tc.constraint_type = 'PRIMARY KEY'
                      WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name LIMIT 1) AS clave
               FROM information_schema.columns c
              WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
              ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
          );
          return r.rows as { tabla: string; columna: string; tipo: string; nulo: string; clave: string | null }[];
        });
  const tables = new Map<string, TableInfo>();
  for (const r of rows) {
    const t2 = tables.get(r.tabla) ?? { table: r.tabla, columns: [] };
    t2.columns.push({ name: r.columna, type: r.tipo, nullable: r.nulo === 'YES', key: r.clave || null });
    tables.set(r.tabla, t2);
  }
  return [...tables.values()];
}

/** Lowest-impact check: connect and ask the server version. */
export async function ping(t: DbTarget): Promise<string> {
  const r = await runRead(t, t.conn.motor === 'mysql' ? 'SELECT VERSION()' : 'SELECT version()');
  return String(r.rows[0]?.[0] ?? '?');
}
