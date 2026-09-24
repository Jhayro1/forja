import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { allRunMetrics } from '../../pilot/metrics.js';
import { pilotReport, renderPilotMarkdown } from '../../pilot/report.js';
import { writeConfig } from '../../registry/config.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { openEngine } from '../engine-context.js';

export function registerPilotCommands(program: Command): void {
  program
    .command('piloto')
    .description('mide los runs del proyecto (tiempo, calidad, reintentos, costo) y recomienda N por defecto')
    .option('--aplicar', 'escribe el N recomendado en forja.yaml (invalida la aprobación del plan vigente)')
    .action(async (opts: { aplicar?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const metrics = allRunMetrics(ctx.engine);
        if (!metrics.length) throw new CliError('todavía no hay runs que medir: ejecuta forja run', EXIT.precondition);
        const report = pilotReport(metrics);
        const dir = join(ctx.checkout.path, '.forja', 'piloto');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'informe.md'), renderPilotMarkdown(report));
        writeFileSync(join(dir, 'metricas.json'), `${JSON.stringify(metrics, null, 2)}\n`);
        let applied = false;
        if (opts.aplicar) {
          if (report.recomendacion.paralelo === null) throw new CliError(`no hay recomendación que aplicar: ${report.recomendacion.motivo}`, EXIT.precondition);
          writeConfig(ctx.checkout.path, { ...ctx.config, ejecucion: { ...ctx.config.ejecucion, paralelo: report.recomendacion.paralelo } });
          applied = true;
        }
        if (g.json) return printJson({ piloto: report, metricas: metrics, aplicado: applied });
        print(renderPilotMarkdown(report).trimEnd());
        print();
        print(`Guardado en ${join(dir, 'informe.md')} (y las métricas por run en metricas.json).`);
        if (applied) print(`✔ ejecucion.paralelo = ${report.recomendacion.paralelo} en forja.yaml. Vuelve a aprobar el plan antes del próximo run.`);
      } finally {
        ctx.close();
      }
    });
}
