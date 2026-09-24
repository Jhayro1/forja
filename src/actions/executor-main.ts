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
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { DestinationError, hostOf, pinDestination, portOf } from './destination.js';
import type { HttpRequestSpec } from './operations.js';
import { openTunnel } from './tunnel.js';

export type ExecutorOrder = {
  request: HttpRequestSpec;
  idempotencyKey: string;
  auth: { header: string; value: string } | null;
  allowLocal: boolean;
  timeoutMs: number;
  /**
   * Sandboxed mode (MEJORAS 4.2): no network here; connect through this unix
   * socket, whose proxy (in the parent) already pinned and checked every destination.
   */
  tunnel?: string;
};

export type ExecutorResult =
  | { phase: 'bloqueado'; detail: string }
  | { phase: 'precondicion'; detail: string }
  | { phase: 'no_enviado'; detail: string }
  | { phase: 'respuesta'; status: number; etag: string | null; location: string | null; body: string }
  | { phase: 'incierto'; detail: string };

type Raw = { status: number; headers: IncomingMessage['headers']; body: string };

/** Where the bytes go: a pinned address (direct mode) or an already open tunnel stream (sandboxed mode). */
type Route = { ip: string } | { stream: Socket };

async function route(url: URL, order: ExecutorOrder): Promise<Route> {
  if (!order.tunnel) return { ip: await pinDestination(url, order.allowLocal) };
  const raw = await openTunnel(order.tunnel, hostOf(url), portOf(url));
  if (url.protocol !== 'https:') return { stream: raw };
  // TLS end to end with the real server name: the tunnel only carries bytes.
  const tls = tlsConnect({ socket: raw, servername: isIP(hostOf(url)) ? '' : hostOf(url) });
  await new Promise<void>((resolve, reject) => {
    tls.once('secureConnect', () => resolve());
    tls.once('error', (e) => reject(Object.assign(e, { notSent: true })));
  });
  return { stream: tls };
}

function send(url: URL, via: Route, method: string, headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<Raw> {
  return new Promise((resolve, reject) => {
    let connected = 'stream' in via;
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        method,
        host: hostOf(url),
        ...(url.port ? { port: Number(url.port) } : {}),
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, ...(body !== null ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) },
        ...('stream' in via
          ? // No agent: with createConnection and no agent, Node uses this stream (agent:false would dial directly).
            { createConnection: () => via.stream }
          : {
              // Pinned resolution: the address checked above is the one used.
              lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
                opts?.all ? cb(null, [{ address: via.ip, family: isIP(via.ip) }]) : cb(null, via.ip, isIP(via.ip))) as unknown as LookupFunction,
            }),
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
    if (!connected) req.on('socket', (s) => s.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => (connected = true)));
    // Own deadline for the whole exchange: the socket timeout does not apply to a stream given by createConnection.
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error(`sin respuesta en ${timeoutMs} ms`), { uncertain: connected })), timeoutMs);
    req.on('close', () => clearTimeout(deadline));
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
  const notSent = (e: unknown): ExecutorResult =>
    e instanceof DestinationError
      ? { phase: e.kind, detail: e.message }
      : (e as { code?: string }).code === 'EBLOQUEADO'
        ? { phase: 'bloqueado', detail: (e as Error).message }
        : { phase: 'no_enviado', detail: (e as Error).message };

  let etag: string | null = null;
  if (r.precondition) {
    const pre = new URL(r.precondition.url);
    try {
      const got = await send(pre, await route(pre, order), 'GET', { Accept: 'application/json', ...auth }, null, order.timeoutMs);
      if (got.status !== 200) return { phase: 'precondicion', detail: `la consulta de precondición respondió ${got.status}` };
      const actual = pointerGet(JSON.parse(got.body), r.precondition.pointer);
      if (JSON.stringify(actual) !== JSON.stringify(r.precondition.expected)) {
        return { phase: 'precondicion', detail: `se esperaba ${JSON.stringify(r.precondition.expected)} y el servicio tiene ${JSON.stringify(actual)}` };
      }
      etag = typeof got.headers.etag === 'string' ? got.headers.etag : null;
    } catch (e) {
      if (e instanceof DestinationError && e.kind === 'bloqueado') return notSent(e);
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
  let via: Route;
  try {
    via = await route(target, order);
  } catch (e) {
    return notSent(e);
  }
  try {
    const res = await send(target, via, r.method, headers, r.body, order.timeoutMs);
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
    // One result line, then exit: an open tunnel or keep-alive socket must not keep the process alive.
    const finish = (r: ExecutorResult) => process.stdout.write(`${JSON.stringify(r)}\n`, () => process.exit(0));
    execute(JSON.parse(input) as ExecutorOrder)
      .then(finish)
      .catch((e: Error) => finish({ phase: 'incierto', detail: e.message }));
  });
}
