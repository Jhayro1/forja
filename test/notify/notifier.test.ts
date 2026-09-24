import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionStore } from '../../src/actions/connections.js';
import { ActionService } from '../../src/actions/protocol.js';
import { NotificationService, POLICY_ACTOR } from '../../src/notify/notifier.js';
import type { PendingItem } from '../../src/run/snapshot.js';
import { EventStore } from '../../src/store/event-store.js';
import { ensureBuilt, ROOT } from '../helpers/engine.js';

const EXECUTOR = join(ROOT, 'dist/actions/executor-main.js');

let dir: string;
let server: Server;
let received: { path: string; auth: string | undefined; body: { evento: string; datos: Record<string, unknown>; origen: string } }[];
let store: EventStore;
let conns: ConnectionStore;
let actions: ActionService;
let notifier: NotificationService;
const secret = (name: string) => (name === 'AVISOS_TOKEN' ? 'tok-avisos-123456' : null);

const QUESTION: PendingItem = { kind: 'pregunta_tarea', id: 'T-003', text: '¿Redondeo a dos decimales? El cliente dijo que sí en la reunión.', action: 'forja responder T-003' };
const BLOCKED: PendingItem = { kind: 'tarea_bloqueada', id: 'T-004', text: 'falló 3 veces', action: 'forja reintentar T-004' };

beforeEach(async () => {
  ensureBuilt();
  dir = mkdtempSync(join(tmpdir(), 'forja-notif-'));
  received = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  store = EventStore.open(join(dir, 'estado.db'), 'chk');
  conns = ConnectionStore.in(dir);
  conns.save({
    name: 'avisos',
    type: 'http',
    base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    secret: 'AVISOS_TOKEN',
    auth_header: 'Authorization',
    auth_scheme: 'Bearer',
    idempotent: true,
    allow_local: true,
    test_path: null,
  });
  actions = new ActionService(store, conns, { executorScript: EXECUTOR, timeoutMs: 3000 });
  notifier = new NotificationService(store, conns, actions, 'mi-bodega');
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(() => r(null)));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('notificaciones como acción tipada con política permanente', () => {
  it('sin política activa no sale nada', async () => {
    expect(await notifier.notify([QUESTION], secret)).toEqual([]);
    expect(received).toEqual([]);
  });

  it('por defecto sólo salen proyecto, tipo e id; una vez por pendiente; todo queda auditado', async () => {
    notifier.activate('avisos', { path: '/hooks/forja' });
    const lines = await notifier.notify([QUESTION, BLOCKED], secret);
    expect(lines).toEqual(['✉ aviso enviado: pregunta_tarea T-003', '✉ aviso enviado: tarea_bloqueada T-004']);
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({
      path: '/hooks/forja',
      auth: 'Bearer tok-avisos-123456',
      body: { evento: 'forja.pendiente', datos: { proyecto: 'mi-bodega', tipo: 'pregunta_tarea', id: 'T-003' }, origen: 'forja' },
    });
    expect(JSON.stringify(received)).not.toContain('Redondeo');
    // Same pending items again: nothing new is sent.
    expect(await notifier.notify([QUESTION, BLOCKED], secret)).toEqual([]);
    expect(received).toHaveLength(2);
    // A new question on the same task is a new notice.
    await notifier.notify([{ ...QUESTION, text: 'otra pregunta' }], secret);
    expect(received).toHaveLength(3);
    const audited = actions.list().filter((a) => a.origin === 'notificaciones');
    expect(audited).toHaveLength(3);
    expect(audited.every((a) => a.state === 'confirmada' && a.approved_by === POLICY_ACTOR)).toBe(true);
  });

  it('el texto sólo sale si se activó con --con-texto, y acotado', async () => {
    notifier.activate('avisos', { includeText: true });
    await notifier.notify([{ ...QUESTION, text: 'x'.repeat(500) }], secret);
    expect(received[0]!.body.datos.texto).toBe(`${'x'.repeat(280)}…`);
  });

  it('si la conexión cambia, se pausa y lo dice una sola vez; desactivar la apaga', async () => {
    notifier.activate('avisos');
    const c = conns.get('avisos');
    conns.save({ ...c, base_url: 'http://127.0.0.1:1/' });
    const first = await notifier.notify([QUESTION], secret);
    expect(first[0]).toMatch(/notificaciones en pausa: la conexión «avisos» cambió/);
    expect(await notifier.notify([QUESTION], secret)).toEqual([]);
    expect(received).toEqual([]);
    notifier.deactivate();
    expect(notifier.policy()).toBeNull();
    expect(() => notifier.deactivate()).toThrow(/no están activas/);
  });

  it('activar vincula la conexión conservando las operaciones que ya tenía', () => {
    actions.link('avisos', ['http.json']);
    notifier.activate('avisos');
    expect(actions.links().find((l) => l.connection === 'avisos')?.operations).toEqual(['http.json', 'webhook.evento']);
  });
});
