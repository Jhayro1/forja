import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { ConnectionError, ConnectionStore } from '../../actions/connections.js';
import { defaultExecutorRunner } from '../../actions/executor-runner.js';
import { OPERATIONS, OperationError } from '../../actions/operations.js';
import { ActionError, type ActionRow, ActionService, type SecretResolver } from '../../actions/protocol.js';
import { TEXTOS } from '../../i18n/textos.js';
import { forjaHome } from '../../registry/home.js';
import { Vault, VaultError, vaultPaths } from '../../vault/vault.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { type EngineContext, openEngine } from '../engine-context.js';
import { readSecret, vaultPassphrase } from '../secret-input.js';

const STATE_TEXT: Record<string, string> = { ...TEXTOS.estadoAccion, desconocido: TEXTOS.estadoAccion.desconocido.toUpperCase() };

export function actionService(ctx: EngineContext): ActionService {
  return new ActionService(ctx.store, ConnectionStore.in(ctx.home), { executor: defaultExecutorRunner() });
}

function domain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ActionError || error instanceof ConnectionError || error instanceof OperationError) throw new CliError(error.message, EXIT.precondition);
    throw error;
  }
}

/** Opens the vault only for the duration of `fn` (it holds the key in memory). */
async function withSecrets<T>(needed: boolean, fn: (resolve: SecretResolver) => Promise<T>): Promise<T> {
  if (!needed) return fn(() => null);
  let vault: Vault;
  try {
    vault = Vault.open(vaultPaths(forjaHome()), await vaultPassphrase());
  } catch (error) {
    if (error instanceof VaultError) throw new CliError(error.message, EXIT.precondition);
    throw error;
  }
  try {
    return await fn((name) => (vault.has(name) ? vault.get(name) : null));
  } finally {
    vault.close();
  }
}

function showAction(a: ActionRow): void {
  print(`${a.action_id} · ${a.type} en «${a.connection}» · ${STATE_TEXT[a.view_state] ?? a.view_state}`);
  print(`  origen: ${a.origin} · vence: ${a.expires_at.slice(0, 16).replace('T', ' ')} UTC${a.attempts ? ` · intentos: ${a.attempts}` : ''}`);
  for (const [k, v] of Object.entries(a.preview)) print(`  ${k.padEnd(16)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  print(`  hash: ${a.hash}`);
  if (a.result) print(`  resultado: ${a.result.detail ?? ''}${a.result.conciliada ? ` (conciliada: ${a.result.note})` : ''}`);
}

export function registerActionCommands(program: Command): void {
  const conexion = program.command('conexion').description('servicios externos (el secreto vive en la bóveda; cada proyecto los vincula explícitamente)');

  conexion
    .command('nueva <nombre>')
    .description('crea o edita una conexión HTTP (editar crea una versión nueva e invalida vínculos y aprobaciones)')
    .requiredOption('--url <url>', 'URL base (https)')
    .option('--secreto <nombre>', 'secreto de la bóveda que se envía como credencial')
    .option('--cabecera <nombre>', 'cabecera de la credencial', 'Authorization')
    .option('--esquema <texto>', 'prefijo de la credencial', 'Bearer')
    .option('--idempotente', 'el servicio respeta Idempotency-Key (permite resolver resultados inciertos reenviando)')
    .option('--permitir-local', 'permite destinos locales/privados (sólo servicios de prueba)')
    .option('--prueba <ruta>', 'ruta GET de menor impacto para forja conexion probar')
    .option('--consulta <ruta>', 'GET que encuentra una acción por su clave, con {clave} (p. ej. /pedidos?clave={clave}): concilia sola los resultados inciertos')
    .action((name: string, o: { url: string; secreto?: string; cabecera: string; esquema: string; idempotente?: boolean; permitirLocal?: boolean; prueba?: string; consulta?: string }) => {
      const c = domain(() =>
        ConnectionStore.in(forjaHome()).save({
          name,
          type: 'http',
          base_url: o.url,
          secret: o.secreto ?? null,
          auth_header: o.cabecera,
          auth_scheme: o.esquema,
          idempotent: Boolean(o.idempotente),
          allow_local: Boolean(o.permitirLocal),
          test_path: o.prueba ?? null,
          lookup_path: o.consulta ?? null,
        }),
      );
      print(`✔ Conexión «${c.name}» versión ${c.version}. Vincúlala a un proyecto con: forja conexion vincular ${c.name} --operaciones http.json`);
    });

  conexion
    .command('listar')
    .description('conexiones de esta máquina y su vínculo con el proyecto actual')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const all = ConnectionStore.in(forjaHome()).all();
      let links: ReturnType<ActionService['links']> = [];
      try {
        const ctx = openEngine(g);
        links = actionService(ctx).links();
        ctx.close();
      } catch {
        links = [];
      }
      if (g.json) return printJson({ conexiones: all, vinculos: links });
      if (!all.length) return print('No hay conexiones. Crea una con: forja conexion nueva <nombre> --url https://…');
      for (const c of all) {
        const l = links.find((x) => x.connection === c.name && x.active);
        const link = !l ? 'sin vincular' : l.version !== c.version ? `vinculada a la v${l.version}: vuelve a vincular` : `vinculada: ${l.operations.join(', ')}`;
        print(`  ${c.name.padEnd(20)} v${c.version} ${c.base_url}  ${c.secret ? `(secreto ${c.secret})` : ''}  · ${link}`);
      }
    });

  conexion
    .command('vincular <nombre>')
    .description('autoriza la conexión en ESTE proyecto para las operaciones indicadas')
    .requiredOption('--operaciones <lista>', 'operaciones permitidas, separadas por coma (p. ej. http.json)')
    .action((name: string, o: { operaciones: string }, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        const l = domain(() =>
          actionService(ctx).link(
            name,
            o.operaciones
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        );
        print(`✔ «${name}» v${l.version} vinculada a este proyecto: ${l.operations.join(', ')}`);
      } finally {
        ctx.close();
      }
    });

  conexion
    .command('desvincular <nombre>')
    .description('retira la autorización de la conexión en este proyecto')
    .action((name: string, _o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        domain(() => actionService(ctx).unlink(name));
        print(`✔ «${name}» desvinculada`);
      } finally {
        ctx.close();
      }
    });

  conexion
    .command('probar <nombre>')
    .description('prueba de menor impacto (GET de la ruta de prueba) por el ejecutor aislado')
    .action(async (name: string, _o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        const conn = domain(() => ConnectionStore.in(ctx.home).get(name));
        const r = await withSecrets(Boolean(conn.secret), (resolve) =>
          actionService(ctx)
            .probe(name, resolve)
            .catch((e: Error) =>
              domain(() => {
                throw e;
              }),
            ),
        );
        print(`${r.ok ? '✔' : '✘'} ${name}: ${r.detail}`);
        if (!r.ok) process.exitCode = EXIT.environment;
      } finally {
        ctx.close();
      }
    });

  program
    .command('acciones')
    .description('acciones externas del proyecto y su estado')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const svc = actionService(ctx);
        svc.recoverInterrupted();
        const list = svc.list();
        if (g.json) return printJson({ acciones: list });
        if (!list.length) return print('No hay acciones.');
        for (const a of list) print(`  ${a.action_id}  ${(STATE_TEXT[a.view_state] ?? a.view_state).padEnd(34)} ${a.type} · ${a.connection} · ${String(a.preview.peticion ?? '')}`);
      } finally {
        ctx.close();
      }
    });

  const accion = program.command('accion').description('proponer, aprobar, ejecutar y conciliar acciones externas');

  accion
    .command('proponer <conexion>')
    .description('propone una petición JSON (nada se envía hasta aprobar y ejecutar)')
    .requiredOption('--ruta <ruta>', 'ruta bajo la URL de la conexión, p. ej. /pedidos')
    .option('--metodo <m>', 'POST, PUT, PATCH o DELETE', 'POST')
    .option('--cuerpo <json>', 'cuerpo JSON')
    .option('--cuerpo-archivo <ruta>', 'cuerpo JSON desde un archivo')
    .option('--precondicion-ruta <ruta>', 'GET que se comprueba antes de ejecutar')
    .option('--precondicion-puntero <puntero>', 'JSON pointer dentro de esa respuesta, p. ej. /estado', '')
    .option('--precondicion-valor <json>', 'valor esperado (JSON)')
    .option('--sin-if-match', 'no pedir al servicio que compruebe la precondición de forma atómica')
    .action(
      (
        name: string,
        o: { ruta: string; metodo: string; cuerpo?: string; cuerpoArchivo?: string; precondicionRuta?: string; precondicionPuntero: string; precondicionValor?: string; sinIfMatch?: boolean },
        cmd: Command,
      ) => {
        const g = cmd.optsWithGlobals<GlobalOptions>();
        const parse = (text: string, what: string) => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            throw new CliError(`${what} no es JSON válido`);
          }
        };
        const body = o.cuerpoArchivo ? parse(readFileSync(o.cuerpoArchivo, 'utf8'), '--cuerpo-archivo') : o.cuerpo !== undefined ? parse(o.cuerpo, '--cuerpo') : undefined;
        if (o.precondicionRuta && o.precondicionValor === undefined) throw new CliError('--precondicion-ruta necesita --precondicion-valor');
        const params = {
          ruta: o.ruta,
          metodo: o.metodo.toUpperCase(),
          ...(body !== undefined ? { cuerpo: body } : {}),
          ...(o.precondicionRuta
            ? { precondicion: { ruta: o.precondicionRuta, puntero: o.precondicionPuntero, valor: parse(o.precondicionValor!, '--precondicion-valor'), si_coincide: !o.sinIfMatch } }
            : {}),
        };
        const ctx = openEngine(g);
        try {
          const a = domain(() => actionService(ctx).propose({ type: 'http.json', connection: name, params, origin: 'cli' }));
          if (g.json) return printJson({ accion: a });
          showAction(a);
          print(`\nRevísala y apruébala con: forja accion aprobar ${a.action_id}`);
        } finally {
          ctx.close();
        }
      },
    );

  accion
    .command('ver <id>')
    .description('vista previa, hash, estado y resultado')
    .action((id: string, _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const a = domain(() => actionService(ctx).get(id));
        if (g.json) return printJson({ accion: a });
        showAction(a);
      } finally {
        ctx.close();
      }
    });

  accion
    .command('aprobar <id>')
    .description('aprueba EXACTAMENTE la vista previa mostrada (ligada a su hash y con vencimiento)')
    .option('--hash <hash>', 'hash de la vista previa (sin terminal, es obligatorio)')
    .action(async (id: string, o: { hash?: string }, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        const svc = actionService(ctx);
        const a = domain(() => svc.get(id));
        let hash = o.hash;
        if (!hash) {
          if (!process.stdin.isTTY) throw new CliError('sin terminal hay que pasar --hash con el hash de la vista previa');
          showAction(a);
          const typed = (await readSecret(`\nPara aprobar escribe los primeros 8 caracteres del hash después de «canon-v1:»: `)).trim();
          const short = a.hash.split(':').at(-1)!.slice(0, 8);
          if (typed !== short) throw new CliError('no coincide: no se aprobó nada');
          hash = a.hash;
        }
        domain(() => svc.approve(id, hash!, 'cli'));
        print(`✔ Aprobada. Ejecútala antes de ${a.expires_at.slice(11, 16)} UTC con: forja accion ejecutar ${id}`);
      } finally {
        ctx.close();
      }
    });

  accion
    .command('descartar <id>')
    .description('descarta una propuesta o una aprobación sin ejecutar')
    .option('--motivo <texto>', 'motivo', 'descartada por el usuario')
    .action((id: string, o: { motivo: string }, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        domain(() => actionService(ctx).discard(id, 'cli', o.motivo));
        print(`✔ ${id} descartada`);
      } finally {
        ctx.close();
      }
    });

  accion
    .command('ejecutar <id>')
    .description('ejecuta una acción aprobada (o reenvía con la misma clave una incierta a un servicio idempotente)')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const svc = actionService(ctx);
        const a = domain(() => svc.get(id));
        const conn = domain(() => ConnectionStore.in(ctx.home).get(a.connection));
        const done = await withSecrets(Boolean(conn.secret), async (resolve) => {
          try {
            return await svc.execute(id, resolve);
          } catch (error) {
            return domain(() => {
              throw error;
            });
          }
        });
        if (g.json) return printJson({ accion: done });
        showAction(done);
        if (done.state === 'desconocido') {
          print(
            conn.idempotent
              ? '\nEl servicio es idempotente: vuelve a ejecutarla para confirmar sin duplicar.'
              : '\nComprueba en el servicio si se aplicó y concílialo: forja accion conciliar <id> --efecto si|no --nota "…"',
          );
          process.exitCode = EXIT.unknown;
        } else if (done.state !== 'confirmada') process.exitCode = EXIT.verification;
      } finally {
        ctx.close();
      }
    });

  accion
    .command('conciliar <id>')
    .description('registra lo que comprobaste en el servicio para una acción con resultado desconocido')
    .requiredOption('--efecto <si|no>', '¿el servicio aplicó la acción?')
    .requiredOption('--nota <texto>', 'qué comprobaste (queda en la auditoría)')
    .action((id: string, o: { efecto: string; nota: string }, cmd: Command) => {
      if (!['si', 'sí', 'no'].includes(o.efecto)) throw new CliError('--efecto debe ser si o no');
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        const a = domain(() => actionService(ctx).reconcile(id, o.efecto !== 'no', 'cli', o.nota));
        print(`✔ ${id}: ${STATE_TEXT[a.state]}`);
      } finally {
        ctx.close();
      }
    });

  accion
    .command('operaciones')
    .description('operaciones tipadas disponibles (qué puede proponerse y si se puede deshacer)')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ops = Object.values(OPERATIONS).map((o) => ({ id: o.id, descripcion: o.description, reintento_ciego: o.retrySafe !== false, deshacer: Boolean(o.undo) }));
      if (g.json) return printJson({ operaciones: ops });
      for (const o of ops) print(`  ${o.id.padEnd(16)} ${o.descripcion}${o.reintento_ciego ? '' : ' · nunca se reenvía a ciegas'}`);
      print("\nProponer: forja accion proponer-tipo <conexion> <operacion> --parametros '{…}' (o @archivo.json)");
    });

  accion
    .command('proponer-tipo <conexion> <operacion>')
    .description('propone cualquier operación tipada (correo.enviar, webhook.evento, dns.registro, http.json)')
    .requiredOption('--parametros <json>', 'parámetros de la operación en JSON, o @archivo.json')
    .action((name: string, type: string, o: { parametros: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      let params: unknown;
      try {
        params = JSON.parse(o.parametros.startsWith('@') ? readFileSync(o.parametros.slice(1), 'utf8') : o.parametros) as unknown;
      } catch {
        throw new CliError('--parametros no es JSON válido');
      }
      const ctx = openEngine(g);
      try {
        const a = domain(() => actionService(ctx).propose({ type, connection: name, params, origin: 'cli' }));
        if (g.json) return printJson({ accion: a });
        showAction(a);
        print(`\nRevísala y apruébala con: forja accion aprobar ${a.action_id}`);
      } finally {
        ctx.close();
      }
    });

  accion
    .command('deshacer <id>')
    .description('propone la acción inversa de una confirmada (necesita su propia aprobación)')
    .action((id: string, _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const a = domain(() => actionService(ctx).undo(id, 'cli'));
        if (g.json) return printJson({ accion: a });
        print(`Propuesta para deshacer ${id} (nada se ejecutó todavía):`);
        showAction(a);
        print(`\nRevísala y apruébala con: forja accion aprobar ${a.action_id}`);
      } finally {
        ctx.close();
      }
    });
}
