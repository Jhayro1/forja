import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { latestPlan } from '../../plan/divide.js';
import { estimatePlan, loadPrices } from '../../plan/estimate.js';
import { activeChange, getChange } from '../../planner/session.js';
import { LockHeldError, type LockFile } from '../../registry/lock.js';
import { readSpool } from '../../runtime/launcher.js';
import { readableLog } from '../../run/activity.js';
import { STATE_ICON, STATE_LABEL, modelOf, progressLine, taskActivityLine, taskDetailLines } from '../../run/describe.js';
import { Orchestrator, RunError, answerTaskQuestion, getExec, startOrResumeRun, unblockTask, type RunSummary } from '../../run/orchestrator.js';
import { RUN_PURPOSE, acquireOrchestratorLock, requestStop, runningOrchestrator } from '../../run/process.js';
import { RunLog } from '../../run/run-log.js';
import { compactTokens, currentChange, runSnapshot, type RunSnapshot, type TaskView } from '../../run/snapshot.js';
import { runBoard } from '../../tui/app.js';
import { EngineBoardSource, taskLogLines } from '../board-source.js';
import { CliError, EXIT, print, printJson, type GlobalOptions } from '../context.js';
import { openEngine, type EngineContext } from '../engine-context.js';
import { showPlan } from '../plan-view.js';

function snapshotOrFail(ctx: EngineContext): RunSnapshot {
  const change = currentChange(ctx.engine);
  if (!change) throw new CliError('no hay cambios todavía: empieza con forja planear', EXIT.precondition);
  return runSnapshot(ctx.engine, change);
}

function taskOrFail(s: RunSnapshot, id: string): TaskView {
  if (!s.run) throw new CliError('el cambio todavía no tiene un run: ejecuta forja run', EXIT.precondition);
  const task = s.tasks.find((t) => t.id === id.toUpperCase());
  if (!task) throw new CliError(`no existe la tarea ${id} en el run ${s.run.run_id}`, EXIT.input);
  return task;
}

const domainError = (error: unknown) => new CliError((error as Error).message, EXIT.precondition);

function showPending(s: RunSnapshot): void {
  if (s.pending.length === 0) return;
  print(`Pendiente de ti (${s.pending.length}):`);
  for (const p of s.pending) {
    print(`  ${p.kind === 'tarea_bloqueada' ? '✘' : '?'} ${p.id}: ${p.text.split('\n')[0]}`);
    print(`      → ${p.action}`);
  }
}

function showSnapshot(s: RunSnapshot, runner: { pid: number } | null): void {
  print(`Cambio: ${s.change.title} · fase ${s.change.phase}`);
  if (!s.run) {
    print(`Plan: ${s.plan ? `${s.plan.tareas.length} tareas${s.approved ? ' · aprobado' : ' · sin aprobar'}` : 'todavía no hay'}`);
  } else {
    print(`Run: ${s.run.run_id} · ${s.run.state} · ${progressLine(s)}`);
    print(`     ${runner ? `forja run activo (pid ${runner.pid})` : 'nadie lo está ejecutando ahora'}${s.run.detail ? ` · ${s.run.detail}` : ''}`);
    print(`Rama de integración: ${s.run.branch}${s.deliveryBranch ? ` · entregado en ${s.deliveryBranch}` : ''}`);
    print();
    for (const t of s.tasks) {
      print(`  ${STATE_ICON[t.state] ?? ' '} ${t.id.padEnd(6)} ${t.title.slice(0, 28).padEnd(28)} ${(STATE_LABEL[t.state] ?? t.state).padEnd(18)} ${modelOf(t).padEnd(20)} ${taskActivityLine(t)}`);
    }
    if (s.usage.length) {
      print();
      print(`Consumo: ${s.usage.map((u) => `${u.role} ${compactTokens(u.tokens)} tok en ${u.calls} llamada(s)${u.costMicro !== null ? ` ≈US$ ${(u.costMicro / 1e6).toFixed(2)}` : ''}`).join(' · ')}`);
    }
  }
  print();
  showPending(s);
  print(`Siguiente paso: ${s.nextStep}`);
}

function snapshotJson(s: RunSnapshot, runner: { pid: number } | null) {
  return {
    cambio: { id: s.change.change_id, titulo: s.change.title, fase: s.change.phase },
    run: s.run ? { id: s.run.run_id, estado: s.run.state, detalle: s.run.detail, rama: s.run.branch, base: s.run.base_sha, activo: runner !== null } : null,
    entrega: s.deliveryBranch,
    progreso: { integradas: s.integrated, total: s.total, por_estado: s.counts },
    tareas: s.tasks.map((t) => ({
      id: t.id,
      titulo: t.title,
      estado: t.state,
      modelo: t.exec.provider ? `${t.exec.provider}:${t.exec.model}` : null,
      intento: t.exec.attempt,
      fallos_calidad: t.exec.quality_failures,
      actividad: t.activity,
      error: t.exec.last_error,
      pregunta: t.state === 'esperando_respuesta' ? t.exec.question : null,
    })),
    pendientes: s.pending,
    consumo: s.usage,
    siguiente: s.nextStep,
  };
}

function exitCodeFor(summary: RunSummary, stoppedByUser: boolean): number {
  if (summary.state === 'completado') return EXIT.ok;
  if (summary.state === 'bloqueado') return EXIT.precondition;
  if (summary.state === 'pausado') return stoppedByUser ? EXIT.ok : EXIT.environment;
  return EXIT.unknown;
}

/** Answers a worker's question from the CLI (also used by `forja responder T-xxx`). */
export function answerTaskFromCli(ctx: EngineContext, taskId: string, text: string): void {
  const s = snapshotOrFail(ctx);
  const task = taskOrFail(s, taskId);
  try {
    answerTaskQuestion(ctx.engine, s.run!.run_id, task.id, text);
  } catch (error) {
    throw domainError(error);
  }
  print(`✔ Respuesta registrada: ${task.id} vuelve a la cola con tu respuesta en su contexto.`);
  print(runningOrchestrator(ctx.dataDir) ? '  El run en curso la retoma solo.' : '  Retoma la ejecución con: forja run');
}

export function registerRunCommands(program: Command): void {
  program
    .command('run')
    .description('ejecuta el plan aprobado: agentes en paralelo, verificación e integración en una rama propia (main no se toca)')
    .option('--paralelo <n>', 'agentes trabajando a la vez (por defecto, ejecucion.paralelo de forja.yaml)', (v) => Number.parseInt(v, 10))
    .option('--estimar', 'sólo muestra la estimación de tiempo y consumo; no ejecuta nada')
    .option('--sin-revisor', 'omite el revisor independiente (más barato, menos control)')
    .option('--tablero', 'muestra el tablero en vivo mientras ejecuta')
    .action(async (opts: { paralelo?: number; estimar?: boolean; sinRevisor?: boolean; tablero?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      if (opts.paralelo !== undefined && (!Number.isInteger(opts.paralelo) || opts.paralelo < 1 || opts.paralelo > 16)) {
        throw new CliError('--paralelo debe ser un número entre 1 y 16');
      }
      const ctx = openEngine(g);
      let lock: LockFile | null = null;
      try {
        const change = activeChange(ctx.engine);
        if (!change) throw new CliError('no hay un cambio en curso: empieza con forja planear', EXIT.precondition);
        if (opts.estimar) {
          const current = latestPlan(ctx.engine, change.change_id);
          if (!current) throw new CliError('todavía no hay plan; ejecuta forja dividir', EXIT.precondition);
          const estimate = estimatePlan(current.plan, { ...ctx.config, ejecucion: { ...ctx.config.ejecucion, paralelo: opts.paralelo ?? ctx.config.ejecucion.paralelo } }, loadPrices(ctx.home));
          if (g.json) return printJson({ estimacion: estimate });
          print(`Estimación para «${change.title}» (no se ejecutó nada):`);
          showPlan(current.plan, estimate);
          return;
        }

        try {
          lock = acquireOrchestratorLock(ctx.dataDir, RUN_PURPOSE);
        } catch (error) {
          if (error instanceof LockHeldError) {
            throw new CliError(`${error.message}. Míralo con forja tablero o detenlo con forja detener`, EXIT.precondition);
          }
          throw error;
        }

        let started;
        try {
          started = await startOrResumeRun(ctx.engine, { changeId: change.change_id, repoPath: ctx.checkout.path });
        } catch (error) {
          if (error instanceof RunError) throw domainError(error);
          throw error;
        }
        const { runId } = started;
        const log = RunLog.of(ctx.dataDir, runId);
        const board = Boolean(opts.tablero && process.stdout.isTTY && process.stdin.isTTY && !g.json);
        let echo = !board && !g.json;
        const say = (line: string) => {
          const entry = log.append(line);
          if (echo) print(entry);
        };
        say(started.resumed ? `↺ se retoma el run ${runId}` : `▶ run ${runId} iniciado sobre ${ctx.checkout.path}`);
        if (started.inherited.length) say(`  heredadas del run anterior (ya integradas y sin cambios): ${started.inherited.join(', ')}`);

        const controller = new AbortController();
        let interrupts = 0;
        const onSignal = () => {
          interrupts++;
          if (interrupts === 1) {
            controller.abort();
            if (!echo) print('⏸ deteniendo: esperando a que los agentes en curso terminen (Ctrl-C otra vez para salir ya; se retoman con forja run)');
          } else {
            print('✘ salida inmediata: los agentes en curso siguen en segundo plano y forja run los reconcilia al volver');
            lock?.release();
            process.exit(130);
          }
        };
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);

        const orchestrator = new Orchestrator(ctx.engine, ctx.checkout.path, runId, {
          ...(opts.paralelo ? { parallel: opts.paralelo } : {}),
          review: !opts.sinRevisor,
          signal: controller.signal,
          onLog: say,
        });
        let summary: RunSummary;
        try {
          let settled = false;
          const loop = orchestrator.loop().finally(() => (settled = true));
          if (board) {
            await runBoard(new EngineBoardSource(ctx), { until: loop.catch(() => undefined) });
            echo = true;
            if (!settled && !controller.signal.aborted) print('El tablero se cerró; el run sigue en esta terminal (Ctrl-C para detenerlo).');
          }
          summary = await loop;
        } finally {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
        }

        // Re-read the change: the run moved its phase (aprobar → ejecutar → entregado).
        const s = runSnapshot(ctx.engine, getChange(ctx.engine, change.change_id));
        if (g.json) {
          printJson({ resumen: summary, estado: snapshotJson(s, null) });
        } else {
          print();
          print(
            summary.state === 'completado'
              ? `✔ Listo: ${s.integrated}/${s.total} tareas integradas en ${summary.deliveryBranch}. main no se tocó.`
              : `■ Run ${summary.state}: ${s.integrated}/${s.total} integradas.`,
          );
          if (summary.state === 'completado') print(`  Revisa: git log --oneline ${summary.deliveryBranch} · informe: forja informe`);
          showPending(s);
          if (summary.state !== 'completado') print(`Siguiente paso: ${s.nextStep}`);
        }
        process.exitCode = exitCodeFor(summary, controller.signal.aborted);
      } finally {
        lock?.release();
        ctx.close();
      }
    });

  program
    .command('estado')
    .description('muestra el cambio en curso, su run y cada tarea (sin pantalla interactiva)')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const change = currentChange(ctx.engine);
        if (!change) {
          if (g.json) return printJson({ cambio: null });
          print('No hay cambios todavía. Empieza con: forja planear "lo que quieres construir"');
          return;
        }
        const s = runSnapshot(ctx.engine, change);
        const runner = runningOrchestrator(ctx.dataDir);
        if (g.json) return printJson(snapshotJson(s, runner));
        showSnapshot(s, runner);
      } finally {
        ctx.close();
      }
    });

  program
    .command('preguntas')
    .description('lo que espera una decisión tuya: preguntas de agentes y de la especificación, bloqueos y aprobaciones')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const change = currentChange(ctx.engine);
        const s = change ? runSnapshot(ctx.engine, change) : null;
        if (g.json) return printJson({ pendientes: s?.pending ?? [] });
        if (!s || s.pending.length === 0) {
          print('Nada pendiente de ti.');
          if (s) print(`Siguiente paso: ${s.nextStep}`);
          return;
        }
        for (const p of s.pending) {
          print(`${p.kind === 'tarea_bloqueada' ? '✘' : '?'} ${p.id} · ${{ pregunta_tarea: 'pregunta de un agente', tarea_bloqueada: 'tarea bloqueada', pregunta_spec: 'pregunta de la especificación', aprobacion: 'aprobación' }[p.kind]}`);
          for (const l of p.text.split('\n')) print(`  ${l}`);
          print(`  → ${p.action}`);
          print();
        }
      } finally {
        ctx.close();
      }
    });

  program
    .command('tarea <id>')
    .description('detalle de una tarea: objetivo, criterios, intentos, modelo, base y verificación')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const s = snapshotOrFail(ctx);
        const task = taskOrFail(s, id);
        const def = s.plan?.tareas.find((t) => t.id === task.id);
        if (g.json) return printJson({ tarea: { ...task, definicion: def ?? null } });
        for (const l of taskDetailLines(task, def)) print(l);
      } finally {
        ctx.close();
      }
    });

  program
    .command('logs <tarea>')
    .description('registro legible del agente de una tarea (redactado)')
    .option('-f, --seguir', 'sigue mostrando líneas nuevas hasta Ctrl-C')
    .option('-n, --lineas <n>', 'últimas líneas a mostrar', (v) => Number.parseInt(v, 10), 40)
    .action(async (id: string, opts: { seguir?: boolean; lineas: number }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const s = snapshotOrFail(ctx);
        const task = taskOrFail(s, id);
        for (const l of taskLogLines(task).slice(-opts.lineas)) print(l);
        if (!opts.seguir) return;
        const runId = s.run!.run_id;
        let launchDir = task.exec.launch_dir;
        let lastSeq = launchDir ? (readSpool(launchDir).at(-1)?.seq ?? 0) : 0;
        const stop = new AbortController();
        const onSignal = () => stop.abort();
        process.once('SIGINT', onSignal);
        try {
          while (!stop.signal.aborted) {
            await new Promise((r) => setTimeout(r, 500));
            const exec = getExec(ctx.engine, runId, task.id);
            if (exec.launch_dir !== launchDir) {
              launchDir = exec.launch_dir;
              lastSeq = 0;
              print(`── nuevo intento ${exec.attempt} · ${exec.provider}:${exec.model} ──`);
            }
            if (!launchDir) continue;
            const records = readSpool(launchDir, lastSeq);
            if (records.length) lastSeq = records.at(-1)!.seq;
            for (const l of readableLog(records, exec.provider)) print(`${l.ts.slice(11, 19)} ${l.text}`);
          }
        } finally {
          process.off('SIGINT', onSignal);
        }
      } finally {
        ctx.close();
      }
    });

  program
    .command('reintentar <tarea> [nota...]')
    .description('vuelve a poner en cola una tarea bloqueada, con una nota opcional para el agente')
    .action(async (id: string, note: string[], _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const s = snapshotOrFail(ctx);
        const task = taskOrFail(s, id);
        try {
          unblockTask(ctx.engine, s.run!.run_id, task.id, note.join(' ').trim() || null);
        } catch (error) {
          throw domainError(error);
        }
        print(`✔ ${task.id} vuelve a la cola con el contador de intentos en cero.`);
        print(runningOrchestrator(ctx.dataDir) ? '  El run en curso la retoma solo.' : '  Retoma la ejecución con: forja run');
      } finally {
        ctx.close();
      }
    });

  program
    .command('detener')
    .description('detiene el run en curso: no lanza tareas nuevas; lo que está en marcha termina y se retoma con forja run')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const holder = requestStop(ctx.dataDir);
        if (!holder) throw new CliError('no hay un forja run activo en este proyecto', EXIT.precondition);
        print(`⏸ Se pidió detener el run (pid ${holder.pid}). Los agentes en curso terminan su tarea; retoma con forja run.`);
      } finally {
        ctx.close();
      }
    });

  program
    .command('informe')
    .description('muestra el informe de la última entrega: tareas, verificación y consumo')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const change = currentChange(ctx.engine);
        const path = change ? join(ctx.checkout.path, '.forja', 'cambios', change.change_id, 'informe.md') : null;
        if (!path || !existsSync(path)) throw new CliError('todavía no hay informe: se escribe al completar un run', EXIT.precondition);
        const text = readFileSync(path, 'utf8');
        if (g.json) return printJson({ ruta: path, informe: text });
        process.stdout.write(text);
      } finally {
        ctx.close();
      }
    });

  program
    .command('tablero')
    .description('tablero interactivo a pantalla completa: agentes en vivo, tareas, logs, diff y lo pendiente de ti')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      if (!process.stdout.isTTY || !process.stdin.isTTY) throw new CliError('el tablero necesita una terminal interactiva; para scripts usa forja estado --json');
      const ctx = openEngine(g);
      try {
        await runBoard(new EngineBoardSource(ctx));
      } finally {
        ctx.close();
      }
    });
}
