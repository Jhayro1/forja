import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionStore } from '../../src/actions/connections.js';
import { urlUnder } from '../../src/actions/operations.js';
import { ActionService, classify } from '../../src/actions/protocol.js';
import { EventStore } from '../../src/store/event-store.js';
import { ensureBuilt, ROOT } from '../helpers/engine.js';

const TOKEN = 'tok-servicio-muy-secreto';
const EXECUTOR = join(ROOT, 'dist/actions/executor-main.js');

/** Test service: honors Idempotency-Key and ETag/If-Match; modes simulate failures after the effect. */
class FakeService {
  server!: Server;
  port = 0;
  version = 1;
  estado = 'abierto';
  applied: { key: string; body: unknown; auth: string | undefined }[] = [];
  mode: 'normal' | 'lento' | 'error500' | 'cambiar_tras_get' = 'normal';
  idempotent = true;
  private readonly responses = new Map<string, { status: number; body: string }>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const etag = `"v${this.version}"`;
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
          this.applied.push({ key, body: JSON.parse(body || 'null'), auth: req.headers.authorization });
          this.version++;
          const out = { status: 201, body: JSON.stringify({ id: this.applied.length, token_eco: TOKEN }) };
          this.responses.set(key, out);
          if (this.mode === 'lento') return setTimeout(() => res.writeHead(out.status).end(out.body), 1500);
          if (this.mode === 'error500') return res.writeHead(500).end();
          return res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(out.body);
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

describe('acciones externas (V2-051)', () => {
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
