import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createEngine } from '../../core/engine.js';
import { engineExecutor, loadCorpus, runCorpus, schedule } from '../../pilot/corpus.js';
import { allRunMetrics } from '../../pilot/metrics.js';
import { MIN_TASKS_FOR_ROUTING, pilotReport, renderPilotMarkdown, routingRecommendation } from '../../pilot/report.js';
import { readConfig, writeConfig } from '../../registry/config.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { openEngine } from '../engine-context.js';
import { confirm } from '../secret-input.js';

export function registerPilotCommands(program: Command): void {
  const piloto = program
    .command('piloto')
    .description('mide los runs del proyecto (tiempo, calidad, reintentos, costo) y recomienda N por defecto')
    .option('--aplicar', 'escribe el N recomendado en forja.yaml (invalida la aprobación del plan vigente)')
    .option('--aplicar-roles', 'reordena los modelos de trabajo según su calidad medida (pide confirmación)')
    .option('--si', 'con --aplicar-roles: no pregunta (para scripts)')
    .action(async (opts: { aplicar?: boolean; aplicarRoles?: boolean; si?: boolean }, cmd: Command) => {
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
        const routing = routingRecommendation(report, ctx.config.roles);
        let rolesApplied = false;
        if (opts.aplicarRoles) {
          if (!routing.length)
            throw new CliError(`no hay cambios de enrutamiento que aplicar (hacen falta ${MIN_TASKS_FOR_ROUTING}+ tareas integradas por modelo y una diferencia clara de calidad)`, EXIT.precondition);
          if (!g.json) for (const r of routing) print(`${r.rol}: ${r.actual.join(', ')}  →  ${r.propuesto.join(', ')}\n  ${r.motivo}`);
          if (opts.si || (await confirm('¿Aplicar este orden de modelos en forja.yaml?'))) {
            const cfg = readConfig(ctx.checkout.path);
            const roles = { ...cfg.roles };
            for (const r of routing) roles[r.rol] = r.propuesto;
            writeConfig(ctx.checkout.path, { ...cfg, roles });
            rolesApplied = true;
          }
        }
        if (g.json) return printJson({ piloto: report, metricas: metrics, aplicado: applied, enrutamiento: routing, roles_aplicados: rolesApplied });
        print(renderPilotMarkdown(report).trimEnd());
        print();
        print(`Guardado en ${join(dir, 'informe.md')} (y las métricas por run en metricas.json).`);
        if (applied) print(`✔ ejecucion.paralelo = ${report.recomendacion.paralelo} en forja.yaml. Vuelve a aprobar el plan antes del próximo run.`);
        if (rolesApplied) print('✔ roles actualizados en forja.yaml. Si algún modelo no tiene conformidad, forja run lo ofrecerá probar.');
        else if (routing.length && !opts.aplicarRoles) {
          print('\nEnrutamiento sugerido (aplícalo con forja piloto --aplicar-roles):');
          for (const r of routing) print(`  ${r.rol}: ${r.propuesto.join(', ')} — ${r.motivo}`);
        }
      } finally {
        ctx.close();
      }
    });

  piloto
    .command('correr')
    .description('ejecuta un corpus fijo (repos, commits, spec y plan) con cada N y repeticiones, sin intervención')
    .requiredOption('--corpus <archivo>', 'corpus.yaml: repeticiones, paralelo: [2,3,4], cambios: [{ id, repo, sha, spec, plan }]')
    .option('--salida <carpeta>', 'dónde guardar clones, métricas e informe (por defecto .forja/piloto/corpus-<fecha>)')
    .option('--sin-revisor', 'omite el revisor independiente en todos los runs')
    .action(async (o: { corpus: string; salida?: string; sinRevisor?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        let loaded: ReturnType<typeof loadCorpus>;
        try {
          loaded = loadCorpus(o.corpus);
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.input);
        }
        const { corpus, dir: corpusDir } = loaded;
        const out = o.salida ?? join(ctx.checkout.path, '.forja', 'piloto', `corpus-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
        const total = schedule(corpus).length;
        if (!g.json)
          print(`Corpus: ${corpus.cambios.length} cambio(s) × N=${corpus.paralelo.join('/')} × ${corpus.repeticiones} repeticiones = ${total} runs. Consume cuota real con los modelos de forja.yaml.`);
        const results = await runCorpus(corpus, {
          workDir: join(out, 'runs'),
          execute: engineExecutor({
            corpusDir,
            review: !o.sinRevisor,
            sandbox: true,
            // Same models, prices and scripted agents (FORJA_SIMULACION) as this project.
            makeEngine: (store, dataDir) =>
              createEngine({ store, dataDir, config: ctx.config, prices: ctx.engine.prices ?? null, ...(ctx.engine.simulation ? { simulation: ctx.engine.simulation } : {}) }),
          }),
          onJob: (r, i, n) => {
            if (g.json) return;
            const m = r.metrics;
            print(
              `[${i + 1}/${n}] ${r.job.cambio.id} N=${r.job.paralelo} rep ${r.job.repeticion}: ${r.error ? `✘ ${r.error}` : `${m!.aceptado ? '✔' : '■'} ${m!.estado} · ${m!.integradas}/${m!.tareas} · ${m!.minutos_activos ?? '?'} min`}`,
            );
          },
        });
        const metrics = results.flatMap((r) => (r.metrics ? [r.metrics] : []));
        const report = pilotReport(metrics);
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'informe.md'), renderPilotMarkdown(report));
        writeFileSync(join(out, 'resultados.json'), `${JSON.stringify(results, null, 2)}\n`);
        if (g.json) return printJson({ piloto: report, resultados: results });
        print();
        print(renderPilotMarkdown(report).trimEnd());
        print(`\nGuardado en ${out} (informe.md y resultados.json).`);
        if (results.some((r) => r.error)) process.exitCode = EXIT.environment;
      } finally {
        ctx.close();
      }
    });
}
