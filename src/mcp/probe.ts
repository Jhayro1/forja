import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORJA_VERSION } from '../version.js';
import { MCP_PROTOCOL } from './external.js';
import { RPC, RpcError, serveRpc } from './jsonrpc.js';

export const PROBE_TOOL = 'eco_conformidad';

/**
 * Minimal «forja» MCP server for conformance (MEJORAS 4.1): one tool that
 * returns a random token. If a provider CLI reaches it through the sandbox
 * bridge and reports the token, the gateway works with that CLI and model.
 */
export class McpProbe {
  readonly token = `eco-${randomBytes(6).toString('hex')}`;
  readonly calls: string[] = [];
  private constructor(
    readonly socket: string,
    private readonly dir: string,
    private readonly server: Server,
  ) {}

  static async start(): Promise<McpProbe> {
    const dir = mkdtempSync(join(tmpdir(), 'fmcp-probe-'));
    const socket = join(dir, 'p.sock');
    let probe: McpProbe | null = null;
    const server = createServer((s) =>
      serveRpc(s, s, async (method, params) => {
        switch (method) {
          case 'initialize':
            return { protocolVersion: MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'forja', version: FORJA_VERSION } };
          case 'notifications/initialized':
          case 'ping':
            return {};
          case 'tools/list':
            return { tools: [{ name: PROBE_TOOL, description: 'Prueba de conformidad de Forja: devuelve un código.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
          case 'tools/call': {
            const name = String((params as { name?: unknown } | undefined)?.name ?? '');
            probe!.calls.push(name);
            if (name !== PROBE_TOOL) return { content: [{ type: 'text', text: 'herramienta desconocida' }], isError: true };
            return { content: [{ type: 'text', text: probe!.token }] };
          }
          default:
            throw new RpcError(RPC.method, `método no soportado: ${method}`);
        }
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => resolve());
    });
    probe = new McpProbe(socket, dir, server);
    return probe;
  }

  close(): void {
    this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
