import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

/**
 * External MCP servers registered by the user (~/.forja/mcp.json). Origin and
 * version are pinned: the command is an absolute path installed in a separate
 * step, never `npx -y` from a definition received from somewhere (v2/06).
 */
export const McpServerDef = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    command: z.string(),
    args: z.array(z.string()).default([]),
    /** Declared version of the installed server (shown in audits; changing it is a new registration). */
    declared_version: z.string().min(1),
    /** Only these tools are ever exposed to agents. */
    tools: z.array(z.string().min(1)).min(1),
    /** ENV variable → vault secret name, injected only into this server's process. */
    secrets: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()).default({}),
    max_response_bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .default(64 * 1024),
    timeout_ms: z.number().int().positive().max(300_000).default(30_000),
    version: z.number().int().positive(),
    updated_at: z.string(),
  })
  .strict();
export type McpServerDef = z.infer<typeof McpServerDef>;

export class McpRegistryError extends Error {}

const AUTO_INSTALLERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'pipx']);

export class McpRegistry {
  constructor(readonly path: string) {}

  static in(home: string): McpRegistry {
    return new McpRegistry(join(home, 'mcp.json'));
  }

  all(): McpServerDef[] {
    if (!existsSync(this.path)) return [];
    return z.array(McpServerDef).parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  get(name: string): McpServerDef {
    const d = this.all().find((x) => x.name === name);
    if (!d) throw new McpRegistryError(`no hay un servidor MCP «${name}» registrado`);
    return d;
  }

  save(input: Omit<McpServerDef, 'version' | 'updated_at' | 'max_response_bytes' | 'timeout_ms'> & Partial<Pick<McpServerDef, 'max_response_bytes' | 'timeout_ms'>>): McpServerDef {
    if (!isAbsolute(input.command)) throw new McpRegistryError('el comando debe ser una ruta absoluta a un programa ya instalado');
    if (AUTO_INSTALLERS.has(basename(input.command)) || input.args.some((a) => a === '-y' || a === '--yes')) {
      throw new McpRegistryError('no se registran instaladores automáticos (npx -y y similares): instala el servidor con una versión fija y registra su ejecutable');
    }
    if (!existsSync(input.command) || !(statSync(input.command).mode & 0o111)) throw new McpRegistryError(`${input.command} no existe o no es ejecutable`);
    const previous = this.all().find((d) => d.name === input.name);
    const next = McpServerDef.parse({ ...input, version: (previous?.version ?? 0) + 1, updated_at: new Date().toISOString() });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify([...this.all().filter((d) => d.name !== input.name), next], null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    return next;
  }
}

/** Link names for MCP servers share the connection-link table: `mcp:<name>`. */
export const mcpLinkName = (name: string) => `mcp:${name}`;
