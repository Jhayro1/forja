import { readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryIdempotencyStore, SqliteIdempotencyStore } from '../../src/api/idempotency.js';
import { memoryModule } from '../../src/api/modules/memory.js';
import { planningModule } from '../../src/api/modules/planning.js';
import { type RunsBackend, runsModule } from '../../src/api/modules/runs.js';
import { type WorkBackend, workModule } from '../../src/api/modules/work.js';
import { type ApiModule, ApiServer, type EventFeed, type ProjectHost, type ProjectScope } from '../../src/api/server.js';
import { SessionManager } from '../../src/api/session.js';
import { ROOT } from '../helpers/engine.js';

type Ev = ReturnType<EventFeed['after']>[number];

class FakeFeed implements EventFeed {
  constructor(readonly checkoutId = 'chk_1') {}
  events: Ev[] = [];
  push(type: string) {
    this.events.push({ seq: this.events.length + 1, type, aggregate_id: 'x', run_id: 'run_1', task_id: null, recorded_at: new Date().toISOString() });
  }
  lastSeq() {
    return this.events.length;
  }
  after(seq: number, limit: number) {
    return this.events.filter((e) => e.seq > seq).slice(0, limit);
  }
}

class FakeBackend implements RunsBackend {
  answers: [string, string][] = [];
  state() {
    return { cambio: { titulo: '<img src=x onerror=alert(1)>' }, tareas: [] };
  }
  task(id: string) {
    return id === 'T-001' ? { detalle: ['d'], registro: ['r'], instrucciones: ['i'] } : null;
  }
  async diff() {
    return ['+ a'];
  }
  answer(taskId: string, text: string) {
    if (taskId !== 'T-001') throw new Error(`la tarea ${taskId} no está esperando una respuesta`);
    this.answers.push([taskId, text]);
  }
  retry() {}
  pauses: string[] = [];
  pause(taskId: string) {
    this.pauses.push(taskId);
    return `⏸ ${taskId} pausada`;
  }
  resume(taskId: string) {
    return `▶ ${taskId} reanudada`;
  }
  reassign(taskId: string, model: string | null) {
    if (model && !model.includes(':')) throw new Error(`«${model}» no está permitido`);
    return `${taskId} → ${model}`;
  }
  resumeProvider(key: string) {
    return `${key} disponible`;
  }
  stop() {
    return 'detenido';
  }
  approvePlan() {
    return 'aprobado';
  }
}

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: any; text: string };

let server: ApiServer;
let base: string;
let port: number;
let feed: FakeFeed;
let backend: FakeBackend;

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

const origin = () => ({ Origin: `http://127.0.0.1:${port}` });

async function login(): Promise<{ cookie: string; csrf: string }> {
  const r = await call('POST', '/v1/sesion', { headers: { ...origin(), 'Content-Type': 'application/json' }, body: { codigo: server.sessions.issueCode() } });
  expect(r.status).toBe(200);
  return { cookie: String(r.headers['set-cookie']).split(';')[0]!, csrf: r.body.csrf };
}

beforeEach(async () => {
  feed = new FakeFeed();
  backend = new FakeBackend();
  server = new ApiServer({ modules: [runsModule(backend)], feed, pollMs: 20, heartbeatMs: 50 });
  ({ url: base, port } = await server.listen());
});
afterEach(() => server.close());

describe('API local · sesión y protecciones', () => {
  it('sólo escucha en loopback', async () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(new ApiServer({ modules: [], feed, host: '0.0.0.0' }).listen()).rejects.toThrow(/loopback/);
  });

  it('sin sesión no hay datos; el código sirve una sola vez; la cookie es HttpOnly y SameSite=Strict', async () => {
    expect((await call('GET', '/v1/estado')).status).toBe(401);
    const code = server.sessions.issueCode();
    const post = (c: string) => call('POST', '/v1/sesion', { headers: { ...origin(), 'Content-Type': 'application/json' }, body: { codigo: c } });
    expect((await post('inventado')).status).toBe(401);
    const ok = await post(code);
    expect(ok.status).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect((await post(code)).status).toBe(401);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    const st = await call('GET', '/v1/estado', { headers: { Cookie: cookie } });
    expect(st.status).toBe(200);
    expect(st.body.estado.cambio.titulo).toBe('<img src=x onerror=alert(1)>');
    expect((await call('GET', '/v1/sesion', { headers: { Cookie: cookie } })).body.csrf).toBe(ok.body.csrf);
  });

  it('un código vencido no abre sesión', () => {
    let now = 0;
    const s = new SessionManager({ codeTtlMs: 1000, now: () => now });
    const code = s.issueCode();
    now = 2000;
    expect(s.exchange(code)).toBeNull();
  });

  it('rechaza otro Host (DNS rebinding) y otro Origin', async () => {
    const { cookie } = await login();
    expect((await call('GET', '/v1/estado', { headers: { Host: 'evil.example:80', Cookie: cookie } })).status).toBe(421);
    expect((await call('GET', '/v1/estado', { headers: { Cookie: cookie, Origin: 'http://evil.example' } })).status).toBe(403);
  });

  it('las mutaciones exigen Origin, CSRF y JSON', async () => {
    const { cookie, csrf } = await login();
    const body = { respuesta: 'sí' };
    const json = { 'Content-Type': 'application/json' };
    expect((await call('POST', '/v1/tareas/T-001/respuesta', { headers: { Cookie: cookie, 'X-Forja-CSRF': csrf, ...json }, body })).status).toBe(403);
    expect((await call('POST', '/v1/tareas/T-001/respuesta', { headers: { Cookie: cookie, ...origin(), ...json }, body })).status).toBe(403);
    expect((await call('POST', '/v1/tareas/T-001/respuesta', { headers: { Cookie: cookie, ...origin(), 'X-Forja-CSRF': 'otro', ...json }, body })).status).toBe(403);
    const form = await call('POST', '/v1/tareas/T-001/respuesta', {
      headers: { Cookie: cookie, ...origin(), 'X-Forja-CSRF': csrf, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'respuesta=si',
    });
    expect(form.status).toBe(415);
    const ok = await call('POST', '/v1/tareas/T-001/respuesta', { headers: { Cookie: cookie, ...origin(), 'X-Forja-CSRF': csrf, ...json }, body });
    expect(ok.status).toBe(200);
    expect(backend.answers).toEqual([['T-001', 'sí']]);
  });

  it('errores con código estable: 422 dato inválido, 409 precondición, 404 recurso', async () => {
    const { cookie, csrf } = await login();
    const h = { Cookie: cookie, ...origin(), 'X-Forja-CSRF': csrf, 'Content-Type': 'application/json' };
    const empty = await call('POST', '/v1/tareas/T-001/respuesta', { headers: h, body: {} });
    expect(empty.status).toBe(422);
    expect(empty.body.error).toMatchObject({ codigo: 'campo_requerido', reintentable: false });
    const pre = await call('POST', '/v1/tareas/T-002/respuesta', { headers: h, body: { respuesta: 'x' } });
    expect(pre.status).toBe(409);
    expect(pre.body.error.mensaje).toMatch(/no está esperando/);
    expect((await call('GET', '/v1/tareas/T-009', { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await call('GET', '/v1/tareas/T-001/diff', { headers: { Cookie: cookie } })).body.diff).toEqual(['+ a']);
  });

  it('pausar, reanudar, reasignar y reanudar un proveedor, con los mismos controles', async () => {
    const { cookie, csrf } = await login();
    const h = { Cookie: cookie, ...origin(), 'X-Forja-CSRF': csrf, 'Content-Type': 'application/json' };
    expect((await call('POST', '/v1/tareas/T-001/pausar', { headers: { Cookie: cookie, ...origin(), 'Content-Type': 'application/json' }, body: {} })).status).toBe(403);
    expect((await call('POST', '/v1/tareas/T-001/pausar', { headers: h, body: {} })).body.mensaje).toBe('⏸ T-001 pausada');
    expect(backend.pauses).toEqual(['T-001']);
    expect((await call('POST', '/v1/tareas/T-001/reanudar', { headers: h, body: {} })).body.mensaje).toBe('▶ T-001 reanudada');
    expect((await call('POST', '/v1/tareas/T-001/reasignar', { headers: h, body: { modelo: 'codex:gpt' } })).body.mensaje).toBe('T-001 → codex:gpt');
    expect((await call('POST', '/v1/tareas/T-001/reasignar', { headers: h, body: { modelo: 'nada' } })).status).toBe(409);
    expect((await call('POST', '/v1/proveedores/claude/reanudar', { headers: h, body: {} })).body.mensaje).toBe('claude disponible');
    expect((await call('POST', '/v1/proveedores/..%2Fx/reanudar', { headers: h, body: {} })).status).toBe(404);
  });

  it('sirve el catálogo de textos y el panel no repite vocabulario propio (MEJORAS 2.12)', async () => {
    const { cookie } = await login();
    const r = await call('GET', '/v1/textos', { headers: { Cookie: cookie } });
    expect(r.body.textos.estadoTarea.ejecutando).toBe('agente trabajando');
    expect(r.body.textos.fases[2]).toEqual(['dividir', 'Plan']);
    expect((await call('GET', '/v1/textos')).status).toBe(401);
    const panel = panelSources()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const word of ["'agente trabajando'", "'pregunta de un agente'", "'espera tu aprobación'", "'Especificar'"]) expect(panel).not.toContain(word);
  });

  it('la clave de idempotencia persiste entre reinicios y no sirve para otro cuerpo (MEJORAS 3.7)', async () => {
    const { cookie, csrf } = await login();
    const store = new MemoryIdempotencyStore();
    const other = new ApiServer({ modules: [runsModule(backend)], feed, sessions: server.sessions, idempotency: store });
    const { port: p } = await other.listen();
    const h = { Cookie: cookie, Origin: `http://127.0.0.1:${p}`, Host: `127.0.0.1:${p}`, 'X-Forja-CSRF': csrf, 'Content-Type': 'application/json', 'Idempotency-Key': 'k-persistente' };
    const post = (srv: number, body: object) =>
      new Promise<Res>((resolve) => {
        const req = request(
          { host: '127.0.0.1', port: srv, method: 'POST', path: '/v1/tareas/T-001/respuesta', headers: { ...h, Host: `127.0.0.1:${srv}`, Origin: `http://127.0.0.1:${srv}` } },
          (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(text), text }));
          },
        );
        req.end(JSON.stringify(body));
      });
    expect((await post(p, { respuesta: 'uno' })).status).toBe(200);
    await other.close();
    // A new process with the same store (forja ui restarted) replays instead of repeating.
    const again = new ApiServer({ modules: [runsModule(backend)], feed, sessions: server.sessions, idempotency: store });
    const { port: p2 } = await again.listen();
    const replay = await post(p2, { respuesta: 'uno' });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(backend.answers).toHaveLength(1);
    const mismatch = await post(p2, { respuesta: 'otra' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.codigo).toBe('idempotencia');
    await again.close();
  });

  it('las lecturas llevan ETag y responden 304 si nada cambió (MEJORAS 3.6)', async () => {
    const { cookie } = await login();
    const first = await call('GET', '/v1/estado', { headers: { Cookie: cookie } });
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^".+"$/);
    const same = await call('GET', '/v1/estado', { headers: { Cookie: cookie, 'If-None-Match': etag } });
    expect(same.status).toBe(304);
    expect(same.text).toBe('');
    expect((await call('GET', '/v1/estado', { headers: { Cookie: cookie, 'If-None-Match': '"otro"' } })).status).toBe(200);
  });

  it('la misma Idempotency-Key no repite el efecto', async () => {
    const { cookie, csrf } = await login();
    const h = { Cookie: cookie, ...origin(), 'X-Forja-CSRF': csrf, 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' };
    const a = await call('POST', '/v1/tareas/T-001/respuesta', { headers: h, body: { respuesta: 'uno' } });
    const b = await call('POST', '/v1/tareas/T-001/respuesta', { headers: h, body: { respuesta: 'uno' } });
    expect(a.body).toEqual(b.body);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(backend.answers).toHaveLength(1);
  });

  it('cabeceras de seguridad y sin CORS; el panel no usa innerHTML ni scripts inline', async () => {
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect(page.text).not.toMatch(/<script>[^<]/);
    expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    // Un nonce nuevo en cada carga, el mismo en la cabecera y en la página; sólo para estilos.
    const nonce = /style-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.text).toContain(`content="${nonce}"`);
    expect(csp).not.toMatch(/script-src[^;]*nonce/);
    expect(String((await call('GET', '/')).headers['content-security-policy'])).not.toContain(nonce!);
    for (const f of panelSources()) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/\.innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write|eval\(|new Function/);
    }
    const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(page.text)?.[1];
    const asset = await call('GET', `/${script}`);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await call('GET', '/forja.svg')).headers['content-type']).toBe('image/svg+xml');
  });

  it('sólo sirve archivos planos del panel compilado: nada fuera de la carpeta', async () => {
    for (const path of [
      '/../package.json',
      '/%2e%2e/package.json',
      '/panel/../../package.json',
      '/assets/../../package.json',
      '/assets/.oculto.js',
      '/src/main.tsx',
      '/no-existe.js',
      '/package.json',
      '/src.ts',
      '/.env',
    ]) {
      expect((await call('GET', path)).status, path).not.toBe(200);
    }
  });
});

/** Every source file of the panel (React), to check what it never does. */
function panelSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(join(ROOT, 'panel/src'));
  return out;
}

describe('API local · eventos (SSE)', () => {
  function stream(cookie: string, lastId?: string): Promise<{ text: () => string; close: () => void }> {
    return new Promise((resolve, reject) => {
      let text = '';
      const req = request({ host: '127.0.0.1', port, path: '/v1/eventos', headers: { Host: `127.0.0.1:${port}`, Cookie: cookie, ...(lastId ? { 'Last-Event-ID': lastId } : {}) } }, (res) => {
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        res.on('data', (c) => (text += c));
        resolve({ text: () => text, close: () => req.destroy() });
      });
      req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
      req.end();
    });
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('sin cursor manda snapshot; luego eventos nuevos; al reconectar recibe lo que se perdió', async () => {
    const { cookie } = await login();
    feed.push('tarea.creada');
    const s1 = await stream(cookie);
    await wait(60);
    expect(s1.text()).toContain('event: snapshot');
    expect(s1.text()).toContain('"watermark":1');
    feed.push('tarea.estado_cambiado');
    await wait(80);
    expect(s1.text()).toContain('id: chk_1:2\nevent: evento');
    expect(s1.text()).toContain(': latido');
    s1.close();
    // Missed while disconnected:
    feed.push('run.estado_cambiado');
    feed.push('tarea.estado_cambiado');
    const s2 = await stream(cookie, 'chk_1:2');
    await wait(80);
    expect(s2.text()).not.toContain('event: snapshot');
    expect(s2.text()).toMatch(/id: chk_1:3[\s\S]*id: chk_1:4/);
    s2.close();
    // A cursor of another checkout or from the future gets a fresh snapshot.
    const s3 = await stream(cookie, 'chk_otro:2');
    await wait(60);
    expect(s3.text()).toContain('"watermark":4');
    s3.close();
  });

  it('varias conexiones comparten un solo sondeo del almacén (MEJORAS 3.5)', async () => {
    const { cookie } = await login();
    const broadcasters = () => [...(server as unknown as { broadcasters: Map<unknown, { reads: number }> }).broadcasters.values()];
    const reads = () => broadcasters().reduce((n, b) => n + b.reads, 0);
    const streams = await Promise.all([stream(cookie), stream(cookie), stream(cookie)]);
    await wait(40);
    expect(broadcasters()).toHaveLength(1);
    const before = reads();
    feed.push('tarea.estado_cambiado');
    await wait(120);
    for (const s of streams) expect(s.text()).toContain('event: evento');
    // ~6 ticks of 20 ms for the three connections together, not per connection.
    expect(reads() - before).toBeLessThan(15);
    for (const s of streams) s.close();
  });

  it('limita las conexiones abiertas', async () => {
    const { cookie } = await login();
    const small = new ApiServer({ modules: [], feed, maxStreams: 1, sessions: server.sessions });
    const { port: p } = await small.listen();
    const open = (): Promise<number> =>
      new Promise((resolve) => {
        const req = request({ host: '127.0.0.1', port: p, path: '/v1/eventos', headers: { Host: `127.0.0.1:${p}`, Cookie: cookie } }, (res) => resolve(res.statusCode ?? 0));
        req.on('error', () => resolve(0));
        req.end();
      });
    expect(await open()).toBe(200);
    expect(await open()).toBe(429);
    await small.close();
  });
});

describe('API local · memoria', () => {
  it('busca con validación y revisa lecciones con CSRF', async () => {
    const reviews: [string, boolean][] = [];
    const mem = new ApiServer({
      modules: [
        memoryModule({
          overview: () => ({ grafo: {} }),
          search: (q) => [{ id: `x:${q}` }],
          review: (id, ok) => {
            reviews.push([id, ok]);
            return { id };
          },
        }),
      ],
      feed,
      sessions: server.sessions,
    });
    const { port: p } = await mem.listen();
    const prev = port;
    port = p;
    try {
      const { cookie, csrf } = await login();
      expect((await call('GET', '/v1/memoria/buscar?q=a', { headers: { Cookie: cookie } })).status).toBe(422);
      expect((await call('GET', '/v1/memoria/buscar?q=UC-001', { headers: { Cookie: cookie } })).body.nodos).toEqual([{ id: 'x:UC-001' }]);
      const id = 'lec_01M3AAPTCH0WXKXT8DQVWD75D6';
      const h = { Cookie: cookie, ...origin(), 'Content-Type': 'application/json' };
      expect((await call('POST', `/v1/memoria/lecciones/${id}/aprobar`, { headers: h, body: {} })).status).toBe(403);
      expect((await call('POST', `/v1/memoria/lecciones/${id}/aprobar`, { headers: { ...h, 'X-Forja-CSRF': csrf }, body: {} })).status).toBe(200);
      expect((await call('POST', '/v1/memoria/lecciones/otra/aprobar', { headers: { ...h, 'X-Forja-CSRF': csrf }, body: {} })).status).toBe(404);
      expect(reviews).toEqual([[id, true]]);
    } finally {
      port = prev;
      await mem.close();
    }
  });
});

describe('idempotencia en SQLite', () => {
  it('guarda, repite dentro del plazo y olvida lo vencido', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE api_idempotency (key TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL)');
    let now = 1_000;
    const store = new SqliteIdempotencyStore(db as never, 100, () => now);
    store.set('k', { status: 200, body: { ok: true }, requestHash: 'h' });
    expect(store.get('k')).toEqual({ status: 200, body: { ok: true }, requestHash: 'h' });
    now = 1_200;
    expect(store.get('k')).toBeUndefined();
    db.close();
  });
});

describe('módulo de planeación (MEJORAS 3.4)', () => {
  it('muestra la planeación y responde preguntas de la spec con los mismos controles', async () => {
    const answered: [string, string][] = [];
    const feed2 = new FakeFeed();
    const srv = new ApiServer({
      modules: [
        planningModule({
          overview: () => ({ cambio: { titulo: 'Fiados' }, plan: { olas: [['T-001']] } }),
          send: () => 'pensando',
          answerSpecQuestion: (id, text) => {
            answered.push([id, text]);
            return `respuesta a ${id}`;
          },
          approveDiscovery: () => 'aprobado',
          selectSprint: (id) => `sprint ${id}`,
          move: (to) => `a ${to}`,
          requestSpecChange: (text) => `cambio ${text}`,
          useCase: () => null,
          editUseCase: (e) => `editado ${e.caso.id}`,
          removeUseCase: (id) => `quitado ${id}`,
        }),
      ],
      feed: feed2,
    });
    const { port: p } = await srv.listen();
    const req = (method: string, path: string, headers: Record<string, string>, body?: object) =>
      new Promise<Res>((resolve) => {
        const r = request({ host: '127.0.0.1', port: p, method, path, headers: { Host: `127.0.0.1:${p}`, ...headers } }, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) : null, text }));
        });
        r.end(body ? JSON.stringify(body) : undefined);
      });
    const login2 = await req('POST', '/v1/sesion', { Origin: `http://127.0.0.1:${p}`, 'Content-Type': 'application/json' }, { codigo: srv.sessions.issueCode() });
    const cookie = String(login2.headers['set-cookie']).split(';')[0]!;
    const h = { Cookie: cookie, Origin: `http://127.0.0.1:${p}`, 'X-Forja-CSRF': login2.body.csrf, 'Content-Type': 'application/json' };
    expect((await req('GET', '/v1/planeacion', { Cookie: cookie })).body.planeacion.plan.olas).toEqual([['T-001']]);
    expect((await req('POST', '/v1/planeacion/preguntas/q-001/respuesta', h, { respuesta: ' sí ' })).body.mensaje).toBe('respuesta a Q-001');
    expect(answered).toEqual([['Q-001', 'sí']]);
    expect((await req('POST', '/v1/planeacion/preguntas/T-001/respuesta', h, { respuesta: 'x' })).status).toBe(404);
    expect((await req('POST', '/v1/planeacion/descubrimiento/aprobar', { ...h, 'X-Forja-CSRF': 'otro' }, {})).status).toBe(403);
    // Sprints: choose one, move it (only known phases), ask a change, edit or remove a use case.
    expect((await req('POST', '/v1/planeacion/sprint', h, { cambio: 'cam_1' })).body.mensaje).toBe('sprint cam_1');
    expect((await req('POST', '/v1/planeacion/mover', h, { a: 'descubrir' })).body.mensaje).toBe('a descubrir');
    expect((await req('POST', '/v1/planeacion/mover', h, { a: 'borrar' })).status).toBe(422);
    expect((await req('POST', '/v1/planeacion/especificacion/cambios', h, { texto: 'UC-002: en dólares' })).body.mensaje).toBe('cambio UC-002: en dólares');
    expect((await req('GET', '/v1/planeacion/especificacion/casos/UC-001', { Cookie: cookie })).status).toBe(404);
    expect((await req('POST', '/v1/planeacion/especificacion/casos/UC-001', h, { caso: { id: 'UC-001' } })).status).toBe(422);
    expect((await req('DELETE', '/v1/planeacion/especificacion/casos/UC-001', h)).body.mensaje).toBe('quitado UC-001');
    await srv.close();
  });
});

describe('API local · panel multi-proyecto', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  class Host implements ProjectHost {
    scope: ProjectScope | null = null;
    private listeners: ((s: ProjectScope) => void)[] = [];
    current() {
      return this.scope;
    }
    onLeave(l: (s: ProjectScope) => void) {
      this.listeners.push(l);
    }
    select(next: ProjectScope | null) {
      if (this.scope) for (const l of this.listeners) l(this.scope);
      this.scope = next;
    }
  }

  const sistema: ApiModule = { name: 'sistema', routes: [{ method: 'GET', path: /^\/v1\/sistema$/, handler: () => ({ ok: true }) }] };

  async function open(host: Host) {
    const srv = new ApiServer({ global: [sistema], project: host, pollMs: 20, heartbeatMs: 50 });
    const { port: p } = await srv.listen();
    const get = (path: string, cookie: string) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port: p, path, headers: { Host: `127.0.0.1:${p}`, Cookie: cookie } }, (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : null }));
        });
        r.on('error', reject);
        r.end();
      });
    const code = srv.sessions.issueCode();
    const cookie = await new Promise<string>((resolve, reject) => {
      const r = request(
        { host: '127.0.0.1', port: p, method: 'POST', path: '/v1/sesion', headers: { Host: `127.0.0.1:${p}`, Origin: `http://127.0.0.1:${p}`, 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(String(res.headers['set-cookie']).split(';')[0]!);
        },
      );
      r.on('error', reject);
      r.end(JSON.stringify({ codigo: code }));
    });
    return { srv, p, get, cookie };
  }

  it('sin proyecto: lo global responde y lo del proyecto pide elegir uno', async () => {
    const host = new Host();
    const { srv, get, cookie } = await open(host);
    expect((await get('/v1/sistema', cookie)).status).toBe(200);
    expect(await get('/v1/modulos', cookie)).toMatchObject({ status: 200, body: { modulos: ['sistema'], proyecto: null } });
    const estado = await get('/v1/estado', cookie);
    expect(estado).toMatchObject({ status: 409, body: { error: { codigo: 'sin_proyecto' } } });
    expect((await get('/v1/eventos', cookie)).status).toBe(409);
    await srv.close();
  });

  it('al cambiar de proyecto cambian las rutas y se cierran los eventos del anterior', async () => {
    const host = new Host();
    const a = new FakeFeed('chk_a');
    const b = new FakeFeed('chk_b');
    host.select({ modules: [runsModule(new FakeBackend())], feed: a });
    const { srv, p, get, cookie } = await open(host);
    expect(await get('/v1/modulos', cookie)).toMatchObject({ body: { modulos: ['sistema', 'runs'], proyecto: 'chk_a' } });

    let text = '';
    let ended = false;
    const req = request({ host: '127.0.0.1', port: p, path: '/v1/eventos', headers: { Host: `127.0.0.1:${p}`, Cookie: cookie } }, (res) => {
      res.on('data', (c) => (text += c));
      res.on('end', () => (ended = true));
    });
    req.end();
    await wait(60);
    expect(text).toContain('chk_a:0');

    host.select({ modules: [], feed: b });
    await wait(30);
    expect(ended).toBe(true);
    expect(await get('/v1/modulos', cookie)).toMatchObject({ body: { modulos: ['sistema'], proyecto: 'chk_b' } });
    expect((await get('/v1/estado', cookie)).status).toBe(404);
    await srv.close();
  });
});

describe('descarga del Excel de requerimientos', () => {
  it('envía el .xlsx como adjunto con su nombre y valida la iniciativa y la contingencia', async () => {
    const asked: object[] = [];
    const stub = new Proxy({} as WorkBackend, {
      get: (_t, prop) =>
        prop === 'requirementsWorkbook'
          ? (opts: object) => {
              asked.push(opts);
              return { file: 'INI007_Mi Proyecto_Reqs_2026-10-02.xlsx', data: Buffer.from('PK\u0003\u0004fake') };
            }
          : () => ({}),
    });
    const srv = new ApiServer({ modules: [workModule(stub)], feed: new FakeFeed() });
    const { port: p } = await srv.listen();
    const get = (path: string, headers: Record<string, string>) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve) => {
        request({ host: '127.0.0.1', port: p, method: 'GET', path, headers: { Host: `127.0.0.1:${p}`, ...headers } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        }).end();
      });
    const login = await new Promise<{ cookie: string }>((resolve) => {
      const r = request(
        { host: '127.0.0.1', port: p, method: 'POST', path: '/v1/sesion', headers: { Host: `127.0.0.1:${p}`, Origin: `http://127.0.0.1:${p}`, 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ cookie: String(res.headers['set-cookie']).split(';')[0]! }));
        },
      );
      r.end(JSON.stringify({ codigo: srv.sessions.issueCode() }));
    });
    const ok = await get('/v1/historial/excel?iniciativa=INI007&contingencia=20', { Cookie: login.cookie });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(ok.headers['content-disposition']).toBe(`attachment; filename="INI007_Mi_Proyecto_Reqs_2026-10-02.xlsx"; filename*=UTF-8''INI007_Mi%20Proyecto_Reqs_2026-10-02.xlsx`);
    expect(ok.body.subarray(0, 2).toString()).toBe('PK');
    expect(asked).toEqual([{ iniciativa: 'INI007', contingencia: 0.2 }]);
    expect((await get('/v1/historial/excel?iniciativa=../x', { Cookie: login.cookie })).status).toBe(422);
    expect((await get('/v1/historial/excel?contingencia=150', { Cookie: login.cookie })).status).toBe(422);
    expect((await get('/v1/historial/excel', {})).status).toBe(401);
    await srv.close();
  });
});
