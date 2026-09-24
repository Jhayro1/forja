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

/** What the executor observed when the action was confirmed (redacted evidence). */
export type ActionEvidence = { status?: number; location?: string | null; body?: string };

export interface OperationType<P = Record<string, unknown>> {
  readonly id: string;
  readonly description: string;
  readonly params: z.ZodType<P>;
  /**
   * false: an uncertain result is never resent, even to an idempotent connection
   * (e.g. e-mail: a duplicate cannot be taken back). Default: the connection decides.
   */
  readonly retrySafe?: boolean;
  preview(conn: Connection, params: P): Record<string, unknown>;
  request(conn: Connection, params: P): HttpRequestSpec;
  /**
   * The inverse operation of a confirmed action, as a NEW proposal that needs its
   * own approval (MEJORAS 4.5). null: it cannot be undone automatically.
   */
  undo?(conn: Connection, params: P, evidence: ActionEvidence): { type: string; params: Record<string, unknown> } | { reason: string };
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
      credencial: credentialPreview(conn),
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

export const credentialPreview = (conn: Connection) => (conn.secret ? `${conn.auth_header}: ${conn.auth_scheme} <${conn.secret} de la bóveda>` : 'ninguna');

/** A path inside the connection taken from a Location header, if it is one. */
function pathUnder(conn: Connection, location: string | null | undefined): string | null {
  if (!location) return null;
  try {
    const root = conn.base_url.endsWith('/') ? conn.base_url : `${conn.base_url}/`;
    const url = new URL(location, root);
    if (!url.href.startsWith(root)) return null;
    return `/${url.href.slice(root.length)}`;
  } catch {
    return null;
  }
}

httpJson.undo = (conn, p, evidence) => {
  const created = pathUnder(conn, evidence.location);
  if (p.metodo === 'POST' && evidence.status === 201 && created) return { type: 'http.json', params: { ruta: created, metodo: 'DELETE' } };
  return { reason: 'sólo se deshace sola una creación (POST que respondió 201 con Location); propón la inversa con forja accion proponer' };
};

const Email = z.string().regex(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/, 'dirección de correo inválida');

const EmailParams = z
  .object({
    para: z.array(Email).min(1).max(20),
    asunto: z.string().min(1).max(200),
    texto: z.string().min(1).max(20_000),
    responder_a: Email.optional(),
    ruta: z.string().min(1).max(200).default('/mensajes'),
  })
  .strict();

/**
 * E-mail through an HTTP sending API. Never resent blindly: a message sent twice
 * cannot be taken back, so an uncertain result always goes to human reconciliation.
 */
export const emailSend: OperationType<z.infer<typeof EmailParams>> = {
  id: 'correo.enviar',
  description: 'envía un correo por la API HTTP de la conexión',
  params: EmailParams,
  retrySafe: false,
  preview(conn, p) {
    return {
      servicio: conn.name,
      peticion: `POST ${urlUnder(conn.base_url, p.ruta)}`,
      para: p.para.join(', '),
      asunto: p.asunto,
      texto: p.texto.length > 600 ? `${p.texto.slice(0, 600)}… (${p.texto.length} caracteres)` : p.texto,
      credencial: credentialPreview(conn),
      reintento_seguro: 'no: un correo no se puede deshacer; si el resultado es incierto se concilia a mano',
    };
  },
  request(conn, p) {
    return {
      method: 'POST',
      url: urlUnder(conn.base_url, p.ruta),
      body: JSON.stringify({ para: p.para, asunto: p.asunto, texto: p.texto, ...(p.responder_a ? { responder_a: p.responder_a } : {}) }),
      precondition: null,
    };
  },
  undo: () => ({ reason: 'un correo enviado no se puede deshacer' }),
};

const WebhookParams = z
  .object({ evento: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/, 'evento: minúsculas, números, punto, guion'), datos: Json, ruta: z.string().min(1).max(200).default('/') })
  .strict();

/** A notification to a webhook of the connection (e.g. chat, CI, automation). */
export const webhookEvent: OperationType<z.infer<typeof WebhookParams>> = {
  id: 'webhook.evento',
  description: 'notifica un evento al webhook de la conexión',
  params: WebhookParams,
  preview(conn, p) {
    return {
      servicio: conn.name,
      peticion: `POST ${urlUnder(conn.base_url, p.ruta)}`,
      evento: p.evento,
      datos: p.datos,
      credencial: credentialPreview(conn),
      reintento_seguro: conn.idempotent ? 'sí: el servicio respeta Idempotency-Key' : 'no: si el resultado es incierto se concilia a mano',
    };
  },
  request(conn, p) {
    return { method: 'POST', url: urlUnder(conn.base_url, p.ruta), body: JSON.stringify({ evento: p.evento, datos: p.datos, origen: 'forja' }), precondition: null };
  },
  undo: () => ({ reason: 'una notificación enviada no se puede retirar' }),
};

const DnsName = z.string().regex(/^(?=.{1,253}$)(\*|@|[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?)*$/i, 'nombre DNS inválido');
const DnsParams = z
  .object({
    zona: DnsName,
    nombre: DnsName,
    tipo: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX']),
    /** null deletes the record. */
    valor: z.string().min(1).max(1000).nullable(),
    ttl: z.number().int().min(60).max(86_400).default(300),
    /** Current value (null: the record does not exist). Checked before the change, and what «deshacer» restores. */
    anterior: z.string().min(1).max(1000).nullable(),
  })
  .strict();
type DnsParams = z.infer<typeof DnsParams>;

const dnsPath = (p: DnsParams) => `/zonas/${encodeURIComponent(p.zona)}/registros/${encodeURIComponent(p.nombre)}/${p.tipo}`;

/**
 * A DNS record through the provider's REST API (convention: PUT/DELETE
 * /zonas/{zona}/registros/{nombre}/{tipo} with { valor, ttl }). The previous
 * value is part of the approval and is checked before changing anything.
 */
export const dnsRecord: OperationType<DnsParams> = {
  id: 'dns.registro',
  description: 'crea, cambia o borra un registro DNS en la API de la conexión',
  params: DnsParams,
  preview(conn, p) {
    return {
      servicio: conn.name,
      peticion: `${p.valor === null ? 'DELETE' : 'PUT'} ${urlUnder(conn.base_url, dnsPath(p))}`,
      registro: `${p.nombre}.${p.zona} ${p.tipo}`,
      cambio: `${p.anterior ?? '(no existe)'} → ${p.valor ?? '(borrado)'}${p.valor === null ? '' : ` · ttl ${p.ttl}`}`,
      precondicion: p.anterior === null ? 'ninguna: se asume que el registro no existe' : `el valor actual debe ser ${p.anterior}`,
      credencial: credentialPreview(conn),
      deshacer: 'sí: forja accion deshacer propone restaurar el valor anterior',
    };
  },
  request(conn, p) {
    const url = urlUnder(conn.base_url, dnsPath(p));
    return {
      method: p.valor === null ? 'DELETE' : 'PUT',
      url,
      body: p.valor === null ? null : JSON.stringify({ valor: p.valor, ttl: p.ttl }),
      precondition: p.anterior === null ? null : { url, pointer: '/valor', expected: p.anterior, ifMatch: true },
    };
  },
  undo: (_conn, p) => ({ type: 'dns.registro', params: { ...p, valor: p.anterior, anterior: p.valor } }),
};

/** Any operation type: its params are validated by its own schema before use. */
// biome-ignore lint/suspicious/noExplicitAny: a registry of operations with different parameter types
export type AnyOperation = OperationType<any>;

export const OPERATIONS: Record<string, AnyOperation> = Object.fromEntries([httpJson, emailSend, webhookEvent, dnsRecord].map((o) => [o.id, o]));

export function operation(id: string): AnyOperation {
  const op = OPERATIONS[id];
  if (!op) throw new OperationError(`operación desconocida: ${id} (disponibles: ${Object.keys(OPERATIONS).join(', ')})`);
  return op;
}
