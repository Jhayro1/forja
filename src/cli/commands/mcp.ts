import type { Command } from 'commander';
import { auditTrail } from '../../actions/audit.js';
import { ExternalMcp } from '../../mcp/external.js';
import { McpRegistry, McpRegistryError, mcpLinkName } from '../../mcp/registry.js';
import { forjaHome } from '../../registry/home.js';
import { Vault, vaultPaths } from '../../vault/vault.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { openEngine } from '../engine-context.js';
import { vaultPassphrase } from '../secret-input.js';
import { actionService } from './actions.js';

const collect = (value: string, previous: string[] = []) => [...previous, value];

export function registerMcpCommands(program: Command): void {
  const mcp = program.command('mcp').description('servidores MCP externos: los agentes sólo los usan a través del gateway de Forja');

  mcp
    .command('registrar <nombre>')
    .description('registra un servidor MCP YA instalado (ruta absoluta y versión fija; nada de npx -y)')
    .requiredOption('--comando <ruta>', 'ruta absoluta del ejecutable')
    .requiredOption('--version <texto>', 'versión instalada (queda en la auditoría)')
    .requiredOption('--herramientas <lista>', 'herramientas que podrán usar los agentes, separadas por coma')
    .option('--arg <valor>', 'argumento del servidor (repetible)', collect, [])
    .option('--secreto <ENV=NOMBRE>', 'variable de entorno del servidor tomada de la bóveda (repetible)', collect, [])
    .action((name: string, o: { comando: string; version: string; herramientas: string; arg: string[]; secreto: string[] }) => {
      const secrets: Record<string, string> = {};
      for (const pair of o.secreto) {
        const [env, secret] = pair.split('=');
        if (!env || !secret) throw new CliError(`--secreto espera ENV=NOMBRE (recibí «${pair}»)`);
        secrets[env] = secret;
      }
      try {
        const def = McpRegistry.in(forjaHome()).save({
          name,
          command: o.comando,
          args: o.arg,
          declared_version: o.version,
          tools: o.herramientas
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          secrets,
        });
        print(`✔ MCP «${def.name}» v${def.version} (${def.declared_version}). Vincúlalo a un proyecto con: forja mcp vincular ${def.name}`);
      } catch (error) {
        if (error instanceof McpRegistryError) throw new CliError(error.message);
        throw error;
      }
    });

  mcp
    .command('listar')
    .description('servidores registrados y su vínculo con el proyecto actual')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const all = McpRegistry.in(forjaHome()).all();
      let links: { connection: string; version: number; operations: string[]; active: boolean }[] = [];
      try {
        const ctx = openEngine(g);
        links = actionService(ctx).links();
        ctx.close();
      } catch {
        links = [];
      }
      if (g.json) return printJson({ mcp: all, vinculos: links.filter((l) => l.connection.startsWith('mcp:')) });
      if (!all.length) return print('No hay servidores MCP registrados.');
      for (const d of all) {
        const l = links.find((x) => x.connection === mcpLinkName(d.name) && x.active);
        print(
          `  ${d.name.padEnd(16)} v${d.version} ${d.declared_version}  ${d.command}  herramientas: ${d.tools.join(', ')}  · ${!l ? 'sin vincular' : l.version !== d.version ? 'cambió: vuelve a vincular' : `vinculado: ${l.operations.join(', ')}`}`,
        );
      }
    });

  mcp
    .command('vincular <nombre>')
    .description('autoriza el servidor en ESTE proyecto (todas sus herramientas registradas o un subconjunto)')
    .option('--herramientas <lista>', 'subconjunto de herramientas')
    .action((name: string, o: { herramientas?: string }, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        const def = McpRegistry.in(ctx.home).get(name);
        const tools = o.herramientas ? o.herramientas.split(',').map((t) => t.trim()) : def.tools;
        const unknown = tools.filter((t) => !def.tools.includes(t));
        if (unknown.length) throw new CliError(`no registradas para «${name}»: ${unknown.join(', ')}`);
        actionService(ctx).linkResource(mcpLinkName(name), def.version, tools);
        print(`✔ MCP «${name}» vinculado: ${tools.join(', ')}`);
      } catch (error) {
        if (error instanceof McpRegistryError) throw new CliError(error.message, EXIT.precondition);
        throw error;
      } finally {
        ctx.close();
      }
    });

  mcp
    .command('desvincular <nombre>')
    .description('retira el servidor de este proyecto')
    .action((name: string, _o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        actionService(ctx).unlink(mcpLinkName(name));
        print(`✔ MCP «${name}» desvinculado`);
      } catch (error) {
        throw new CliError((error as Error).message, EXIT.precondition);
      } finally {
        ctx.close();
      }
    });

  mcp
    .command('probar <nombre>')
    .description('arranca el servidor como lo haría el gateway y muestra las herramientas autorizadas que ofrece')
    .action(async (name: string) => {
      let def: ReturnType<McpRegistry['get']>;
      try {
        def = McpRegistry.in(forjaHome()).get(name);
      } catch (error) {
        throw new CliError((error as Error).message, EXIT.precondition);
      }
      const env: Record<string, string> = {};
      if (Object.keys(def.secrets).length) {
        const v = Vault.open(vaultPaths(forjaHome()), await vaultPassphrase());
        try {
          for (const [k, s] of Object.entries(def.secrets)) env[k] = v.get(s);
        } finally {
          v.close();
        }
      }
      try {
        const server = await ExternalMcp.start(def, env);
        const missing = def.tools.filter((t) => !server.tools.some((x) => x.name === t));
        print(`✔ «${name}» responde. Herramientas autorizadas disponibles: ${server.tools.map((t) => t.name).join(', ') || 'ninguna'}`);
        if (missing.length) print(`  ! registradas pero el servidor no las ofrece: ${missing.join(', ')}`);
        server.close();
      } catch (error) {
        throw new CliError((error as Error).message, EXIT.environment);
      }
    });

  program
    .command('auditoria')
    .description('historial de conexiones, servidores MCP y acciones externas de este proyecto')
    .option('-n, --lineas <n>', 'últimos registros', (v) => Number.parseInt(v, 10), 50)
    .action((o: { lineas: number }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const rows = auditTrail(ctx.store.db, o.lineas);
        if (g.json) return printJson({ auditoria: rows });
        if (!rows.length) return print('Sin registros de conexiones ni acciones.');
        for (const r of rows) print(`${r.cuando}  ${r.que.padEnd(22)} ${r.sobre.padEnd(32)} ${r.detalle}`);
      } finally {
        ctx.close();
      }
    });
}
