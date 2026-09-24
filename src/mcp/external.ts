import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Redactor } from '../security/redact.js';
import { FORJA_VERSION } from '../version.js';
import { RpcClient } from './jsonrpc.js';
import type { McpServerDef } from './registry.js';

export type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> };
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: unknown };

type OutputCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validates `structuredContent` against the tool's declared `outputSchema`
 * (MEJORAS 4.10). Nothing unvalidated reaches the agent as structured data:
 * a missing or non-conforming answer becomes an error result.
 */
export function outputValidator(schema: Record<string, unknown> | undefined): (value: unknown) => OutputCheck {
  if (!schema) return () => ({ ok: true });
  let parser: z.ZodType;
  try {
    parser = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    const reason = `el outputSchema declarado no se puede usar: ${(error as Error).message.slice(0, 200)}`;
    return () => ({ ok: false, reason });
  }
  return (value) => {
    if (value === undefined) return { ok: false, reason: 'la herramienta declara outputSchema pero no devolvió structuredContent' };
    const r = parser.safeParse(value);
    return r.success
      ? { ok: true }
      : {
          ok: false,
          reason: r.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
            .join('; '),
        };
  };
}

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

  private readonly validators = new Map<string, ReturnType<typeof outputValidator>>();

  async call(tool: string, args: unknown): Promise<ToolResult> {
    const def = this.tools.find((t) => t.name === tool);
    if (!def) return { content: [{ type: 'text', text: `herramienta no autorizada: ${tool}` }], isError: true };
    const r = (await this.client.request('tools/call', { name: tool, arguments: args ?? {} })) as ToolResult;
    let structured: unknown;
    if (def.outputSchema && !r?.isError) {
      if (!this.validators.has(tool)) this.validators.set(tool, outputValidator(def.outputSchema));
      const check = this.validators.get(tool)!(r?.structuredContent);
      if (!check.ok) return { content: [{ type: 'text', text: `la respuesta de ${this.def.name}__${tool} no cumple su outputSchema: ${check.reason}` }], isError: true };
      const json = this.redactor.redact(JSON.stringify(r.structuredContent));
      if (Buffer.byteLength(json) <= this.def.max_response_bytes) structured = JSON.parse(json) as unknown;
    }
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
    return {
      content: [{ type: 'text', text: truncated ? `${safe}\n… [respuesta recortada a ${this.def.max_response_bytes} bytes]` : safe }],
      ...(r?.isError ? { isError: true } : {}),
      ...(structured !== undefined ? { structuredContent: structured } : {}),
    };
  }

  close(): void {
    this.client.close();
    this.child.kill('SIGTERM');
    rmSync(this.cwd, { recursive: true, force: true });
  }
}
