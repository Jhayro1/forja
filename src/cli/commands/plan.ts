import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { NoProviderError } from '../../core/engine.js';
import { approvePlan, currentApproval, gateProblems } from '../../plan/approve.js';
import { dividePlan, latestPlan } from '../../plan/divide.js';
import { estimatePlan, loadPrices } from '../../plan/estimate.js';
import { waves } from '../../plan/plan.js';
import { type AttachmentInput, saveAttachments, validate as validateAttachments } from '../../planner/attachments.js';
import { closureBlockers, type DiscoveryState, openQuestions } from '../../planner/discovery.js';
import { activeChange, approveDiscovery, createChange, getDiscovery, listChanges, PlannerError, plannerScratch, runPlannerTurn, type TurnResult, transcript } from '../../planner/session.js';
import { EFFORTS, type Effort, isEffort } from '../../providers/catalog.js';
import { type LockFile, LockHeldError } from '../../registry/lock.js';
import { acquireOrchestratorLock } from '../../run/process.js';
import { renderDocs, writeDocs } from '../../spec/docs.js';
import { answerSpecQuestion, changeDir, generateSpec, latestSpec, requestSpecChange } from '../../spec/generate.js';
import { blockingQuestions } from '../../spec/spec.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { type EngineContext, hasProductCode, openEngine, repoEvidence } from '../engine-context.js';
import { showPlan } from '../plan-view.js';
import { answerTaskFromCli } from './run.js';

function spinner(label: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    process.stderr.write(`\r${frames[i++ % frames.length]} ${label} ${Math.round((Date.now() - started) / 1000)}s `);
  }, 120);
  return () => {
    clearInterval(timer);
    process.stderr.write('\r\x1b[K');
  };
}

function showTurn(r: TurnResult): void {
  print();
  print(r.message.trim());
  print();
  const qs = r.questions;
  if (qs.length > 0) {
    print('Preguntas abiertas:');
    for (const q of qs) print(`  ${q.id}${q.bloquea ? ' (bloquea)' : ''}: ${q.texto}${q.recomendacion ? `  → recomiendo: ${q.recomendacion}` : ''}`);
    print();
  }
  for (const n of r.notes) print(`  ⚠ ${n}`);
  print(`  [${r.provider}:${r.model} · revisión ${r.revision}${r.blockers.length === 0 ? ' · se puede aprobar con /aprobar' : ''}]`);
}

function showState(state: DiscoveryState): void {
  print(`Resumen: ${state.resumen || '(todavía no hay)'}`);
  if (state.alcance.incluye.length) print(`Incluye: ${state.alcance.incluye.join('; ')}`);
  if (state.alcance.excluye.length) print(`Fuera:   ${state.alcance.excluye.join('; ')}`);
  const decisions = Object.values(state.decisiones);
  if (decisions.length) {
    print('Decisiones:');
    for (const d of decisions) print(`  ${d.estado === 'aceptada' ? '✔' : '?'} ${d.id}: ${d.contenido}`);
  }
  const pending = Object.values(state.propuestas).filter((p) => p.estado === 'pendiente');
  if (pending.length) {
    print('Sugerencias por decidir:');
    for (const p of pending) print(`  ${p.id} (${p.prioridad}): ${p.recomendacion}`);
  }
  const blockers = closureBlockers(state);
  print(blockers.length ? `Falta para aprobar:\n${blockers.map((b) => `  - ${b}`).join('\n')}` : 'Se puede aprobar el descubrimiento con /aprobar.');
}

async function planningInputs(ctx: EngineContext, mode: 'idea' | 'mejora') {
  return mode === 'mejora' ? { workspace: ctx.checkout.path, evidence: await repoEvidence(ctx.checkout.path) } : { workspace: plannerScratch(ctx.engine) };
}

type TurnExtras = { files?: AttachmentInput[]; model?: string; effort?: Effort };

async function turn(ctx: EngineContext, changeId: string, mode: 'idea' | 'mejora', userText: string | null, closing = false, extras: TurnExtras = {}): Promise<TurnResult> {
  const stop = spinner(`pensando con ${extras.model ?? ctx.config.roles.planeador[0]}…`);
  try {
    const attachments = extras.files?.length ? saveAttachments(ctx.engine.dataDir, changeId, extras.files) : [];
    return await runPlannerTurn(ctx.engine, {
      changeId,
      userText,
      ...(await planningInputs(ctx, mode)),
      closing,
      ...(attachments.length ? { attachments } : {}),
      ...(extras.model ? { model: extras.model } : {}),
      ...(extras.effort ? { effort: extras.effort } : {}),
    });
  } catch (error) {
    if (error instanceof NoProviderError || error instanceof PlannerError) throw new CliError(error.message, EXIT.environment);
    throw error;
  } finally {
    stop();
  }
}

export function registerPlanCommands(program: Command): void {
  program
    .command('planear [idea...]')
    .description('conversa con el planeador para definir una idea o una mejora')
    .option('--nuevo', 'empieza un cambio nuevo aunque haya uno en curso')
    .option('--mejora', 'es una mejora de este repositorio (por defecto se detecta)')
    .option('--idea', 'es una idea nueva')
    .option('-m, --mensaje <texto>', 'envía un mensaje y termina (sin conversación interactiva)')
    .option('--adjuntar <archivos...>', 'documentos de texto para el planeador (p. ej. un plan en .md); se nombran con @archivo')
    .option('--modelo <ref>', 'modelo con el que planear en este mensaje (p. ej. claude:opus, codex:gpt-6-astra)')
    .option('--esfuerzo <nivel>', `esfuerzo de razonamiento (${EFFORTS.join(', ')})`)
    .action(async (ideaWords: string[], opts: { nuevo?: boolean; mejora?: boolean; idea?: boolean; mensaje?: string; adjuntar?: string[]; modelo?: string; esfuerzo?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      if (opts.esfuerzo && !isEffort(opts.esfuerzo)) throw new CliError(`esfuerzo desconocido: usa ${EFFORTS.join(', ')}`);
      if (opts.modelo && !/^(claude|codex|simulado):[A-Za-z0-9._[\]-]{1,60}$/.test(opts.modelo)) throw new CliError('--modelo va como proveedor:modelo (p. ej. claude:opus)');
      let files: AttachmentInput[] = [];
      try {
        files = validateAttachments((opts.adjuntar ?? []).map((f) => ({ name: basename(f), text: readFileSync(f, 'utf8') })));
      } catch (error) {
        throw new CliError(`no se pudo adjuntar: ${(error as Error).message}`);
      }
      // The documents go with the first message sent; model and effort with every one.
      const extras = (): TurnExtras => {
        const e: TurnExtras = { ...(opts.modelo ? { model: opts.modelo } : {}), ...(opts.esfuerzo ? { effort: opts.esfuerzo as Effort } : {}), ...(files.length ? { files } : {}) };
        files = [];
        return e;
      };
      const ctx = openEngine(g);
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
      try {
        let change = opts.nuevo ? undefined : activeChange(ctx.engine);
        if (change && change.phase !== 'descubrir') {
          throw new CliError(`el cambio «${change.title}» ya pasó el descubrimiento (fase ${change.phase}); usa --nuevo para empezar otro`, EXIT.precondition);
        }
        if (!change) {
          let idea = ideaWords.join(' ').trim();
          if (!idea) {
            if (!process.stdin.isTTY) throw new CliError('escribe la idea: forja planear "lo que quiero construir"');
            idea = (await rl.question('¿Qué quieres construir o mejorar? ')).trim();
          }
          if (!idea) throw new CliError('no se recibió ninguna idea');
          const mode = opts.mejora ? 'mejora' : opts.idea ? 'idea' : (await hasProductCode(ctx.checkout.path)) ? 'mejora' : 'idea';
          const changeId = createChange(ctx.engine, `cambio:${Date.now()}`, idea.slice(0, 120), mode);
          change = listChanges(ctx.engine).find((c) => c.change_id === changeId)!;
          print(`Nuevo cambio (${mode === 'mejora' ? 'mejora de este repositorio' : 'idea nueva'}): ${change.title}`);
          const first = extras();
          showTurn(await turn(ctx, change.change_id, change.mode, first.files?.length && !opts.mensaje ? idea : null, false, first));
        } else if (!opts.mensaje) {
          const history = transcript(ctx.engine, change.change_id);
          print(`Retomando «${change.title}» (${history.length} turnos).`);
          const last = history.at(-1);
          if (last) {
            print();
            print(last.planner_text.trim());
            const qs = openQuestions(getDiscovery(ctx.engine, change.change_id).state);
            if (qs.length) {
              print();
              print('Preguntas abiertas:');
              for (const q of qs) print(`  ${q.id}${q.bloquea ? ' (bloquea)' : ''}: ${q.texto}`);
            }
          } else {
            showTurn(await turn(ctx, change.change_id, change.mode, null, false, extras()));
          }
        }

        if (opts.mensaje) {
          const r = await turn(ctx, change.change_id, change.mode, opts.mensaje, false, extras());
          if (g.json) printJson({ turno: r });
          else showTurn(r);
          return;
        }
        if (!process.stdin.isTTY) return;

        print();
        print('Escribe tu respuesta. Comandos: /estado  /cerrar  /aprobar  /salir');
        for (;;) {
          const text = (await rl.question('\ntú › ')).trim();
          if (!text) continue;
          if (text === '/salir' || text === '/q') break;
          if (text === '/estado') {
            showState(getDiscovery(ctx.engine, change.change_id).state);
            continue;
          }
          if (text === '/cerrar') {
            showTurn(await turn(ctx, change.change_id, change.mode, 'Quiero cerrar el descubrimiento: revisa huecos y prepara el resumen para aprobar.', true, extras()));
            continue;
          }
          if (text === '/aprobar') {
            try {
              approveDiscovery(ctx.engine, change.change_id, `aprobar:${change.change_id}:${getDiscovery(ctx.engine, change.change_id).revision}`);
              print('✔ Descubrimiento aprobado. Siguiente paso: forja especificar');
              break;
            } catch (error) {
              print(`✘ ${(error as Error).message}`);
            }
            continue;
          }
          showTurn(await turn(ctx, change.change_id, change.mode, text, false, extras()));
        }
      } finally {
        rl.close();
        ctx.close();
      }
    });

  program
    .command('cambios')
    .description('lista los cambios (incrementos) del proyecto y su fase')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const rows = listChanges(ctx.engine);
        if (g.json) return printJson({ cambios: rows });
        if (rows.length === 0) return print('Todavía no hay cambios. Empieza con: forja planear');
        for (const r of rows) print(`${r.change_id}  ${r.phase.padEnd(11)} ${r.title}`);
      } finally {
        ctx.close();
      }
    });

  const aprobar = program.command('aprobar').description('aprobaciones explícitas (nunca se infieren del silencio)');
  aprobar
    .command('descubrimiento')
    .description('aprueba el resumen del descubrimiento del cambio en curso')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const change = activeChange(ctx.engine);
        if (!change) throw new CliError('no hay un cambio en curso', EXIT.precondition);
        const { revision } = getDiscovery(ctx.engine, change.change_id);
        try {
          approveDiscovery(ctx.engine, change.change_id, `aprobar:${change.change_id}:${revision}`);
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.precondition);
        }
        print(`✔ Descubrimiento de «${change.title}» aprobado (revisión ${revision}). Siguiente paso: forja especificar`);
      } finally {
        ctx.close();
      }
    });

  program
    .command('especificar')
    .description('convierte el descubrimiento aprobado en especificación y documentos (también para cambiarla después de aprobar el plan)')
    .option('--cambio <texto>', 'cambio que quieres en la especificación ya aprobada (sólo se rehace lo que toque)')
    .action(async (o: { cambio?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      let lock: LockFile | null = null;
      try {
        const change = activeChange(ctx.engine);
        if (!change) throw new CliError('no hay un cambio en curso; empieza con: forja planear', EXIT.precondition);
        if (change.phase === 'ejecutar') {
          // Changing the spec mid-run: no orchestrator may keep executing the old plan meanwhile.
          try {
            lock = acquireOrchestratorLock(ctx.dataDir, 'cambiar la especificación');
          } catch (error) {
            if (error instanceof LockHeldError) throw new CliError(`${error.message}: detenlo con forja detener antes de cambiar la especificación`, EXIT.precondition);
            throw error;
          }
        }
        if ((change.phase === 'aprobar' || change.phase === 'ejecutar') && !o.cambio) {
          throw new CliError('la especificación ya se dividió en un plan: di qué quieres cambiar con forja especificar --cambio "…"', EXIT.input);
        }
        if (o.cambio) requestSpecChange(ctx.engine, change.change_id, o.cambio.trim());
        const stop = spinner(`especificando con ${ctx.config.roles.planeador[0]}…`);
        let result: Awaited<ReturnType<typeof generateSpec>>;
        try {
          result = await generateSpec(ctx.engine, {
            changeId: change.change_id,
            repoPath: ctx.checkout.path,
            projectId: ctx.config.project_id,
            ...(await planningInputs(ctx, change.mode)),
          });
        } catch (error) {
          if (error instanceof NoProviderError || error instanceof PlannerError) throw new CliError(error.message, EXIT.environment);
          throw error;
        } finally {
          stop();
        }
        const dir = changeDir(ctx.checkout.path, change.change_id);
        const report = writeDocs(dir, result.spec, renderDocs(result.spec));
        const errors = result.issues.filter((i) => i.severity === 'error');
        const warnings = result.issues.filter((i) => i.severity === 'aviso');
        if (g.json) return printJson({ spec: { revision: result.revision, hash: result.hash }, problemas: result.issues, documentos: report, carpeta: dir });
        const s = result.spec;
        print(`${errors.length ? '!' : '✔'} Especificación revisión ${result.revision} (${result.attempts} llamada${result.attempts > 1 ? 's' : ''} al planeador)`);
        print(`  ${s.casos_uso.length} casos de uso · ${s.criterios.length} criterios · ${s.requisitos.length} requisitos · ${s.reglas.length} reglas · ${s.entidades.length} entidades`);
        print(`  Documentos en ${dir}`);
        print(
          `  ${report.written.length} escritos · ${report.unchanged.length} sin cambios${report.conflicts.length ? ` · ${report.conflicts.length} editados a mano (versión nueva en .nuevo)` : ''}`,
        );
        for (const e of errors) print(`  ✘ ${e.path}: ${e.message}`);
        for (const w of warnings) print(`  ! ${w.path}: ${w.message}`);
        const qs = blockingQuestions(s);
        for (const q of qs) print(`  ? ${q.id} ${q.texto} (bloquea ${q.bloquea.join(', ')})`);
        print(
          errors.length ? '\nCorrige o vuelve a ejecutar forja especificar.' : `\nSiguiente paso: forja dividir${o.cambio ? ' (el run siguiente sólo rehace las tareas que el cambio afecta)' : ''}`,
        );
        if (errors.length) process.exitCode = EXIT.verification;
      } finally {
        lock?.release();
        ctx.close();
      }
    });

  program
    .command('responder <pregunta> <respuesta...>')
    .description('responde una pregunta pendiente: de la especificación (Q-001) o de un agente (T-001)')
    .action(async (questionId: string, words: string[], _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        if (/^T-\d+$/i.test(questionId)) return answerTaskFromCli(ctx, questionId, words.join(' '));
        const change = activeChange(ctx.engine);
        if (!change) throw new CliError('no hay un cambio en curso', EXIT.precondition);
        try {
          answerSpecQuestion(ctx.engine, change.change_id, questionId.toUpperCase(), words.join(' '));
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.input);
        }
        const pending = (latestSpec(ctx.engine, change.change_id)?.spec.preguntas ?? []).filter(
          (q) => !ctx.engine.store.db.prepare('SELECT 1 FROM spec_answers WHERE change_id = ? AND question_id = ?').get(change.change_id, q.id),
        );
        print(`✔ Respuesta a ${questionId.toUpperCase()} registrada.`);
        print(pending.length ? `  Quedan ${pending.length} pregunta(s): ${pending.map((q) => q.id).join(', ')}` : '  No quedan preguntas: ejecuta forja especificar para incorporar las respuestas.');
      } finally {
        ctx.close();
      }
    });

  program
    .command('dividir')
    .description('divide la especificación en tareas ejecutables (con estimación)')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      let lock: LockFile | null = null;
      try {
        const change = activeChange(ctx.engine);
        if (!change) throw new CliError('no hay un cambio en curso', EXIT.precondition);
        const replan = change.phase === 'ejecutar';
        if (replan) {
          // Re-planning mid-run: no orchestrator may be running on the old plan meanwhile.
          try {
            lock = acquireOrchestratorLock(ctx.dataDir, 'rehacer el plan');
          } catch (error) {
            if (error instanceof LockHeldError) throw new CliError(`${error.message}: detenlo con forja detener antes de rehacer el plan`, EXIT.precondition);
            throw error;
          }
        }
        const stop = spinner(`dividiendo en tareas con ${ctx.config.roles.planeador[0]}…`);
        let result: Awaited<ReturnType<typeof dividePlan>>;
        try {
          result = await dividePlan(ctx.engine, {
            changeId: change.change_id,
            repoPath: ctx.checkout.path,
            hasCode: await hasProductCode(ctx.checkout.path),
            ...(await planningInputs(ctx, change.mode)),
          });
        } catch (error) {
          if (error instanceof NoProviderError || error instanceof PlannerError) throw new CliError(error.message, EXIT.precondition);
          throw error;
        } finally {
          stop();
        }
        const estimate = estimatePlan(result.plan, ctx.config, loadPrices(ctx.home));
        if (g.json) return printJson({ plan: result.plan, hash: result.hash, problemas: result.issues, estimacion: estimate });
        const errors = result.issues.filter((i) => i.severity === 'error');
        print(`${errors.length ? '!' : '✔'} Plan revisión ${result.plan.revision}: ${result.plan.tareas.length} tareas en ${waves(result.plan.tareas).length} olas`);
        for (const e of errors) print(`  ✘ ${e.task ?? 'plan'}: ${e.message}`);
        for (const w of result.issues.filter((i) => i.severity === 'aviso')) print(`  ! ${w.task ?? 'plan'}: ${w.message}`);
        showPlan(result.plan, estimate);
        print(errors.length ? '\nEl plan tiene errores: vuelve a ejecutar forja dividir.' : '\nRevisa el plan y apruébalo con: forja aprobar plan');
        if (replan && !errors.length) print('Al aprobarlo, forja run crea un run nuevo que conserva las tareas ya integradas cuya definición no cambió.');
      } finally {
        lock?.release();
        ctx.close();
      }
    });

  program
    .command('plan')
    .description('muestra el plan vigente, su estimación y si está aprobado')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const change = activeChange(ctx.engine);
        const current = change ? latestPlan(ctx.engine, change.change_id) : null;
        if (!change || !current) throw new CliError('todavía no hay plan; ejecuta forja dividir', EXIT.precondition);
        const estimate = estimatePlan(current.plan, ctx.config, loadPrices(ctx.home));
        const approval = currentApproval(ctx.engine, change.change_id);
        if (g.json) return printJson({ plan: current.plan, hash: current.hash, estimacion: estimate, aprobacion: approval, problemas: gateProblems(ctx.engine, change.change_id) });
        print(`Plan de «${change.title}» · revisión ${current.revision} · ${approval ? `aprobado (${approval.approval_id})` : 'sin aprobar'}`);
        showPlan(current.plan, estimate);
      } finally {
        ctx.close();
      }
    });

  const aprobarCmd = program.commands.find((c) => c.name() === 'aprobar')!;
  aprobarCmd
    .command('plan')
    .description('aprueba exactamente esta especificación, este plan, este perfil y esta política')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const change = activeChange(ctx.engine);
        if (!change) throw new CliError('no hay un cambio en curso', EXIT.precondition);
        let approval: ReturnType<typeof approvePlan>;
        try {
          approval = approvePlan(ctx.engine, change.change_id);
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.precondition);
        }
        print(`✔ Plan aprobado (${approval.approval_id}): ${approval.allowed_task_ids.length} tareas.`);
        print('  Cualquier cambio en la especificación, el plan, el perfil o la política invalida esta aprobación.');
        print('  Siguiente paso: forja run');
      } finally {
        ctx.close();
      }
    });
}
