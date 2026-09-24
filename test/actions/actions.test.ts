import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionStore } from '../../src/actions/connections.js';
import { type ExecutorRunner, ProcessExecutorRunner, SandboxedExecutorRunner } from '../../src/actions/executor-runner.js';
import { urlUnder } from '../../src/actions/operations.js';
import { ActionService, classify } from '../../src/actions/protocol.js';
import { openTunnel, PinnedTunnelProxy } from '../../src/actions/tunnel.js';
import { EventStore } from '../../src/store/event-store.js';
import { ensureBuilt, HAS_BWRAP, ROOT } from '../helpers/engine.js';

const TOKEN = 'tok-servicio-muy-secreto';
const EXECUTOR = join(ROOT, 'dist/actions/executor-main.js');

/** Test service: honors Idempotency-Key and ETag/If-Match; modes simulate failures after the effect. */
class FakeService {
  server!: Server;
  port = 0;
  version = 1;
  estado = 'abierto';
  applied: { key: string; body: unknown; auth: string | undefined }[] = [];
  mode: 'normal' | 'lento' | 'colgado' | 'error500' | 'cambiar_tras_get' = 'normal';
  idempotent = true;
  private readonly responses = new Map<string, { status: number; body: string; location?: string }>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const etag = `"v${this.version}"`;
        if (req.method === 'GET' && req.url?.startsWith('/buscar?clave=')) {
          const key = decodeURIComponent(req.url.slice('/buscar?clave='.length));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.applied.filter((a) => a.key === key)));
          return;
        }
        if (req.method === 'GET' && req.url === '/recurso') {
          res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag });
          res.end(JSON.stringify({ estado: this.estado, version: this.version }));
          if (this.mode === 'cambiar_tras_get') this.version++;
          return;
        }
        if (req.url?.startsWith('/pedidos')) {
          if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
          const key = String(req.headers['idempotency-key'] ?? '');
          if (this.idempotent && this.responses.has(key)) {
            const prev = this.responses.get(key)!;
            return res.writeHead(prev.status, { 'Content-Type': 'application/json' }).end(prev.body);
          }
          if (req.headers['if-match'] && req.headers['if-match'] !== `"v${this.version}"`) return res.writeHead(412).end();
          if (this.mode === 'colgado') return setTimeout(() => res.writeHead(503).end(), 1500);
          this.applied.push({ key, body: JSON.parse(body || 'null'), auth: req.headers.authorization });
          this.version++;
          const out = { status: 201, body: JSON.stringify({ id: this.applied.length, token_eco: TOKEN }), location: `/pedidos/${this.applied.length}` };
          this.responses.set(key, out);
          if (this.mode === 'lento') return setTimeout(() => res.writeHead(out.status).end(out.body), 1500);
          if (this.mode === 'error500') return res.writeHead(500).end();
          return res.writeHead(out.status, { 'Content-Type': 'application/json', Location: out.location }).end(out.body);
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }
  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}

let dir: string;
let store: EventStore;
let conns: ConnectionStore;
let svc: FakeService;
let now: number;
let actions: ActionService;
const secret = (name: string) => (name === 'SERVICIO_TOKEN' ? TOKEN : null);

beforeEach(async () => {
  ensureBuilt();
  dir = mkdtempSync(join(tmpdir(), 'forja-acc-'));
  store = EventStore.open(join(dir, 'estado.db'), 'chk');
  conns = ConnectionStore.in(dir);
  svc = new FakeService();
  await svc.start();
  now = Date.now();
  actions = new ActionService(store, conns, { now: () => now, executorScript: EXECUTOR, timeoutMs: 700 });
  conns.save({
    name: 'pedidos',
    type: 'http',
    base_url: `http://127.0.0.1:${svc.port}/`,
    secret: 'SERVICIO_TOKEN',
    auth_header: 'Authorization',
    auth_scheme: 'Bearer',
    idempotent: true,
    allow_local: true,
    test_path: null,
  });
  actions.link('pedidos', ['http.json']);
});
afterEach(async () => {
  await svc.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const propose = (params: Record<string, unknown> = { ruta: '/pedidos', cuerpo: { producto: 'arroz', cantidad: 2 } }) =>
  actions.propose({ type: 'http.json', connection: 'pedidos', params, origin: 'cli' });

const RUNNERS: [string, () => ExecutorRunner][] = [
  ['proceso aparte', () => new ProcessExecutorRunner(EXECUTOR)],
  ...(HAS_BWRAP ? ([['bwrap con túnel (MEJORAS 4.2)', () => new SandboxedExecutorRunner(EXECUTOR)]] as [string, () => ExecutorRunner][]) : []),
];

describe.each(RUNNERS)('acciones externas (V2-051) · ejecutor en %s', (_name, makeRunner) => {
  beforeEach(() => {
    actions = new ActionService(store, conns, { now: () => now, executor: makeRunner(), timeoutMs: 700 });
  });

  it('propuesta → vista previa → aprobación por hash → ejecución confirmada, sin el secreto en ningún registro', async () => {
    const a = propose();
    expect(a.state).toBe('propuesta');
    expect(a.preview).toMatchObject({ peticion: `POST http://127.0.0.1:${svc.port}/pedidos`, credencial: 'Authorization: Bearer <SERVICIO_TOKEN de la bóveda>' });
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    await expect(actions.execute(a.action_id, secret)).rejects.toThrow(/sólo se ejecuta una acción aprobada/);
    expect(() => actions.approve(a.action_id, 'otro-hash', 'yo')).toThrow(/hash no coincide/);
    actions.approve(a.action_id, a.hash, 'yo');
    const seqBefore = (store.db.prepare('SELECT MAX(seq) s FROM events').get() as { s: number }).s;
    actions.approve(a.action_id, a.hash, 'yo'); // double approval: no new event
    expect((store.db.prepare('SELECT MAX(seq) s FROM events').get() as { s: number }).s).toBe(seqBefore);

    const done = await actions.execute(a.action_id, secret);
    expect(done.state, JSON.stringify(done.result)).toBe('confirmada');
    expect(svc.applied).toEqual([{ key: a.idempotency_key, body: { producto: 'arroz', cantidad: 2 }, auth: `Bearer ${TOKEN}` }]);
    // The service echoed the token in its response: it is redacted before persisting.
    const everything = JSON.stringify(store.events(0, 1000));
    expect(everything).not.toContain(TOKEN);
    expect(everything).toContain('«secreto:SERVICIO_TOKEN»');
    // The approval was consumed: executing again is refused.
    await expect(actions.execute(a.action_id, secret)).rejects.toThrow(/confirmada/);
    expect(svc.applied).toHaveLength(1);
  });

  it('caducidad, cambio de conexión y permisos invalidan lo aprobado', async () => {
    const a = propose();
    now += 31 * 60_000;
    expect(actions.get(a.action_id).view_state).toBe('caducada');
    expect(() => actions.approve(a.action_id, a.hash, 'yo')).toThrow(/caducó/);
    now = Date.now();

    const b = propose();
    actions.approve(b.action_id, b.hash, 'yo');
    conns.save({ ...conns.get('pedidos'), idempotent: false });
    await expect(actions.execute(b.action_id, secret)).rejects.toThrow(/cambió/);
    expect(() => propose()).toThrow(/vuelve a vincularla/);
    actions.link('pedidos', ['http.json']);
    actions.unlink('pedidos');
    expect(() => propose()).toThrow(/no está vinculada/);
    expect(svc.applied).toHaveLength(0);
  });

  it('valida parámetros y rutas: nada fuera de la conexión', () => {
    expect(() => propose({ ruta: '/pedidos', metodo: 'GETX' })).toThrow(/parámetros inválidos/);
    expect(() => propose({ ruta: '/../admin' })).toThrow(/ruta inválida/);
    expect(() => propose({ ruta: '/pedidos', extra: 1 })).toThrow(/parámetros inválidos/);
    expect(urlUnder('https://api.example.com/v1', '/pedidos?x=1')).toBe('https://api.example.com/v1/pedidos?x=1');
    for (const bad of ['//evil.com/x', '/a/%2e%2e/b', 'relativa', '/a\\b', '/%2F/evil']) expect(() => urlUnder('https://api.example.com/v1', bad)).toThrow();
  });

  it('precondición: si no se cumple no se envía; si el recurso cambia entre la lectura y el envío, If-Match lo frena', async () => {
    const pre = (valor: string) => propose({ ruta: '/pedidos', cuerpo: {}, precondicion: { ruta: '/recurso', puntero: '/estado', valor, si_coincide: true } });
    const a = pre('cerrado');
    actions.approve(a.action_id, a.hash, 'yo');
    const r1 = await actions.execute(a.action_id, secret);
    expect(r1.state).toBe('rechazada');
    expect(r1.result?.detail).toMatch(/se esperaba "cerrado"/);

    svc.mode = 'cambiar_tras_get';
    const b = pre('abierto');
    actions.approve(b.action_id, b.hash, 'yo');
    const r2 = await actions.execute(b.action_id, secret);
    expect(r2.state).toBe('rechazada');
    expect(r2.result?.detail).toMatch(/412/);
    expect(svc.applied).toHaveLength(0);
  });

  it('timeout tras enviar a un servicio idempotente: desconocido y se resuelve reenviando la MISMA clave, sin duplicar', async () => {
    svc.mode = 'lento';
    const a = propose();
    actions.approve(a.action_id, a.hash, 'yo');
    const r1 = await actions.execute(a.action_id, secret);
    expect(r1.state).toBe('desconocido');
    svc.mode = 'normal';
    const r2 = await actions.execute(a.action_id, secret);
    expect(r2.state).toBe('confirmada');
    expect(r2.attempts).toBe(2);
    expect(svc.applied).toHaveLength(1);
  });

  it('sin idempotencia no se reenvía a ciegas: se concilia a mano', async () => {
    svc.mode = 'error500';
    svc.idempotent = false;
    conns.save({ ...conns.get('pedidos'), idempotent: false });
    actions.link('pedidos', ['http.json']);
    const a = propose();
    actions.approve(a.action_id, a.hash, 'yo');
    expect((await actions.execute(a.action_id, secret)).state).toBe('desconocido');
    await expect(actions.execute(a.action_id, secret)).rejects.toThrow(/concílialo a mano/);
    const r = actions.reconcile(a.action_id, true, 'yo', 'el pedido 1 aparece en el panel del servicio');
    expect(r.state).toBe('confirmada');
    expect(r.result).toMatchObject({ conciliada: true, note: 'el pedido 1 aparece en el panel del servicio' });
    expect(svc.applied).toHaveLength(1);
  });

  it('servicio caído antes de enviar: sin efecto; destino interno sin permiso: bloqueado', async () => {
    const a = propose();
    actions.approve(a.action_id, a.hash, 'yo');
    await svc.stop();
    expect((await actions.execute(a.action_id, secret)).state).toBe('sin_efecto');
    await svc.start();

    conns.save({
      name: 'interno',
      type: 'http',
      base_url: 'https://127.0.0.1:9/',
      secret: null,
      auth_header: 'Authorization',
      auth_scheme: 'Bearer',
      idempotent: false,
      allow_local: false,
      test_path: null,
    });
    actions.link('interno', ['http.json']);
    const b = actions.propose({ type: 'http.json', connection: 'interno', params: { ruta: '/x' }, origin: 'cli' });
    actions.approve(b.action_id, b.hash, 'yo');
    const r = await actions.execute(b.action_id, secret);
    expect(r.state).toBe('rechazada');
    expect(r.result?.detail).toMatch(/destino interno bloqueado/);
    expect(() => conns.save({ ...conns.get('interno'), name: 'plano', base_url: 'http://api.example.com', allow_local: false })).toThrow(/sólo https/);
    expect(() => conns.save({ ...conns.get('interno'), name: 'conclave', base_url: 'https://u:p@api.example.com' })).toThrow(/credenciales/);
  });

  it('una acción que quedó «ejecutando» por una caída se registra como desconocida, nunca como hecha', () => {
    const a = propose();
    actions.approve(a.action_id, a.hash, 'yo');
    store.execute({ request_id: 'x', type: 'accion.ejecutando', input: null }, () => ({
      result: null,
      events: [{ type: 'accion.ejecutando', aggregate_type: 'accion', aggregate_id: a.action_id, payload: { attempt: 1 } }],
    }));
    now += 10 * 60_000;
    expect(actions.recoverInterrupted()).toEqual([a.action_id]);
    expect(actions.get(a.action_id).state).toBe('desconocido');
  });

  it('la prueba de conexión hace un GET de menor impacto con la credencial', async () => {
    await expect(actions.probe('pedidos', secret)).rejects.toThrow(/ruta de prueba/);
    conns.save({ ...conns.get('pedidos'), test_path: '/recurso' });
    expect(await actions.probe('pedidos', secret)).toEqual({ ok: true, detail: 'respondió 200' });
    expect(svc.applied).toHaveLength(0);
  });

  it('clasifica respuestas según la tabla de v2/06', () => {
    const r = (status: number) => classify({ phase: 'respuesta', status, etag: null, location: null, body: '' }).state;
    expect([r(200), r(201), r(303), r(404), r(409), r(412), r(500), r(503)]).toEqual(['confirmada', 'confirmada', 'desconocido', 'rechazada', 'rechazada', 'rechazada', 'desconocido', 'desconocido']);
  });
});

describe.skipIf(!HAS_BWRAP)('aislamiento del ejecutor en bwrap (MEJORAS 4.2)', () => {
  it('el túnel sólo abre los destinos fijados por el proceso padre', async () => {
    const sock = join(dir, 't.sock');
    const proxy = new PinnedTunnelProxy(sock, new Map([[`127.0.0.1:${svc.port}`, '127.0.0.1']]));
    await proxy.start();
    try {
      const ok = await openTunnel(sock, '127.0.0.1', svc.port);
      ok.destroy();
      await expect(openTunnel(sock, 'evil.example', 443)).rejects.toMatchObject({ code: 'EBLOQUEADO' });
      await expect(openTunnel(sock, '127.0.0.1', 22)).rejects.toMatchObject({ code: 'EBLOQUEADO' });
      expect(proxy.decisions.map((d) => d.allowed)).toEqual([true, false, false]);
    } finally {
      await proxy.stop();
    }
  });

  it('dentro del sandbox el ejecutor no ve el HOME ni tiene red propia', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const probeDir = join(dir, 'sonda');
    mkdirSync(probeDir);
    // A fake «executor» that reports what it can reach, in the result format.
    writeFileSync(
      join(probeDir, 'sonda.mjs'),
      `import { readdirSync } from 'node:fs';\nimport net from 'node:net';\nlet home = 'oculto';\ntry { home = String(readdirSync(${JSON.stringify(homedir())}).length); } catch { home = 'error'; }\nconst s = net.connect(${svc.port}, '127.0.0.1');\ns.on('connect', () => { console.log(JSON.stringify({ phase: 'no_enviado', detail: 'home=' + home + ' red=si' })); process.exit(0); });\ns.on('error', () => { console.log(JSON.stringify({ phase: 'no_enviado', detail: 'home=' + home + ' red=no' })); process.exit(0); });\n`,
    );
    const r = await new SandboxedExecutorRunner(join(probeDir, 'sonda.mjs')).run({
      request: { method: 'GET', url: `http://127.0.0.1:${svc.port}/recurso`, body: null, precondition: null },
      idempotencyKey: 'k',
      auth: null,
      allowLocal: true,
      timeoutMs: 5_000,
    });
    // The real HOME is an empty tmpfs inside the sandbox, and there is no direct network.
    expect(r).toEqual({ phase: 'no_enviado', detail: 'home=0 red=no' });
  });
});

describe('ejecutar desde el panel con la bóveda abierta (MEJORAS 4.4)', () => {
  it('exige el hash visto, la bóveda del panel y que siga abierta', async () => {
    const { EngineConnectionsBackend } = await import('../../src/cli/engine-backend.js');
    const { Vault, vaultPaths } = await import('../../src/vault/vault.js');
    let clock = Date.now();
    Vault.create(vaultPaths(dir), 'clave de prueba larga').close();
    const vault = Vault.open(vaultPaths(dir), 'clave de prueba larga', { idleMs: 60_000, now: () => clock });
    vault.set('SERVICIO_TOKEN', TOKEN);
    const ctx = { store, home: dir } as never;
    const a = propose();
    actions.approve(a.action_id, a.hash, 'yo');
    const make = () => new ActionService(store, conns, { executorScript: EXECUTOR, timeoutMs: 5_000 });
    await expect(new EngineConnectionsBackend(ctx, null, make).execute(a.action_id, a.hash)).rejects.toThrow(/sin la bóveda/);
    const backend = new EngineConnectionsBackend(ctx, vault, make);
    expect(backend.vaultState()).toBe('abierta');
    await expect(backend.execute(a.action_id, 'otro')).rejects.toThrow(/cambió desde que la viste/);
    const done = (await backend.execute(a.action_id, a.hash)) as { state: string; result: unknown };
    expect(done.state, JSON.stringify(done.result)).toBe('confirmada');
    expect(svc.applied).toHaveLength(1);
    clock += 61_000;
    expect(backend.vaultState()).toBe('cerrada');
    const b = propose();
    actions.approve(b.action_id, b.hash, 'yo');
    await expect(backend.execute(b.action_id, b.hash)).rejects.toThrow(/se cerró por inactividad/);
  });
});

describe('más operaciones tipadas y deshacer (MEJORAS 4.5)', () => {
  it('una creación confirmada se deshace con un DELETE propuesto aparte, que también necesita aprobación', async () => {
    const a = propose();
    actions.approve(a.action_id, a.hash, 'yo');
    const done = await actions.execute(a.action_id, secret);
    expect(done.state).toBe('confirmada');
    const inverse = actions.undo(a.action_id, 'cli');
    expect(inverse.state).toBe('propuesta');
    expect(inverse.params).toEqual({ ruta: '/pedidos/1', metodo: 'DELETE' });
    expect(inverse.origin).toBe(`deshacer ${a.action_id} · cli`);
    await expect(actions.execute(inverse.action_id, secret)).rejects.toThrow(/sólo se ejecuta una acción aprobada/);
    expect(() => actions.undo(inverse.action_id, 'cli')).toThrow(/sólo se deshace una acción confirmada/);
  });

  it('correo: vista previa legible y nunca se reenvía a ciegas aunque el servicio sea idempotente', async () => {
    actions.link('pedidos', ['http.json', 'correo.enviar', 'webhook.evento', 'dns.registro']);
    expect(() => actions.propose({ type: 'correo.enviar', connection: 'pedidos', params: { para: ['no-es-correo'], asunto: 'x', texto: 'y' }, origin: 'cli' })).toThrow(/dirección de correo inválida/);
    const mail = actions.propose({ type: 'correo.enviar', connection: 'pedidos', params: { para: ['ana@bodega.pe'], asunto: 'Pedido listo', texto: 'Hola', ruta: '/pedidos' }, origin: 'cli' });
    expect(mail.preview).toMatchObject({ para: 'ana@bodega.pe', asunto: 'Pedido listo', reintento_seguro: expect.stringContaining('no') });
    actions.approve(mail.action_id, mail.hash, 'yo');
    svc.mode = 'lento';
    expect((await actions.execute(mail.action_id, secret)).state).toBe('desconocido');
    svc.mode = 'normal';
    await expect(actions.execute(mail.action_id, secret)).rejects.toThrow(/concílialo a mano/);
    expect(() => actions.undo(mail.action_id, 'cli')).toThrow(/sólo se deshace una acción confirmada/);
  });

  it('DNS: comprueba el valor anterior y deshacer propone restaurarlo; webhook y rutas validadas', () => {
    actions.link('pedidos', ['dns.registro', 'webhook.evento']);
    const dns = actions.propose({ type: 'dns.registro', connection: 'pedidos', params: { zona: 'bodega.pe', nombre: 'www', tipo: 'A', valor: '203.0.113.7', anterior: '203.0.113.5' }, origin: 'cli' });
    expect(dns.preview).toMatchObject({ registro: 'www.bodega.pe A', cambio: '203.0.113.5 → 203.0.113.7 · ttl 300', precondicion: 'el valor actual debe ser 203.0.113.5' });
    expect(() =>
      actions.propose({ type: 'dns.registro', connection: 'pedidos', params: { zona: 'bodega.pe/../x', nombre: 'www', tipo: 'A', valor: '1.1.1.1', anterior: null }, origin: 'cli' }),
    ).toThrow(/nombre DNS inválido/);
    const hook = actions.propose({ type: 'webhook.evento', connection: 'pedidos', params: { evento: 'pedido.listo', datos: { id: 1 } }, origin: 'cli' });
    expect(hook.preview).toMatchObject({ evento: 'pedido.listo', datos: { id: 1 } });
  });
});

describe('conciliación automática por consulta (MEJORAS 4.8)', () => {
  it('sin idempotencia pero consultable: si la consulta encuentra la acción queda confirmada; si no, sigue para un humano', async () => {
    conns.save({
      name: 'pedidos',
      type: 'http',
      base_url: `http://127.0.0.1:${svc.port}/`,
      secret: 'SERVICIO_TOKEN',
      auth_header: 'Authorization',
      auth_scheme: 'Bearer',
      idempotent: false,
      allow_local: true,
      test_path: null,
      lookup_path: '/buscar?clave={clave}',
    });
    actions.link('pedidos', ['http.json']);
    svc.idempotent = false;
    svc.mode = 'lento';
    const a = propose();
    actions.approve(a.action_id, a.hash, 'yo');
    const r = await actions.execute(a.action_id, secret);
    // The request reached the service (applied) but the answer came too late: the query finds it.
    expect(r.state).toBe('confirmada');
    expect(r.result).toMatchObject({ conciliada: true });
    const trail = JSON.stringify(store.events(0, 1000));
    expect(trail).toContain('consulta automática');

    // Uncertain and NOT found: absence proves nothing, a human decides.
    svc.mode = 'colgado';
    const b = propose();
    actions.approve(b.action_id, b.hash, 'yo');
    const rb = await actions.execute(b.action_id, secret);
    expect(rb.state).toBe('desconocido');
    await expect(actions.execute(b.action_id, secret)).rejects.toThrow(/concílialo a mano/);
  });
});
