import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionService } from '../actions/protocol.js';
import { MCP_SOCKET_NAME } from '../providers/adapters.js';
import { FORJA_VERSION } from '../version.js';
import type { ExternalMcp, McpTool, ToolResult } from './external.js';
import { MCP_PROTOCOL } from './external.js';
import { RPC, RpcError, serveRpc } from './jsonrpc.js';

/**
 * MCP gateway (V2-052). What an agent can reach through MCP, and nothing else:
 *  - propose typed actions (never execute: a human approves the exact preview),
 *  - see its proposals and the connections linked to the project (no secrets),
 *  - call the tools the user authorized on registered external servers.
 * The agent gets no secrets and no extra built-in tools.
 */

const MAX_ARGS_BYTES = 64 * 1024;

const OWN_TOOLS: McpTool[] = [
  {
    name: 'listar_conexiones',
    description: 'Conexiones externas vinculadas a este proyecto y las operaciones permitidas en cada una.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'proponer_accion',
    description: 'Propone una operación externa tipada. NO se ejecuta: queda pendiente de aprobación humana con su vista previa. Úsala cuando la tarea necesite un efecto fuera del repositorio.',
    inputSchema: {
      type: 'object',
      properties: {
        conexion: { type: 'string' },
        operacion: { type: 'string', description: 'p. ej. http.json' },
        parametros: { type: 'object', description: 'para http.json: { ruta, metodo?, cuerpo?, precondicion? }' },
        motivo: { type: 'string', description: 'por qué la tarea la necesita' },
      },
      required: ['conexion', 'operacion', 'parametros', 'motivo'],
      additionalProperties: false,
    },
  },
  {
    name: 'estado_accion',
    description: 'Estado de una acción que propusiste (propuesta, aprobada, confirmada, rechazada…).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
];

export type GatewayContext = { origin: string; actions: ActionService; externals: ExternalMcp[] };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

export function gatewayHandler(ctx: GatewayContext): (method: string, params: unknown) => Promise<unknown> {
  const external = (name: string): { server: ExternalMcp; tool: string } | null => {
    const [server, tool] = name.split('__');
    const s = ctx.externals.find((e) => e.def.name === server);
    return s && tool && s.tools.some((t) => t.name === tool) ? { server: s, tool } : null;
  };

  return async (method, params) => {
    switch (method) {
      case 'initialize':
        return { protocolVersion: MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'forja', version: FORJA_VERSION } };
      case 'notifications/initialized':
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: [
            ...OWN_TOOLS,
            ...ctx.externals.flatMap((e) => e.tools.map((t) => ({ ...t, name: `${e.def.name}__${t.name}`, description: `[${e.def.name} ${e.def.declared_version}] ${t.description ?? ''}`.trim() }))),
          ],
        };
      case 'tools/call': {
        const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof p.name !== 'string') throw new RpcError(RPC.params, 'falta el nombre de la herramienta');
        if (Buffer.byteLength(JSON.stringify(p.arguments ?? {})) > MAX_ARGS_BYTES) return text('argumentos demasiado grandes', true);
        const args = (p.arguments ?? {}) as Record<string, unknown>;
        try {
          switch (p.name) {
            case 'listar_conexiones':
              return text(
                JSON.stringify(
                  ctx.actions
                    .links()
                    .filter((l) => l.active && !l.connection.startsWith('mcp:'))
                    .map((l) => ({ conexion: l.connection, operaciones: l.operations })),
                ),
              );
            case 'proponer_accion': {
              const a = ctx.actions.propose({
                type: String(args.operacion),
                connection: String(args.conexion),
                params: args.parametros,
                origin: `${ctx.origin} · ${String(args.motivo ?? '').slice(0, 200)}`,
              });
              return text(
                JSON.stringify({ id: a.action_id, estado: 'pendiente de aprobación humana', vista_previa: a.preview, nota: 'No se ejecutó nada. Sigue con tu tarea sin depender de su resultado.' }),
              );
            }
            case 'estado_accion': {
              const a = ctx.actions.get(String(args.id));
              // Agents only see their own proposals.
              if (!a.origin.startsWith(ctx.origin)) return text('no existe esa acción', true);
              return text(JSON.stringify({ id: a.action_id, estado: a.view_state, detalle: a.result?.detail ?? null }));
            }
            default: {
              const target = external(p.name);
              if (!target) return text(`herramienta desconocida o no autorizada: ${p.name}`, true);
              return await target.server.call(target.tool, args);
            }
          }
        } catch (error) {
          return text((error as Error).message, true);
        }
      }
      default:
        throw new RpcError(RPC.method, `método no soportado: ${method}`);
    }
  };
}

/**
 * Hosts the gateway for a run: one unix socket PER LAUNCH, so the origin of a
 * call («agente T-003») comes from the socket, not from anything the agent says.
 */
export class GatewayHost {
  private readonly dir: string;
  private readonly servers = new Map<string, Server>();

  /**
   * `baseDir`: where each launch gets its own folder with `p.sock`. A stable
   * base (derived from the checkout) lets a restarted `forja run` recreate the
   * socket of an agent that kept working, at the path its sandbox mounted.
   */
  constructor(
    private readonly actions: ActionService,
    readonly externals: ExternalMcp[] = [],
    baseDir?: string,
  ) {
    // Short path: unix socket paths are limited to ~107 bytes.
    this.dir = baseDir ?? mkdtempSync(join(tmpdir(), 'fmcp-'));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Stable short base folder for a checkout's data directory. */
  static baseFor(dataDir: string): string {
    return join(tmpdir(), `fmcp-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`);
  }

  /** Socket for one launch (`key`: its launch id), recreated at the same path if it already existed. */
  async socketFor(origin: string, key: string): Promise<string> {
    const folder = join(this.dir, createHash('sha256').update(key).digest('hex').slice(0, 12));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, MCP_SOCKET_NAME);
    this.servers.get(path)?.close();
    rmSync(path, { force: true });
    const server = createServer((socket) => serveRpc(socket, socket, gatewayHandler({ origin, actions: this.actions, externals: this.externals })));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
    this.servers.set(path, server);
    return path;
  }

  release(path: string): void {
    this.servers.get(path)?.close();
    this.servers.delete(path);
  }

  close(): void {
    for (const s of this.servers.values()) s.close();
    this.servers.clear();
    for (const e of this.externals) e.close();
  }
}
