import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor } from '../security/redact.js';
import { FORJA_VERSION } from '../version.js';
import { RpcClient } from './jsonrpc.js';
import type { McpServerDef } from './registry.js';

export type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export const MCP_PROTOCOL = '2025-06-18';

/**
 * Client of one registered external MCP server, run by the gateway host
 * (outside the agents' sandbox). Its environment has only PATH and the
 * secrets declared for it; its answers are size-limited and redacted.
 */
export class ExternalMcp {
  private constructor(
    readonly def: McpServerDef,
    private readonly child: ChildProcess,
    private readonly client: RpcClient,
    private readonly redactor: Redactor,
    private readonly cwd: string,
    readonly tools: McpTool[],
  ) {}

  static async start(def: McpServerDef, secrets: Record<string, string>): Promise<ExternalMcp> {
    const cwd = mkdtempSync(join(tmpdir(), `forja-mcp-${def.name}-`));
    const child = spawn(def.command, def.args, { cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...secrets }, stdio: ['pipe', 'pipe', 'ignore'] });
    const client = new RpcClient(child.stdout!, child.stdin!, def.timeout_ms);
    const redactor = new Redactor();
    for (const [name, value] of Object.entries(secrets)) redactor.add({ name, value });
    try {
      await client.request('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'forja-gateway', version: FORJA_VERSION } });
      client.notify('notifications/initialized');
      const listed = (await client.request('tools/list')) as { tools?: McpTool[] };
      // Only what the user authorized, and only if the server really offers it.
      const tools = (listed.tools ?? []).filter((t) => def.tools.includes(t.name));
      return new ExternalMcp(def, child, client, redactor, cwd, tools);
    } catch (error) {
      child.kill('SIGKILL');
      rmSync(cwd, { recursive: true, force: true });
      throw new Error(`el servidor MCP «${def.name}» no arrancó: ${(error as Error).message}`);
    }
  }

  async call(tool: string, args: unknown): Promise<ToolResult> {
    if (!this.tools.some((t) => t.name === tool)) return { content: [{ type: 'text', text: `herramienta no autorizada: ${tool}` }], isError: true };
    const r = (await this.client.request('tools/call', { name: tool, arguments: args ?? {} })) as ToolResult;
    let text = JSON.stringify(r?.content ?? []);
    let truncated = false;
    if (Buffer.byteLength(text) > this.def.max_response_bytes) {
      text = text.slice(0, this.def.max_response_bytes);
      truncated = true;
    }
    const safe = this.redactor.redact(
      truncated
        ? text
        : (r?.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
    );
    return { content: [{ type: 'text', text: truncated ? `${safe}\n… [respuesta recortada a ${this.def.max_response_bytes} bytes]` : safe }], ...(r?.isError ? { isError: true } : {}) };
  }

  close(): void {
    this.client.close();
    this.child.kill('SIGTERM');
    rmSync(this.cwd, { recursive: true, force: true });
  }
}
