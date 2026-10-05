import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { DB_ENGINES, DbConnectionError, type DbConnectionInput, DbConnectionStore, DEFAULT_PORT, parseDbUrl, parseVariables, suggestFromVariables } from '../../db/connections.js';
import { ping, readOverview, readSchema, type TableInfo } from '../../db/driver.js';
import { dbServiceFor } from '../../db/project.js';
import { DbServiceError } from '../../db/service.js';
import { forjaHome } from '../../registry/home.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { openEngine } from '../engine-context.js';
import { readSecret } from '../secret-input.js';

const fmtBytes = (n: number | null): string => {
  if (n === null) return '—';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
};
const fmtRows = (n: number | null): string => (n === null ? '—' : n.toLocaleString('es'));
const fmtColumns = (t: TableInfo): string => t.columns.map((c) => `${c.name} ${c.type}${c.key === 'PRI' ? ' PK' : ''}${c.ref ? ` → ${c.ref}` : ''}${c.nullable ? '' : ' no nulo'}`).join(', ');

/**
 * `forja bd …` (docs/guias/BASES-DE-DATOS.md): register a database (from a JDBC URL or
 * the block of variables you already have), use it in a project with its rules, and
 * decide on the agents' requests. A password is never a command-line argument.
 */
const known = (error: unknown): never => {
  if (error instanceof DbConnectionError || error instanceof DbServiceError) throw new CliError(error.message, EXIT.precondition);
  throw error;
};

export function registerDatabaseCommands(program: Command): void {
  const bd = program.command('bd').description('bases de datos: conexiones (clave cifrada), reglas por proyecto y solicitudes de los agentes');

  bd.command('nueva <nombre>')
    .description('registra o edita una conexión; lo más fácil: --desde-archivo con tus variables (URL, usuario y clave)')
    .option('--url <url>', 'jdbc:mysql://host:3306/base, postgres://host:5432/base…')
    .option('--desde-archivo <archivo>', 'archivo con líneas NOMBRE: valor (URLs, usuario, clave); se guardan también como variables para las pruebas')
    .option('--motor <motor>', `${DB_ENGINES.join(' o ')}`)
    .option('--host <host>')
    .option('--puerto <n>', 'puerto', (v) => Number.parseInt(v, 10))
    .option('--bases <lista>', 'bases separadas por coma')
    .option('--usuario <usuario>')
    .option('--ssl', 'conectar con SSL/TLS')
    .option('--con-clave', 'pide la clave (sin eco; también por stdin)')
    .action(
      async (
        name: string,
        o: { url?: string; desdeArchivo?: string; motor?: string; host?: string; puerto?: number; bases?: string; usuario?: string; ssl?: boolean; conClave?: boolean },
        cmd: Command,
      ) => {
        const g = cmd.optsWithGlobals<GlobalOptions>();
        const store = new DbConnectionStore(forjaHome());
        try {
          const prev = store.list().find((c) => c.name === name);
          const fromFile = o.desdeArchivo ? suggestFromVariables(parseVariables(readFileSync(o.desdeArchivo, 'utf8'))) : null;
          const fromUrl = o.url ? parseDbUrl(o.url) : null;
          const motor = (o.motor ?? fromUrl?.motor ?? fromFile?.motor ?? prev?.motor ?? 'mysql') as DbConnectionInput['motor'];
          if (!(DB_ENGINES as readonly string[]).includes(motor)) throw new CliError(`--motor: ${DB_ENGINES.join(' o ')}`);
          const bases = o.bases
            ? o.bases.split(',').map((b) => b.trim())
            : [...new Set([...(fromUrl?.base ? [fromUrl.base] : []), ...(fromFile?.bases ?? []), ...(!fromUrl && !fromFile ? (prev?.bases ?? []) : [])])];
          const input: DbConnectionInput = {
            name,
            motor,
            host: o.host ?? fromUrl?.host ?? fromFile?.host ?? prev?.host ?? '',
            port: o.puerto ?? fromUrl?.port ?? fromFile?.port ?? prev?.port ?? DEFAULT_PORT[motor],
            bases,
            usuario: o.usuario ?? fromUrl?.usuario ?? fromFile?.usuario ?? prev?.usuario ?? '',
            ssl: o.ssl ?? fromUrl?.ssl ?? fromFile?.ssl ?? prev?.ssl ?? false,
          };
          const clave = o.conClave ? await readSecret('Clave de la base de datos: ') : (fromUrl?.clave ?? fromFile?.clave);
          if (clave !== undefined) input.clave = clave;
          if (fromFile?.variables) input.variables = fromFile.variables;
          if (!input.host) throw new CliError('falta el host: usa --url, --desde-archivo o --host');
          if (!input.usuario) throw new CliError('falta el usuario: --usuario');
          const saved = store.save(input);
          if (g.json) return printJson({ conexion: saved, avisos: fromFile?.avisos ?? [] });
          print(
            `✔ «${saved.name}» guardada (v${saved.version}): ${saved.motor} ${saved.host}:${saved.port} · bases ${saved.bases.join(', ')} · usuario ${saved.usuario}${saved.tiene_clave ? ' · clave cifrada' : ' · sin clave'}`,
          );
          if (saved.variables_nombres.length) print(`  variables para pruebas: ${saved.variables_nombres.join(', ')}`);
          for (const a of fromFile?.avisos ?? []) print(`  ⚠ ${a}`);
          print(`Pruébala con: forja bd probar ${saved.name} · úsala en un proyecto con: forja bd usar ${saved.name}`);
        } catch (error) {
          known(error);
        }
      },
    );

  bd.command('listar')
    .description('conexiones de esta máquina (sin claves)')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const list = new DbConnectionStore(forjaHome()).list();
      if (g.json) return printJson({ conexiones: list });
      if (!list.length) return print('No hay conexiones. Crea una con: forja bd nueva <nombre> --desde-archivo variables.txt');
      for (const c of list)
        print(
          `${c.name.padEnd(22)} ${c.motor.padEnd(8)} ${c.host}:${c.port}  bases ${c.bases.join(', ')}  usuario ${c.usuario}${c.variables_nombres.length ? `  (${c.variables_nombres.length} variables)` : ''}`,
        );
    });

  bd.command('probar <nombre>')
    .description('se conecta a cada base y muestra la versión del servidor')
    .action(async (name: string) => {
      const store = new DbConnectionStore(forjaHome());
      try {
        const conn = store.get(name);
        const password = store.secrets(name).clave;
        let bad = 0;
        for (const base of conn.bases) {
          try {
            print(`✔ ${base}: ${await ping({ conn, base, password })}`);
          } catch (error) {
            bad++;
            print(`✘ ${base}: ${(error as Error).message}`);
          }
        }
        if (bad) process.exitCode = EXIT.environment;
      } catch (error) {
        known(error);
      }
    });

  bd.command('ver <nombre>')
    .alias('mostrar')
    .description('muestra qué alcanza la conexión, sin leer filas: bases del servidor, tablas, vistas, filas aproximadas y tamaño (no hace falta un proyecto)')
    .option('--base <base>', 'sólo esta base (por defecto, todas las de la conexión)')
    .option('--columnas', 'también las columnas de cada tabla, con claves primarias y foráneas')
    .option('--contar', 'cuenta las filas exactas con COUNT(*) (más lento en bases grandes)')
    .action(async (name: string, o: { base?: string; columnas?: boolean; contar?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const store = new DbConnectionStore(forjaHome());
      try {
        const conn = store.get(name);
        if (o.base && !conn.bases.includes(o.base)) throw new CliError(`«${name}» no tiene la base «${o.base}» (${conn.bases.join(', ')})`, EXIT.precondition);
        const password = store.secrets(name).clave;
        const out: { base: string; ok: boolean; error?: string; version?: string; bases_del_servidor?: string[]; tablas?: unknown[]; columnas?: TableInfo[] }[] = [];
        for (const base of o.base ? [o.base] : conn.bases) {
          const target = { conn, base, password };
          try {
            const ov = await readOverview(target, { count: o.contar ?? false });
            const cols = o.columnas ? await readSchema(target) : undefined;
            out.push({ base, ok: true, version: ov.version, bases_del_servidor: ov.serverBases, tablas: ov.tables, ...(cols ? { columnas: cols } : {}) });
            if (g.json) continue;
            if (out.filter((x) => x.ok).length === 1) {
              print(`✔ conectado a ${conn.motor} ${ov.version.split(' ').slice(0, 2).join(' ')} en ${conn.host}:${conn.port} como ${conn.usuario}`);
              print(`  bases que este usuario ve en el servidor: ${ov.serverBases.map((b) => (conn.bases.includes(b) ? `${b}*` : b)).join(', ') || '(ninguna)'}  (* = configuradas en «${name}»)`);
            }
            const tablas = ov.tables.filter((t) => t.kind === 'tabla');
            const vistas = ov.tables.filter((t) => t.kind === 'vista');
            print('');
            print(`── ${base} · ${tablas.length} tabla(s)${vistas.length ? ` · ${vistas.length} vista(s)` : ''} · ${fmtBytes(ov.tables.reduce((a, t) => a + (t.bytes ?? 0), 0))}`);
            if (!ov.tables.length) {
              print('   (vacía: no hay tablas, o este usuario no tiene permiso para verlas)');
              continue;
            }
            const label = (t: { table: string; kind: string }) => (t.kind === 'vista' ? `${t.table} (vista)` : t.table);
            const width = Math.min(48, Math.max(...ov.tables.map((t) => label(t).length)));
            print(`   ${'tabla'.padEnd(width)}  ${(o.contar ? 'filas' : 'filas aprox.').padStart(12)}  ${'tamaño'.padStart(8)}`);
            const byName = new Map((cols ?? []).map((c) => [c.table, c]));
            for (const t of ov.tables) {
              print(
                `   ${(t.kind === 'vista' ? `${t.table} (vista)` : t.table).padEnd(width)}  ${fmtRows(t.rows).padStart(12)}  ${fmtBytes(t.bytes).padStart(8)}${t.comment ? `  · ${t.comment}` : ''}`,
              );
              const c = byName.get(t.table);
              if (c) print(`      ${fmtColumns(c)}`);
            }
          } catch (error) {
            out.push({ base, ok: false, error: (error as Error).message });
            if (!g.json) print(`✘ ${base}: ${(error as Error).message}`);
          }
        }
        if (g.json) printJson({ conexion: name, motor: conn.motor, bases: out });
        else if (!o.contar && out.some((x) => x.ok)) print('\nLas filas son la estimación del motor (— = todavía no la calculó); para contarlas exactas: --contar. Para ver las columnas: --columnas.');
        if (out.some((x) => !x.ok)) process.exitCode = EXIT.environment;
      } catch (error) {
        known(error);
      }
    });

  bd.command('contexto')
    .description('lo que el planeador ve de tus bases en este proyecto (descubrir, especificar y dividir): úsalo para comprobar que le llega todo')
    .option('--completo', 'imprime el bloque exacto que recibe el planeador')
    .action(async (o: { completo?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const svc = dbServiceFor(ctx.engine, ctx.home);
        const block = (await svc.schemaForPrompt()) as {
          bases: { conexion: string; base: string; motor: string; tablas?: string[]; tablas_total?: number; error?: string; tablas_creadas_por_forja: string[] }[];
        } | null;
        if (g.json) return printJson({ bases_de_datos: block, caracteres: block ? JSON.stringify(block).length : 0 });
        if (!block) {
          print('El planeador no ve ninguna base: este proyecto no tiene conexiones vinculadas.');
          print('Vincula una con: forja bd usar <nombre> (míralas con forja bd listar)');
          process.exitCode = EXIT.precondition;
          return;
        }
        let bad = 0;
        for (const b of block.bases) {
          if (b.error) {
            bad++;
            print(`✘ ${b.conexion}/${b.base}: el planeador recibe sólo el error → ${b.error}`);
            continue;
          }
          const shown = b.tablas?.length ?? 0;
          const fks = (b.tablas ?? []).reduce((a, t) => a + (t.match(/ → /g)?.length ?? 0), 0);
          print(
            `✔ ${b.conexion}/${b.base} (${b.motor}): ${shown} tabla(s)${b.tablas_total !== undefined && shown < b.tablas_total ? ` de ${b.tablas_total} — recortada por tamaño` : ''} · ${fks} clave(s) foránea(s)${b.tablas_creadas_por_forja.length ? ` · creadas por Forja: ${b.tablas_creadas_por_forja.join(', ')}` : ''}`,
          );
        }
        print(`Tamaño del bloque: ${JSON.stringify(block).length.toLocaleString('es')} caracteres (sin datos, sólo la estructura).`);
        if (o.completo) {
          print('');
          print(JSON.stringify(block, null, 2));
        } else print('Para ver el bloque exacto: forja bd contexto --completo');
        if (bad) process.exitCode = EXIT.environment;
      } catch (error) {
        known(error);
      } finally {
        ctx.close();
      }
    });

  bd.command('eliminar <nombre>')
    .description('borra la conexión de esta máquina (la base de datos no se toca)')
    .action((name: string) => {
      try {
        new DbConnectionStore(forjaHome()).remove(name);
        print(`✔ «${name}» eliminada de esta máquina`);
      } catch (error) {
        known(error);
      }
    });

  bd.command('usar <nombre>')
    .description('usa la conexión en este proyecto: esquema libre; lecturas con aprobación (o --lectura libre); cambios siempre con aprobación y sólo en tablas creadas por Forja')
    .option('--bases <lista>', 'sólo estas bases (por defecto todas las de la conexión)')
    .option('--lectura <modo>', 'preguntar (por defecto) o libre')
    .option('--pruebas', 'pasa las variables de la conexión a los comandos de prueba del proyecto')
    .option('--sin-pruebas', 'deja de pasarlas')
    .action((name: string, o: { bases?: string; lectura?: string; pruebas?: boolean; sinPruebas?: boolean }, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        if (o.lectura && o.lectura !== 'preguntar' && o.lectura !== 'libre') throw new CliError('--lectura: preguntar o libre');
        const l = dbServiceFor(ctx.engine, ctx.home).link(name, {
          ...(o.bases ? { bases: o.bases.split(',').map((b) => b.trim()) } : {}),
          ...(o.lectura ? { lectura: o.lectura as 'preguntar' | 'libre' } : {}),
          ...(o.pruebas ? { pruebas: true } : o.sinPruebas ? { pruebas: false } : {}),
        });
        print(`✔ «${name}» en este proyecto: bases ${l.bases.join(', ')} · lecturas ${l.lectura === 'libre' ? 'sin preguntar' : 'con aprobación'}${l.pruebas ? ' · variables en las pruebas' : ''}`);
      } catch (error) {
        known(error);
      } finally {
        ctx.close();
      }
    });

  bd.command('dejar <nombre>')
    .description('deja de usar la conexión en este proyecto')
    .action((name: string, _o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        dbServiceFor(ctx.engine, ctx.home).unlink(name);
        print(`✔ «${name}» ya no se usa en este proyecto`);
      } catch (error) {
        known(error);
      } finally {
        ctx.close();
      }
    });

  bd.command('esquema <nombre>')
    .description('tablas y columnas de una base')
    .requiredOption('--base <base>')
    .action(async (name: string, o: { base: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const tables = await dbServiceFor(ctx.engine, ctx.home).schema(name, o.base, true);
        if (g.json) return printJson({ esquema: tables });
        for (const t of tables) print(`${t.table}: ${fmtColumns(t)}`);
      } catch (error) {
        known(error);
      } finally {
        ctx.close();
      }
    });

  bd.command('solicitudes')
    .description('consultas y cambios que pidieron los agentes')
    .option('--todas', 'también las ya resueltas')
    .action((o: { todas?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const svc = dbServiceFor(ctx.engine, ctx.home);
        const list = o.todas ? svc.requests() : svc.requests('pendiente');
        if (g.json) return printJson({ solicitudes: list });
        if (!list.length) return print(o.todas ? 'No hay solicitudes.' : 'No hay solicitudes pendientes.');
        for (const r of list) {
          print(`${r.req_id}  ${r.state.padEnd(10)} ${r.kind.padEnd(8)} ${r.conn}/${r.base} · ${r.origin}`);
          print(`    ${r.sql.replace(/\s+/g, ' ').slice(0, 200)}`);
          if (r.motivo) print(`    por qué: ${r.motivo}`);
          if (r.para_que) print(`    para qué: ${r.para_que}`);
          if (r.detail) print(`    ${r.detail}`);
        }
        if (!o.todas) print('Decide con: forja bd aprobar <id> · forja bd rechazar <id> "motivo"');
      } finally {
        ctx.close();
      }
    });

  bd.command('aprobar <id>')
    .description('aprueba y ejecuta una solicitud (las reglas se revisan otra vez antes de ejecutar)')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const r = await dbServiceFor(ctx.engine, ctx.home).approve(id);
        if (g.json) return printJson({ solicitud: r });
        print(
          r.state === 'ejecutada'
            ? `✔ ejecutada${r.result?.affected !== null && r.result?.affected !== undefined ? ` · ${r.result.affected} fila(s) afectada(s)` : r.result ? ` · ${r.result.total} fila(s)` : ''}`
            : `✘ ${r.state}: ${r.detail}`,
        );
        if (r.state !== 'ejecutada') process.exitCode = EXIT.precondition;
      } catch (error) {
        known(error);
      } finally {
        ctx.close();
      }
    });

  bd.command('rechazar <id> [motivo]')
    .description('rechaza una solicitud (el agente ve el motivo)')
    .action((id: string, reason: string | undefined, _o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        dbServiceFor(ctx.engine, ctx.home).reject(id, reason ?? 'rechazada por el usuario');
        print('✔ rechazada');
      } catch (error) {
        known(error);
      } finally {
        ctx.close();
      }
    });

  bd.command('tablas')
    .description('tablas que Forja creó en este proyecto (las únicas que se pueden cambiar o borrar)')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const list = dbServiceFor(ctx.engine, ctx.home).objects(true);
        if (g.json) return printJson({ tablas: list });
        if (!list.length) return print('Forja todavía no creó tablas en este proyecto.');
        for (const t of list)
          print(`${t.dropped_at ? '✗' : '✔'} ${t.conn}/${t.base}.${t.name}  creada por ${t.created_by} el ${t.created_at.slice(0, 16).replace('T', ' ')}${t.dropped_at ? ' · eliminada' : ''}`);
      } finally {
        ctx.close();
      }
    });
}
