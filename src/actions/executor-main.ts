#!/usr/bin/env node
/**
 * Action executor: a separate process that receives ONE approved request and
 * its credential on stdin, performs it and prints one JSON line. It starts with
 * an empty environment and an empty working directory; workers never see it.
 *
 * Safety: destinations are resolved once and pinned (no DNS rebinding between
 * check and use); private/loopback/metadata addresses are refused unless the
 * connection allows local test services; redirects are never followed.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { HttpRequestSpec } from './operations.js';

export type ExecutorOrder = {
  request: HttpRequestSpec;
  idempotencyKey: string;
  auth: { header: string; value: string } | null;
  allowLocal: boolean;
  timeoutMs: number;
};

export type ExecutorResult =
  | { phase: 'bloqueado'; detail: string }
  | { phase: 'precondicion'; detail: string }
  | { phase: 'no_enviado'; detail: string }
  | { phase: 'respuesta'; status: number; etag: string | null; location: string | null; body: string }
  | { phase: 'incierto'; detail: string };

function isPrivate(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
}

async function pin(url: URL, allowLocal: boolean): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length) throw Object.assign(new Error(`no se pudo resolver ${host}`), { notSent: true });
  const blocked = addresses.find((a) => isPrivate(a.address));
  if (blocked && !allowLocal) throw Object.assign(new Error(`destino interno bloqueado: ${host} → ${blocked.address}`), { blocked: true });
  return addresses[0]!.address;
}

type Raw = { status: number; headers: IncomingMessage['headers']; body: string };

function send(url: URL, ip: string, method: string, headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<Raw> {
  return new Promise((resolve, reject) => {
    let connected = false;
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        method,
        host: url.hostname.replace(/^\[|\]$/g, ''),
        ...(url.port ? { port: Number(url.port) } : {}),
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, ...(body !== null ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) },
        // Pinned resolution: the address checked above is the one used.
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address: ip, family: isIP(ip) }]) : cb(null, ip, isIP(ip))) as unknown as LookupFunction,
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (text.length < 64 * 1024) text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
        res.on('error', (e) => reject(Object.assign(e, { uncertain: true })));
      },
    );
    req.on('socket', (s) => s.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => (connected = true)));
    req.on('timeout', () => req.destroy(Object.assign(new Error(`sin respuesta en ${timeoutMs} ms`), { uncertain: connected })));
    req.on('error', (e) => reject(Object.assign(e, { uncertain: (e as { uncertain?: boolean }).uncertain ?? connected })));
    if (body !== null) req.write(body);
    req.end();
  });
}

function pointerGet(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export async function execute(order: ExecutorOrder): Promise<ExecutorResult> {
  const { request: r } = order;
  const auth: Record<string, string> = order.auth ? { [order.auth.header]: order.auth.value } : {};
  const target = new URL(r.url);
  let ip: string;
  try {
    ip = await pin(target, order.allowLocal);
  } catch (e) {
    return (e as { blocked?: boolean }).blocked ? { phase: 'bloqueado', detail: (e as Error).message } : { phase: 'no_enviado', detail: (e as Error).message };
  }

  let etag: string | null = null;
  if (r.precondition) {
    const pre = new URL(r.precondition.url);
    try {
      const got = await send(pre, await pin(pre, order.allowLocal), 'GET', { Accept: 'application/json', ...auth }, null, order.timeoutMs);
      if (got.status !== 200) return { phase: 'precondicion', detail: `la consulta de precondición respondió ${got.status}` };
      const actual = pointerGet(JSON.parse(got.body), r.precondition.pointer);
      if (JSON.stringify(actual) !== JSON.stringify(r.precondition.expected)) {
        return { phase: 'precondicion', detail: `se esperaba ${JSON.stringify(r.precondition.expected)} y el servicio tiene ${JSON.stringify(actual)}` };
      }
      etag = typeof got.headers.etag === 'string' ? got.headers.etag : null;
    } catch (e) {
      // A read that failed changed nothing: the action was not sent.
      return { phase: 'no_enviado', detail: `no se pudo comprobar la precondición: ${(e as Error).message}` };
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Idempotency-Key': order.idempotencyKey,
    'User-Agent': 'forja-ejecutor',
    ...auth,
    ...(r.body !== null ? { 'Content-Type': 'application/json' } : {}),
    ...(etag && r.precondition?.ifMatch ? { 'If-Match': etag } : {}),
  };
  try {
    const res = await send(target, ip, r.method, headers, r.body, order.timeoutMs);
    return {
      phase: 'respuesta',
      status: res.status,
      etag: (res.headers.etag as string | undefined) ?? null,
      location: (res.headers.location as string | undefined) ?? null,
      body: res.body.slice(0, 4096),
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { uncertain?: boolean };
    if (!err.uncertain && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err.code ?? '')) {
      return { phase: 'no_enviado', detail: `${err.code}: el servicio no recibió la petición` };
    }
    return { phase: 'incierto', detail: `${err.code ?? 'error'}: ${err.message}` };
  }
}

// Run as a process: order on stdin, result on stdout.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c: string) => (input += c));
  process.stdin.on('end', () => {
    execute(JSON.parse(input) as ExecutorOrder)
      .then((r) => process.stdout.write(`${JSON.stringify(r)}\n`))
      .catch((e: Error) => process.stdout.write(`${JSON.stringify({ phase: 'incierto', detail: e.message })}\n`));
  });
}
