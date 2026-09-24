import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { connectionsModule } from '../../api/modules/connections.js';
import { memoryModule } from '../../api/modules/memory.js';
import { runsModule } from '../../api/modules/runs.js';
import { ApiServer, type ApiModule } from '../../api/server.js';
import { CliError, print, type GlobalOptions } from '../context.js';
import { EngineConnectionsBackend, EngineEventFeed, EngineMemoryBackend, EngineRunsBackend } from '../engine-backend.js';
import { openEngine, type EngineContext } from '../engine-context.js';

/**
 * Modules the panel offers for a project. Each milestone adds its own module
 * here (connections in M5, memory in M6) without touching the server.
 */
export type ModuleFactory = (ctx: EngineContext) => ApiModule;
export const PANEL_MODULES: ModuleFactory[] = [(ctx) => runsModule(new EngineRunsBackend(ctx)), (ctx) => connectionsModule(new EngineConnectionsBackend(ctx)), (ctx) => memoryModule(new EngineMemoryBackend(ctx))];

export function registerUiCommands(program: Command): void {
  program
    .command('ui')
    .description('abre el panel web local (sólo en esta máquina: 127.0.0.1)')
    .option('--puerto <n>', 'puerto (por defecto, uno libre)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { puerto?: number }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      if (opts.puerto !== undefined && (!Number.isInteger(opts.puerto) || opts.puerto < 1 || opts.puerto > 65535)) throw new CliError('--puerto debe estar entre 1 y 65535');
      const ctx = openEngine(g);
      const server = new ApiServer({ modules: PANEL_MODULES.map((f) => f(ctx)), feed: new EngineEventFeed(ctx), ...(opts.puerto ? { port: opts.puerto } : {}) });
      try {
        const { url } = await server.listen();
        const link = () => `${url}/#codigo=${server.sessions.issueCode()}`;
        print(`Panel de «${ctx.config.nombre}» en ${url}`);
        print(`Abre este enlace (sirve una sola vez y vence en 5 minutos):`);
        print(`  ${link()}`);
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
        await server.close();
        ctx.close();
      }
    });
}
