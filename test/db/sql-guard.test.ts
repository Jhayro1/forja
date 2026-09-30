import { describe, expect, it } from 'vitest';
import { parseDbUrl, parseVariables, suggestFromVariables } from '../../src/db/connections.js';
import { checkSql, SqlRejected } from '../../src/db/sql-guard.js';

const my = (sql: string) => checkSql(sql, 'mysql', 'appdb');
const pg = (sql: string) => checkSql(sql, 'postgres', 'appdb');

describe('guardia SQL: qué puede pedir un agente', () => {
  it('lecturas: SELECT, WITH, SHOW, DESCRIBE, EXPLAIN; funciones de texto sí', () => {
    for (const q of [
      'SELECT * FROM facturas WHERE id = 1',
      "select replace(nombre, 'a', 'b') from clientes;",
      'WITH t AS (SELECT 1 AS x) SELECT x FROM t',
      'SHOW TABLES',
      'DESCRIBE facturas',
      'EXPLAIN SELECT * FROM facturas',
      "SELECT '-- no es comentario', 'a;b' FROM dual",
    ]) {
      expect(my(q).kind, q).toBe('lectura');
    }
  });

  it('una lectura no esconde escrituras, bloqueos ni funciones peligrosas', () => {
    for (const q of [
      'SELECT 1; DROP TABLE facturas',
      'SELECT * FROM facturas -- WHERE 1',
      'SELECT * FROM facturas /* x */',
      'SELECT * FROM facturas # x',
      'SELECT * FROM facturas INTO OUTFILE "/tmp/x"',
      'SELECT * FROM facturas FOR UPDATE',
      'SELECT SLEEP(10)',
      "SELECT LOAD_FILE('/etc/passwd')",
      'WITH x AS (DELETE FROM facturas RETURNING *) SELECT * FROM x',
      'EXPLAIN ANALYZE DELETE FROM facturas',
      "SELECT pg_read_file('/etc/passwd')",
      'SELECT $x$ hola $x$',
    ]) {
      expect(() => (q.includes('pg_') || q.includes('$x$') || q.includes('RETURNING') ? pg(q) : my(q)), q).toThrow(SqlRejected);
    }
  });

  it('crear: sólo CREATE TABLE, con la tabla normalizada', () => {
    expect(my('CREATE TABLE IF NOT EXISTS `forja_pagos` (id INT PRIMARY KEY)')).toMatchObject({ kind: 'crear', targets: ['forja_pagos'] });
    expect(pg('create table Pagos (id int)')).toMatchObject({ kind: 'crear', targets: ['public.pagos'] });
    expect(pg('create table ventas."Pagos" (id int)')).toMatchObject({ targets: ['ventas.Pagos'] });
    for (const q of [
      'CREATE VIEW v AS SELECT 1',
      'CREATE PROCEDURE p() BEGIN END',
      'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @a=1',
      'CREATE DATABASE otra',
      'CREATE TABLE otra_base.t (id int)',
    ]) {
      expect(() => my(q), q).toThrow(SqlRejected);
    }
  });

  it('cambios: una tabla por sentencia y nunca de otra base, ni CASCADE, ni renombrar', () => {
    expect(my('ALTER TABLE forja_pagos ADD COLUMN monto DECIMAL(10,2)')).toMatchObject({ kind: 'cambio', targets: ['forja_pagos'] });
    expect(my('INSERT INTO forja_pagos (id) SELECT id FROM facturas')).toMatchObject({ kind: 'cambio', targets: ['forja_pagos'] });
    expect(my('UPDATE forja_pagos p SET monto = 0 WHERE p.id = 1')).toMatchObject({ targets: ['forja_pagos'] });
    expect(pg('UPDATE forja_pagos SET monto = 0 FROM facturas f WHERE f.id = forja_pagos.id')).toMatchObject({ targets: ['public.forja_pagos'] });
    expect(my('DELETE FROM forja_pagos WHERE id = 3')).toMatchObject({ targets: ['forja_pagos'] });
    expect(my('DROP TABLE IF EXISTS forja_pagos, forja_tmp')).toMatchObject({ targets: ['forja_pagos', 'forja_tmp'] });
    expect(my('TRUNCATE TABLE forja_tmp')).toMatchObject({ targets: ['forja_tmp'] });
    expect(my('CREATE INDEX idx ON forja_pagos (monto)')).toMatchObject({ kind: 'cambio', targets: ['forja_pagos'] });
    for (const q of [
      'UPDATE forja_pagos, facturas SET facturas.total = 0',
      'UPDATE forja_pagos JOIN facturas ON 1=1 SET facturas.total = 0',
      'DELETE facturas FROM facturas JOIN forja_pagos',
      'DELETE FROM forja_pagos, facturas USING forja_pagos JOIN facturas',
      'ALTER TABLE forja_pagos RENAME TO facturas',
      'RENAME TABLE forja_pagos TO facturas',
      'DROP TABLE forja_pagos CASCADE',
      'DROP DATABASE appdb',
      'GRANT ALL ON *.* TO x',
      'SET GLOBAL read_only = 0',
      'CALL limpiar()',
      "LOAD DATA INFILE 'x' INTO TABLE t",
      'UPDATE otra.facturas SET total = 0',
    ]) {
      expect(() => my(q), q).toThrow(SqlRejected);
    }
  });
});

describe('conexiones: lo que la gente ya tiene pegado', () => {
  it('lee URLs JDBC y nativas, sin los parámetros de Java', () => {
    expect(parseDbUrl('jdbc:mysql://10.0.0.5:3306/ventas?logger=Slf4JLogger&profileSQL=false&useSSL=false')).toMatchObject({
      motor: 'mysql',
      host: '10.0.0.5',
      port: 3306,
      base: 'ventas',
      ssl: false,
    });
    expect(parseDbUrl('postgres://yo:secreta@db.local/erp?sslmode=require')).toMatchObject({ motor: 'postgres', port: 5432, base: 'erp', usuario: 'yo', clave: 'secreta', ssl: true });
    expect(() => parseDbUrl('https://x')).toThrow(/no reconozco/);
  });

  it('entiende un bloque de variables: varias bases del mismo servidor, usuario y clave', () => {
    const vars = parseVariables(
      [
        'APP_URL_VENTAS: jdbc:mysql://10.0.0.5:3306/ventas?useSSL=false',
        'APP_URL_DEVVENTAS: jdbc:mysql://10.0.0.5:3306/devventas?useSSL=false',
        'APP_DBUSER_API: usuario_app',
        'APP_DBPASSWORD_API: $$clave_x1',
      ].join('\n'),
    );
    const s = suggestFromVariables(vars);
    expect(s).toMatchObject({ motor: 'mysql', host: '10.0.0.5', port: 3306, bases: ['ventas', 'devventas'], usuario: 'usuario_app', clave: '$$clave_x1' });
    expect(Object.keys(s.variables!)).toHaveLength(4);
    expect(parseVariables('export A="1"\nB=2\n# comentario')).toEqual({ A: '1', B: '2' });
  });
});
