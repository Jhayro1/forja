import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { SqliteIdempotencyStore } from '../../api/idempotency.js';
import { connectionsModule } from '../../api/modules/connections.js';
import { memoryModule } from '../../api/modules/memory.js';
import { planningModule } from '../../api/modules/planning.js';
import { runsModule } from '../../api/modules/runs.js';
import { type ApiModule, ApiServer } from '../../api/server.js';
import { forjaHome } from '../../registry/home.js';
import { Vault, vaultPaths } from '../../vault/vault.js';
import { CliError, EXIT, type GlobalOptions, print } from '../context.js';
import { EngineConnectionsBackend, EngineEventFeed, EngineMemoryBackend, EnginePlanningBackend, EngineRunsBackend } from '../engine-backend.js';
import { type EngineContext, openEngine } from '../engine-context.js';
import { vaultPassphrase } from '../secret-input.js';

/**
 * Modules the panel offers for a project. Each milestone adds its own module
 * here (connections in M5, memory in M6) without touching the server.
 */
export type PanelResources = { vault: Vault | null };
export type ModuleFactory = (ctx: EngineContext, res: PanelResources) => ApiModule;
export const PANEL_MODULES: ModuleFactory[] = [
  (ctx) => runsModule(new EngineRunsBackend(ctx)),
  (ctx, res) => connectionsModule(new EngineConnectionsBackend(ctx, res.vault)),
  (ctx) => memoryModule(new EngineMemoryBackend(ctx)),
  (ctx) => planningModule(new EnginePlanningBackend(ctx)),
];

export function registerUiCommands(program: Command): void {
  program
    .command('ui')
    .description('abre el panel web local (sólo en esta máquina: 127.0.0.1)')
    .option('--puerto <n>', 'puerto (por defecto, uno libre)', (v) => Number.parseInt(v, 10))
    .option('--boveda', 'abre la bóveda para ejecutar acciones aprobadas desde el panel (se cierra sola por inactividad)')
    .option('--boveda-minutos <n>', 'minutos sin uso tras los que se cierra la bóveda', (v) => Number.parseInt(v, 10), 15)
    .action(async (opts: { puerto?: number; boveda?: boolean; bovedaMinutos: number }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      if (opts.puerto !== undefined && (!Number.isInteger(opts.puerto) || opts.puerto < 1 || opts.puerto > 65535)) throw new CliError('--puerto debe estar entre 1 y 65535');
      if (!Number.isInteger(opts.bovedaMinutos) || opts.bovedaMinutos < 1 || opts.bovedaMinutos > 240) throw new CliError('--boveda-minutos debe estar entre 1 y 240');
      let vault: Vault | null = null;
      if (opts.boveda) {
        try {
          vault = Vault.open(vaultPaths(forjaHome()), await vaultPassphrase(), { idleMs: opts.bovedaMinutos * 60_000 });
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.precondition);
        }
      }
      const ctx = openEngine(g);
      const server = new ApiServer({
        modules: PANEL_MODULES.map((f) => f(ctx, { vault })),
        feed: new EngineEventFeed(ctx),
        idempotency: new SqliteIdempotencyStore(ctx.store.db),
        ...(opts.puerto ? { port: opts.puerto } : {}),
      });
      try {
        const { url } = await server.listen();
        const link = () => `${url}/#codigo=${server.sessions.issueCode()}`;
        print(`Panel de «${ctx.config.nombre}» en ${url}`);
        print(`Abre este enlace (sirve una sola vez y vence en 5 minutos):`);
        print(`  ${link()}`);
        if (vault) print(`Bóveda abierta para ejecutar acciones aprobadas; se cierra tras ${opts.bovedaMinutos} min sin uso.`);
        print('Enter = enlace nuevo · Ctrl-C = cerrar el panel (los runs en curso no se detienen)');
        const rl = createInterface({ input: process.stdin, terminal: false });
        rl.on('line', () => print(`  ${link()}`));
        await new Promise<void>((resolve) => {
          process.once('SIGINT', resolve);
          process.once('SIGTERM', resolve);
        });
        rl.close();
        print('\nPanel cerrado.');
      } finally {
        vault?.close();
        await server.close();
        ctx.close();
      }
    });
}
