import { DB_ENGINES, DbConnectionError, type DbConnectionInput, parseDbUrl, parseVariables, suggestFromVariables } from '../../db/connections.js';
import { ping } from '../../db/driver.js';
import { type DbService, DbServiceError, type ReadPolicy } from '../../db/service.js';
import { ApiError, stringField } from '../http.js';
import type { ApiModule } from '../server.js';

/**
 * Databases in the panel (docs/guias/BASES-DE-DATOS.md): a form to register a connection
 * (paste the JDBC URL or the whole block of variables), link it to the project with its
 * read policy, and decide on the agents' requests. The password never comes back.
 */
const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const REQ = /^bdq_[0-9A-HJKMNP-TV-Z]{26}$/;

const who = 'usuario (panel)';

function fail(error: unknown): never {
  if (error instanceof DbConnectionError || error instanceof DbServiceError) throw new ApiError(422, 'bd', error.message);
  throw error;
}

function formInput(b: Record<string, unknown>): DbConnectionInput & { variablesText?: string } {
  const motor = String(b.motor ?? '');
  if (!(DB_ENGINES as readonly string[]).includes(motor)) throw new ApiError(422, 'campo_invalido', 'motor: mysql o postgres');
  const port = Number(b.puerto);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(422, 'campo_invalido', 'puerto no válido');
  const bases = Array.isArray(b.bases) ? b.bases.map(String) : [];
  const input: DbConnectionInput = {
    name: stringField(b, 'nombre', { max: 41 })!,
    motor: motor as DbConnectionInput['motor'],
    host: stringField(b, 'host', { max: 255 })!,
    port,
    bases,
    usuario: stringField(b, 'usuario', { max: 128 })!,
    ssl: b.ssl === true,
  };
  if (typeof b.clave === 'string' && b.clave !== '') input.clave = b.clave;
  if (b.borrar_clave === true) input.clave = '';
  if (typeof b.variables === 'string') {
    try {
      input.variables = parseVariables(b.variables);
    } catch (error) {
      fail(error);
    }
  }
  return input;
}

export function databasesModule(svc: DbService): ApiModule {
  return {
    name: 'bases',
    routes: [
      {
        method: 'GET',
        path: /^\/v1\/bases$/,
        handler: () => ({
          bases: {
            conexiones: svc.store.list(),
            vinculos: svc.links(),
            tablas_creadas: svc.objects(true),
            solicitudes: svc.requests().map(({ result, ...r }) => ({ ...r, filas: result?.total ?? null, resultado: result })),
          },
        }),
      },
      {
        // Understands what the user pasted: a URL or a block of NAME: value lines.
        method: 'POST',
        path: /^\/v1\/bases\/analizar$/,
        handler: async ({ body }) => {
          const text = stringField(await body(), 'texto', { max: 20_000 })!.trim();
          try {
            if (/^(jdbc:)?(mysql|mariadb|postgres|postgresql):\/\//i.test(text) && !text.includes('\n')) {
              const u = parseDbUrl(text);
              return {
                sugerencia: {
                  motor: u.motor,
                  host: u.host,
                  puerto: u.port,
                  bases: u.base ? [u.base] : [],
                  ssl: u.ssl,
                  ...(u.usuario ? { usuario: u.usuario } : {}),
                  ...(u.clave ? { clave: u.clave } : {}),
                },
              };
            }
            const vars = parseVariables(text);
            const s = suggestFromVariables(vars);
            return {
              sugerencia: {
                ...(s.motor ? { motor: s.motor } : {}),
                ...(s.host ? { host: s.host } : {}),
                ...(s.port ? { puerto: s.port } : {}),
                ...(s.bases ? { bases: s.bases } : {}),
                ...(s.ssl !== undefined ? { ssl: s.ssl } : {}),
                ...(s.usuario ? { usuario: s.usuario } : {}),
                ...(s.clave !== undefined ? { clave: s.clave } : {}),
                variables: text,
                variables_nombres: Object.keys(vars),
              },
              avisos: s.avisos,
            };
          } catch (error) {
            fail(error);
          }
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/bases$/,
        handler: async ({ body }) => {
          try {
            const c = svc.store.save(formInput(await body()));
            return { ok: true, conexion: c, mensaje: `conexión «${c.name}» guardada (v${c.version})` };
          } catch (error) {
            fail(error);
          }
        },
      },
      {
        // Tries the saved connection (or the form, with its password) on every database.
        method: 'POST',
        path: /^\/v1\/bases\/probar$/,
        handler: async ({ body }) => {
          const b = await body();
          const name = stringField(b, 'nombre', { max: 41 })!;
          let conn: ReturnType<DbService['store']['get']>;
          let password: string | null;
          if (b.host) {
            const f = formInput(b);
            conn = {
              name: f.name,
              motor: f.motor,
              host: f.host,
              port: f.port,
              bases: f.bases,
              usuario: f.usuario,
              ssl: f.ssl ?? false,
              variables_nombres: [],
              version: 0,
              updated_at: '',
              tiene_clave: Boolean(f.clave),
            };
            password = f.clave ?? (svc.store.list().some((c) => c.name === name) ? svc.store.secrets(name).clave : null);
          } else {
            try {
              conn = svc.store.get(name);
              password = svc.store.secrets(name).clave;
            } catch (error) {
              fail(error);
            }
          }
          const resultados: { base: string; ok: boolean; detalle: string }[] = [];
          for (const base of conn.bases) {
            try {
              resultados.push({ base, ok: true, detalle: `conectado · ${await ping({ conn, base, password })}` });
            } catch (error) {
              resultados.push({ base, ok: false, detalle: (error as Error).message.slice(0, 300) });
            }
          }
          const ok = resultados.every((r) => r.ok);
          return { ok, resultados, mensaje: ok ? 'conexión correcta' : 'alguna base no respondió' };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/bases\/([a-z][a-z0-9-]{1,40})\/(vincular|desvincular|eliminar)$/,
        handler: async ({ params, body }) => {
          const [name, op] = [params[0]!, params[1]!];
          if (!NAME.test(name)) throw new ApiError(422, 'campo_invalido', 'nombre no válido');
          try {
            if (op === 'vincular') {
              const b = await body();
              const lectura = b.lectura === 'libre' ? 'libre' : 'preguntar';
              const link = svc.link(name, { ...(Array.isArray(b.bases) ? { bases: b.bases.map(String) } : {}), lectura: lectura as ReadPolicy, pruebas: b.pruebas === true });
              return { ok: true, vinculo: link, mensaje: `«${name}» vinculada a este proyecto` };
            }
            if (op === 'desvincular') {
              svc.unlink(name);
              return { ok: true, mensaje: `«${name}» ya no se usa en este proyecto` };
            }
            svc.store.remove(name);
            return { ok: true, mensaje: `conexión «${name}» eliminada de esta máquina` };
          } catch (error) {
            fail(error);
          }
        },
      },
      {
        method: 'GET',
        path: /^\/v1\/bases\/([a-z][a-z0-9-]{1,40})\/esquema$/,
        handler: async ({ params, query }) => {
          try {
            return { esquema: await svc.schema(params[0]!, query.get('base') ?? '', query.get('fresco') === '1') };
          } catch (error) {
            fail(error);
          }
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/bases\/solicitudes\/(bdq_[0-9A-HJKMNP-TV-Z]{26})\/(aprobar|rechazar)$/,
        handler: async ({ params, body }) => {
          const [id, op] = [params[0]!, params[1]!];
          if (!REQ.test(id)) throw new ApiError(422, 'campo_invalido', 'solicitud no válida');
          try {
            if (op === 'aprobar') {
              const r = await svc.approve(id);
              const msg = r.state === 'ejecutada' ? 'aprobada y ejecutada' : r.state === 'bloqueada' ? `bloqueada: ${r.detail}` : `falló: ${r.detail}`;
              return { ok: r.state === 'ejecutada', solicitud: r, mensaje: msg };
            }
            const r = svc.reject(id, stringField(await body(), 'motivo', { optional: true, max: 500 }) ?? `rechazada por ${who}`);
            return { ok: true, solicitud: r, mensaje: 'rechazada' };
          } catch (error) {
            fail(error);
          }
        },
      },
    ],
  };
}
