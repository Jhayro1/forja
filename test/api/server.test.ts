import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryModule } from '../../src/api/modules/memory.js';
import { type RunsBackend, runsModule } from '../../src/api/modules/runs.js';
import { ApiServer, type EventFeed } from '../../src/api/server.js';
import { SessionManager } from '../../src/api/session.js';
import { ROOT } from '../helpers/engine.js';

type Ev = ReturnType<EventFeed['after']>[number];

class FakeFeed implements EventFeed {
  readonly checkoutId = 'chk_1';
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
    const panel = readFileSync(join(ROOT, 'panel/panel.js'), 'utf8');
    for (const word of ["'agente trabajando'", "'pregunta de un agente'", "'espera tu aprobación'", "'Especificar'"]) expect(panel).not.toContain(word);
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
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect(page.text).not.toMatch(/<script>[^<]/);
    const js = readFileSync(join(ROOT, 'panel/panel.js'), 'utf8');
    expect(js).not.toMatch(/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(js).not.toMatch(/setAttribute\('style'/);
    expect((await call('GET', '/panel.js')).headers['content-type']).toMatch(/javascript/);
  });
});

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
