import { join } from 'node:path';
import type { Command } from 'commander';
import { ConformanceStore, SIMULATED_CONFORMANCE, cliVersion, runConformance, type ConformanceReport } from '../../providers/conformance.js';
import { FORJA_VERSION } from '../../version.js';
import { CliError, EXIT, print, printJson, type GlobalOptions } from '../context.js';
import { openEngine } from '../engine-context.js';

const ICON = { ok: '✔', fallo: '✘', desconocido: '?' } as const;

function showReport(r: ConformanceReport): void {
  print(`${r.passed ? '✔' : '✘'} ${r.provider}:${r.model} (${r.cli_version}) ${r.passed ? 'aprobado' : 'NO aprobado'}`);
  for (const c of r.checks) print(`    ${ICON[c.estado]} ${c.id.padEnd(16)} ${c.detalle}`);
}

export function registerConformanceCommands(program: Command): void {
  program
    .command('conformidad [modelos...]')
    .description('prueba modelos (proveedor:modelo) antes de habilitarlos; sin argumentos, los de los roles del proyecto')
    .option('--listar', 'muestra los resultados guardados sin probar nada')
    .action(async (models: string[], opts: { listar?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const store = ConformanceStore.in(ctx.home);
        if (opts.listar) {
          const all = store.all();
          if (g.json) return printJson({ conformidad: all });
          if (!all.length) return print('Todavía no hay resultados: ejecuta forja conformidad');
          for (const r of all) showReport(r);
          return;
        }
        const refs = models.length ? models : [...new Set(Object.values(ctx.config.roles).flat())];
        const reports: ConformanceReport[] = [];
        for (const ref of refs) {
          const [provider, model] = ref.split(':') as [string, string | undefined];
          if (!model || !['claude', 'codex', 'simulado'].includes(provider)) throw new CliError(`«${ref}» no tiene el formato proveedor:modelo`);
          const version = await cliVersion(provider, FORJA_VERSION);
          if (!version) {
            print(`! ${ref}: el CLI de ${provider} no está instalado; se omite`);
            continue;
          }
          if (!g.json) print(`… probando ${ref} (${version}); con modelos reales consume un poco de cuota`);
          const report = await runConformance({
            adapter: ctx.engine.adapters[provider as 'claude' | 'codex' | 'simulado'],
            model,
            cliVersion: version,
            dir: join(ctx.dataDir, 'conformidad', `${provider}-${model}-${Date.now()}`),
            ...(ctx.engine.runnerScript ? { runnerScript: ctx.engine.runnerScript } : {}),
            ...(provider === 'simulado' ? { simulation: SIMULATED_CONFORMANCE } : {}),
          });
          store.record(report);
          reports.push(report);
          if (!g.json) showReport(report);
        }
        if (g.json) printJson({ conformidad: reports });
        if (reports.some((r) => !r.passed)) process.exitCode = EXIT.verification;
      } finally {
        ctx.close();
      }
    });
}
