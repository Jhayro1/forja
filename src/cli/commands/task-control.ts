import type { Command } from 'commander';
import { activePauses, allowedModels, resumeProvider } from '../../core/engine.js';
import { reassignTask, requestPause, resumeTask } from '../../run/orchestrator.js';
import { runningOrchestrator } from '../../run/process.js';
import { applyTaskControls } from '../../run/task-control.js';
import { CliError, EXIT, print, printJson, type GlobalOptions } from '../context.js';
import { openEngine } from '../engine-context.js';
import { domainError, snapshotOrFail, taskOrFail } from '../run-selection.js';

const hint = (running: boolean) => (running ? '  El run en curso lo aplica solo.' : '  Retoma la ejecución con: forja run');

/** Per-task control (v2/10): pausar, reanudar, reasignar; and provider pauses. */
export function registerTaskControlCommands(program: Command): void {
  program
    .command('pausar <tarea>')
    .description('pausa una tarea: si hay un agente trabajando se detiene y su trabajo parcial se conserva')
    .action((id: string, _o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        const s = snapshotOrFail(ctx);
        const task = taskOrFail(s, id);
        const running = runningOrchestrator(ctx.dataDir) !== null;
        let r;
        try {
          r = requestPause(ctx.engine, s.run!.run_id, task.id);
          // Nobody runs the run: apply the request here (stops the agent if there is one).
          if (!r.immediate && !running) applyTaskControls(ctx.engine, s.run!.run_id, new Set());
        } catch (error) {
          throw domainError(error);
        }
        print(r.immediate || !running ? `⏸ ${task.id} pausada.` : `⏸ Se pidió pausar ${task.id}: el run la detiene en cuanto sea seguro.`);
        print('  Reanúdala con: forja reanudar ' + task.id);
      } finally {
        ctx.close();
      }
    });

  program
    .command('reanudar <tarea>')
    .description('reanuda una tarea pausada donde quedó (un candidato ya verificado se vuelve a verificar)')
    .action((id: string, _o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        const s = snapshotOrFail(ctx);
        const task = taskOrFail(s, id);
        let to;
        try {
          to = resumeTask(ctx.engine, s.run!.run_id, task.id);
        } catch (error) {
          throw domainError(error);
        }
        print(`▶ ${task.id} reanudada (${to}).`);
        print(hint(runningOrchestrator(ctx.dataDir) !== null));
      } finally {
        ctx.close();
      }
    });

  program
    .command('reasignar <tarea> [modelo]')
    .description('fija el modelo de una tarea desde su próximo intento (proveedor:modelo de los roles de forja.yaml)')
    .option('--quitar', 'vuelve al orden de modelos de su rol')
    .action((id: string, model: string | undefined, o: { quitar?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const s = snapshotOrFail(ctx);
        const task = taskOrFail(s, id);
        if (!o.quitar && !model) throw new CliError(`indica el modelo (uno de: ${allowedModels(ctx.engine).join(', ')}) o usa --quitar`, EXIT.input);
        try {
          reassignTask(ctx.engine, s.run!.run_id, task.id, o.quitar ? null : model!);
        } catch (error) {
          throw domainError(error);
        }
        if (g.json) return printJson({ tarea: task.id, modelo: o.quitar ? null : model });
        print(o.quitar ? `✔ ${task.id} vuelve al orden de su rol.` : `✔ ${task.id} usará ${model} desde su próximo intento.`);
        if (task.state === 'ejecutando') print('  El intento en curso sigue con su modelo; pausa y reanuda la tarea para cambiarlo ya.');
      } finally {
        ctx.close();
      }
    });

  const prov = program.command('proveedores').description('pausas de proveedores por cuota o sesión (visibles desde cualquier proceso)');
  prov
    .command('estado', { isDefault: true })
    .description('muestra qué proveedores están en pausa y hasta cuándo')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const pauses = activePauses(ctx.engine);
        if (g.json) return printJson({ pausas: pauses.map((p) => ({ ...p, until: new Date(p.until).toISOString() })) });
        if (!pauses.length) return print('Ningún proveedor en pausa.');
        for (const p of pauses) print(`⏸ ${p.key} hasta ${new Date(p.until).toLocaleTimeString()} · ${p.reason}`);
        print('Si ya renovaste la sesión o la cuota: forja proveedores reanudar <proveedor>');
      } finally {
        ctx.close();
      }
    });
  prov
    .command('reanudar <proveedor>')
    .description('levanta la pausa de un proveedor antes de tiempo')
    .action((key: string, _o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        if (!resumeProvider(ctx.engine, key)) throw new CliError(`${key} no está en pausa`, EXIT.precondition);
        print(`▶ ${key} disponible de nuevo.`);
      } finally {
        ctx.close();
      }
    });
}
