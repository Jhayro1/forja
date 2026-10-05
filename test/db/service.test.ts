import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbConnectionStore } from '../../src/db/connections.js';
import type { TableInfo } from '../../src/db/driver.js';
import { type DbDriver, DbService } from '../../src/db/service.js';
import { testEngine } from '../helpers/engine.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

/** A database in memory: enough to see which statements reach it. */
function fakeDriver(initial: string[]) {
  const tables = new Set(initial);
  const ran: string[] = [];
  const driver: DbDriver = {
    schema: async () => [...tables].map((t): TableInfo => ({ table: t, columns: [{ name: 'id', type: 'int', nullable: false, key: 'PRI' }] })),
    read: async (_t, sql) => {
      ran.push(sql);
      return { columns: ['id'], rows: [[1]], total: 1, truncated: false, affected: null };
    },
    change: async (_t, sql) => {
      ran.push(sql);
      const create = /CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)/i.exec(sql);
      if (create) tables.add(create[1]!);
      const drop = /DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(sql);
      if (drop) tables.delete(drop[1]!);
      return { columns: [], rows: [], total: 0, truncated: false, affected: 1 };
    },
  };
  return { driver, tables, ran };
}

function setup(lectura: 'preguntar' | 'libre' = 'preguntar') {
  const t = testEngine(() => ({ pasos: [] }));
  cleanup = t.cleanup;
  const home = mkdtempSync(join(tmpdir(), 'forja-bd-'));
  const store = new DbConnectionStore(home);
  store.save({ name: 'pruebas', motor: 'mysql', host: '10.0.0.5', port: 3306, bases: ['ventas', 'devventas'], usuario: 'app', clave: 'secreta-123', variables: { APP_DBPASSWORD: 'secreta-123' } });
  const fake = fakeDriver(['facturas', 'clientes']);
  const svc = new DbService(t.engine, store, fake.driver);
  svc.link('pruebas', { bases: ['devventas'], lectura, pruebas: true });
  return { svc, fake, home, store };
}

const agent = { who: 'agente T-003 · run_1', run_id: 'run_1', task_id: 'T-003' };

describe('bases de datos: las reglas del usuario', () => {
  it('la clave y las variables se guardan cifradas y nunca se muestran', () => {
    const { home, store } = setup();
    const raw = readFileSync(join(home, 'bases.json'), 'utf8');
    expect(raw).not.toContain('secreta-123');
    expect(store.get('pruebas')).toMatchObject({ tiene_clave: true, variables_nombres: ['APP_DBPASSWORD'] });
    expect(JSON.stringify(store.list())).not.toContain('secreta-123');
  });

  it('el esquema es libre; sólo las bases habilitadas para el proyecto', async () => {
    const { svc } = setup();
    expect((await svc.schema('pruebas', 'devventas')).map((t) => t.table)).toEqual(['facturas', 'clientes']);
    await expect(svc.schema('pruebas', 'ventas')).rejects.toThrow(/no está habilitada/);
  });

  it('lecturas: con aprobación por defecto; sin preguntar si el proyecto lo eligió', async () => {
    const { svc, fake } = setup('preguntar');
    const r = await svc.query(agent, { conn: 'pruebas', base: 'devventas', sql: 'SELECT * FROM facturas', motivo: 'ver columnas' });
    expect(r.state).toBe('pendiente');
    expect(fake.ran).toEqual([]);
    expect((await svc.approve(r.req_id)).state).toBe('ejecutada');
    expect(svc.get(r.req_id).result?.rows).toEqual([[1]]);

    svc.link('pruebas', { lectura: 'libre' });
    const free = await svc.query(agent, { conn: 'pruebas', base: 'devventas', sql: 'SELECT COUNT(*) FROM clientes' });
    expect(free.state).toBe('ejecutada');
    await expect(svc.query(agent, { conn: 'pruebas', base: 'devventas', sql: 'DELETE FROM clientes' })).rejects.toThrow(/no es una consulta/);
  });

  it('crear y cambiar: siempre con motivo y aprobación; sólo sobre tablas creadas por Forja', async () => {
    const { svc, fake } = setup();
    await expect(svc.requestChange(agent, { conn: 'pruebas', base: 'devventas', sql: 'CREATE TABLE forja_pagos (id INT)', motivo: '', para_que: '' })).rejects.toThrow(/por qué/);

    const create = await svc.requestChange(agent, {
      conn: 'pruebas',
      base: 'devventas',
      sql: 'CREATE TABLE forja_pagos (id INT)',
      motivo: 'guardar pagos parciales',
      para_que: 'la pantalla de cobros',
    });
    expect(create.state).toBe('pendiente');
    expect(fake.ran).toEqual([]);
    expect((await svc.approve(create.req_id)).state).toBe('ejecutada');
    expect(svc.objects()).toMatchObject([{ conn: 'pruebas', base: 'devventas', name: 'forja_pagos', created_by: 'agente T-003 · run_1' }]);

    // Its own table: a change is allowed (with approval).
    const alter = await svc.requestChange(agent, {
      conn: 'pruebas',
      base: 'devventas',
      sql: 'ALTER TABLE forja_pagos ADD COLUMN monto INT',
      motivo: 'falta el monto del pago',
      para_que: 'mostrar el saldo',
    });
    expect(alter.state).toBe('pendiente');
    expect((await svc.approve(alter.req_id)).state).toBe('ejecutada');

    // A table that already existed: blocked, and it never reaches the database.
    const before = fake.ran.length;
    for (const sql of ['ALTER TABLE facturas ADD COLUMN x INT', 'DROP TABLE clientes', 'DELETE FROM facturas WHERE id = 1', 'CREATE TABLE facturas (id INT)']) {
      const r = await svc.requestChange(agent, { conn: 'pruebas', base: 'devventas', sql, motivo: 'probar el bloqueo', para_que: 'la prueba' });
      expect(r.state, sql).toBe('bloqueada');
      await expect(svc.approve(r.req_id)).rejects.toThrow(/bloqueada/);
    }
    expect(fake.ran.length).toBe(before);

    // Dropping its own table takes it out of the registry: after that it is off limits too.
    const drop = await svc.requestChange(agent, { conn: 'pruebas', base: 'devventas', sql: 'DROP TABLE forja_pagos', motivo: 'ya no se usa la tabla', para_que: 'limpiar' });
    await svc.approve(drop.req_id);
    expect(svc.objects()).toEqual([]);
    expect(svc.objects(true)[0]?.dropped_at).toBeTruthy();
  });

  it('el planeador recibe la estructura con claves foráneas, y el error si una base no responde', async () => {
    const { svc, fake } = setup();
    fake.driver.schema = async () => [
      { table: 'clientes', columns: [{ name: 'id', type: 'int', nullable: false, key: 'PRI' }] },
      { table: 'facturas', columns: [{ name: 'cliente_id', type: 'int', nullable: false, key: null, ref: 'clientes.id' }] },
    ];
    const block = (await svc.schemaForPrompt()) as { bases: { base: string; tablas?: string[]; tablas_total?: number; error?: string }[] };
    expect(block.bases[0]).toMatchObject({ base: 'devventas', tablas_total: 2 });
    expect(block.bases[0]!.tablas).toEqual(['clientes(id int PK)', 'facturas(cliente_id int → clientes.id)']);
    expect(JSON.stringify(block)).not.toContain('secreta-123');

    const broken = setup();
    broken.fake.driver.schema = async () => {
      throw new Error('no se pudo conectar a 10.0.0.5:3306/devventas: ECONNREFUSED');
    };
    const failed = (await broken.svc.schemaForPrompt()) as { bases: { error?: string; tablas?: string[] }[] };
    expect(failed.bases[0]!.error).toContain('ECONNREFUSED');
    expect(failed.bases[0]!.tablas).toBeUndefined();
  });

  it('una solicitud rechazada no se ejecuta; las variables sólo salen para las pruebas', async () => {
    const { svc, fake } = setup();
    const r = await svc.requestChange(agent, { conn: 'pruebas', base: 'devventas', sql: 'CREATE TABLE forja_x (id INT)', motivo: 'una tabla de prueba', para_que: 'nada en especial' });
    expect(svc.reject(r.req_id, 'no hace falta').state).toBe('rechazada');
    await expect(svc.approve(r.req_id)).rejects.toThrow(/rechazada/);
    expect(fake.ran).toEqual([]);
    expect(svc.testEnv()).toEqual({ APP_DBPASSWORD: 'secreta-123' });
    svc.link('pruebas', { pruebas: false });
    expect(svc.testEnv()).toEqual({});
  });
});
