import type { Command } from 'commander';
import { publishDelivery } from '../../git/publish-delivery.js';
import { MailService, panelLink } from '../../notify/mail.js';
import { mailOnce } from '../../notify/mail-notices.js';
import { ObservationService } from '../../quality/observations.js';
import { validateSprint } from '../../quality/validate.js';
import { currentChange } from '../../run/snapshot.js';
import { buildHistory, historyMarkdown } from '../../work/history.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { openEngine } from '../engine-context.js';

const mark = { ok: '✔', fail: '✘', none: '·' } as const;

/** `forja validar`, `forja observaciones` y `forja historial` (v3/PLAN.md §5.1, §6.3). */
export function registerQualityCommands(program: Command): void {
  program
    .command('validar')
    .description('QA y auditoría del sprint entregado: compila y prueba la entrega, busca secretos y riesgos, y guarda observaciones (no corrige nada)')
    .option('--sin-sandbox', 'ejecuta los comandos del perfil sin sandbox (sólo para pruebas)')
    .action(async (opts: { sinSandbox?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const change = currentChange(ctx.engine);
        if (!change) throw new CliError('no hay ningún sprint', EXIT.precondition);
        let report: Awaited<ReturnType<typeof validateSprint>>;
        try {
          report = await validateSprint(ctx.engine, { changeId: change.change_id, repoPath: ctx.checkout.path, sandbox: !opts.sinSandbox, onLog: g.json ? () => {} : print });
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.precondition);
        }
        if (report.observaciones > 0)
          await mailOnce(
            ctx.store,
            new MailService(ctx.home),
            'observaciones',
            `validacion:${report.id}`,
            {
              asunto: `Forja · ${ctx.config.nombre}: ${report.observaciones} observación(es) para revisar`,
              texto: `Sprint: ${change.title}\nLa validación (QA y auditoría) dejó ${report.observaciones} observación(es). Revísalas y decide si se corrigen con un plan de acción.${panelLink()}`,
            },
            print,
          );
        if (g.json) return printJson({ validacion: report });
        print(`Validación de «${change.title}» sobre ${report.commit.slice(0, 10)}:`);
        for (const c of report.comprobaciones) print(`  ${c.ok === null ? mark.none : c.ok ? mark.ok : mark.fail} ${c.paso}: ${c.detalle.split('\n')[0]!.slice(0, 160)}`);
        print(`  auditor: ${'error' in report.auditor ? `✘ ${report.auditor.error}` : report.auditor.resumen}`);
        print(`  QA: ${'error' in report.qa ? `✘ ${report.qa.error}` : report.qa.resumen}`);
        print(report.observaciones ? `→ ${report.observaciones} observación(es): revísalas con forja observaciones o en el panel (Calidad).` : '→ sin observaciones nuevas.');
      } finally {
        ctx.close();
      }
    });

  program
    .command('publicar')
    .description('sube la rama de entrega del sprint a GitHub y abre su PR (nunca une ni toca la rama principal); usa el token de Ajustes → GitHub')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const change = currentChange(ctx.engine);
        if (!change) throw new CliError('no hay ningún sprint', EXIT.precondition);
        let r: Awaited<ReturnType<typeof publishDelivery>>;
        try {
          r = await publishDelivery(ctx.engine, change, { home: ctx.home, repoPath: ctx.checkout.path });
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.precondition);
        }
        if (g.json) return printJson({ publicacion: r });
        print(`✔ Rama ${r.rama} subida a ${r.repositorio}${r.pr ? `\n  PR ${r.pr.nuevo ? 'abierto' : 'ya existente'}: ${r.pr.url}` : ''}`);
        print('  Forja no une el PR ni toca la rama principal: eso lo decides tú.');
      } finally {
        ctx.close();
      }
    });

  program
    .command('observaciones')
    .description('lo que dejaron revisión, auditoría y QA, con su estado')
    .option('--todas', 'incluye resueltas y descartadas')
    .action((opts: { todas?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const list = new ObservationService(ctx.engine).list(opts.todas ? {} : { states: ['abierta', 'pospuesta', 'en_plan', 'en_correccion'] });
        if (g.json) return printJson({ observaciones: list });
        if (!list.length) return print('No hay observaciones pendientes.');
        for (const o of list)
          print(`${o.obs_id} [${o.state}] ${o.severity} · ${o.kind} · ${o.source}${o.task_id ? ` · ${o.task_id}` : ''}\n    ${o.location ? `${o.location}: ` : ''}${o.text.split('\n')[0]}`);
      } finally {
        ctx.close();
      }
    });

  program
    .command('historial')
    .description('lista de control del proyecto: épicas, sprints, historias y tareas con sus fechas')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const h = buildHistory(ctx.engine);
        if (g.json) return printJson({ historial: h });
        process.stdout.write(`${historyMarkdown(h)}\n`);
      } finally {
        ctx.close();
      }
    });
}
