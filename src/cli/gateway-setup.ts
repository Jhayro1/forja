import { ExternalMcp } from '../mcp/external.js';
import { GatewayHost } from '../mcp/gateway.js';
import { McpRegistry } from '../mcp/registry.js';
import { EngineContextProvider } from '../memory/context-requests.js';
import { forjaHome } from '../registry/home.js';
import { currentChange } from '../run/snapshot.js';
import { Vault, vaultPaths } from '../vault/vault.js';
import { actionService } from './commands/actions.js';
import type { EngineContext } from './engine-context.js';
import { vaultPassphrase } from './secret-input.js';

/**
 * Gateway for a run, only when the project authorized something (connections
 * or MCP servers) or enabled context on request (contexto.bajo_pedido). External servers start with just their authorized tools and
 * declared secrets; a server whose registration changed since it was linked,
 * or whose secrets cannot be read, is left out with a visible warning.
 */
export async function gatewayForProject(ctx: EngineContext, warn: (line: string) => void): Promise<GatewayHost | null> {
  const actions = actionService(ctx);
  const links = actions.links().filter((l) => l.active);
  const onRequest = ctx.config.contexto.bajo_pedido;
  if (!links.length && !onRequest) return null;
  const change = currentChange(ctx.engine);
  const context = onRequest && change ? new EngineContextProvider(ctx.engine, change.change_id) : undefined;
  const registry = McpRegistry.in(ctx.home);
  const externals: ExternalMcp[] = [];
  let vault: Vault | undefined;
  for (const link of links.filter((l) => l.connection.startsWith('mcp:'))) {
    const name = link.connection.slice(4);
    try {
      const def = registry.get(name);
      if (def.version !== link.version) {
        warn(`⚠ MCP «${name}» cambió desde que se vinculó (v${link.version} → v${def.version}): no se usa hasta volver a vincularlo`);
        continue;
      }
      const env: Record<string, string> = {};
      if (Object.keys(def.secrets).length) {
        if (vault === undefined) vault = Vault.open(vaultPaths(forjaHome()), await vaultPassphrase('Clave de la bóveda (servidores MCP): '), { idleMs: 60_000 });
        for (const [envName, secretName] of Object.entries(def.secrets)) env[envName] = vault.get(secretName);
      }
      externals.push(await ExternalMcp.start({ ...def, tools: def.tools.filter((t) => link.operations.includes(t)) }, env));
    } catch (error) {
      warn(`⚠ MCP «${name}» no disponible: ${(error as Error).message}`);
    }
  }
  vault?.close();
  return new GatewayHost(actions, externals, GatewayHost.baseFor(ctx.dataDir), context);
}
