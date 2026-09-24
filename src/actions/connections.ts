import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Global connections of this user (~/.forja/conexiones.json). A connection
 * names a service and the vault secret to reach it; it holds no secret value.
 * Every edit bumps `version`: links and approvals made for an older version
 * stop being valid (v2/06).
 */
export const Connection = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'nombre: minúsculas, números y guiones'),
    type: z.literal('http'),
    base_url: z.url(),
    /** Name of the vault secret sent as credential; null for services without auth. */
    secret: z.string().nullable(),
    auth_header: z.string().regex(/^[A-Za-z0-9-]+$/).default('Authorization'),
    auth_scheme: z.string().default('Bearer'),
    /** The service honors Idempotency-Key: an uncertain result can be resolved by resending. */
    idempotent: z.boolean().default(false),
    /** Loopback/private destinations, only for test services on this machine. */
    allow_local: z.boolean().default(false),
    /** Lowest-impact check for `forja conexion probar` (a GET path). */
    test_path: z.string().startsWith('/').nullable().default(null),
    version: z.number().int().positive(),
    updated_at: z.string(),
  })
  .strict();
export type Connection = z.infer<typeof Connection>;

export class ConnectionError extends Error {}

export class ConnectionStore {
  constructor(readonly path: string) {}

  static in(home: string): ConnectionStore {
    return new ConnectionStore(join(home, 'conexiones.json'));
  }

  all(): Connection[] {
    if (!existsSync(this.path)) return [];
    return z.array(Connection).parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  get(name: string): Connection {
    const c = this.all().find((x) => x.name === name);
    if (!c) throw new ConnectionError(`no existe la conexión «${name}»: créala con forja conexion nueva`);
    return c;
  }

  /** Creates or edits; an edit is a new version. */
  save(input: Omit<Connection, 'version' | 'updated_at'>): Connection {
    const url = new URL(input.base_url);
    if (url.username || url.password) throw new ConnectionError('la URL no puede llevar credenciales: guárdalas en la bóveda');
    if (url.protocol !== 'https:' && !input.allow_local) throw new ConnectionError('sólo https (http sólo para servicios locales de prueba con --permitir-local)');
    const others = this.all().filter((c) => c.name !== input.name);
    const previous = this.all().find((c) => c.name === input.name);
    const next = Connection.parse({ ...input, version: (previous?.version ?? 0) + 1, updated_at: new Date().toISOString() });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify([...others, next], null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    return next;
  }
}
