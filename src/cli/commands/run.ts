import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { label, TEXTOS } from '../../i18n/textos.js';
import { latestPlan } from '../../plan/divide.js';
import { estimatePlan, loadPrices } from '../../plan/estimate.js';
import { activeChange, getChange } from '../../planner/session.js';
import { ConformanceStore, conformanceProblems, mcpGaps, uncertifiedModels } from '../../providers/conformance.js';
import { type LockFile, LockHeldError } from '../../registry/lock.js';
import { readableLog } from '../../run/activity.js';
import { modelOf, progressLine, STATE_ICON, STATE_LABEL, taskActivityLine, taskDetailLines } from '../../run/describe.js';
import { answerTaskQuestion, getExec, Orchestrator, RunError, type RunSummary, startOrResumeRun, unblockTask } from '../../run/orchestrator.js';
import { acquireOrchestratorLock, RUN_PURPOSE, requestStop, runningOrchestrator } from '../../run/process.js';
import { RunLog } from '../../run/run-log.js';
import { SELF_HOST_WARNING, supervisesItself } from '../../run/self-host.js';
import { compactTokens, costLabel, currentChange, type RunSnapshot, runSnapshot } from '../../run/snapshot.js';
import { snapshotJson } from '../../run/snapshot-json.js';
import { readSpool } from '../../runtime/launcher.js';
import { listTasks } from '../../store/projections.js';
import { runBoard } from '../../tui/app.js';
import { DirWatchSet, Waker } from '../../util/waker.js';
import { FORJA_VERSION } from '../../version.js';
import { EngineBoardSource, taskLogLines } from '../board-source.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { type EngineContext, openEngine } from '../engine-context.js';
import { gatewayForProject } from '../gateway-setup.js';
import { showPlan } from '../plan-view.js';
import { domainError, snapshotOrFail, taskOrFail } from '../run-selection.js';
import { confirm } from '../secret-input.js';
import { certifyModels } from './conformance.js';
import { startRunNotifications } from './notify.js';

function showPending(s: RunSnapshot): void {
  if (s.pending.length === 0) return;
  print(`Pendiente de ti (${s.pending.length}):`);
  for (const p of s.pending) {
    print(`  ${p.kind === 'tarea_bloqueada' ? '✘' : p.kind === 'tarea_pausada' ? '⏸' : '?'} ${p.id}: ${p.text.split('\n')[0]}`);
    print(`      → ${p.action}`);
  }
}

function showSnapshot(s: RunSnapshot, runner: { pid: number } | null): void {
  if (s.demo) print(DEMO_NOTICE);
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
      print(`Consumo: ${s.usage.map((u) => `${u.role} ${compactTokens(u.tokens)} tok en ${u.calls} llamada(s)${u.costMicro !== null ? ` ${costLabel(u)}` : ''}`).join(' · ')}`);
    }
  }
  for (const p of s.providerPauses) print(`⏸ ${p.key}: en pausa hasta ${new Date(p.until).toLocaleTimeString()} (${p.reason})`);
  print();
  showPending(s);
  print(`Siguiente paso: ${s.nextStep}`);
}

/** `--solo` never skips dependencies: the task must be able to run on what is already integrated. */
function soloTarget(ctx: EngineContext, runId: string, id: string): string {
  const tasks = listTasks(ctx.store.db, runId);
  const task = tasks.find((t) => t.task_id === id.toUpperCase());
  if (!task) throw new CliError(`no existe la tarea ${id} en el run ${runId}`, EXIT.input);
  if (task.state === 'integrada') throw new CliError(`${task.task_id} ya está integrada: no hay nada que ejecutar`, EXIT.precondition);
  if (['invalidada', 'cancelada'].includes(task.state)) throw new CliError(`${task.task_id} está ${task.state}`, EXIT.precondition);
  const pending = task.depends_on.filter((d) => tasks.find((t) => t.task_id === d)?.state !== 'integrada');
  if (pending.length) {
    throw new CliError(`${task.task_id} depende de tareas sin integrar (${pending.join(', ')}): ejecútalas antes (forja run --solo ${pending[0]}) o corre el plan completo`, EXIT.precondition);
  }
  if (task.state === 'bloqueada' || task.state === 'esperando_respuesta' || task.state === 'pausada') {
    throw new CliError(`${task.task_id} está ${task.state}: resuélvelo primero (forja preguntas)`, EXIT.precondition);
  }
  return task.task_id;
}

const DEMO_NOTICE = `⚠ ${TEXTOS.modoDemo}`;

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
    .option('--sin-conformidad', 'permite modelos sin conformidad aprobada con la versión instalada de su CLI (queda registrado)')
    .option('--probar-conformidad', 'si hay modelos sin conformidad (p. ej. tras actualizar su CLI), los prueba antes de ejecutar')
    .option('--solo <tarea>', 'ejecuta sólo esa tarea (para depurarla); sus dependencias deben estar integradas')
    .action(async (opts: { paralelo?: number; estimar?: boolean; sinRevisor?: boolean; tablero?: boolean; sinConformidad?: boolean; probarConformidad?: boolean; solo?: string }, cmd: Command) => {
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

        // V2-040: autonomous work only with models certified for the installed CLI version.
        const roles = ctx.config.roles;
        const integrates = latestPlan(ctx.engine, change.change_id)?.plan.tareas.some((t) => t.tipo === 'integracion') ?? false;
        const refs = [...roles.trabajador, ...roles.complejo, ...roles.revisor, ...(integrates ? roles.integrador : [])];
        const store = ConformanceStore.in(ctx.home);
        let unverified = await conformanceProblems(store, refs, FORJA_VERSION);
        if (unverified.length && !opts.sinConformidad) {
          // A new CLI version (or an untested model) can be certified right here (MEJORAS 3.8).
          const pending = await uncertifiedModels(store, refs, FORJA_VERSION);
          print(`Modelos sin conformidad aprobada:\n${unverified.map((u) => `  - ${u}`).join('\n')}`);
          if (opts.probarConformidad || (!g.json && (await confirm('¿Probarlos ahora? Consume un poco de cuota de cada uno.')))) {
            await certifyModels(
              ctx,
              pending.map((p) => p.ref),
              { quiet: g.json === true },
            );
            unverified = await conformanceProblems(store, refs, FORJA_VERSION);
          }
        }
        if (unverified.length && !opts.sinConformidad) {
          throw new CliError(
            `modelos sin conformidad aprobada:\n${unverified.map((u) => `  - ${u}`).join('\n')}\nPruébalos con: forja conformidad (o forja run --probar-conformidad; bajo tu responsabilidad, forja run --sin-conformidad)`,
            EXIT.precondition,
          );
        }

        try {
          lock = acquireOrchestratorLock(ctx.dataDir, RUN_PURPOSE);
        } catch (error) {
          if (error instanceof LockHeldError) {
            throw new CliError(`${error.message}. Míralo con forja tablero o detenlo con forja detener`, EXIT.precondition);
          }
          throw error;
        }

        let started: Awaited<ReturnType<typeof startOrResumeRun>>;
        try {
          started = await startOrResumeRun(ctx.engine, { changeId: change.change_id, repoPath: ctx.checkout.path });
        } catch (error) {
          if (error instanceof RunError) throw domainError(error);
          throw error;
        }
        const { runId } = started;
        const only = opts.solo ? soloTarget(ctx, runId, opts.solo) : undefined;
        const log = RunLog.of(ctx.dataDir, runId);
        const board = Boolean(opts.tablero && process.stdout.isTTY && process.stdin.isTTY && !g.json);
        let echo = !board && !g.json;
        const say = (line: string) => {
          const entry = log.append(line);
          if (echo) print(entry);
        };
        if (ctx.engine.simulation) say(DEMO_NOTICE);
        say(started.resumed ? `↺ se retoma el run ${runId}` : `▶ run ${runId} iniciado sobre ${ctx.checkout.path}`);
        if (unverified.length) say(`⚠ se ejecuta con modelos sin conformidad aprobada (--sin-conformidad): ${unverified.join('; ')}`);
        if (only) say(`· modo --solo: sólo se lanza ${only}`);
        if (started.inherited.length) say(`  heredadas del run anterior (ya integradas y sin cambios): ${started.inherited.join(', ')}`);
        for (const r of started.redone) say(`  ↻ ${r.task} se rehace: ${r.reason}`);

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

        const gateway = await gatewayForProject(ctx, say);
        const noMcp = gateway ? await mcpGaps(store, [...roles.trabajador, ...roles.complejo], FORJA_VERSION) : [];
        if (noMcp.length) say(`⚠ sin prueba MCP aprobada: ${noMcp.join(', ')}; esos modelos podrían no poder proponer acciones (forja conformidad)`);
        if (gateway)
          say(
            `· gateway MCP activo: conexiones vinculadas${gateway.externals.length ? ` y ${gateway.externals.map((e) => e.def.name).join(', ')}` : ''} (los agentes sólo proponen; nada se ejecuta sin tu aprobación)`,
          );
        const orchestrator = new Orchestrator(ctx.engine, ctx.checkout.path, runId, {
          ...(gateway ? { gateway } : {}),
          ...(opts.paralelo ? { parallel: opts.paralelo } : {}),
          review: !opts.sinRevisor,
          ...(only ? { only } : {}),
          signal: controller.signal,
          onLog: say,
        });
        if (supervisesItself(ctx.checkout.path)) say(SELF_HOST_WARNING);
        const stopNotifications = startRunNotifications(ctx, say);
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
          await stopNotifications();
          gateway?.close();
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
          print(`${p.kind === 'tarea_bloqueada' ? '✘' : '?'} ${p.id} · ${label('pendiente', p.kind)}`);
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
        const waker = new Waker();
        const onSignal = () => {
          stop.abort();
          waker.notify();
        };
        process.once('SIGINT', onSignal);
        // New spool lines or a new attempt (a store write) wake the loop; the timer is a fallback.
        const watch = new DirWatchSet(
          () => waker.notify(),
          (f) => f === 'spool.jsonl' || f.startsWith('estado.db'),
        );
        try {
          while (!stop.signal.aborted) {
            watch.sync([ctx.dataDir, ...(launchDir ? [launchDir] : [])]);
            await waker.wait(2000);
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
          watch.close();
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
