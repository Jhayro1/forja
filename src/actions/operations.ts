import { z } from 'zod';
import type { Connection } from './connections.js';

/**
 * Typed operations (v2/06): an agent or the user proposes one of these, never
 * an arbitrary request. Each type validates its parameters, renders a preview
 * without secrets and builds the concrete request. New services add a type
 * here (open/closed); the protocol and the executor do not change.
 */

/** GET is only used by the low-impact connection test, never by a proposable operation. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Precondition = { url: string; pointer: string; expected: unknown; ifMatch: boolean };

export type HttpRequestSpec = { method: HttpMethod; url: string; body: string | null; precondition: Precondition | null };

export interface OperationType<P = Record<string, unknown>> {
  readonly id: string;
  readonly description: string;
  readonly params: z.ZodType<P>;
  preview(conn: Connection, params: P): Record<string, unknown>;
  request(conn: Connection, params: P): HttpRequestSpec;
}

export class OperationError extends Error {}

/** Resolves a path strictly under the connection's base URL (no host or `..` escapes). */
export function urlUnder(base: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || /\\|[\u0000-\u001f]/.test(path)) throw new OperationError(`ruta inválida: ${path}`);
  const pathOnly = path.split(/[?#]/)[0]!;
  if (pathOnly.split('/').some((seg) => seg === '..' || seg === '.' || /%2e/i.test(seg) || /%2f/i.test(seg))) throw new OperationError(`ruta inválida: ${path}`);
  const root = base.endsWith('/') ? base : `${base}/`;
  const url = new URL(path.slice(1), root);
  if (!url.href.startsWith(root)) throw new OperationError(`la ruta sale de la conexión: ${path}`);
  return url.href;
}

const Json: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Json), z.record(z.string(), Json)]));

const HttpJsonParams = z
  .object({
    ruta: z.string().min(1).max(2000),
    metodo: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    cuerpo: Json.optional(),
    /** Checked right before executing; with `si_coincide` the service enforces it atomically (If-Match). */
    precondicion: z
      .object({ ruta: z.string().min(1), puntero: z.string().regex(/^(\/[^/]*)*$/), valor: Json, si_coincide: z.boolean().default(true) })
      .strict()
      .optional(),
  })
  .strict();
type HttpJsonParams = z.infer<typeof HttpJsonParams>;

/** Reference operation: a JSON request to a path of an HTTP connection. */
export const httpJson: OperationType<HttpJsonParams> = {
  id: 'http.json',
  description: 'petición JSON a una ruta de una conexión HTTP',
  params: HttpJsonParams,
  preview(conn, p) {
    return {
      servicio: conn.name,
      peticion: `${p.metodo} ${urlUnder(conn.base_url, p.ruta)}`,
      cuerpo: p.cuerpo ?? null,
      credencial: conn.secret ? `${conn.auth_header}: ${conn.auth_scheme} <${conn.secret} de la bóveda>` : 'ninguna',
      precondicion: p.precondicion
        ? `${p.precondicion.ruta} ${p.precondicion.puntero || '(documento)'} = ${JSON.stringify(p.precondicion.valor)}${p.precondicion.si_coincide ? ' (atómica con If-Match si el servicio da ETag)' : ' (sin garantía atómica: hay ventana de carrera)'}`
        : 'ninguna',
      reintento_seguro: conn.idempotent ? 'sí: el servicio respeta Idempotency-Key' : 'no: si el resultado es incierto se concilia a mano',
    };
  },
  request(conn, p) {
    return {
      method: p.metodo,
      url: urlUnder(conn.base_url, p.ruta),
      body: p.cuerpo === undefined ? null : JSON.stringify(p.cuerpo),
      precondition: p.precondicion ? { url: urlUnder(conn.base_url, p.precondicion.ruta), pointer: p.precondicion.puntero, expected: p.precondicion.valor, ifMatch: p.precondicion.si_coincide } : null,
    };
  },
};

/** Any operation type: its params are validated by its own schema before use. */
// biome-ignore lint/suspicious/noExplicitAny: a registry of operations with different parameter types
export type AnyOperation = OperationType<any>;

export const OPERATIONS: Record<string, AnyOperation> = { [httpJson.id]: httpJson };

export function operation(id: string): AnyOperation {
  const op = OPERATIONS[id];
  if (!op) throw new OperationError(`operación desconocida: ${id} (disponibles: ${Object.keys(OPERATIONS).join(', ')})`);
  return op;
}
