import type { IncomingMessage, ServerResponse } from 'node:http';

/** Error with a stable code for the API contract (v2/10 · API v1). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly action: string | null = null,
  ) {
    super(message);
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify({ version: 1, ...(body as object) });
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

export function sendError(res: ServerResponse, error: ApiError): void {
  send(res, error.status, { error: { codigo: error.code, mensaje: error.message, reintentable: error.retryable, accion: error.action } });
}

export async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  // JSON only: an HTML form cannot send it, one more barrier against CSRF.
  if (!type.startsWith('application/json')) throw new ApiError(415, 'tipo_no_soportado', 'el cuerpo debe ser application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new ApiError(413, 'cuerpo_grande', `el cuerpo supera ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('no es un objeto');
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'json_invalido', 'el cuerpo no es un objeto JSON válido');
  }
}

export function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function stringField(body: Record<string, unknown>, name: string, opts: { optional?: boolean; max?: number } = {}): string | null {
  const v = body[name];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return null;
    throw new ApiError(422, 'campo_requerido', `falta «${name}»`);
  }
  if (typeof v !== 'string') throw new ApiError(422, 'campo_invalido', `«${name}» debe ser texto`);
  if (v.length > (opts.max ?? 10_000)) throw new ApiError(422, 'campo_invalido', `«${name}» es demasiado largo`);
  return v;
}
