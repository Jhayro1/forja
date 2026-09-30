import type { DbEngine } from './connections.js';

/**
 * What one SQL statement from an agent is allowed to be (docs/guias/BASES-DE-DATOS.md).
 * Deliberately narrow: ONE statement, no comments, and only these forms —
 *   lectura: SELECT / WITH … SELECT / SHOW / DESCRIBE / EXPLAIN;
 *   crear:   CREATE TABLE <nueva>;
 *   cambio:  ALTER / DROP / TRUNCATE / INSERT / UPDATE / DELETE / CREATE INDEX on ONE table.
 * Everything else (views, procedures, triggers, grants, other databases, renames,
 * CASCADE, multi-table writes, SELECT … INTO, sleep/file functions) is refused. Whether a
 * «cambio» may touch its table (only tables Forja created) is checked by the caller
 * against the project's registry and, again, right before executing.
 * The database adds a second barrier: reads run in a READ ONLY transaction.
 */
export class SqlRejected extends Error {}

export type SqlKind = 'lectura' | 'crear' | 'cambio';
export type SqlCheck = { kind: SqlKind /** Tables written (cambio) or created (crear), normalized. */; targets: string[]; statement: string; verb: string };

type Token = { t: 'word' | 'ident' | 'string' | 'number' | 'sym'; v: string };

/** Splits into tokens outside of strings; comments and a second statement are refused here. */
export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const s = sql;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && s[i + 1] === '-') throw new SqlRejected('sin comentarios (--) en la sentencia');
    if (c === '/' && s[i + 1] === '*') throw new SqlRejected('sin comentarios (/* */) en la sentencia');
    if (c === '#') throw new SqlRejected('sin comentarios (#) en la sentencia');
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= s.length) throw new SqlRejected('hay una comilla sin cerrar');
        const d = s[j]!;
        if (d === '\\' && c === "'") {
          v += s.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (d === c) {
          if (s[j + 1] === c) {
            v += c;
            j += 2;
            continue;
          }
          break;
        }
        v += d;
        j++;
      }
      out.push({ t: c === "'" ? 'string' : 'ident', v });
      i = j + 1;
      continue;
    }
    if (c === '$' && /[A-Za-z_$]/.test(s[i + 1] ?? '')) {
      // PostgreSQL dollar quoting ($tag$…$tag$) can hide anything: refused.
      const m = /^\$[A-Za-z_]*\$/.exec(s.slice(i));
      if (m) throw new SqlRejected('sin cadenas $…$ (PostgreSQL)');
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(s.slice(i))!;
      out.push({ t: 'word', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9][0-9.eE+-]*/.exec(s.slice(i))!;
      out.push({ t: 'number', v: m[0] });
      i += m[0].length;
      continue;
    }
    out.push({ t: 'sym', v: c });
    i++;
  }
  const semi = out.findIndex((t) => t.t === 'sym' && t.v === ';');
  if (semi >= 0 && semi !== out.length - 1) throw new SqlRejected('una sola sentencia por solicitud (sin «;» en medio)');
  if (semi === out.length - 1) out.pop();
  if (!out.length) throw new SqlRejected('la sentencia está vacía');
  return out;
}

const W = (t: Token | undefined) => (t?.t === 'word' ? t.v.toUpperCase() : null);
const hasWord = (tokens: Token[], words: string[]) => tokens.some((t) => t.t === 'word' && words.includes(t.v.toUpperCase()));
/** Like hasWord, but a word used as a function (`REPLACE(…)`, `INSERT(…)` in MySQL) does not count. */
const hasStatementWord = (tokens: Token[], words: string[]) => tokens.some((t, i) => t.t === 'word' && words.includes(t.v.toUpperCase()) && !(tokens[i + 1]?.t === 'sym' && tokens[i + 1]!.v === '('));
const CLAUSES = ['WHERE', 'USING', 'ORDER', 'LIMIT', 'RETURNING', 'SET'];
/** Skips an optional alias after a table name (`t`, `AS t`). */
function skipAlias(tokens: Token[], at: number): number {
  if (W(tokens[at]) === 'AS') return at + 2;
  const t = tokens[at];
  if (t && (t.t === 'word' || t.t === 'ident') && !CLAUSES.includes(W(t) ?? '')) return at + 1;
  return at;
}

/** Functions that sleep, read files or reach other servers: never, not even in a read. */
const DANGEROUS_FUNCTIONS = [
  'SLEEP',
  'BENCHMARK',
  'LOAD_FILE',
  'PG_SLEEP',
  'PG_READ_FILE',
  'PG_READ_BINARY_FILE',
  'PG_LS_DIR',
  'LO_IMPORT',
  'LO_EXPORT',
  'DBLINK',
  'DBLINK_EXEC',
  'PG_TERMINATE_BACKEND',
  'PG_CANCEL_BACKEND',
  'SET_CONFIG',
];
const WRITE_WORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'REPLACE',
  'GRANT',
  'REVOKE',
  'RENAME',
  'CALL',
  'EXECUTE',
  'COPY',
  'LOAD',
  'HANDLER',
  'LOCK',
  'UNLOCK',
  'SET',
  'DO',
  'PREPARE',
];

/**
 * Reads a table name at `i`: `tabla`, `base.tabla` or `esquema.tabla`, quoted or not.
 * MySQL: a qualified name must be the database in use. PostgreSQL: `esquema.tabla`,
 * `public` by default. Returns the normalized name and where it ended.
 */
function tableAt(tokens: Token[], i: number, engine: DbEngine, base: string): { name: string; next: number } {
  const first = tokens[i];
  if (!first || (first.t !== 'word' && first.t !== 'ident')) throw new SqlRejected('falta el nombre de la tabla');
  const part = (t: Token) => (t.t === 'word' && engine === 'postgres' ? t.v.toLowerCase() : t.v);
  let schema: string | null = null;
  let name = part(first);
  let next = i + 1;
  if (tokens[next]?.t === 'sym' && tokens[next]!.v === '.') {
    const second = tokens[next + 1];
    if (!second || (second.t !== 'word' && second.t !== 'ident')) throw new SqlRejected('nombre de tabla incompleto');
    schema = name;
    name = part(second);
    next += 2;
  }
  if (engine === 'mysql') {
    if (schema !== null && schema !== base) throw new SqlRejected(`sólo se trabaja en la base «${base}», no en «${schema}»`);
    return { name, next };
  }
  return { name: `${schema ?? 'public'}.${name}`, next };
}

function tableList(tokens: Token[], i: number, engine: DbEngine, base: string): { names: string[]; next: number } {
  const names: string[] = [];
  let at = i;
  for (;;) {
    const t = tableAt(tokens, at, engine, base);
    names.push(t.name);
    at = t.next;
    if (tokens[at]?.t === 'sym' && tokens[at]!.v === ',') {
      at++;
      continue;
    }
    return { names, next: at };
  }
}

export function checkSql(sql: string, engine: DbEngine, base: string): SqlCheck {
  const statement = sql.trim();
  if (statement.length > 20_000) throw new SqlRejected('la sentencia es demasiado larga');
  const tokens = tokenize(statement);
  for (const t of tokens) {
    if (t.t === 'word' && DANGEROUS_FUNCTIONS.includes(t.v.toUpperCase())) throw new SqlRejected(`${t.v} no está permitido`);
  }
  const verb = W(tokens[0]) ?? '';
  const words = (from: number) => tokens.slice(from);

  // ---- lectura
  if (['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES'].includes(verb)) {
    if (verb === 'EXPLAIN' && hasWord(tokens, ['ANALYZE'])) throw new SqlRejected('EXPLAIN ANALYZE ejecuta la sentencia: usa EXPLAIN a secas');
    if (hasStatementWord(tokens, WRITE_WORDS)) throw new SqlRejected('una consulta de lectura no puede llevar INSERT, UPDATE, DELETE, CREATE… (pide un cambio aparte)');
    if (hasWord(tokens, ['INTO', 'OUTFILE', 'DUMPFILE'])) throw new SqlRejected('SELECT … INTO no está permitido');
    for (let k = 0; k < tokens.length - 1; k++) {
      if (W(tokens[k]) === 'FOR' && ['UPDATE', 'SHARE', 'NO'].includes(W(tokens[k + 1]) ?? '')) throw new SqlRejected('una lectura no bloquea filas (FOR UPDATE/SHARE)');
    }
    return { kind: 'lectura', targets: [], statement, verb };
  }

  // ---- crear tabla / índice
  if (verb === 'CREATE') {
    let k = 1;
    if (['TEMPORARY', 'TEMP'].includes(W(tokens[k]) ?? '')) k++;
    if (W(tokens[k]) === 'TABLE') {
      k++;
      if (W(tokens[k]) === 'IF' && W(tokens[k + 1]) === 'NOT' && W(tokens[k + 2]) === 'EXISTS') k += 3;
      const t = tableAt(tokens, k, engine, base);
      if (hasWord(words(t.next), ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE', 'GRANT', 'RENAME'])) throw new SqlRejected('CREATE TABLE sólo crea la tabla');
      return { kind: 'crear', targets: [t.name], statement, verb: 'CREATE TABLE' };
    }
    k = 1;
    if (W(tokens[k]) === 'UNIQUE') k++;
    if (W(tokens[k]) === 'INDEX') {
      const on = tokens.findIndex((t, idx) => idx > k && W(t) === 'ON');
      if (on < 0) throw new SqlRejected('CREATE INDEX necesita ON <tabla>');
      const t = tableAt(tokens, on + 1, engine, base);
      return { kind: 'cambio', targets: [t.name], statement, verb: 'CREATE INDEX' };
    }
    throw new SqlRejected('sólo se permite CREATE TABLE o CREATE INDEX (nada de vistas, funciones, disparadores ni bases)');
  }

  // ---- cambios sobre UNA tabla (o varias en DROP/TRUNCATE)
  if (verb === 'ALTER') {
    if (W(tokens[1]) !== 'TABLE') throw new SqlRejected('sólo ALTER TABLE');
    let k = 2;
    if (W(tokens[k]) === 'IF' && W(tokens[k + 1]) === 'EXISTS') k += 2;
    if (W(tokens[k]) === 'ONLY') k++;
    const t = tableAt(tokens, k, engine, base);
    if (hasWord(words(t.next), ['RENAME'])) throw new SqlRejected('renombrar tablas o columnas no está permitido: crea una nueva');
    return { kind: 'cambio', targets: [t.name], statement, verb: 'ALTER TABLE' };
  }
  if (verb === 'DROP') {
    if (W(tokens[1]) === 'INDEX') throw new SqlRejected('para quitar un índice usa ALTER TABLE <tabla> DROP INDEX …');
    if (W(tokens[1]) !== 'TABLE') throw new SqlRejected('sólo DROP TABLE');
    let k = 2;
    if (W(tokens[k]) === 'IF' && W(tokens[k + 1]) === 'EXISTS') k += 2;
    const l = tableList(tokens, k, engine, base);
    if (hasWord(words(l.next), ['CASCADE'])) throw new SqlRejected('CASCADE puede borrar objetos de otras tablas: no está permitido');
    return { kind: 'cambio', targets: l.names, statement, verb: 'DROP TABLE' };
  }
  if (verb === 'TRUNCATE') {
    let k = 1;
    if (W(tokens[k]) === 'TABLE') k++;
    if (W(tokens[k]) === 'ONLY') k++;
    const l = tableList(tokens, k, engine, base);
    if (hasWord(words(l.next), ['CASCADE'])) throw new SqlRejected('CASCADE puede vaciar otras tablas: no está permitido');
    return { kind: 'cambio', targets: l.names, statement, verb: 'TRUNCATE' };
  }
  if (verb === 'INSERT' || verb === 'REPLACE') {
    let k = 1;
    while (['IGNORE', 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY'].includes(W(tokens[k]) ?? '')) k++;
    if (W(tokens[k]) !== 'INTO') throw new SqlRejected(`${verb} necesita INTO <tabla>`);
    const t = tableAt(tokens, k + 1, engine, base);
    if (hasWord(words(t.next), ['DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT'])) throw new SqlRejected('un INSERT sólo inserta');
    return { kind: 'cambio', targets: [t.name], statement, verb };
  }
  if (verb === 'UPDATE') {
    let k = 1;
    while (['LOW_PRIORITY', 'IGNORE', 'ONLY'].includes(W(tokens[k]) ?? '')) k++;
    const t = tableAt(tokens, k, engine, base);
    const after = skipAlias(tokens, t.next);
    if (W(tokens[after]) !== 'SET') throw new SqlRejected('UPDATE de varias tablas a la vez no está permitido');
    if (hasWord(words(after), ['DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'INSERT', 'GRANT'])) throw new SqlRejected('un UPDATE sólo actualiza');
    return { kind: 'cambio', targets: [t.name], statement, verb };
  }
  if (verb === 'DELETE') {
    if (W(tokens[1]) !== 'FROM') throw new SqlRejected('usa DELETE FROM <tabla> (sin borrar de varias tablas a la vez)');
    let k = 2;
    if (W(tokens[k]) === 'ONLY') k++;
    const t = tableAt(tokens, k, engine, base);
    const after = skipAlias(tokens, t.next);
    if (tokens[after] && !['WHERE', 'USING', 'ORDER', 'LIMIT', 'RETURNING'].includes(W(tokens[after]) ?? '')) throw new SqlRejected('DELETE de varias tablas a la vez no está permitido');
    if (hasWord(words(after), ['DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'INSERT', 'UPDATE', 'GRANT'])) throw new SqlRejected('un DELETE sólo borra filas');
    return { kind: 'cambio', targets: [t.name], statement, verb };
  }
  throw new SqlRejected(`«${verb || tokens[0]!.v}» no está permitido: sólo consultas, CREATE TABLE y cambios sobre tablas creadas por Forja`);
}
