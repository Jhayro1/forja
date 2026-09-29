import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { TEXTOS } from '../i18n/textos.js';
import { FeedBroadcaster, type FeedEvent } from './broadcaster.js';
import { ApiError, cookie, readJson, SECURITY_HEADERS, send, sendError } from './http.js';
import { type IdempotencyStore, MemoryIdempotencyStore } from './idempotency.js';
import type { OwnerAuth } from './owner-auth.js';
import { type Session, SessionManager, safeEqual } from './session.js';

/**
 * Local HTTP API and panel (V2-041). Loopback only, no CORS, session cookie +
 * CSRF for mutations, Host/Origin validation against DNS rebinding. Features
 * plug in as modules (runs, connections, memory…) so the core never changes to
 * add a screen: open for extension, closed for modification.
 */

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  query: URLSearchParams;
  session: Session;
  body: () => Promise<Record<string, unknown>>;
};

export type Route = {
  method: 'GET' | 'POST' | 'DELETE';
  path: RegExp;
  /** Handler returns the JSON body (status 200) or writes the response itself. */
  handler: (ctx: RouteContext) => unknown | Promise<unknown>;
};

export type ApiModule = { name: string; routes: Route[] };

/** Ordered domain events for SSE (at-least-once, cursor = checkout:seq). */
export interface EventFeed {
  readonly checkoutId: string;
  lastSeq(): number;
  after(seq: number, limit: number): { seq: number; type: string; aggregate_id: string; run_id: string | null; task_id: string | null; recorded_at: string }[];
}

/** What the panel sees for one project: its screens and its event feed. */
export type ProjectScope = { readonly modules: ApiModule[]; readonly feed: EventFeed };

/**
 * The project the panel is looking at, switchable at runtime (multi-project panel).
 * `null` when no project is chosen yet: global modules still work.
 */
export interface ProjectHost {
  current(): ProjectScope | null;
  /** Called before a scope stops being current (and before its store closes). */
  onLeave?(listener: (scope: ProjectScope) => void): void;
}

export type ApiOptions = {
  /** Always available, with or without a project (system, providers, projects). */
  global?: ApiModule[];
  /** A switchable project; takes precedence over `modules` + `feed`. */
  project?: ProjectHost;
  /** A single fixed project (kept for embedding and tests). */
  modules?: ApiModule[];
  feed?: EventFeed;
  sessions?: SessionManager;
  host?: string;
  port?: number;
  pollMs?: number;
  heartbeatMs?: number;
  maxStreams?: number;
  /** Where answers by Idempotency-Key are kept (in memory by default). */
  idempotency?: IdempotencyStore;
  /**
   * Server mode (v3/PLAN.md §6.9): listens beyond loopback behind a TLS proxy, and
   * NOTHING is served without the owner's session except the login page, its own
   * files, `/v1/auth/*` and `/salud`.
   */
  server?: { auth: OwnerAuth; publicUrl: string; trustProxy?: boolean };
};

/** Where a session comes from: one-time links (local) or the owner login (server). */
export interface SessionLookup {
  get(id: string | undefined): Session | null;
  revoke(id: string): void;
}

/** The compiled panel (panel/ is a Vite project; `npm run build` leaves it in panel/dist). */
const PANEL_DIR = fileURLToPath(new URL('../../panel/dist/', import.meta.url));
const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  png: 'image/png',
};
/**
 * A plain file name at the root of the panel or inside assets/: every dot-separated
 * part has at least one safe character, so `..`, slashes and hidden files never match.
 */
const PANEL_FILE = /^\/((?:assets\/)?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(js|css|svg|woff2|png))$/;
const NONCE_MARK = '__FORJA_NONCE__';

type StaticFile = { file: string; type: string; immutable: boolean };

function staticFile(pathname: string): StaticFile | null {
  if (pathname === '/' || pathname === '/index.html') return { file: 'index.html', type: TYPES.html!, immutable: false };
  const m = PANEL_FILE.exec(pathname);
  // Vite names what is in assets/ by content hash: it can be cached forever.
  return m && existsSync(`${PANEL_DIR}${m[1]}`) ? { file: m[1]!, type: TYPES[m[2]!]!, immutable: m[1]!.startsWith('assets/') } : null;
}

/**
 * The page with a fresh nonce: Radix adds a <style> to lock scrolling behind dialogs and
 * the panel hands it this nonce, so the CSP can keep refusing any other inline style.
 */
function panelPage(): { body: string; csp: string } | null {
  const path = `${PANEL_DIR}index.html`;
  if (!existsSync(path)) return null;
  const nonce = randomBytes(16).toString('base64');
  const csp = SECURITY_HEADERS['Content-Security-Policy']!.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`);
  return { body: readFileSync(path, 'utf8').replaceAll(NONCE_MARK, nonce), csp };
}

/**
 * Files the login page needs (server mode): its entry, CSS, fonts and imported chunks,
 * read from Vite's manifest. Everything else in the panel requires a session.
 */
function loginAssets(): Set<string> {
  const path = `${PANEL_DIR}.vite/manifest.json`;
  const allowed = new Set<string>();
  if (!existsSync(path)) return allowed;
  type Chunk = { file: string; src?: string; isEntry?: boolean; css?: string[]; assets?: string[]; imports?: string[] };
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Chunk>;
  const visit = (key: string) => {
    const c = manifest[key];
    if (!c || allowed.has(c.file)) return;
    allowed.add(c.file);
    for (const f of [...(c.css ?? []), ...(c.assets ?? [])]) allowed.add(f);
    for (const i of c.imports ?? []) visit(i);
  };
  visit('login.html');
  return allowed;
}

/** The login page (server mode) with its own fresh nonce, like the panel page. */
function loginPage(): { body: string; csp: string } | null {
  const path = `${PANEL_DIR}login.html`;
  if (!existsSync(path)) return null;
  const nonce = randomBytes(16).toString('base64');
  const csp = SECURITY_HEADERS['Content-Security-Policy']!.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`);
  return { body: readFileSync(path, 'utf8').replaceAll(NONCE_MARK, nonce), csp };
}

const SESSION_COOKIE = 'forja_sesion';

export class ApiServer {
  readonly sessions: SessionManager;
  private readonly lookup: SessionLookup;
  private readonly cookieName: string;
  private readonly cookieFlags: string;
  private readonly publicUrl: URL | null;
  private loginFiles: Set<string> | null = null;
  private readonly server: Server;
  private readonly global: ApiModule[];
  private readonly project: ProjectHost;
  private readonly idempotency: IdempotencyStore;
  private readonly broadcasters = new Map<EventFeed, FeedBroadcaster>();
  /** Open SSE streams per feed, so leaving a project ends them before its store closes. */
  private readonly openStreams = new Map<EventFeed, Set<() => void>>();
  private streams = 0;
  private port = 0;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly opts: ApiOptions) {
    this.sessions = opts.sessions ?? new SessionManager();
    this.lookup = opts.server?.auth ?? this.sessions;
    this.publicUrl = opts.server ? new URL(opts.server.publicUrl) : null;
    const https = this.publicUrl?.protocol === 'https:';
    // __Host- cookies must be Secure, host-only and Path=/: the browser enforces it.
    this.cookieName = https ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
    this.cookieFlags = `HttpOnly; SameSite=Strict; Path=/${https ? '; Secure' : ''}`;
    this.idempotency = opts.idempotency ?? new MemoryIdempotencyStore();
    this.global = opts.global ?? [];
    if (opts.project) this.project = opts.project;
    else if (opts.feed) {
      const fixed: ProjectScope = { modules: opts.modules ?? [], feed: opts.feed };
      this.project = { current: () => fixed };
    } else this.project = { current: () => null };
    this.project.onLeave?.((scope) => this.leave(scope.feed));
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof ApiError) sendError(res, error);
        // Internal details stay out of the response (v2/10).
        else sendError(res, new ApiError(500, 'error_interno', 'error interno; revisa la terminal de forja ui', true));
      });
    });
  }

  async listen(): Promise<{ url: string; port: number }> {
    const host = this.opts.host ?? '127.0.0.1';
    // Beyond loopback only in server mode, where every route is behind the owner login.
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !this.opts.server) throw new Error('la API sólo escucha en loopback (127.0.0.1)');
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port ?? 0, host, () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    return { url: this.publicUrl ? this.publicUrl.origin : `http://127.0.0.1:${this.port}`, port: this.port };
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const b of this.broadcasters.values()) b.close();
    this.broadcasters.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Ends every stream of a feed and forgets its broadcaster (the browser reconnects to the new project). */
  private leave(feed: EventFeed): void {
    for (const end of [...(this.openStreams.get(feed) ?? [])]) end();
    this.openStreams.delete(feed);
    this.broadcasters.get(feed)?.close();
    this.broadcasters.delete(feed);
  }

  private broadcasterFor(feed: EventFeed): FeedBroadcaster {
    let b = this.broadcasters.get(feed);
    if (!b) {
      b = new FeedBroadcaster(feed, this.opts.pollMs ?? 500);
      this.broadcasters.set(feed, b);
    }
    return b;
  }

  private routes(): Route[] {
    return [...this.global, ...(this.project.current()?.modules ?? [])].flatMap((m) => m.routes);
  }

  private allowedHosts(): string[] {
    if (this.publicUrl) return [this.publicUrl.host];
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
  }

  private allowedOrigins(): string[] {
    if (this.publicUrl) return [this.publicUrl.origin];
    return this.allowedHosts().map((h) => `http://${h}`);
  }

  /** The client address for rate limits: the proxy's X-Forwarded-For when it is trusted. */
  private clientIp(req: IncomingMessage): string {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')[0]
      ?.trim();
    if (this.opts.server?.trustProxy !== false && forwarded) return forwarded.slice(0, 64);
    return req.socket.remoteAddress ?? 'desconocida';
  }

  /** DNS rebinding: a page on evil.com resolving to 127.0.0.1 still sends Host: evil.com. */
  private checkHost(req: IncomingMessage): void {
    if (!this.allowedHosts().includes(req.headers.host ?? '')) throw new ApiError(421, 'host_no_permitido', 'host no permitido');
  }

  private checkOrigin(req: IncomingMessage, required: boolean): void {
    const origin = req.headers.origin;
    if (!origin) {
      if (required) throw new ApiError(403, 'origen_requerido', 'falta el encabezado Origin');
      return;
    }
    if (!this.allowedOrigins().includes(origin)) throw new ApiError(403, 'origen_no_permitido', 'origen no permitido');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const method = req.method ?? 'GET';
    // Health check for the platform (Doko): no Host check, no data, no session.
    if (this.opts.server && method === 'GET' && url.pathname === '/salud') return send(res, 200, { ok: true });
    this.checkHost(req);

    if (this.opts.server) {
      const done = await this.serverGate(req, res, url, method);
      if (done) return;
    }

    const asset = method === 'GET' ? staticFile(url.pathname) : null;
    if (asset?.file === 'index.html') {
      const page = panelPage();
      if (!page) throw new ApiError(503, 'panel_sin_compilar', 'falta compilar el panel: corre «npm run build» en el repositorio de Forja');
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Security-Policy': page.csp, 'Content-Type': asset.type });
      res.end(page.body);
      return;
    }
    if (asset) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type, ...(asset.immutable ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}) });
      res.end(readFileSync(`${PANEL_DIR}${asset.file}`));
      return;
    }

    const mutation = method !== 'GET';
    this.checkOrigin(req, mutation);

    if (url.pathname === '/v1/sesion') return this.sessionRoute(req, res, method);

    const session = this.lookup.get(cookie(req, this.cookieName));
    if (!session) {
      if (this.opts.server) throw new ApiError(401, 'sin_sesion', 'inicia sesión', false, '/login');
      throw new ApiError(401, 'sin_sesion', 'inicia sesión con el enlace que muestra forja ui', false, 'forja ui');
    }
    if (mutation) {
      const csrf = String(req.headers['x-forja-csrf'] ?? '');
      if (!csrf || !safeEqual(csrf, session.csrf)) throw new ApiError(403, 'csrf', 'falta o no coincide el token CSRF');
    }

    if (method === 'GET' && url.pathname === '/v1/eventos') return this.stream(req, res);
    if (method === 'GET' && url.pathname === '/v1/modulos') {
      const scope = this.project.current();
      return send(res, 200, { modulos: [...this.global, ...(scope?.modules ?? [])].map((m) => m.name), proyecto: scope ? scope.feed.checkoutId : null });
    }
    if (method === 'GET' && url.pathname === '/v1/textos') return send(res, 200, { textos: TEXTOS });

    for (const route of this.routes()) {
      if (route.method !== method) continue;
      const m = route.path.exec(url.pathname);
      if (!m) continue;
      const key = mutation ? req.headers['idempotency-key'] : undefined;
      if (typeof key === 'string' && key.length > 200) throw new ApiError(422, 'idempotencia', 'Idempotency-Key demasiado larga');
      // Scoped by method and path (not by session): a retry after restarting forja ui still replays.
      const cacheKey = typeof key === 'string' && key ? `${method}:${url.pathname}:${key}` : null;
      let bodyCache: Promise<Record<string, unknown>> | null = null;
      let requestHash = '';
      if (cacheKey) {
        bodyCache = readJson(req);
        requestHash = createHash('sha256')
          .update(JSON.stringify(await bodyCache))
          .digest('hex');
        const prev = this.idempotency.get(cacheKey);
        if (prev) {
          if (prev.requestHash !== requestHash) throw new ApiError(422, 'idempotencia', 'esta Idempotency-Key ya se usó con otro cuerpo');
          return send(res, prev.status, prev.body as object, { 'Idempotent-Replayed': 'true' });
        }
      }
      const ctx: RouteContext = { req, res, params: m.slice(1).map(decodeURIComponent), query: url.searchParams, session, body: () => (bodyCache ??= readJson(req)) };
      let result: unknown;
      try {
        result = await route.handler(ctx);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // Domain refusals (wrong state, missing approval…) are precondition conflicts.
        if (mutation) throw new ApiError(409, 'precondicion', (error as Error).message);
        throw error;
      }
      if (res.headersSent) return;
      const body = (result ?? {}) as object;
      if (cacheKey) this.idempotency.set(cacheKey, { status: 200, body, requestHash });
      if (!mutation) {
        // Reads carry an ETag: the panel asks with If-None-Match and skips re-rendering on 304 (MEJORAS 3.6).
        const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ...SECURITY_HEADERS, ETag: etag });
          res.end();
          return;
        }
        return send(res, 200, body, { ETag: etag });
      }
      return send(res, 200, body);
    }
    if (!this.project.current() && url.pathname.startsWith('/v1/')) throw new ApiError(409, 'sin_proyecto', 'elige o importa un proyecto primero', false);
    throw new ApiError(404, 'no_encontrado', 'recurso no encontrado');
  }

  /**
   * Server mode: what may be answered before the owner signs in. Returns true when the
   * request was fully handled here; false lets it continue to the (session-checked) panel.
   */
  private async serverGate(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const auth = this.opts.server!.auth;
    const session = auth.get(cookie(req, this.cookieName));
    const path = url.pathname;
    if (path.startsWith('/v1/auth/')) {
      await this.authRoute(req, res, path, method, session);
      return true;
    }
    if (method === 'GET' && (path === '/login' || path === '/login.html')) {
      if (session) return this.redirect(res, '/');
      const page = loginPage();
      if (!page) throw new ApiError(503, 'panel_sin_compilar', 'falta compilar el panel');
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Security-Policy': page.csp, 'Content-Type': TYPES.html! });
      res.end(page.body);
      return true;
    }
    if (session) return false;
    // No session: the login page's own files, and nothing else.
    const asset = method === 'GET' ? staticFile(path) : null;
    this.loginFiles ??= loginAssets();
    if (asset && asset.file !== 'index.html' && (this.loginFiles.has(asset.file) || asset.file === 'forja.svg')) return false;
    if (method === 'GET' && !path.startsWith('/v1/')) return this.redirect(res, '/login');
    throw new ApiError(401, 'sin_sesion', 'inicia sesión', false, '/login');
  }

  private redirect(res: ServerResponse, to: string): true {
    res.writeHead(302, { ...SECURITY_HEADERS, Location: to });
    res.end();
    return true;
  }

  /** Owner sign-up (closed except for FORJA_DUENO_EMAIL), verification, login and password reset. */
  private async authRoute(req: IncomingMessage, res: ServerResponse, path: string, method: string, session: Session | null): Promise<void> {
    const auth = this.opts.server!.auth;
    const ip = this.clientIp(req);
    if (method === 'GET' && path === '/v1/auth/estado') return send(res, 200, { ...auth.status(), sesion: Boolean(session) });
    if (method !== 'POST') throw new ApiError(405, 'metodo', 'método no permitido');
    // Same-origin JSON only, even before there is a session (login CSRF).
    this.checkOrigin(req, true);
    const body = await readJson(req, 8192);
    const str = (name: string, max = 254) => {
      const v = body[name];
      if (typeof v !== 'string' || !v.trim()) throw new ApiError(422, 'campo_requerido', `falta «${name}»`);
      if (v.length > max) throw new ApiError(422, 'campo_invalido', `«${name}» es demasiado largo`);
      return v;
    };
    switch (path) {
      case '/v1/auth/registro':
        return send(res, 200, await auth.register({ email: str('email'), clave: str('clave', 200) }, ip));
      case '/v1/auth/verificar':
        return send(res, 200, await auth.verify({ email: str('email'), codigo: str('codigo', 12) }, ip));
      case '/v1/auth/reenviar':
        return send(res, 200, await auth.resendCode(str('email'), ip));
      case '/v1/auth/recuperar':
        return send(res, 200, await auth.requestReset(str('email'), ip));
      case '/v1/auth/recuperar/confirmar':
        return send(res, 200, await auth.confirmReset({ email: str('email'), codigo: str('codigo', 12), clave: str('clave', 200) }, ip));
      case '/v1/auth/entrar': {
        const s = await auth.login({ email: str('email'), clave: str('clave', 200) }, ip);
        const maxAge = Math.max(0, Math.floor((s.expiresAt - Date.now()) / 1000));
        return send(res, 200, { csrf: s.csrf }, { 'Set-Cookie': `${this.cookieName}=${s.id}; ${this.cookieFlags}; Max-Age=${maxAge}` });
      }
      case '/v1/auth/salir': {
        if (session) {
          if (!safeEqual(String(req.headers['x-forja-csrf'] ?? ''), session.csrf)) throw new ApiError(403, 'csrf', 'falta o no coincide el token CSRF');
          auth.revoke(session.id);
        }
        return send(res, 200, {}, { 'Set-Cookie': `${this.cookieName}=; ${this.cookieFlags}; Max-Age=0` });
      }
      case '/v1/auth/clave': {
        if (!session) throw new ApiError(401, 'sin_sesion', 'inicia sesión', false, '/login');
        if (!safeEqual(String(req.headers['x-forja-csrf'] ?? ''), session.csrf)) throw new ApiError(403, 'csrf', 'falta o no coincide el token CSRF');
        return send(res, 200, await auth.changePassword(session, { actual: str('actual', 200), nueva: str('nueva', 200) }));
      }
      default:
        throw new ApiError(404, 'no_encontrado', 'recurso no encontrado');
    }
  }

  private async sessionRoute(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
    if (method === 'POST' && this.opts.server) throw new ApiError(404, 'no_encontrado', 'en modo servidor se entra con /login');
    if (method === 'POST') {
      const body = await readJson(req, 4096);
      const code = typeof body.codigo === 'string' ? body.codigo : '';
      const session = code ? this.sessions.exchange(code) : null;
      if (!session) throw new ApiError(401, 'codigo_invalido', 'el código no es válido, ya se usó o venció', false, 'vuelve a ejecutar forja ui');
      const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
      return send(res, 200, { csrf: session.csrf }, { 'Set-Cookie': `${this.cookieName}=${session.id}; ${this.cookieFlags}; Max-Age=${maxAge}` });
    }
    const session = this.lookup.get(cookie(req, this.cookieName));
    if (!session) throw new ApiError(401, 'sin_sesion', 'no hay sesión', false, this.opts.server ? '/login' : 'forja ui');
    if (method === 'GET') return send(res, 200, { csrf: session.csrf, servidor: Boolean(this.opts.server) });
    if (method === 'DELETE') {
      if (!safeEqual(String(req.headers['x-forja-csrf'] ?? ''), session.csrf)) throw new ApiError(403, 'csrf', 'falta o no coincide el token CSRF');
      this.lookup.revoke(session.id);
      return send(res, 200, {}, { 'Set-Cookie': `${this.cookieName}=; ${this.cookieFlags}; Max-Age=0` });
    }
    throw new ApiError(405, 'metodo', 'método no permitido');
  }

  /**
   * Server-sent events, at least once: ids are `checkout:seq`; the browser
   * reconnects with Last-Event-ID and receives what it missed. Without a usable
   * cursor it gets a `snapshot` event with the watermark and should refetch state.
   */
  private stream(req: IncomingMessage, res: ServerResponse): void {
    if (this.streams >= (this.opts.maxStreams ?? 8)) throw new ApiError(429, 'demasiadas_conexiones', 'demasiadas conexiones de eventos abiertas', true);
    const scope = this.project.current();
    if (!scope) throw new ApiError(409, 'sin_proyecto', 'elige o importa un proyecto primero', false);
    const feed = scope.feed;
    const raw = String(req.headers['last-event-id'] ?? new URL(req.url ?? '/', 'http://x').searchParams.get('desde') ?? '');
    const [checkout, seqText] = raw.split(':');
    const last = feed.lastSeq();
    let cursor = checkout === feed.checkoutId && seqText !== undefined && /^\d+$/.test(seqText) ? Number(seqText) : -1;
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    this.streams++;
    if (cursor < 0 || cursor > last) {
      cursor = last;
      res.write(`id: ${feed.checkoutId}:${cursor}\nevent: snapshot\ndata: ${JSON.stringify({ watermark: cursor })}\n\n`);
    }
    res.write('retry: 2000\n\n');
    let paused = false;
    const write = (e: FeedEvent): boolean => {
      cursor = e.seq;
      return res.write(`id: ${feed.checkoutId}:${e.seq}\nevent: evento\ndata: ${JSON.stringify(e)}\n\n`);
    };
    // Catch-up from this stream's own cursor (reconnections), then the shared broadcast.
    const catchUp = () => {
      for (;;) {
        const batch = feed.after(cursor, 200);
        if (batch.length === 0) return;
        for (const e of batch) {
          if (!write(e)) return pause();
        }
      }
    };
    // Backpressure: a slow browser never slows the scheduler; we stop writing and catch up on drain.
    const pause = () => {
      paused = true;
      res.once('drain', () => {
        paused = false;
        catchUp();
      });
    };
    catchUp();
    const unsubscribe = this.broadcasterFor(feed).subscribe((events) => {
      if (paused) return;
      for (const e of events) {
        if (e.seq <= cursor) continue;
        if (!write(e)) return pause();
      }
    });
    const beat = setInterval(() => res.write(': latido\n\n'), this.opts.heartbeatMs ?? 15_000);
    this.timers.add(beat);
    let ended = false;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      unsubscribe();
      clearInterval(beat);
      this.timers.delete(beat);
      this.openStreams.get(feed)?.delete(end);
      this.streams--;
    };
    // Leaving the project ends the stream; EventSource reconnects and lands on the new one.
    const end = () => {
      cleanup();
      res.end();
    };
    if (!this.openStreams.has(feed)) this.openStreams.set(feed, new Set());
    this.openStreams.get(feed)!.add(end);
    req.on('close', cleanup);
  }
}
