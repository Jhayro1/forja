import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decryptLocal, encryptLocal } from '../security/local-secret.js';

/**
 * Database connections of this user (~/.forja/bases.json), for the projects that link
 * them (docs/guias/BASES-DE-DATOS.md). The password and the test variables are stored
 * encrypted with the machine's local key, like the SMTP password and the GitHub token;
 * no agent ever receives them: Forja itself runs what the rules allow.
 */
export class DbConnectionError extends Error {}

export const DB_ENGINES = ['mysql', 'postgres'] as const;
export type DbEngine = (typeof DB_ENGINES)[number];

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const BASE = /^[A-Za-z0-9_$-]{1,64}$/;

const Stored = z
  .object({
    name: z.string().regex(NAME),
    motor: z.enum(DB_ENGINES),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    /** Databases (MySQL) or database names (PostgreSQL) this connection may use. */
    bases: z.array(z.string().regex(BASE)).min(1).max(20),
    usuario: z.string().min(1).max(128),
    clave_cifrada: z.string().nullable(),
    ssl: z.boolean().default(false),
    /** KEY → value lines for the project's test commands, encrypted as one JSON blob. */
    variables_cifradas: z.string().nullable().default(null),
    variables_nombres: z.array(z.string()).default([]),
    version: z.number().int().positive(),
    updated_at: z.string(),
  })
  .strict();
type Stored = z.infer<typeof Stored>;

/** What the panel and the CLI see: never the password nor the variables' values. */
export type DbConnectionView = Omit<Stored, 'clave_cifrada' | 'variables_cifradas'> & { tiene_clave: boolean };

export type DbConnectionInput = {
  name: string;
  motor: DbEngine;
  host: string;
  port: number;
  bases: string[];
  usuario: string;
  /** undefined = keep the saved one; '' = none. */
  clave?: string;
  ssl?: boolean;
  /** undefined = keep; {} = remove. */
  variables?: Record<string, string>;
};

export const DEFAULT_PORT: Record<DbEngine, number> = { mysql: 3306, postgres: 5432 };

export type ParsedUrl = { motor: DbEngine; host: string; port: number; base: string | null; usuario?: string; clave?: string };

/**
 * Reads the URLs people already have: `jdbc:mysql://host:3306/base?…`, `mysql://…`,
 * `jdbc:postgresql://…`, `postgres://usuario:clave@host/base`. Java driver parameters
 * (logger, useSSL…) are ignored; `useSSL=true`/`sslmode=require` only turn on TLS.
 */
export function parseDbUrl(raw: string): ParsedUrl & { ssl: boolean } {
  const text = raw.trim().replace(/^jdbc:/i, '');
  const m = /^(mysql|mariadb|postgres|postgresql):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/?#]+)(?::(\d{1,5}))?(?:\/([^?#]*))?(?:\?(.*))?$/i.exec(text);
  if (!m) throw new DbConnectionError('no reconozco esa URL: pega algo como jdbc:mysql://host:3306/base o postgres://host:5432/base');
  const motor: DbEngine = /^postgres/i.test(m[1]!) ? 'postgres' : 'mysql';
  const params = new URLSearchParams(m[7] ?? '');
  const ssl = /^true$/i.test(params.get('useSSL') ?? '') || /^(require|verify-ca|verify-full)$/i.test(params.get('sslmode') ?? '') || /^true$/i.test(params.get('ssl') ?? '');
  return {
    motor,
    host: m[4]!,
    port: m[5] ? Number(m[5]) : DEFAULT_PORT[motor],
    base: m[6] ? decodeURIComponent(m[6]) : null,
    ssl,
    ...(m[2] ? { usuario: decodeURIComponent(m[2]) } : {}),
    ...(m[3] !== undefined && m[2] ? { clave: decodeURIComponent(m[3]) } : {}),
  };
}

/** `CLAVE: valor` or `CLAVE=valor` lines (what a .env, a YAML or a CI screen shows). */
export function parseVariables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/.exec(t);
    if (!m) throw new DbConnectionError(`no entiendo esta línea: «${t.slice(0, 60)}» (usa NOMBRE: valor)`);
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}

/**
 * A whole pasted block, understood: every URL becomes a database of the same server,
 * a *USER* variable the user and a *PASS* one the password. The block itself is kept as
 * the variables for the project's tests (their names as they are).
 */
export function suggestFromVariables(vars: Record<string, string>): Partial<DbConnectionInput> & { avisos: string[] } {
  const avisos: string[] = [];
  const urls = Object.entries(vars).filter(([, v]) => /^(jdbc:)?(mysql|mariadb|postgres|postgresql):\/\//i.test(v));
  const out: Partial<DbConnectionInput> & { avisos: string[] } = { avisos, variables: vars };
  if (urls.length) {
    const parsed = urls.map(([, v]) => parseDbUrl(v));
    const first = parsed[0]!;
    out.motor = first.motor;
    out.host = first.host;
    out.port = first.port;
    out.ssl = first.ssl;
    out.bases = [...new Set(parsed.map((p) => p.base).filter((b): b is string => Boolean(b)))];
    if (parsed.some((p) => p.host !== first.host || p.port !== first.port)) avisos.push('hay URLs de servidores distintos: se usa el primero; crea otra conexión para el otro');
    if (first.usuario) out.usuario = first.usuario;
    if (first.clave) out.clave = first.clave;
  }
  const user = Object.entries(vars).find(([k]) => /USER|USUARIO/i.test(k) && !/PASS/i.test(k));
  const pass = Object.entries(vars).find(([k]) => /PASS|CLAVE|PWD/i.test(k));
  if (user && !out.usuario) out.usuario = user[1];
  if (pass && out.clave === undefined) out.clave = pass[1];
  return out;
}

export class DbConnectionStore {
  private readonly path: string;

  constructor(private readonly home: string) {
    this.path = join(home, 'bases.json');
  }

  private read(): Stored[] {
    if (!existsSync(this.path)) return [];
    return z.array(Stored).parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  private write(all: Stored[]): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  list(): DbConnectionView[] {
    return this.read().map(view);
  }

  get(name: string): DbConnectionView {
    const c = this.read().find((x) => x.name === name);
    if (!c) throw new DbConnectionError(`no existe la conexión de base de datos «${name}»`);
    return view(c);
  }

  /** Creates or edits (a new version); the password and variables are kept unless given. */
  save(input: DbConnectionInput): DbConnectionView {
    if (!NAME.test(input.name)) throw new DbConnectionError('nombre: minúsculas, números y guiones (p. ej. pruebas-invoice)');
    if (!/^[A-Za-z0-9.-]{1,255}$/.test(input.host)) throw new DbConnectionError('host no válido');
    const bases = [...new Set(input.bases.map((b) => b.trim()).filter(Boolean))];
    if (!bases.length) throw new DbConnectionError('indica al menos una base');
    for (const b of bases) if (!BASE.test(b)) throw new DbConnectionError(`nombre de base no válido: «${b}»`);
    const all = this.read();
    const prev = all.find((c) => c.name === input.name);
    const next = Stored.parse({
      name: input.name,
      motor: input.motor,
      host: input.host.trim(),
      port: input.port,
      bases,
      usuario: input.usuario.trim(),
      clave_cifrada: input.clave === undefined ? (prev?.clave_cifrada ?? null) : input.clave ? encryptLocal(this.home, input.clave) : null,
      ssl: input.ssl ?? prev?.ssl ?? false,
      variables_cifradas: input.variables === undefined ? (prev?.variables_cifradas ?? null) : Object.keys(input.variables).length ? encryptLocal(this.home, JSON.stringify(input.variables)) : null,
      variables_nombres: input.variables === undefined ? (prev?.variables_nombres ?? []) : Object.keys(input.variables),
      version: (prev?.version ?? 0) + 1,
      updated_at: new Date().toISOString(),
    });
    this.write([...all.filter((c) => c.name !== input.name), next]);
    return view(next);
  }

  /** Forgets a connection (the user asked for it); its tables registry per project stays as history. */
  remove(name: string): void {
    const all = this.read();
    if (!all.some((c) => c.name === name)) throw new DbConnectionError(`no existe la conexión «${name}»`);
    this.write(all.filter((c) => c.name !== name));
  }

  /** Only for Forja's own process (driver and test commands); never for an agent. */
  secrets(name: string): { clave: string | null; variables: Record<string, string> } {
    const c = this.read().find((x) => x.name === name);
    if (!c) throw new DbConnectionError(`no existe la conexión «${name}»`);
    return {
      clave: c.clave_cifrada ? decryptLocal(this.home, c.clave_cifrada) : null,
      variables: c.variables_cifradas ? (JSON.parse(decryptLocal(this.home, c.variables_cifradas)) as Record<string, string>) : {},
    };
  }
}

function view(c: Stored): DbConnectionView {
  const { clave_cifrada, variables_cifradas: _v, ...rest } = c;
  return { ...rest, tiene_clave: clave_cifrada !== null };
}
