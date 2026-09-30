import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionService } from '../../src/actions/protocol.js';
import { DbConnectionStore } from '../../src/db/connections.js';
import { type DbDriver, DbService } from '../../src/db/service.js';
import { gatewayHandler } from '../../src/mcp/gateway.js';
import { testEngine } from '../helpers/engine.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const driver: DbDriver = {
  schema: async () => [{ table: 'facturas', columns: [{ name: 'id', type: 'int', nullable: false, key: 'PRI' }] }],
  read: async () => ({ columns: ['n'], rows: [[3]], total: 1, truncated: false, affected: null }),
  change: async () => ({ columns: [], rows: [], total: 0, truncated: false, affected: 0 }),
};

function setup() {
  const t = testEngine(() => ({ pasos: [] }));
  cleanup = t.cleanup;
  const store = new DbConnectionStore(mkdtempSync(join(tmpdir(), 'forja-gwbd-')));
  store.save({ name: 'pruebas', motor: 'mysql', host: '10.0.0.5', port: 3306, bases: ['devventas'], usuario: 'app', clave: 'secreta-123' });
  const db = new DbService(t.engine, store, driver);
  db.link('pruebas', {});
  const call = (origin: string) => {
    const h = gatewayHandler({ origin, actions: {} as ActionService, externals: [], scope: { runId: 'run_1', taskId: 'T-003' }, db });
    return async (name: string, args: object) => {
      const r = (await h('tools/call', { name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]!.text, error: r.isError === true };
    };
  };
  return { db, call, gw: gatewayHandler({ origin: 'x', actions: {} as ActionService, externals: [], db }) };
}

describe('herramientas bd_* del gateway', () => {
  it('el agente ve el esquema, pide consultas y cambios, y sólo ve sus propias solicitudes', async () => {
    const { call, gw } = setup();
    const tools = ((await gw('tools/list', {})) as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['bd_listar', 'bd_esquema', 'bd_consultar', 'bd_solicitar_cambio', 'bd_estado']));

    const a = call('agente T-003 · run_1');
    expect((await a('bd_esquema', { conexion: 'pruebas', base: 'devventas' })).text).toContain('facturas');
    const q = JSON.parse((await a('bd_consultar', { conexion: 'pruebas', base: 'devventas', sql: 'SELECT COUNT(*) FROM facturas', motivo: 'contar' })).text);
    expect(q).toMatchObject({ estado: 'pendiente', tipo: 'lectura' });
    const blocked = JSON.parse(
      (await a('bd_solicitar_cambio', { conexion: 'pruebas', base: 'devventas', sql: 'DROP TABLE facturas', motivo: 'ya no se usa la tabla', para_que: 'limpiar la base' })).text,
    );
    expect(blocked.estado).toBe('bloqueada');
    const bad = await a('bd_consultar', { conexion: 'pruebas', base: 'devventas', sql: 'SELECT 1; DROP TABLE facturas', motivo: 'x' });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/una sola sentencia/);
    // Nothing about the connection's secrets reaches the agent.
    expect(JSON.stringify(await a('bd_listar', {}))).not.toContain('secreta-123');

    // Another agent cannot read this agent's request.
    expect((await call('agente T-009 · run_1')('bd_estado', { id: q.id })).error).toBe(true);
    expect(JSON.parse((await a('bd_estado', { id: q.id })).text).estado).toBe('pendiente');
  });
});
