import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DbConnectionStore, parseDbUrl } from '../../src/db/connections.js';
import { ping, readSchema, runChange, runRead } from '../../src/db/driver.js';
import { DbService } from '../../src/db/service.js';
import { testEngine } from '../helpers/engine.js';

/**
 * Against real servers (CI starts MySQL and PostgreSQL): FORJA_BD_MYSQL / FORJA_BD_PG with
 * a URL like mysql://root:clave@127.0.0.1:3306/prueba. Skipped when not set.
 */
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups) c();
});

for (const [label, url] of [
  ['MySQL', process.env.FORJA_BD_MYSQL],
  ['PostgreSQL', process.env.FORJA_BD_PG],
] as const) {
  describe.skipIf(!url)(`${label} real`, () => {
    const u = url ? parseDbUrl(url) : null;
    const conn = u
      ? { name: 'real', motor: u.motor, host: u.host, port: u.port, bases: [u.base!], usuario: u.usuario!, ssl: false, variables_nombres: [], version: 1, updated_at: '', tiene_clave: true }
      : null;
    const target = () => ({ conn: conn!, base: u!.base!, password: u!.clave ?? null });
    const existing = u?.motor === 'postgres' ? 'public.clientes' : 'clientes';

    it('conecta, lee el esquema y una lectura no puede escribir aunque se salte la guardia', async () => {
      expect(await ping(target())).toBeTruthy();
      await runChange(target(), 'DROP TABLE IF EXISTS clientes').catch(() => undefined);
      await runChange(target(), 'CREATE TABLE clientes (id INT PRIMARY KEY, nombre VARCHAR(40))');
      await runChange(target(), "INSERT INTO clientes VALUES (1, 'Ana')");
      expect((await readSchema(target())).map((t) => t.table)).toContain(existing);
      expect((await runRead(target(), 'SELECT nombre FROM clientes')).rows).toEqual([['Ana']]);
      // The database's own barrier: a READ ONLY transaction.
      await expect(runRead(target(), "INSERT INTO clientes VALUES (2, 'Beto')")).rejects.toThrow();
      expect((await runRead(target(), 'SELECT COUNT(*) FROM clientes')).rows[0]![0]).toBe(u!.motor === 'postgres' ? '1' : 1);
    });

    it('las reglas de punta a punta: crear con aprobación, cambiar lo propio, nunca lo que ya existía', async () => {
      const t = testEngine(() => ({ pasos: [] }));
      cleanups.push(t.cleanup);
      const store = new DbConnectionStore(mkdtempSync(join(tmpdir(), 'forja-real-')));
      store.save({ name: 'real', motor: u!.motor, host: u!.host, port: u!.port, bases: [u!.base!], usuario: u!.usuario!, clave: u!.clave ?? '' });
      const svc = new DbService(t.engine, store);
      svc.link('real', {});
      const who = { who: 'agente T-001 · run_r' };
      await runChange(target(), 'DROP TABLE IF EXISTS forja_pagos').catch(() => undefined);
      const c = await svc.requestChange(who, {
        conn: 'real',
        base: u!.base!,
        sql: 'CREATE TABLE forja_pagos (id INT PRIMARY KEY, monto INT)',
        motivo: 'guardar pagos parciales',
        para_que: 'la pantalla de cobros',
      });
      expect((await svc.approve(c.req_id)).state).toBe('ejecutada');
      const ins = await svc.requestChange(who, { conn: 'real', base: u!.base!, sql: 'INSERT INTO forja_pagos VALUES (1, 50)', motivo: 'dato de ejemplo para probar', para_que: 'las pruebas' });
      expect((await svc.approve(ins.req_id)).state).toBe('ejecutada');
      for (const sql of ['DELETE FROM clientes', 'ALTER TABLE clientes ADD COLUMN x INT', 'DROP TABLE clientes']) {
        expect((await svc.requestChange(who, { conn: 'real', base: u!.base!, sql, motivo: 'intentar tocar lo existente', para_que: 'la prueba' })).state, sql).toBe('bloqueada');
      }
      expect((await runRead(target(), 'SELECT COUNT(*) FROM clientes')).rows[0]![0]).toBe(u!.motor === 'postgres' ? '1' : 1);
      const drop = await svc.requestChange(who, { conn: 'real', base: u!.base!, sql: 'DROP TABLE forja_pagos', motivo: 'ya no hace falta la tabla', para_que: 'limpiar' });
      expect((await svc.approve(drop.req_id)).state).toBe('ejecutada');
      expect(svc.objects()).toEqual([]);
    });
  });
}
